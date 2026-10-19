import {
  clampSegParams,
  type LineBox,
  type SegParams,
} from "./segment-core";
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerResult,
} from "./segment-protocol";

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MIN_LONG_EDGE = 600;
export const MAX_LONG_EDGE = 10000;

export type SegmentPageResult = {
  /** Null when the working page did not change. */
  bitmap: ImageBitmap | null;
  pageChanged: boolean;
  width: number;
  height: number;
  angle: number;
  boxes: LineBox[];
  params: SegParams;
};

export class SegmenterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmenterError";
  }
}

export function segmenterErrorMessage(
  error: unknown,
  fallback: string,
): string {
  return error instanceof SegmenterError ? error.message : fallback;
}

function hasWorkerSupport(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function"
  );
}

/** Type and size checks that run before the file is decoded. */
export function validatePageFile(file: File): string | null {
  const mime = file.type.toLowerCase();
  const mimeOk =
    mime === "image/jpeg" || mime === "image/png" || mime === "image/webp";
  const extensionOk = /\.(jpe?g|png|webp)$/i.test(file.name);

  if (!mimeOk && !(mime === "" && extensionOk)) {
    return "That file is not a JPG, PNG or WebP image. Choose one of those and try again.";
  }

  if (file.size === 0) {
    return "That file is empty. Choose a page image with something on it.";
  }

  if (file.size > MAX_FILE_BYTES) {
    return "That image is larger than 15 MB. Choose a smaller file.";
  }

  return null;
}

/** Decode on the main thread, with EXIF orientation, then check dimensions. */
export async function decodePageFile(file: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") {
    throw new SegmenterError(
      "This browser cannot read an image for in-browser detection. Try a current version of Chrome, Edge, Firefox or Safari.",
    );
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new SegmenterError(
      "That image could not be opened. It may be damaged or in an unsupported format.",
    );
  }

  const longEdge = Math.max(bitmap.width, bitmap.height);
  if (longEdge < MIN_LONG_EDGE) {
    bitmap.close();
    throw new SegmenterError(
      "That image is too small. The long edge must be at least 600 px.",
    );
  }

  if (longEdge > MAX_LONG_EDGE) {
    bitmap.close();
    throw new SegmenterError(
      "That image is too large. The long edge must be at most 10,000 px.",
    );
  }

  return bitmap;
}

type Pending = {
  resolve: (value: SegmentPageResult) => void;
  reject: (reason: SegmenterError) => void;
};

/**
 * Typed client for the segmentation Worker. Decode the File first, then hand
 * the ImageBitmap over; it is transferred, not copied.
 */
export class PageSegmenter {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;
  private fatal: string | null = null;

  /** Called with short stage messages, never with image data. */
  onProgress: ((message: string) => void) | null = null;

  constructor() {
    if (!hasWorkerSupport()) {
      throw new SegmenterError(
        "This browser cannot run in-browser line detection. Try a current version of Chrome, Edge, Firefox or Safari.",
      );
    }

    this.worker = new Worker(new URL("./segment.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleError);
    this.worker.addEventListener("messageerror", this.handleMessageError);
  }

  private assertUsable() {
    if (this.disposed) {
      throw new SegmenterError("The page was replaced. Upload the image again.");
    }
    if (this.fatal) throw new SegmenterError(this.fatal);
  }

  /**
   * Decode on the main thread and hand the bitmap to the Worker. It is
   * transferred, so the caller must not draw or close it afterwards. Only
   * bitmaps returned in the result are held on the main thread.
   */
  load(bitmap: ImageBitmap, params: SegParams): Promise<SegmentPageResult> {
    this.assertUsable();
    const id = this.nextId++;
    const clamped = clampSegParams(params);

    return new Promise<SegmentPageResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        const request: WorkerRequest = { id, type: "load", bitmap, params: clamped };
        this.worker.postMessage(request, [bitmap]);
      } catch {
        this.pending.delete(id);
        bitmap.close();
        reject(
          new SegmenterError(
            "The page could not be sent to the line detector. Try another image.",
          ),
        );
      }
    });
  }

  update(params: SegParams): Promise<SegmentPageResult> {
    this.assertUsable();
    const id = this.nextId++;
    const clamped = clampSegParams(params);

    return new Promise<SegmentPageResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        const request: WorkerRequest = {
          id,
          type: "process",
          params: clamped,
        };
        this.worker.postMessage(request);
      } catch {
        this.pending.delete(id);
        reject(
          new SegmenterError(
            "The line detector could not be reached. Try changing a setting again.",
          ),
        );
      }
    });
  }

  private handleMessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;

    if (message.type === "progress") {
      this.onProgress?.(message.message);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      if (message.type === "result" && message.page) message.page.close();
      return;
    }
    this.pending.delete(message.id);

    if (message.type === "error") {
      pending.reject(new SegmenterError(message.message));
      return;
    }

    pending.resolve(this.toResult(message));
  };

  private toResult(message: WorkerResult): SegmentPageResult {
    return {
      bitmap: message.page,
      pageChanged: message.pageChanged,
      width: message.width,
      height: message.height,
      angle: message.angle,
      boxes: message.boxes,
      params: message.params,
    };
  }

  private handleError = (event: ErrorEvent) => {
    event.preventDefault();
    this.failAll(
      "The line detector stopped. Open the page again to retry in this browser.",
    );
  };

  private handleMessageError = () => {
    this.failAll(
      "The line detector returned unreadable data. Open the page again to retry.",
    );
  };

  private failAll(message: string) {
    if (this.disposed) return;
    this.fatal = message;
    for (const pending of this.pending.values()) {
      pending.reject(new SegmenterError(message));
    }
    this.pending.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new SegmenterError("The page was replaced."));
    }
    this.pending.clear();

    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleError);
    this.worker.removeEventListener("messageerror", this.handleMessageError);
    this.worker.terminate();
  }
}

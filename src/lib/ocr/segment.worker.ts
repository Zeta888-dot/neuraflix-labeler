import {
  buildInkMask,
  clampSegParams,
  estimateSkewAngle,
  findLineBoxes,
  otsuThreshold,
  rgbaToGray,
  rowProfile,
  smoothProfile,
  type SegParams,
} from "./segment-core";
import type {
  WorkerError,
  WorkerRequest,
  WorkerResponse,
  WorkerResult,
} from "./segment-protocol";

/* The working page is only downscaled when the long edge is above this. */
const MAX_LONG_EDGE = 3000;
const SKEW_WIDTH = 900;

type WorkerScope = {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const scope = self as unknown as WorkerScope;

let baseCanvas: OffscreenCanvas | null = null;
let baseWidth = 0;
let baseHeight = 0;
let angle = 0;

let workingCanvas: OffscreenCanvas | null = null;
let workingDeskewed = false;
let width = 0;
let height = 0;

let mask: Uint8Array | null = null;
let profile: Float64Array | null = null;

function context2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D is not available.");
  return context;
}

function progress(id: number, message: string) {
  scope.postMessage({ id, type: "progress", message });
}

function postError(id: number, message: string) {
  const response: WorkerError = { id, type: "error", message };
  scope.postMessage(response);
}

/** Flatten onto white and downscale in one draw, never above 3000 px. */
function prepareBase(bitmap: ImageBitmap) {
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const longEdge = Math.max(sourceWidth, sourceHeight);
  const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const context = context2d(canvas);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, targetWidth, targetHeight);
  context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

  return { canvas, width: targetWidth, height: targetHeight };
}

/** Skew is estimated on a grayscale copy about 900 px wide, once per page. */
function estimateAngle(
  canvas: OffscreenCanvas,
  pageWidth: number,
  pageHeight: number,
): number {
  if (pageWidth <= SKEW_WIDTH) {
    const data = context2d(canvas).getImageData(0, 0, pageWidth, pageHeight);
    const gray = rgbaToGray(data.data, pageWidth, pageHeight);
    return estimateSkewAngle(gray, pageWidth, pageHeight);
  }

  const smallWidth = SKEW_WIDTH;
  const smallHeight = Math.max(
    1,
    Math.round((pageHeight * smallWidth) / pageWidth),
  );
  const small = new OffscreenCanvas(smallWidth, smallHeight);
  const context = context2d(small);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, smallWidth, smallHeight);
  context.drawImage(canvas, 0, 0, smallWidth, smallHeight);

  const data = context.getImageData(0, 0, smallWidth, smallHeight);
  const gray = rgbaToGray(data.data, smallWidth, smallHeight);
  return estimateSkewAngle(gray, smallWidth, smallHeight);
}

function prepareWorking(deskew: boolean) {
  if (!baseCanvas) throw new Error("No page is loaded.");

  const shouldDeskew = deskew && Math.abs(angle) > 0.01;
  if (!shouldDeskew) {
    workingCanvas = baseCanvas;
    workingDeskewed = false;
    width = baseWidth;
    height = baseHeight;
    return;
  }

  const radians = (angle * Math.PI) / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const rotatedWidth = Math.max(
    1,
    Math.ceil(baseWidth * cosine + baseHeight * sine),
  );
  const rotatedHeight = Math.max(
    1,
    Math.ceil(baseWidth * sine + baseHeight * cosine),
  );

  const canvas = new OffscreenCanvas(rotatedWidth, rotatedHeight);
  const context = context2d(canvas);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, rotatedWidth, rotatedHeight);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.translate(rotatedWidth / 2, rotatedHeight / 2);
  context.rotate(radians);
  context.drawImage(baseCanvas, -baseWidth / 2, -baseHeight / 2);

  workingCanvas = canvas;
  workingDeskewed = true;
  width = rotatedWidth;
  height = rotatedHeight;
}

/** The mask and profile are cached; only findBands reruns on a slider move. */
function computeInk() {
  if (!workingCanvas) throw new Error("No page is loaded.");

  const data = context2d(workingCanvas).getImageData(0, 0, width, height);
  const gray = rgbaToGray(data.data, width, height);
  const threshold = otsuThreshold(gray);
  mask = buildInkMask(gray, threshold);
  profile = smoothProfile(rowProfile(gray, width, height, threshold));
}

async function buildResult(
  id: number,
  params: SegParams,
  pageChanged: boolean,
): Promise<WorkerResult> {
  const boxes =
    mask && profile ? findLineBoxes(mask, width, height, profile, params) : [];

  let page: ImageBitmap | null = null;
  if (pageChanged && workingCanvas) {
    page = await createImageBitmap(workingCanvas);
  }

  return {
    id,
    type: "result",
    page,
    pageChanged,
    width,
    height,
    angle,
    boxes,
    params,
  };
}

function postResult(response: WorkerResult) {
  scope.postMessage(response, response.page ? [response.page] : []);
}

function unavailable() {
  return (
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap === "undefined"
  );
}

async function handleLoad(
  id: number,
  bitmap: ImageBitmap,
  requested: SegParams,
) {
  const params = clampSegParams(requested);

  try {
    if (unavailable()) {
      postError(
        id,
        "This browser cannot run the line detector. Try a current version of Chrome, Edge, Firefox or Safari.",
      );
      return;
    }

    if (bitmap.width <= 0 || bitmap.height <= 0) {
      postError(
        id,
        "The page image is no longer available. Reload the page to try again.",
      );
      return;
    }

    progress(id, "Flattening the page");
    const prepared = prepareBase(bitmap);
    baseCanvas = prepared.canvas;
    baseWidth = prepared.width;
    baseHeight = prepared.height;
    workingCanvas = null;
    mask = null;
    profile = null;

    progress(id, "Checking the page tilt");
    angle = estimateAngle(baseCanvas, baseWidth, baseHeight);

    progress(id, "Finding the lines");
    prepareWorking(params.deskew);
    computeInk();

    postResult(await buildResult(id, params, true));
  } catch {
    postError(
      id,
      "The page could not be prepared. Try another JPG, PNG or WebP image.",
    );
  } finally {
    bitmap.close();
  }
}

async function handleProcess(id: number, requested: SegParams) {
  const params = clampSegParams(requested);

  try {
    if (!baseCanvas || !workingCanvas) {
      postError(id, "No page is loaded. Upload a page image first.");
      return;
    }

    const previousDeskewed = workingDeskewed;
    const previousWidth = width;
    const previousHeight = height;

    prepareWorking(params.deskew);
    const pageChanged =
      previousDeskewed !== workingDeskewed ||
      previousWidth !== width ||
      previousHeight !== height;

    if (pageChanged) {
      progress(id, "Straightening the page");
      computeInk();
    }

    postResult(await buildResult(id, params, pageChanged));
  } catch {
    postError(
      id,
      "The lines could not be updated. Try changing a setting again.",
    );
  }
}

let chain: Promise<void> = Promise.resolve();

scope.onmessage = (event) => {
  const request = event.data;
  chain = chain
    .then(() =>
      request.type === "load"
        ? handleLoad(request.id, request.bitmap, request.params)
        : handleProcess(request.id, request.params),
    )
    .catch(() => {
      // Handlers report their own failures. Never log image data.
    });
};

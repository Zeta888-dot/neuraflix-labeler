import {
  MAX_UPLOAD_BYTES,
  pickImageExtension,
} from "./submit";

/**
 * DOM only. Encodes one grayscale line canvas for upload. WebP quality 0.90 is
 * the target; a browser that returns another type (Safari can return PNG when
 * asked for WebP) gets a JPEG quality 0.92 fallback. The returned type is the
 * type the browser really produced, and the extension follows it.
 */

export type EncodedLine = {
  blob: Blob;
  /** The real blob type, normally image/webp or image/jpeg. */
  type: "image/webp" | "image/jpeg";
  extension: "webp" | "jpg";
  width: number;
  height: number;
  bytes: number;
};

function toBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(resolve, type, quality);
    } catch {
      resolve(null);
    }
  });
}

export async function encodeLine(canvas: HTMLCanvasElement): Promise<EncodedLine> {
  if (canvas.width < 1 || canvas.height < 1) {
    throw new Error("This line has no image to upload. Reload the page to try again.");
  }

  let blob = await toBlob(canvas, "image/webp", 0.9);
  if (!blob || blob.type !== "image/webp") {
    blob = await toBlob(canvas, "image/jpeg", 0.92);
  }

  if (!blob || blob.size < 1) {
    throw new Error(
      "This line could not be encoded for upload. Try another browser, or reload the page.",
    );
  }

  const type = blob.type === "image/webp" ? "image/webp" : "image/jpeg";
  if (blob.type !== "image/webp" && blob.type !== "image/jpeg") {
    throw new Error(
      "This browser produced an image type that cannot be uploaded. Try another browser.",
    );
  }

  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      "One line is larger than 2 MB after encoding. Split the line or use a smaller page image.",
    );
  }

  return {
    blob,
    type,
    extension: pickImageExtension(type),
    width: canvas.width,
    height: canvas.height,
    bytes: blob.size,
  };
}

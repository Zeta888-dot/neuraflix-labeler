import { rgbaToGray, type LineBox } from "./segment-core";

export type CropPage = ImageBitmap | HTMLCanvasElement;

/**
 * One line as a new canvas at the working page resolution, grayscale on a
 * white background. No UI or object URLs here; L4c encodes the result as
 * WebP straight from this canvas, and the labeling view scales it for display.
 */
export function cropToCanvas(page: CropPage, box: LineBox): HTMLCanvasElement {
  const sourceWidth = page.width;
  const sourceHeight = page.height;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error(
      "The page image is no longer available. Reload the page to try again.",
    );
  }

  const left = Math.max(0, Math.min(sourceWidth - 1, Math.floor(box[0])));
  const top = Math.max(0, Math.min(sourceHeight - 1, Math.floor(box[1])));
  const right = Math.max(
    left + 1,
    Math.min(sourceWidth, Math.ceil(box[2])),
  );
  const bottom = Math.max(
    top + 1,
    Math.min(sourceHeight, Math.ceil(box[3])),
  );
  const width = right - left;
  const height = bottom - top;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas 2D is not available in this browser.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(page, left, top, width, height, 0, 0, width, height);

  const image = context.getImageData(0, 0, width, height);
  const gray = rgbaToGray(image.data, width, height);

  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const value = gray[i];
    image.data[p] = value;
    image.data[p + 1] = value;
    image.data[p + 2] = value;
    image.data[p + 3] = 255;
  }

  context.putImageData(image, 0, 0);
  return canvas;
}

import {
  buildInkMask,
  inkExtent,
  otsuThreshold,
  rgbaToGray,
} from "./segment-core";

export type HorizontalExtent = { x0: number; x1: number };

/**
 * Ink extent for one horizontal band of the working page, with padding
 * clamped to the page. Used by split and merge so both parts are re-trimmed
 * to the ink. Returns null when the band has no ink at all.
 */
export function trimHorizontally(
  bitmap: ImageBitmap,
  y0: number,
  y1: number,
  pad: number,
): HorizontalExtent | null {
  const width = bitmap.width;
  const height = bitmap.height;
  if (width <= 0 || height <= 0) return null;
  const top = Math.max(0, Math.floor(y0));
  const bottom = Math.min(height, Math.ceil(y1));
  const bandHeight = bottom - top;
  if (width <= 0 || bandHeight <= 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = bandHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, bandHeight);
  context.drawImage(bitmap, 0, top, width, bandHeight, 0, 0, width, bandHeight);

  const data = context.getImageData(0, 0, width, bandHeight);
  const gray = rgbaToGray(data.data, width, bandHeight);
  const threshold = otsuThreshold(gray);
  const mask = buildInkMask(gray, threshold);
  const extent = inkExtent(mask, width, bandHeight, {
    y0: 0,
    y1: bandHeight,
  });
  if (!extent) return null;

  return {
    x0: Math.max(0, extent.minX - pad),
    x1: Math.min(width, extent.maxX + 1 + pad),
  };
}

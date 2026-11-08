import { rgbaToGray } from "./segment-core";
import {
  MAX_STRAIGHTEN_EDGE,
  applyHomography,
  clampRotation,
  computeHomography,
  detectPageQuad,
  insetQuad,
  invertHomography,
  isQuadValid,
  outputSizeForQuad,
  suggestDeskewAngle,
  type Quad,
  type StraightenSettings,
} from "./straighten";

/**
 * Browser-side straighten helpers. They draw the source into a working canvas,
 * run the pure geometry, and produce a new bitmap. Nothing here uploads or
 * stores the page.
 */

const ANALYSIS_EDGE = 520;
const WARP_SOURCE_EDGE = 5000;
const DESKEW_EDGE = 460;

export type StraightenSource = {
  bitmap: ImageBitmap;
  width: number;
  height: number;
};

export class StraightenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StraightenError";
  }
}

export function straightenErrorMessage(
  error: unknown,
  fallback: string,
): string {
  return error instanceof StraightenError ? error.message : fallback;
}

function context2d(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new StraightenError(
      "This browser cannot redraw the page. Try a current version of Chrome, Edge, Firefox or Safari.",
    );
  }
  return context;
}

function scaledSize(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number; scale: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

function drawScaled(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxEdge: number,
): { canvas: HTMLCanvasElement; width: number; height: number; scale: number } {
  const size = scaledSize(sourceWidth, sourceHeight, maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;

  const context = context2d(canvas);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(source, 0, 0, size.width, size.height);

  return { canvas, ...size };
}

function grayFromCanvas(canvas: HTMLCanvasElement): Uint8Array {
  const context = context2d(canvas);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  return rgbaToGray(data.data, canvas.width, canvas.height);
}

/**
 * Detect the page quad and a starting deskew angle. The deskew scan runs on
 * the page after the quad has been mapped to a rectangle, so it measures the
 * remaining text tilt rather than the page edge tilt.
 */
export function analyzePage(bitmap: ImageBitmap): {
  quad: Quad;
  rotation: number;
} {
  const small = drawScaled(bitmap, bitmap.width, bitmap.height, ANALYSIS_EDGE);
  const gray = grayFromCanvas(small.canvas);
  const smallQuad = detectPageQuad(gray, small.width, small.height);

  const scaleX = bitmap.width / small.width;
  const scaleY = bitmap.height / small.height;
  const quad: Quad = smallQuad.map((point) => ({
    x: point.x * scaleX,
    y: point.y * scaleY,
  })) as Quad;

  let rotation = 0;
  try {
    const deskewSize = outputSizeForQuad(smallQuad, DESKEW_EDGE);
    const deskewed = warpCanvas(
      small.canvas,
      small.width,
      small.height,
      smallQuad,
      deskewSize.width,
      deskewSize.height,
      0,
    );
    rotation = suggestDeskewAngle(
      grayFromCanvas(deskewed),
      deskewed.width,
      deskewed.height,
    );
  } catch {
    // Corner detection still works; the slider starts at zero.
  }

  return { quad, rotation };
}

function samplePixel(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  channel: number,
): number {
  const x0 = Math.max(0, Math.min(width - 2, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 2, Math.floor(y)));
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));

  const top =
    data[(y0 * width + x0) * 4 + channel] * (1 - fx) +
    data[(y0 * width + x1) * 4 + channel] * fx;
  const bottom =
    data[(y1 * width + x0) * 4 + channel] * (1 - fx) +
    data[(y1 * width + x1) * 4 + channel] * fx;

  return Math.round(top * (1 - fy) + bottom * fy);
}

/**
 * Map the chosen quad to a rectangle with a bilinear inverse warp. The manual
 * rotation turns the output around its centre after the perspective mapping.
 */
export function warpCanvas(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  quad: Quad,
  outWidth: number,
  outHeight: number,
  rotation: number,
): HTMLCanvasElement {
  if (!isQuadValid(quad, sourceWidth, sourceHeight)) {
    throw new StraightenError(
      "The four corners must form a page shape. Drag them again.",
    );
  }

  const work = drawScaled(source, sourceWidth, sourceHeight, WARP_SOURCE_EDGE);
  const workQuad: Quad = quad.map((point) => ({
    x: point.x * work.scale,
    y: point.y * work.scale,
  })) as Quad;

  const matrix = computeHomography(workQuad, outWidth, outHeight);
  const inverse = matrix ? invertHomography(matrix) : null;
  if (!inverse) {
    throw new StraightenError(
      "The page corners could not be mapped. Move them slightly and try again.",
    );
  }

  const workContext = context2d(work.canvas);
  const sourceData = workContext.getImageData(
    0,
    0,
    work.width,
    work.height,
  ).data;

  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.round(outWidth));
  output.height = Math.max(1, Math.round(outHeight));
  const outputContext = context2d(output);
  const image = outputContext.createImageData(output.width, output.height);
  const data = image.data;

  const radians = (clampRotation(rotation) * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = output.width / 2;
  const centerY = output.height / 2;

  for (let y = 0; y < output.height; y++) {
    const dy = y + 0.5 - centerY;
    for (let x = 0; x < output.width; x++) {
      const dx = x + 0.5 - centerX;
      const rotatedX = dx * cosine + dy * sine + centerX;
      const rotatedY = -dx * sine + dy * cosine + centerY;
      const sourcePoint = applyHomography(inverse, rotatedX, rotatedY);

      const offset = (y * output.width + x) * 4;
      if (
        !sourcePoint ||
        sourcePoint.x < 0 ||
        sourcePoint.y < 0 ||
        sourcePoint.x > work.width - 1 ||
        sourcePoint.y > work.height - 1
      ) {
        data[offset] = 255;
        data[offset + 1] = 255;
        data[offset + 2] = 255;
        data[offset + 3] = 255;
        continue;
      }

      data[offset] = samplePixel(
        sourceData,
        work.width,
        work.height,
        sourcePoint.x,
        sourcePoint.y,
        0,
      );
      data[offset + 1] = samplePixel(
        sourceData,
        work.width,
        work.height,
        sourcePoint.x,
        sourcePoint.y,
        1,
      );
      data[offset + 2] = samplePixel(
        sourceData,
        work.width,
        work.height,
        sourcePoint.x,
        sourcePoint.y,
        2,
      );
      data[offset + 3] = 255;
    }
  }

  outputContext.putImageData(image, 0, 0);
  return output;
}

/** Produce a new working bitmap from the source and its straighten settings. */
export async function createStraightenedBitmap(
  bitmap: ImageBitmap,
  settings: StraightenSettings,
): Promise<ImageBitmap> {
  const size = outputSizeForQuad(settings.corners, MAX_STRAIGHTEN_EDGE);
  const canvas = warpCanvas(
    bitmap,
    bitmap.width,
    bitmap.height,
    settings.corners,
    size.width,
    size.height,
    settings.rotation,
  );

  try {
    return await createImageBitmap(canvas);
  } catch {
    throw new StraightenError(
      "The straightened page could not be prepared. Try again, or skip straightening.",
    );
  }
}

/** The fallback corners shown before detection finishes or after a reset. */
export function defaultStraightenQuad(width: number, height: number): Quad {
  return insetQuad(width, height);
}

import { estimateSkewAngle } from "./segment-core";

/**
 * Pure straighten geometry. No DOM and no canvas here, so the same functions
 * run in Node tests and in the browser. The original page image never leaves
 * the browser; this only decides how to redraw it as a working copy.
 */

export type Point = { x: number; y: number };

/** Clockwise order: top left, top right, bottom right, bottom left. */
export type Quad = [Point, Point, Point, Point];

export type StraightenSettings = {
  /** Corner points in source image pixels. */
  corners: Quad;
  /** Clockwise canvas rotation in degrees, clamped to the manual range. */
  rotation: number;
};

/** Longest side of the straightened working copy. */
export const MAX_STRAIGHTEN_EDGE = 3000;
export const MIN_ROTATION = -8;
export const MAX_ROTATION = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampRotation(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = clamp(value, MIN_ROTATION, MAX_ROTATION);
  return Math.round(clamped * 10) / 10;
}

export function clampPoint(
  point: Point,
  width: number,
  height: number,
): Point {
  return {
    x: clamp(point.x, 0, Math.max(0, width)),
    y: clamp(point.y, 0, Math.max(0, height)),
  };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function insetQuad(
  width: number,
  height: number,
  insetFraction = 0.015,
): Quad {
  const inset = Math.max(
    2,
    Math.round(Math.min(width, height) * insetFraction),
  );
  const left = Math.min(inset, width / 2);
  const top = Math.min(inset, height / 2);
  const right = Math.max(left, width - inset);
  const bottom = Math.max(top, height - inset);

  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Shoelace area, always positive. */
export function quadArea(quad: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** True when the four points are finite, convex and all on one winding. */
export function isQuadConvex(quad: Quad): boolean {
  if (
    quad.some(
      (point) => !Number.isFinite(point.x) || !Number.isFinite(point.y),
    )
  ) {
    return false;
  }

  const signs = [
    cross(quad[0], quad[1], quad[2]),
    cross(quad[1], quad[2], quad[3]),
    cross(quad[2], quad[3], quad[0]),
    cross(quad[3], quad[0], quad[1]),
  ];

  return signs.every((value) => value > 0) || signs.every((value) => value < 0);
}

export function isQuadValid(
  quad: Quad,
  width: number,
  height: number,
): boolean {
  if (width < 2 || height < 2) return false;
  if (!isQuadConvex(quad)) return false;
  if (!quad.every((point) => point.x >= 0 && point.x <= width)) return false;
  if (!quad.every((point) => point.y >= 0 && point.y <= height)) return false;

  const area = quadArea(quad);
  if (area < width * height * 0.01) return false;
  if (area > width * height * 0.995) return false;

  return (
    distance(quad[0], quad[1]) >= 4 &&
    distance(quad[1], quad[2]) >= 4 &&
    distance(quad[2], quad[3]) >= 4 &&
    distance(quad[3], quad[0]) >= 4
  );
}

function pointInQuad(point: Point, quad: Quad): boolean {
  const signs = [
    cross(quad[0], quad[1], point),
    cross(quad[1], quad[2], point),
    cross(quad[2], quad[3], point),
    cross(quad[3], quad[0], point),
  ];
  return signs.every((value) => value >= 0) || signs.every((value) => value <= 0);
}

function borderMedian(
  gray: Uint8Array,
  width: number,
  height: number,
): number {
  const histogram = new Uint32Array(256);
  const border = Math.max(1, Math.round(Math.min(width, height) * 0.01));

  const add = (x: number, y: number) => {
    histogram[gray[y * width + x]]++;
  };

  for (let y = 0; y < border; y++) {
    for (let x = 0; x < width; x++) {
      add(x, y);
      add(x, height - 1 - y);
    }
  }
  for (let x = 0; x < border; x++) {
    for (let y = 0; y < height; y++) {
      add(x, y);
      add(width - 1 - x, y);
    }
  }

  let total = 0;
  for (let value = 0; value < 256; value++) total += histogram[value];

  let seen = 0;
  for (let value = 0; value < 256; value++) {
    seen += histogram[value];
    if (seen >= total / 2) return value;
  }
  return 255;
}

/**
 * Lightweight page-corner detection for a grayscale page. It looks for the
 * dominant region that differs from the border colour, rejects sparse text
 * masks, and falls back to a small inset when the result is not confident.
 */
export function detectPageQuad(
  gray: Uint8Array,
  width: number,
  height: number,
): Quad {
  const fallback = insetQuad(width, height);
  if (width < 8 || height < 8 || gray.length < width * height) return fallback;

  const background = borderMedian(gray, width, height);
  const threshold = 26;
  const mask = new Uint8Array(width * height);
  let foreground = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const offset = y * width + x;
      if (Math.abs(gray[offset] - background) <= threshold) continue;

      let support = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const value = gray[(y + dy) * width + x + dx];
          if (Math.abs(value - background) > threshold) support++;
        }
      }
      if (support < 3) continue;

      mask[offset] = 1;
      foreground++;
    }
  }

  const total = width * height;
  const ratio = foreground / total;
  if (ratio < 0.04 || ratio > 0.9) return fallback;

  let topLeft = { x: width, y: height };
  let topRight = { x: 0, y: height };
  let bottomRight = { x: 0, y: 0 };
  let bottomLeft = { x: width, y: 0 };
  let topLeftScore = Number.POSITIVE_INFINITY;
  let topRightScore = Number.NEGATIVE_INFINITY;
  let bottomRightScore = Number.NEGATIVE_INFINITY;
  let bottomLeftScore = Number.POSITIVE_INFINITY;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (!mask[y * width + x]) continue;

      if (x + y < topLeftScore) {
        topLeftScore = x + y;
        topLeft = { x, y };
      }
      if (x - y > topRightScore) {
        topRightScore = x - y;
        topRight = { x, y };
      }
      if (x + y > bottomRightScore) {
        bottomRightScore = x + y;
        bottomRight = { x, y };
      }
      if (x - y < bottomLeftScore) {
        bottomLeftScore = x - y;
        bottomLeft = { x, y };
      }
    }
  }

  const quad: Quad = [topLeft, topRight, bottomRight, bottomLeft];
  if (!isQuadConvex(quad)) return fallback;

  const area = quadArea(quad);
  if (area < total * 0.2 || area > total * 0.95) return fallback;

  const top = distance(quad[0], quad[1]);
  const right = distance(quad[1], quad[2]);
  const bottom = distance(quad[2], quad[3]);
  const left = distance(quad[3], quad[0]);
  if (
    top < width * 0.25 ||
    bottom < width * 0.25 ||
    left < height * 0.25 ||
    right < height * 0.25
  ) {
    return fallback;
  }

  // A sparse text block is not a page. A real page fills most of its quad.
  let inside = 0;
  const leftEdge = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.x))));
  const topEdge = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.y))));
  const rightEdge = Math.min(width - 1, Math.ceil(Math.max(...quad.map((p) => p.x))));
  const bottomEdge = Math.min(height - 1, Math.ceil(Math.max(...quad.map((p) => p.y))));

  for (let y = topEdge; y <= bottomEdge; y++) {
    for (let x = leftEdge; x <= rightEdge; x++) {
      if (mask[y * width + x] && pointInQuad({ x, y }, quad)) inside++;
    }
  }
  if (inside < area * 0.5) return fallback;

  return quad;
}

/**
 * Clockwise canvas rotation that levels the text. The projection scan lives in
 * segment-core; this wrapper drops tiny noise and clamps to the manual range.
 */
export function suggestDeskewAngle(
  gray: Uint8Array,
  width: number,
  height: number,
): number {
  const angle = estimateSkewAngle(gray, width, height);
  if (!Number.isFinite(angle) || Math.abs(angle) < 0.3) return 0;
  return clampRotation(angle);
}

export type OutputSize = {
  width: number;
  height: number;
  scale: number;
};

/** Rectangular output size for a quad, capped on its longest side. */
export function outputSizeForQuad(
  quad: Quad,
  maxEdge = MAX_STRAIGHTEN_EDGE,
): OutputSize {
  const top = distance(quad[0], quad[1]);
  const right = distance(quad[1], quad[2]);
  const bottom = distance(quad[2], quad[3]);
  const left = distance(quad[3], quad[0]);

  const width = Math.max(1, Math.round(Math.max(top, bottom)));
  const height = Math.max(1, Math.round(Math.max(left, right)));
  const scale = Math.min(1, maxEdge / Math.max(width, height));

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

/**
 * Homography that maps the four source corners to the rectangle
 * (0,0), (width,0), (width,height), (0,height). Returns row-major 3x3.
 */
export function computeHomography(
  source: Quad,
  width: number,
  height: number,
): number[] | null {
  const destination: Quad = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];

  const rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = source[i];
    const { x: u, y: v } = destination[i];

    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }

  // Gaussian elimination with partial pivoting on the 8x8 system.
  for (let column = 0; column < 8; column++) {
    let pivot = column;
    for (let row = column + 1; row < 8; row++) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(rows[pivot][column]) < 1e-12) return null;

    if (pivot !== column) {
      const temp = rows[column];
      rows[column] = rows[pivot];
      rows[pivot] = temp;
    }

    const divisor = rows[column][column];
    for (let i = column; i <= 8; i++) rows[column][i] /= divisor;

    for (let row = 0; row < 8; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      if (factor === 0) continue;
      for (let i = column; i <= 8; i++) {
        rows[row][i] -= factor * rows[column][i];
      }
    }
  }

  const solution = rows.map((row) => row[8]);
  if (!solution.every((value) => Number.isFinite(value))) return null;

  return [
    solution[0],
    solution[1],
    solution[2],
    solution[3],
    solution[4],
    solution[5],
    solution[6],
    solution[7],
    1,
  ];
}

/** Inverse of a row-major 3x3 matrix. */
export function invertHomography(matrix: number[]): number[] | null {
  if (matrix.length !== 9) return null;

  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant =
    a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    return null;
  }

  const scale = 1 / determinant;
  const inverse = [
    (e * i - f * h) * scale,
    (c * h - b * i) * scale,
    (b * f - c * e) * scale,
    (f * g - d * i) * scale,
    (a * i - c * g) * scale,
    (c * d - a * f) * scale,
    (d * h - e * g) * scale,
    (b * g - a * h) * scale,
    (a * e - b * d) * scale,
  ];

  return inverse.every((value) => Number.isFinite(value)) ? inverse : null;
}

export function applyHomography(
  matrix: number[],
  x: number,
  y: number,
): Point | null {
  const divisor = matrix[6] * x + matrix[7] * y + matrix[8];
  if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-12) return null;

  return {
    x: (matrix[0] * x + matrix[1] * y + matrix[2]) / divisor,
    y: (matrix[3] * x + matrix[4] * y + matrix[5]) / divisor,
  };
}

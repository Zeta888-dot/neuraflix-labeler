/* Pure segmentation math, ported from reference/PORTING.md section 3.
   No DOM and no canvas here so the same functions run in Node, in a Worker
   and in the browser. */

export type SegParams = {
  deskew: boolean;
  /** Fraction of the tallest row profile. Lower means more sensitive. */
  sensitivity: number;
  /** Drop bands shorter than this many pixels. */
  minHeight: number;
  /** Merge bands whose gap is at most this many pixels. */
  mergeGap: number;
  /** Padding around each line box. */
  pad: number;
};

export type LineBox = [x0: number, y0: number, x1: number, y1: number];
export type Band = { y0: number; y1: number };

export const DEFAULT_PARAMS: SegParams = {
  deskew: true,
  sensitivity: 0.02,
  minHeight: 18,
  mergeGap: 6,
  pad: 6,
};

/** Slider ranges from PORTING.md section 3. */
export const PARAM_RANGES = {
  sensitivity: { min: 0.005, max: 0.15, step: 0.005 },
  minHeight: { min: 5, max: 80, step: 1 },
  mergeGap: { min: 0, max: 40, step: 1 },
  pad: { min: 0, max: 30, step: 1 },
} as const;

/** Wider server clamps listed in PORTING.md section 3. */
export const SERVER_CLAMPS = {
  sensitivity: { min: 0.001, max: 0.3 },
  minHeight: { min: 1, max: 200 },
  mergeGap: { min: 0, max: 100 },
  pad: { min: 0, max: 60 },
} as const;

function clampNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Clamp user or URL supplied values to the wider server ranges. */
export function clampSegParams(
  params: Partial<SegParams> | undefined,
): SegParams {
  return {
    deskew:
      typeof params?.deskew === "boolean"
        ? params.deskew
        : DEFAULT_PARAMS.deskew,
    sensitivity: clampNumber(
      params?.sensitivity,
      DEFAULT_PARAMS.sensitivity,
      SERVER_CLAMPS.sensitivity.min,
      SERVER_CLAMPS.sensitivity.max,
    ),
    minHeight: clampNumber(
      params?.minHeight,
      DEFAULT_PARAMS.minHeight,
      SERVER_CLAMPS.minHeight.min,
      SERVER_CLAMPS.minHeight.max,
    ),
    mergeGap: clampNumber(
      params?.mergeGap,
      DEFAULT_PARAMS.mergeGap,
      SERVER_CLAMPS.mergeGap.min,
      SERVER_CLAMPS.mergeGap.max,
    ),
    pad: clampNumber(
      params?.pad,
      DEFAULT_PARAMS.pad,
      SERVER_CLAMPS.pad.min,
      SERVER_CLAMPS.pad.max,
    ),
  };
}

/**
 * Rec.709 luma from an RGBA buffer. Alpha is composited over white, matching
 * the worker's white canvas fill. Extra or missing bytes are treated as white.
 */
export function rgbaToGray(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const count = width * height;
  const gray = new Uint8Array(count);
  const available = Math.min(rgba.length, count * 4);

  for (let i = 0, p = 0; i < count; i++, p += 4) {
    if (p + 3 >= available) {
      gray[i] = 255;
      continue;
    }

    const alpha = rgba[p + 3];
    const luma =
      0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2];
    const composited =
      alpha === 255 ? luma : (luma * alpha + 255 * (255 - alpha)) / 255;
    gray[i] = Math.round(composited);
  }

  return gray;
}

/** Otsu threshold from the 256-bin histogram. */
export function otsuThreshold(gray: ArrayLike<number>): number {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) histogram[gray[i]]++;

  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];

  let sumB = 0;
  let weightB = 0;
  let max = -1;
  let threshold = 127;

  for (let t = 0; t < 256; t++) {
    weightB += histogram[t];
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;

    sumB += t * histogram[t];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const between =
      weightB * weightF * (meanB - meanF) * (meanB - meanF);

    if (between > max) {
      max = between;
      threshold = t;
    }
  }

  return threshold;
}

/** 1 for ink, 0 for paper. One byte per pixel; never coordinate arrays. */
export function buildInkMask(
  gray: ArrayLike<number>,
  threshold: number,
): Uint8Array {
  const mask = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    mask[i] = gray[i] <= threshold ? 1 : 0;
  }
  return mask;
}

/**
 * Nearest-neighbour downscale for skew estimation. The worker draws a 900 px
 * wide canvas instead, for better smoothing; this helper keeps the core
 * self-contained for Node.
 */
export function resizeGrayToWidth(
  gray: Uint8Array,
  width: number,
  height: number,
  maxWidth = 900,
): { gray: Uint8Array; width: number; height: number } {
  if (width <= maxWidth || width <= 0 || height <= 0) {
    return { gray, width, height };
  }

  const outWidth = Math.max(1, Math.round(maxWidth));
  const outHeight = Math.max(1, Math.round((height * outWidth) / width));
  const out = new Uint8Array(outWidth * outHeight);

  for (let y = 0; y < outHeight; y++) {
    const sourceY = Math.min(
      height - 1,
      Math.floor(((y + 0.5) * height) / outHeight),
    );
    const sourceRow = sourceY * width;
    const outRow = y * outWidth;
    for (let x = 0; x < outWidth; x++) {
      const sourceX = Math.min(
        width - 1,
        Math.floor(((x + 0.5) * width) / outWidth),
      );
      out[outRow + x] = gray[sourceRow + sourceX];
    }
  }

  return { gray: out, width: outWidth, height: outHeight };
}

/**
 * Clockwise canvas rotation (degrees) that levels the ink, from a grayscale
 * page about 900 px wide. PORTING.md section 3: Otsu, stride sampling, 25
 * candidate angles from -3 to +3 in 0.25 steps, and the smallest variance of
 * the shifted row positions wins. Fewer than 100 samples gives angle 0.
 */
export function estimateSkewAngle(
  gray: Uint8Array,
  width: number,
  height: number,
): number {
  if (width < 2 || height < 2) return 0;

  const threshold = otsuThreshold(gray);
  const mask = buildInkMask(gray, threshold);
  const step = Math.max(1, Math.floor((width * height) / 400000));

  let inkCount = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) inkCount++;
  }

  const sampleCount = Math.ceil(inkCount / step);
  if (sampleCount < 100) return 0;

  const samples = new Int32Array(sampleCount);
  let inkSeen = 0;
  let sampleIndex = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    if (inkSeen % step === 0) samples[sampleIndex++] = i;
    inkSeen++;
  }

  const rows = new Uint32Array(height);
  const centerX = width / 2;
  let bestAngle = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let candidate = 0; candidate < 25; candidate++) {
    const angle = -3 + candidate * 0.25;
    const tangent = Math.tan((angle * Math.PI) / 180);
    rows.fill(0);

    for (let k = 0; k < sampleIndex; k++) {
      const offset = samples[k];
      const x = offset % width;
      const y = (offset - x) / width;
      const yy = Math.round(y + (x - centerX) * tangent);
      if (yy >= 0 && yy < height) rows[yy]++;
    }

    let count = 0;
    let sum = 0;
    let sumSquares = 0;
    for (let y = 0; y < height; y++) {
      const rowCount = rows[y];
      if (rowCount === 0) continue;
      count += rowCount;
      sum += rowCount * y;
      sumSquares += rowCount * y * y;
    }
    if (count === 0) continue;

    const mean = sum / count;
    const score = sumSquares / count - mean * mean;
    if (
      score < bestScore ||
      (score === bestScore && Math.abs(angle) < Math.abs(bestAngle))
    ) {
      bestScore = score;
      bestAngle = angle;
    }
  }

  return bestAngle;
}

/** Ink pixels per row. */
export function rowProfile(
  gray: ArrayLike<number>,
  width: number,
  height: number,
  threshold: number,
): Float64Array {
  const profile = new Float64Array(height);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x < width; x++) {
      if (gray[row + x] <= threshold) count++;
    }
    profile[y] = count;
  }

  return profile;
}

/** Three-row moving average; edge rows clamp to themselves. */
export function smoothProfile(profile: ArrayLike<number>): Float64Array {
  const height = profile.length;
  const smoothed = new Float64Array(height);

  for (let y = 0; y < height; y++) {
    const previous = y > 0 ? profile[y - 1] : profile[y];
    const next = y + 1 < height ? profile[y + 1] : profile[y];
    smoothed[y] = (previous + profile[y] + next) / 3;
  }

  return smoothed;
}

/**
 * Bands from a smoothed row profile. Runs where the profile is above
 * sensitivity * max, merged when the gap is at most mergeGap, then bands
 * shorter than minHeight are dropped.
 */
export function findBands(
  profile: ArrayLike<number>,
  params: Pick<SegParams, "sensitivity" | "minHeight" | "mergeGap">,
): Band[] {
  const height = profile.length;
  if (height === 0) return [];

  let max = 0;
  for (let y = 0; y < height; y++) {
    if (profile[y] > max) max = profile[y];
  }
  if (max <= 0) return [];

  const sensitivity = clampNumber(
    params.sensitivity,
    DEFAULT_PARAMS.sensitivity,
    SERVER_CLAMPS.sensitivity.min,
    SERVER_CLAMPS.sensitivity.max,
  );
  const minHeight = clampNumber(
    params.minHeight,
    DEFAULT_PARAMS.minHeight,
    SERVER_CLAMPS.minHeight.min,
    SERVER_CLAMPS.minHeight.max,
  );
  const mergeGap = clampNumber(
    params.mergeGap,
    DEFAULT_PARAMS.mergeGap,
    SERVER_CLAMPS.mergeGap.min,
    SERVER_CLAMPS.mergeGap.max,
  );
  const cut = sensitivity * max;
  const merged: Band[] = [];
  let start = -1;

  function closeRun(end: number) {
    if (start < 0) return;
    const last = merged[merged.length - 1];
    if (last && start - last.y1 <= mergeGap) {
      last.y1 = end;
    } else {
      merged.push({ y0: start, y1: end });
    }
    start = -1;
  }

  for (let y = 0; y < height; y++) {
    const on = profile[y] > cut;
    if (on && start < 0) {
      start = y;
    } else if (!on) {
      closeRun(y);
    }
  }
  closeRun(height);

  return merged.filter((band) => band.y1 - band.y0 >= minHeight);
}

/** Horizontal ink extent inside one band, or null when the band is empty. */
export function inkExtent(
  mask: Uint8Array,
  width: number,
  height: number,
  band: Band,
): { minX: number; maxX: number } | null {
  const y0 = Math.max(0, Math.floor(band.y0));
  const y1 = Math.min(height, Math.ceil(band.y1));
  let minX = width;
  let maxX = -1;

  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }

  return maxX < 0 ? null : { minX, maxX };
}

/** Bands plus horizontal ink extents, clamped to the page, in reading order. */
export function findLineBoxes(
  mask: Uint8Array,
  width: number,
  height: number,
  profile: ArrayLike<number>,
  params: SegParams,
): LineBox[] {
  const clamped = clampSegParams(params);
  const boxes: LineBox[] = [];

  for (const band of findBands(profile, clamped)) {
    const extent = inkExtent(mask, width, height, band);
    if (!extent) continue;

    boxes.push([
      Math.max(0, extent.minX - clamped.pad),
      Math.max(0, band.y0 - clamped.pad),
      Math.min(width, extent.maxX + 1 + clamped.pad),
      Math.min(height, band.y1 + clamped.pad),
    ]);
  }

  return boxes;
}

export function segParamsEqual(a: SegParams, b: SegParams): boolean {
  return (
    a.deskew === b.deskew &&
    a.sensitivity === b.sensitivity &&
    a.minHeight === b.minHeight &&
    a.mergeGap === b.mergeGap &&
    a.pad === b.pad
  );
}

export function lineBoxesEqual(a: LineBox[], b: LineBox[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    for (let k = 0; k < 4; k++) {
      if (a[i][k] !== b[i][k]) return false;
    }
  }
  return true;
}

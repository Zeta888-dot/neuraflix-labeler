import sharp from "sharp";

export type SegParams = {
  deskew: boolean;
  sensitivity: number; // fraction of max row ink; lower = more sensitive
  minHeight: number; // px, drop lines shorter than this
  mergeGap: number; // px, merge runs closer than this (dots/diacritics)
  pad: number; // px padding around each crop
};

export const DEFAULT_PARAMS: SegParams = {
  deskew: true,
  sensitivity: 0.02,
  minHeight: 18,
  mergeGap: 6,
  pad: 6,
};

export type LineBox = [number, number, number, number]; // x0,y0,x1,y1

export type SegResult = {
  angle: number;
  boxes: LineBox[];
  lines: Buffer[]; // JPEG crops, same order as boxes
  overlay: Buffer; // JPEG page with numbered boxes
  page: Buffer; // deskewed page PNG
};

type Gray = { data: Buffer; w: number; h: number };

async function toGray(input: Buffer): Promise<Gray> {
  const { data, info } = await sharp(input)
    .grayscale()
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

function otsu(data: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  const total = data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0,
    wB = 0,
    max = -1,
    thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) {
      max = between;
      thr = t;
    }
  }
  return thr;
}

// Returns clockwise rotation (degrees) that levels the text lines.
async function estimateSkew(oriented: Buffer): Promise<number> {
  const small = await toGray(
    await sharp(oriented).resize({ width: 900, withoutEnlargement: true }).toBuffer()
  );
  const { data, w, h } = small;
  const thr = otsu(data);
  const xs: number[] = [];
  const ys: number[] = [];
  const step = Math.max(1, Math.floor((w * h) / 400000));
  let c = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] <= thr && c++ % step === 0) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (xs.length < 100) return 0;
  const cx = w / 2;
  const rows = new Float64Array(h);
  let bestA = 0,
    bestScore = -1;
  for (let a = -3; a <= 3.0001; a += 0.25) {
    const tan = Math.tan((a * Math.PI) / 180);
    rows.fill(0);
    for (let k = 0; k < xs.length; k++) {
      const yy = Math.round(ys[k] + (xs[k] - cx) * tan);
      if (yy >= 0 && yy < h) rows[yy]++;
    }
    let s = 0,
      s2 = 0;
    for (let y = 0; y < h; y++) {
      s += rows[y];
      s2 += rows[y] * rows[y];
    }
    const score = s2 / h - (s / h) * (s / h);
    if (score > bestScore) {
      bestScore = score;
      bestA = a;
    }
  }
  return bestA;
}

export async function segmentPage(input: Buffer, p: SegParams): Promise<SegResult> {
  // 1) normalise orientation / alpha
  const oriented = await sharp(input)
    .rotate() // EXIF auto-orient
    .flatten({ background: "#ffffff" })
    .png({ compressionLevel: 1 })
    .toBuffer();

  // 2) deskew
  const angle = p.deskew ? await estimateSkew(oriented) : 0;
  const page =
    Math.abs(angle) > 0.01
      ? await sharp(oriented)
          .rotate(angle, { background: "#ffffff" })
          .png({ compressionLevel: 1 })
          .toBuffer()
      : oriented;

  // 3) binarize + row profile
  const { data, w, h } = await toGray(page);
  const thr = otsu(data);
  const prof = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let cnt = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) if (data[row + x] <= thr) cnt++;
    prof[y] = cnt;
  }
  const sm = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    sm[y] = ((prof[y - 1] ?? prof[y]) + prof[y] + (prof[y + 1] ?? prof[y])) / 3;
  }
  let maxP = 0;
  for (let y = 0; y < h; y++) if (sm[y] > maxP) maxP = sm[y];

  const boxes: LineBox[] = [];
  if (maxP > 0) {
    const cut = p.sensitivity * maxP;
    const runs: [number, number][] = [];
    let start = -1;
    for (let y = 0; y < h; y++) {
      const on = sm[y] > cut;
      if (on && start < 0) start = y;
      else if (!on && start >= 0) {
        runs.push([start, y]);
        start = -1;
      }
    }
    if (start >= 0) runs.push([start, h]);

    const merged: [number, number][] = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && r[0] - last[1] <= p.mergeGap) last[1] = r[1];
      else merged.push([r[0], r[1]]);
    }

    for (const [y0, y1] of merged) {
      if (y1 - y0 < p.minHeight) continue;
      let minX = w,
        maxX = -1;
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          if (data[row + x] <= thr) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
      }
      if (maxX < 0) continue;
      boxes.push([
        Math.max(0, minX - p.pad),
        Math.max(0, y0 - p.pad),
        Math.min(w, maxX + 1 + p.pad),
        Math.min(h, y1 + p.pad),
      ]);
    }
  }

  // 4) crops
  const lines: Buffer[] = [];
  for (const [x0, y0, x1, y1] of boxes) {
    lines.push(
      await sharp(page)
        .grayscale()
        .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
        .jpeg({ quality: 95 })
        .toBuffer()
    );
  }

  // 5) overlay for visual check
  const sw = Math.min(w, 1000);
  const s = sw / w;
  const base = await sharp(page).resize({ width: sw }).png().toBuffer();
  const sh = Math.round(h * s);
  const rects = boxes
    .map(([x0, y0, x1, y1], i) => {
      const rx = Math.round(x0 * s),
        ry = Math.round(y0 * s);
      return `<rect x="${rx}" y="${ry}" width="${Math.round((x1 - x0) * s)}" height="${Math.round(
        (y1 - y0) * s
      )}" fill="none" stroke="red" stroke-width="2"/><text x="${Math.max(
        2,
        rx - 2
      )}" y="${ry + 16}" font-size="16" font-family="sans-serif" font-weight="bold" fill="blue">${
        i + 1
      }</text>`;
    })
    .join("");
  const svg = `<svg width="${sw}" height="${sh}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
  const overlay = await sharp(base)
    .composite([{ input: Buffer.from(svg) }])
    .jpeg({ quality: 85 })
    .toBuffer();

  return { angle, boxes, lines, overlay, page };
}
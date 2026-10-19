import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PARAMS,
  buildInkMask,
  estimateSkewAngle,
  findBands,
  findLineBoxes,
  otsuThreshold,
  rowProfile,
  smoothProfile,
  type LineBox,
  type SegParams,
} from "./segment-core";

type Page = { gray: Uint8Array; width: number; height: number };

function whitePage(width: number, height: number): Page {
  const gray = new Uint8Array(width * height);
  gray.fill(255);
  return { gray, width, height };
}

/** Half-open rectangle, black by default. */
function fillRect(
  page: Page,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value = 0,
) {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(page.width, Math.ceil(x1));
  const bottom = Math.min(page.height, Math.ceil(y1));

  for (let y = top; y < bottom; y++) {
    const row = y * page.width;
    for (let x = left; x < right; x++) page.gray[row + x] = value;
  }
}

function segment(page: Page, params: SegParams) {
  const threshold = otsuThreshold(page.gray);
  const mask = buildInkMask(page.gray, threshold);
  const profile = smoothProfile(
    rowProfile(page.gray, page.width, page.height, threshold),
  );
  return {
    threshold,
    mask,
    profile,
    bands: findBands(profile, params),
    boxes: findLineBoxes(mask, page.width, page.height, profile, params),
  };
}

test("Otsu separates black bars from a white page", () => {
  const page = whitePage(200, 160);
  fillRect(page, 20, 20, 180, 40);
  fillRect(page, 20, 70, 180, 90);
  fillRect(page, 20, 120, 180, 140);

  const result = segment(page, DEFAULT_PARAMS);
  assert.ok(result.threshold >= 0 && result.threshold < 128);

  let ink = 0;
  for (let i = 0; i < page.gray.length; i++) {
    if (page.gray[i] <= result.threshold) ink++;
  }
  assert.equal(ink, 3 * 160 * 20);
  assert.equal(result.bands.length, 3);
  assert.equal(result.boxes.length, 3);
});

test("smoothing keeps each bar as one band in reading order", () => {
  const page = whitePage(160, 140);
  fillRect(page, 10, 10, 150, 30);
  fillRect(page, 10, 60, 150, 80);
  fillRect(page, 10, 110, 150, 130);

  const { boxes } = segment(page, DEFAULT_PARAMS);
  assert.equal(boxes.length, 3);
  assert.ok(boxes[0][1] < boxes[1][1]);
  assert.ok(boxes[1][1] < boxes[2][1]);
});

test("mergeGap merges two close bars only when the gap is at most the setting", () => {
  const page = whitePage(200, 120);
  fillRect(page, 20, 30, 180, 50);
  fillRect(page, 20, 54, 180, 74);

  const merged = segment(page, { ...DEFAULT_PARAMS, mergeGap: 6 });
  const separate = segment(page, { ...DEFAULT_PARAMS, mergeGap: 0 });

  assert.equal(merged.bands.length, 1);
  assert.equal(separate.bands.length, 2);
});

test("minHeight drops a thin bar and keeps a tall one", () => {
  const page = whitePage(200, 140);
  fillRect(page, 20, 20, 180, 50);
  fillRect(page, 20, 90, 180, 100);

  const result = segment(page, DEFAULT_PARAMS);
  assert.equal(result.bands.length, 1);
  assert.equal(result.boxes.length, 1);
});

test("padding is applied and clamped to the page", () => {
  const page = whitePage(120, 100);
  fillRect(page, 0, 0, 40, 30);
  fillRect(page, 20, 60, 60, 80);

  const { boxes } = segment(page, { ...DEFAULT_PARAMS, pad: 6 });
  assert.equal(boxes.length, 2);

  const [edge, inner] = boxes as [LineBox, LineBox];
  assert.equal(edge[0], 0);
  assert.equal(edge[1], 0);
  assert.equal(edge[2], 46);
  assert.ok(edge[3] <= page.height);

  assert.equal(inner[0], 14);
  assert.equal(inner[2], 66);
  assert.ok(inner[3] <= page.height);
});

test("a slightly rotated bar gets a non-zero skew angle", () => {
  const page = whitePage(300, 200);
  const slope = Math.tan((1.5 * Math.PI) / 180);
  const centerX = page.width / 2;

  for (let x = 50; x < 250; x++) {
    const centerY = 100 + (x - centerX) * slope;
    fillRect(page, x, centerY - 3, x + 1, centerY + 3);
  }

  const angle = estimateSkewAngle(page.gray, page.width, page.height);
  assert.notEqual(angle, 0);
  assert.ok(Math.abs(angle + 1.5) <= 0.5, `expected about -1.5, got ${angle}`);
});

test("a level bar keeps the skew angle at zero", () => {
  const page = whitePage(300, 200);
  fillRect(page, 50, 97, 250, 103);

  const angle = estimateSkewAngle(page.gray, page.width, page.height);
  assert.equal(angle, 0);
});

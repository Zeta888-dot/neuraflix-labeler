import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_STRAIGHTEN_EDGE,
  applyHomography,
  computeHomography,
  detectPageQuad,
  insetQuad,
  invertHomography,
  isQuadValid,
  outputSizeForQuad,
  suggestDeskewAngle,
  type Quad,
} from "./straighten";

type Page = { gray: Uint8Array; width: number; height: number };

function page(width: number, height: number, value = 40): Page {
  const gray = new Uint8Array(width * height);
  gray.fill(value);
  return { gray, width, height };
}

function fillRect(
  target: Page,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value = 255,
) {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(target.width, Math.ceil(x1));
  const bottom = Math.min(target.height, Math.ceil(y1));

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      target.gray[y * target.width + x] = value;
    }
  }
}

test("homography maps the four page corners to the output rectangle", () => {
  const quad: Quad = [
    { x: 12, y: 18 },
    { x: 208, y: 26 },
    { x: 196, y: 214 },
    { x: 22, y: 202 },
  ];
  const width = 220;
  const height = 200;
  const matrix = computeHomography(quad, width, height);

  assert.ok(matrix);
  const destination = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];

  quad.forEach((point, index) => {
    const mapped = applyHomography(matrix, point.x, point.y);
    assert.ok(mapped);
    assert.ok(Math.abs(mapped.x - destination[index].x) < 1e-6);
    assert.ok(Math.abs(mapped.y - destination[index].y) < 1e-6);
  });
});

test("the inverse homography returns output points to the source", () => {
  const quad: Quad = [
    { x: 30, y: 20 },
    { x: 280, y: 50 },
    { x: 250, y: 300 },
    { x: 10, y: 260 },
  ];
  const matrix = computeHomography(quad, 300, 320);
  assert.ok(matrix);
  const inverse = invertHomography(matrix);
  assert.ok(inverse);

  const source = { x: 90, y: 110 };
  const output = applyHomography(matrix, source.x, source.y);
  assert.ok(output);
  const roundTrip = applyHomography(inverse, output.x, output.y);
  assert.ok(roundTrip);
  assert.ok(Math.abs(roundTrip.x - source.x) < 1e-6);
  assert.ok(Math.abs(roundTrip.y - source.y) < 1e-6);
});

test("output size follows the quad and caps the longest side", () => {
  const quad: Quad = [
    { x: 0, y: 0 },
    { x: 3000, y: 0 },
    { x: 3000, y: 4000 },
    { x: 0, y: 4000 },
  ];
  const size = outputSizeForQuad(quad);

  assert.equal(size.height, MAX_STRAIGHTEN_EDGE);
  assert.equal(size.width, 2250);
  assert.equal(size.scale, MAX_STRAIGHTEN_EDGE / 4000);
});

test("a crossed quad is rejected while a page quad is accepted", () => {
  const width = 200;
  const height = 200;
  const good: Quad = [
    { x: 20, y: 20 },
    { x: 180, y: 24 },
    { x: 176, y: 176 },
    { x: 24, y: 172 },
  ];
  const crossing: Quad = [
    { x: 20, y: 20 },
    { x: 180, y: 180 },
    { x: 180, y: 20 },
    { x: 20, y: 180 },
  ];

  assert.equal(isQuadValid(good, width, height), true);
  assert.equal(isQuadValid(crossing, width, height), false);
});

test("page corner detection finds a bright page on a dark background", () => {
  const target = page(200, 200);
  fillRect(target, 40, 30, 160, 170);

  const quad = detectPageQuad(target.gray, target.width, target.height);

  assert.ok(Math.abs(quad[0].x - 40) <= 2);
  assert.ok(Math.abs(quad[0].y - 30) <= 2);
  assert.ok(Math.abs(quad[1].x - 159) <= 2);
  assert.ok(Math.abs(quad[1].y - 30) <= 2);
  assert.ok(Math.abs(quad[2].x - 159) <= 2);
  assert.ok(Math.abs(quad[2].y - 169) <= 2);
  assert.ok(Math.abs(quad[3].x - 40) <= 2);
  assert.ok(Math.abs(quad[3].y - 169) <= 2);
});

test("a flat page and a sparse text block both fall back to the inset", () => {
  const flat = page(200, 200, 255);
  assert.deepEqual(
    detectPageQuad(flat.gray, flat.width, flat.height),
    insetQuad(flat.width, flat.height),
  );

  const text = page(200, 200, 255);
  for (let row = 0; row < 10; row++) {
    fillRect(text, 50, 40 + row * 12, 150, 44 + row * 12, 0);
  }
  assert.deepEqual(
    detectPageQuad(text.gray, text.width, text.height),
    insetQuad(text.width, text.height),
  );
});

test("deskew detection finds a small clockwise tilt and returns its correction", () => {
  const target = page(300, 200, 255);
  const slope = Math.tan((1.5 * Math.PI) / 180);
  const centerX = target.width / 2;

  for (let x = 50; x < 250; x++) {
    const centerY = 100 + (x - centerX) * slope;
    fillRect(target, x, centerY - 3, x + 1, centerY + 3, 0);
  }

  const angle = suggestDeskewAngle(target.gray, target.width, target.height);
  assert.ok(Math.abs(angle + 1.5) <= 0.5, `expected about -1.5, got ${angle}`);
});

test("deskew detection keeps a level page at zero", () => {
  const target = page(300, 200, 255);
  fillRect(target, 50, 97, 250, 103, 0);

  assert.equal(
    suggestDeskewAngle(target.gray, target.width, target.height),
    0,
  );
});

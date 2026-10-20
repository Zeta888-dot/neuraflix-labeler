import assert from "node:assert/strict";
import test from "node:test";
import { inspectImage } from "./image-check";

function setAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function setUInt32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function setUInt24LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

function webpVp8l(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(26);
  setAscii(bytes, 0, "RIFF");
  setUInt32LE(bytes, 4, 18);
  setAscii(bytes, 8, "WEBP");
  setAscii(bytes, 12, "VP8L");
  setUInt32LE(bytes, 16, 5);
  bytes[20] = 0x2f;
  const bits = (width - 1) | ((height - 1) << 14);
  setUInt32LE(bytes, 21, bits);
  return bytes;
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  setAscii(bytes, 0, "RIFF");
  setUInt32LE(bytes, 4, 22);
  setAscii(bytes, 8, "WEBP");
  setAscii(bytes, 12, "VP8X");
  setUInt32LE(bytes, 16, 10);
  setUInt24LE(bytes, 24, width - 1);
  setUInt24LE(bytes, 27, height - 1);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x07,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0xff,
    0xd9,
  ]);
}

test("WebP VP8L dimensions are read from the header", () => {
  assert.deepEqual(inspectImage(webpVp8l(320, 48)), {
    format: "webp",
    width: 320,
    height: 48,
  });
});

test("WebP VP8X dimensions are read from the canvas header", () => {
  assert.deepEqual(inspectImage(webpVp8x(1000, 250)), {
    format: "webp",
    width: 1000,
    height: 250,
  });
});

test("JPEG dimensions are read from the start of frame segment", () => {
  assert.deepEqual(inspectImage(jpeg(640, 120)), {
    format: "jpeg",
    width: 640,
    height: 120,
  });
});

test("unknown, truncated and mislabeled files are rejected", () => {
  assert.equal(inspectImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(inspectImage(new Uint8Array(0)), null);
  assert.equal(inspectImage(new Uint8Array([0xff, 0xd8])), null);

  const truncated = webpVp8l(10, 10);
  assert.equal(inspectImage(truncated.slice(0, 20)), null);

  const wrongSize = webpVp8l(10, 10);
  setUInt32LE(wrongSize, 4, 17);
  assert.equal(inspectImage(wrongSize), null);

  const badJpeg = jpeg(10, 10);
  badJpeg[5] = 0xff;
  assert.equal(inspectImage(badJpeg), null);

  const noEnd = jpeg(10, 10);
  assert.equal(inspectImage(noEnd.slice(0, -2)), null);
});

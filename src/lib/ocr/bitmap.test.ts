import assert from "node:assert/strict";
import { test } from "node:test";
import { isBitmapUsable } from "./bitmap";

test("only a bitmap with pixels can be drawn", () => {
  assert.equal(isBitmapUsable(null), false);
  assert.equal(isBitmapUsable(undefined), false);
  assert.equal(isBitmapUsable({ width: 0, height: 0 }), false);
  assert.equal(isBitmapUsable({ width: 0, height: 1200 }), false);
  assert.equal(isBitmapUsable({ width: 900, height: 0 }), false);
  assert.equal(isBitmapUsable({ width: 900, height: 1200 }), true);
});

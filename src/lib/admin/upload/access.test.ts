import assert from "node:assert/strict";
import { test } from "node:test";
import { canImport } from "./access";

test("canImport allows only the admin role", () => {
  assert.equal(canImport("admin"), true);
  assert.equal(canImport("contributor"), false);
  assert.equal(canImport("reviewer"), false);
  assert.equal(canImport(null), false);
  assert.equal(canImport(undefined), false);
});

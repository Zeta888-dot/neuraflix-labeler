import assert from "node:assert/strict";
import { test } from "node:test";
import { type LineDraft, type LineStatus } from "./labels";
import {
  buildUploadPlan,
  decideQuota,
  pickImageExtension,
  submitGate,
} from "./submit";

function line(
  id: string,
  status: LineStatus,
  label = "",
  box: LineDraft["box"] = [0, 0, 10, 10],
): LineDraft {
  return { id, box, status, label };
}

test("upload plan drops unreadable and empty lines and keeps line numbers", () => {
  const lines = [
    line("1", "labeled", "  الف "),
    line("2", "unreadable", "hidden"),
    line("3", "empty", ""),
    line("4", "labeled", "دوم"),
  ];

  assert.deepEqual(buildUploadPlan(lines, "user-1", "page-1", "webp"), [
    {
      idx: 1,
      storage_path: "user-1/page-1/1.webp",
      label: "الف",
    },
    {
      idx: 4,
      storage_path: "user-1/page-1/4.webp",
      label: "دوم",
    },
  ]);
});

test("upload plan drops a line whose status is labeled but text is blank", () => {
  const lines = [line("1", "labeled", " \n\t "), line("2", "labeled", "سلام")];

  assert.deepEqual(buildUploadPlan(lines, "u", "p", "jpg"), [
    { idx: 2, storage_path: "u/p/2.jpg", label: "سلام" },
  ]);
});

test("webp stays webp and everything else becomes jpg", () => {
  assert.equal(pickImageExtension("image/webp"), "webp");
  assert.equal(pickImageExtension("image/jpeg"), "jpg");
  assert.equal(pickImageExtension("image/png"), "jpg");
  assert.equal(pickImageExtension(""), "jpg");
});

test("quota decisions use the 60 and 80 percent thresholds", () => {
  assert.equal(decideQuota(0, 1000, 599), "ok");
  assert.equal(decideQuota(0, 1000, 600), "warn");
  assert.equal(decideQuota(0, 1000, 800), "warn");
  assert.equal(decideQuota(0, 1000, 801), "block");
  assert.equal(decideQuota(790, 1000, 20), "block");
  assert.equal(decideQuota(500, 1000, 100), "warn");
  assert.equal(decideQuota(0, 0, 1), "block");
  assert.equal(decideQuota(Number.NaN, 1000, Number.NaN), "ok");
});

test("submit gate requires rights, labels, no empty lines and 40 lines max", () => {
  const valid = [
    line("1", "labeled", "سلام"),
    line("2", "unreadable", "unreadable"),
  ];

  assert.equal(submitGate(valid, true).canSubmit, true);
  assert.equal(submitGate(valid, false).reason, "Confirm the rights statement before you submit.");
  assert.equal(submitGate([], true).reason, "There are no lines to submit.");
  assert.equal(
    submitGate([line("1", "empty", "")], true).reason,
    "Some lines are empty. Write them or mark them unreadable.",
  );
  assert.equal(
    submitGate(
      [line("1", "unreadable", ""), line("2", "unreadable", "")],
      true,
    ).reason,
    "Add at least one line label before you submit.",
  );

  const tooMany = Array.from({ length: 41 }, (_, index) =>
    line(String(index), "labeled", "سلام"),
  );
  assert.equal(
    submitGate(tooMany, true).reason,
    "A page can have at most 40 lines.",
  );

  const forty = tooMany.slice(0, 40);
  assert.equal(submitGate(forty, true).canSubmit, true);

  const latin = [line("1", "labeled", "hello world")];
  assert.equal(
    submitGate(latin, true).reason,
    "Some labels are too long or contain too many Latin letters. Fix them before you submit.",
  );
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("Japanese Worker implementation matches the pinned source except for its package-local reviewed import", () => {
  const baselinePath = resolve(import.meta.dirname, "baseline/japanese-worker.mjs");
  const extractedPath = resolve(import.meta.dirname, "../src/japanese/worker.mjs");
  const baseline = readFileSync(baselinePath, "utf8");
  const extracted = readFileSync(extractedPath, "utf8").replace('"../reviewed.mjs"', '"../ocr/reviewed.mjs"');
  assert.equal(extracted, baseline);
});

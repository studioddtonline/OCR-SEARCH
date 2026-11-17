import assert from "node:assert/strict";
import test from "node:test";
import {
  OcrSearchError,
  SearchBusyError,
  SearchCancelledError,
  SearchQueryError,
  SearchUnavailableError,
  SearchWorkerError,
} from "../src/errors.js";
import { SearchQueryValidationError } from "../src/query.js";

test("all expected OCR-SEARCH errors share OcrSearchError", () => {
  const errors = [
    new SearchUnavailableError(),
    new SearchBusyError(),
    new SearchCancelledError(),
    new SearchQueryError(),
    new SearchWorkerError(),
    new SearchQueryValidationError("invalid query"),
  ];
  for (const error of errors) {
    assert.ok(error instanceof OcrSearchError);
    assert.equal(typeof error.code, "string");
    assert.equal(typeof error.retryable, "boolean");
  }
});

test("retryable distinguishes transient Worker pressure from terminal conditions", () => {
  assert.equal(new SearchWorkerError("busy").retryable, true);
  assert.equal(new SearchBusyError().retryable, true);
  assert.equal(new SearchWorkerError("closed", { retryable: false }).retryable, false);
  assert.equal(new SearchUnavailableError("disabled").retryable, false);
  assert.equal(new SearchCancelledError().retryable, false);
  assert.equal(new SearchQueryValidationError("invalid").retryable, false);
});

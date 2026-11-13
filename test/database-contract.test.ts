import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { assertSearchDatabaseCompatible, assertTrigramSearchDatabaseCompatible } from "../src/testing.js";
import { SearchUnavailableError } from "../src/errors.js";

const source = "CREATE TABLE source_images (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, ocr_text TEXT, reviewed INTEGER);";

test("production validator accepts an FTS5 unicode61 table without assuming trigram", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(source + " CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text, tokenize='unicode61');");
  try {
    assert.doesNotThrow(() => assertSearchDatabaseCompatible(db));
    assert.throws(() => assertTrigramSearchDatabaseCompatible(db), SearchUnavailableError);
  } finally { db.close(); }
});

test("strict test helper accepts trigram and production validator leaves connection open", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(source + " CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text, tokenize='trigram');");
  try {
    assert.doesNotThrow(() => assertTrigramSearchDatabaseCompatible(db));
    assert.equal((db.prepare("SELECT 1 AS ok").get() as {ok:number}).ok, 1);
  } finally { db.close(); }
});

test("validator rejects missing required columns and non-FTS5 virtual tables", () => {
  const missing = new DatabaseSync(":memory:");
  missing.exec("CREATE TABLE source_images (id INTEGER PRIMARY KEY); CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text);");
  try { assert.throws(() => assertSearchDatabaseCompatible(missing), /missing required column/); }
  finally { missing.close(); }

  const fts4 = new DatabaseSync(":memory:");
  fts4.exec(source + " CREATE VIRTUAL TABLE images_fts USING fts4(ocr_text);");
  try { assert.throws(() => assertSearchDatabaseCompatible(fts4), /FTS5 virtual table/); }
  finally { fts4.close(); }
});

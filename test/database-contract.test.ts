import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { assertSearchDatabaseCompatible, assertTrigramSearchDatabaseCompatible } from "../src/testing.js";
import { SearchUnavailableError } from "../src/errors.js";

const source = "CREATE TABLE source_images (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, ocr_text TEXT, reviewed INTEGER);";

test("production validator accepts an FTS5 unicode61 table without assuming trigram", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(source + " CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text, content='source_images', content_rowid='id', tokenize='unicode61');");
  try {
    assert.doesNotThrow(() => assertSearchDatabaseCompatible(db));
    assert.throws(() => assertTrigramSearchDatabaseCompatible(db), SearchUnavailableError);
  } finally { db.close(); }
});

test("strict test helper accepts trigram and production validator leaves connection open", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(source + ` CREATE VIRTUAL TABLE images_fts USING fts5(
    ocr_text, content='source_images', content_rowid='id', tokenize='trigram'
  );`);
  try {
    assert.doesNotThrow(() => assertTrigramSearchDatabaseCompatible(db));
    assert.equal((db.prepare("SELECT 1 AS ok").get() as {ok:number}).ok, 1);
  } finally { db.close(); }
});

test("production validator accepts quoted, unquoted, and mixed external-content option values", () => {
  const definitions = [
    "content='source_images', content_rowid='id'",
    'content="source_images", content_rowid="id"',
    "content=source_images, content_rowid=id",
    "content='source_images', content_rowid=id",
    'content=source_images, content_rowid="id"',
    "CONTENT='source_images', CONTENT_ROWID='id'",
    "content = 'source_images', content_rowid = 'id'",
    "content=\n'source_images',\ncontent_rowid=\n'id'",
    "content_rowid='id', content='source_images'",
    "content_rowid=id, content=source_images",
    'content="source_images", content_rowid=id',
    "content=source_images, content_rowid='id'",
    'CONTENT = "source_images", CONTENT_ROWID = "id"',
  ];
  for (const definition of definitions) {
    const db = new DatabaseSync(":memory:");
    db.exec(source + ` CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text, ${definition});`);
    try {
      assert.doesNotThrow(() => assertSearchDatabaseCompatible(db), definition);
    } finally { db.close(); }
  }
});

test("production validator rejects an incorrect external-content rowid mapping", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(source + " CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text, content='source_images', content_rowid='reviewed');");
  try {
    assert.throws(() => assertSearchDatabaseCompatible(db), /content_rowid=id/);
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


test("strict test helper validates the external-content rowid mapping", () => {
  const valid = new DatabaseSync(":memory:");
  valid.exec(source + ` CREATE VIRTUAL TABLE images_fts USING fts5(
    ocr_text, CONTENT = "source_images", CONTENT_ROWID = "id", tokenize = 'trigram'
  );`);
  try {
    assert.doesNotThrow(() => assertTrigramSearchDatabaseCompatible(valid));
  } finally { valid.close(); }

  const invalid = new DatabaseSync(":memory:");
  invalid.exec(source + ` CREATE VIRTUAL TABLE images_fts USING fts5(
    ocr_text, content = 'source_images', content_rowid = 'reviewed', tokenize = 'trigram'
  );`);
  try {
    assert.throws(
      () => assertTrigramSearchDatabaseCompatible(invalid),
      /content_rowid=id/,
    );
  } finally { invalid.close(); }
});


test("production validator rejects near-miss identifiers and trailing option junk", () => {
  const invalidDefinitions = [
    "content='source_images_backup', content_rowid='id'",
    "content='backup_source_images', content_rowid='id'",
    "content='source_images', content_rowid='id_extra'",
    "content='source_images', content_rowid='backup_id'",
  ];
  for (const definition of invalidDefinitions) {
    const db = new DatabaseSync(":memory:");
    db.exec(source + ` CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text, ${definition});`);
    try {
      assert.throws(() => assertSearchDatabaseCompatible(db), /external content source_images with content_rowid=id/);
    } finally { db.close(); }
  }

  const trailingJunk = new DatabaseSync(":memory:");
  trailingJunk.exec(source + " CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text, content='source_images', content_rowid='id');");
  try {
    trailingJunk.exec("PRAGMA writable_schema=ON;");
    trailingJunk.prepare("UPDATE sqlite_master SET sql = ? WHERE name = 'images_fts'").run(
      "CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text, content='source_images' unexpected, content_rowid='id')",
    );
    trailingJunk.exec("PRAGMA writable_schema=OFF;");
    assert.throws(
      () => assertSearchDatabaseCompatible(trailingJunk),
      /external content source_images with content_rowid=id/,
    );
  } finally { trailingJunk.close(); }
});

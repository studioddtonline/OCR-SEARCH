import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createStandardSearchFixture } from "./support/standard-search-fixture.mjs";

const extensionPath = resolve(process.env.SQLITE_VAPORETTO_EXTENSION ?? "native/sqlite-vaporetto/libsqlite_vaporetto.so");
const builderPath = resolve(import.meta.dirname, "../scripts/build-japanese-index.mjs");
const hasExtension = existsSync(extensionPath);

test("Japanese index builder creates a schema-v2 snapshot from the source database", { skip: !hasExtension }, () => {
  const directory = mkdtempSync(join(tmpdir(), "ocr-search-index-build-"));
  const sourcePath = join(directory, "source.sqlite");
  const indexPath = join(directory, "japanese.sqlite");
  const source = createStandardSearchFixture("keyset-pagination", sourcePath);
  source.close();
  try {
    const result = spawnSync(process.execPath, [
      builderPath,
      `--database=${sourcePath}`,
      `--index=${indexPath}`,
      `--extension=${extensionPath}`,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const index = new DatabaseSync(indexPath, { readOnly: true });
    try {
      const metadata = index.prepare("SELECT schema_version, tokenizer, source_record_count FROM japanese_search_meta WHERE singleton = 1").get();
      assert.equal(metadata?.schema_version, 2);
      assert.equal(metadata?.tokenizer, "vaporetto-pretokenized-unicode61");
      assert.equal(metadata?.source_record_count, index.prepare("SELECT COUNT(*) AS count FROM japanese_documents").get()?.count);
      const fts = index.prepare("SELECT sql FROM sqlite_master WHERE name = 'japanese_fts'").get()?.sql;
      assert.match(fts ?? "", /content=''[\s\S]*tokenize='unicode61'/);
    } finally {
      index.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Japanese index builder preserves an existing index when source validation fails", { skip: !hasExtension }, () => {
  const directory = mkdtempSync(join(tmpdir(), "ocr-search-index-failure-"));
  const sourcePath = join(directory, "invalid-source.sqlite");
  const indexPath = join(directory, "japanese.sqlite");
  const invalid = new DatabaseSync(sourcePath);
  invalid.exec("CREATE TABLE source_images (id INTEGER PRIMARY KEY);");
  invalid.close();
  writeFileSync(indexPath, "previous-index-must-survive");
  try {
    const result = spawnSync(process.execPath, [
      builderPath,
      `--database=${sourcePath}`,
      `--index=${indexPath}`,
      `--extension=${extensionPath}`,
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /previous index.*not replaced/i);
    assert.equal(readFileSync(indexPath, "utf8"), "previous-index-must-survive");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

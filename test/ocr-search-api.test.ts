import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createStandardSearchFixture } from "./support/standard-search-fixture.mjs";
import { createJapaneseSearchFixtureIndex } from "./support/japanese-search-fixture.mjs";
import { OcrSearch } from "../src/ocr-search.js";
import { SearchUnavailableError } from "../src/errors.js";

test("OcrSearch.close does not close the caller-owned source database", async () => {
  const database = createStandardSearchFixture("short-literal-substring");
  const search = new OcrSearch({ database });
  try {
    const result = await search.search({ query: "東京", limit: 10 });
    assert.equal(result.returned, result.results.length);
    search.close();
    assert.doesNotThrow(() => database.prepare("SELECT 1").get());
    await assert.rejects(search.search({ query: "東京" }), /closed/);
    await assert.rejects(search.searchJapanese({ query: "東京" }), (error) => error instanceof SearchUnavailableError && error.code === "SEARCH_UNAVAILABLE");
  } finally {
    search.close();
    database.close();
  }
});

const extensionPath = resolve(process.env.SQLITE_VAPORETTO_EXTENSION ?? "native/sqlite-vaporetto/libsqlite_vaporetto.so");
test("OcrSearch delegates Japanese search to the isolated Vaporetto Worker", {
  skip: !existsSync(extensionPath),
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ocr-search-japanese-"));
  const indexPath = join(directory, "japanese.sqlite");
  const fixture = createJapaneseSearchFixtureIndex(indexPath, extensionPath);
  const database = createStandardSearchFixture("keyset-pagination");
  database.prepare("INSERT INTO source_images (id, file_path, file_name, ocr_text, reviewed) VALUES (?, ?, ?, ?, ?)").run(7, "テスト書籍", "001.webp", "東京特許許可局", 1);
  const search = new OcrSearch({
    database,
    japanese: {
      indexPath,
      extensionPath,
      busyTimeoutMs: 500,
      maxLimit: 10,
    },
  });
  try {
    const result = await search.searchJapanese({
      query: fixture.query,
      mode: "any",
      offset: 0,
    });
    assert.equal(result.limit, 10);
    assert.equal(result.returned, 1);
    assert.equal(result.results[0]?.id, 7);
    assert.equal(result.results[0]?.label, "テスト書籍");
    assert.match(result.results[0]?.snippet ?? "", /〔東京〕/);
    assert.equal(result.index.indexedAt, fixture.metadata.indexedAt);
    assert.equal(result.index.indexedRecords, 1);
    await assert.rejects(search.searchJapanese({ query: "東京", limit: 21 }), /limit/);
    await assert.rejects(search.searchJapanese({ query: "😀".repeat(251) }), /500 UTF-16 code units/);
  } finally {
    search.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Japanese search is disabled unless explicit Worker configuration is supplied", async () => {
  const database = createStandardSearchFixture("keyset-pagination");
  const search = new OcrSearch({ database });
  try {
    await assert.rejects(search.searchJapanese({ query: "東京" }), /not enabled/);
  } finally {
    search.close();
    database.close();
  }
});

test("Japanese search hydrates current source fields and continues past deleted snapshot rows", {
  skip: !existsSync(extensionPath),
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ocr-search-japanese-hydrate-"));
  const indexPath = join(directory, "japanese.sqlite");
  const fixture = createJapaneseSearchFixtureIndex(indexPath, extensionPath);
  const indexDb = new DatabaseSync(indexPath);
  try {
    indexDb.prepare("INSERT INTO japanese_documents (source_id, file_path, file_name, reviewed, ocr_text) VALUES (?, ?, ?, ?, ?)").run(
      8, "旧ラベル", "008.webp", 1, "東京特許許可局",
    );
    indexDb.prepare("INSERT INTO japanese_fts(rowid, search_text) VALUES (?, ?)").run(8, fixture.queryTokens.join(" "));
    indexDb.prepare("UPDATE japanese_search_meta SET source_record_count = 2, source_max_id = 8 WHERE singleton = 1").run();
  } finally {
    indexDb.close();
  }

  const database = createStandardSearchFixture("keyset-pagination");
  database.prepare("INSERT INTO source_images (id, file_path, file_name, ocr_text, reviewed) VALUES (?, ?, ?, ?, ?)").run(
    8, "最新ラベル", "008-current.webp", "更新後のOCR本文：東京特許許可局を確認。", 0,
  );
  const search = new OcrSearch({
    database,
    japanese: { indexPath, extensionPath, busyTimeoutMs: 500, maxLimit: 10 },
  });
  try {
    const result = await search.searchJapanese({
      query: fixture.query,
      mode: "any",
      label: "最新ラベル",
      reviewed: false,
      limit: 1,
    });
    // Snapshot row 7 sorts first but has been deleted from source_images. The API
    // continues to the next candidate and hydrates row 8 from the current source DB.
    assert.deepEqual(result.results.map((row) => row.id), [8]);
    assert.equal(result.results[0]?.label, "最新ラベル");
    assert.equal(result.results[0]?.fileName, "008-current.webp");
    assert.equal(result.results[0]?.reviewed, 0);
    assert.match(result.results[0]?.snippet ?? "", /更新後のOCR本文/);
    assert.match(result.results[0]?.snippet ?? "", /〔[^〕]*東京[^〕]*〕/);
    assert.equal(result.returned, 1);
    assert.equal(result.nextOffset, null);
    assert.equal(result.index.indexedAt, fixture.metadata.indexedAt);
  } finally {
    search.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createStandardSearchFixture } from "./support/standard-search-fixture.mjs";
import { createJapaneseSearchFixtureIndex } from "./support/japanese-search-fixture.mjs";
import { OcrSearch } from "../src/ocr-search.js";

test("OcrSearch.close does not close the caller-owned source database", async () => {
  const database = createStandardSearchFixture("short-literal-substring");
  const search = new OcrSearch({ database });
  try {
    const result = await search.search({ query: "東京", limit: 10 });
    assert.equal(result.returned, result.results.length);
    search.close();
    assert.doesNotThrow(() => database.prepare("SELECT 1").get());
    await assert.rejects(search.search({ query: "東京" }), /closed/);
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

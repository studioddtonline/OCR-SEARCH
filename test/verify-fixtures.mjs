import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceCommit = "d9f23b0a7870ea267670bcf27208942172e27563";

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

const standard = readJson("test/fixtures/standard-search-baseline.json");
const japanese = readJson("test/fixtures/japanese-search-baseline.json");
const schema = readFileSync(resolve(root, "test/fixtures/ocr-search-schema.sql"), "utf8");
const nullableReviewedSchema = readFileSync(
  resolve(root, "test/fixtures/ocr-search-schema-nullable-reviewed.sql"),
  "utf8",
);

assert.equal(standard.formatVersion, 1);
assert.equal(standard.source.commit, sourceCommit);
assert.equal(japanese.formatVersion, 1);
assert.equal(japanese.source.commit, sourceCommit);

const expectedStandardCases = [
  "keyset-pagination",
  "short-literal-substring",
  "boolean-ast",
  "structured-filter-pagination",
  "quoted-and-injection-like-terms",
  "unicode-lowercase-expansion",
  "surrogate-pair-boundaries",
  "reviewed-fail-closed",
];
assert.deepEqual(standard.cases.map((item) => item.id), expectedStandardCases);

for (const scenario of standard.cases) {
  const ids = new Set(scenario.rows.map((row) => row.id));
  assert.equal(ids.size, scenario.rows.length, scenario.id + ": fixture row IDs must be unique");
  for (const row of scenario.rows) {
    assert.equal(typeof row.id, "number", scenario.id + ": row ID must be numeric");
    assert.equal(typeof row.label, "string", scenario.id + ": label must be a string");
    assert.equal(typeof row.fileName, "string", scenario.id + ": fileName must be a string");
    assert.equal(typeof row.text, "string", scenario.id + ": text must be a string");
  }
  for (const query of scenario.queries) {
    for (const id of query.expectedIds) {
      assert.ok(ids.has(id), scenario.id + ": expected result ID " + id + " must exist in fixture rows");
    }
    if (Object.hasOwn(query, "nextAfterId") && query.nextAfterId !== null) {
      assert.ok(ids.has(query.nextAfterId), scenario.id + ": nextAfterId must reference a fixture row");
    }
  }
}

const unicodeCase = standard.cases.find((item) => item.id === "unicode-lowercase-expansion");
assert.equal([...unicodeCase.rows[0].text.split(" target")[0]].length, 50);
const surrogateCase = standard.cases.find((item) => item.id === "surrogate-pair-boundaries");
assert.equal(surrogateCase.rows[0].text.indexOf("𠮷"), 159);
const reviewedCase = standard.cases.find((item) => item.id === "reviewed-fail-closed");
assert.deepEqual(reviewedCase.rows.map((row) => row.reviewed), [1, 0, 2, null]);
assert.equal(reviewedCase.schemaFile, "ocr-search-schema-nullable-reviewed.sql");
assert.match(nullableReviewedSchema, /reviewed INTEGER\s*[,)]/i);

assert.equal(japanese.metadata.schema_version, 2);
assert.equal(japanese.metadata.tokenizer, "vaporetto-pretokenized-unicode61");
assert.equal(japanese.metadata.indexed_at, "2026-01-01T00:00:00.000Z");
assert.equal(japanese.documents.length, 1);
assert.equal(japanese.documents[0].source_id, 7);
assert.ok(japanese.index.virtualTable.includes("content=''"));
assert.ok(japanese.index.virtualTable.includes("tokenize='unicode61'"));
assert.ok(japanese.searchAssertions.queryTokensMustInclude.includes("東京"));

assert.match(schema, /CREATE TABLE source_images/i);
assert.match(schema, /CREATE VIRTUAL TABLE images_fts USING fts5/i);
assert.match(schema, /content='source_images'/);
assert.match(schema, /content_rowid='id'/);
assert.match(schema, /tokenize='trigram'/);

process.stdout.write(
  "Regression fixture integrity OK: " +
  standard.cases.length +
  " standard-search scenarios; 1 Japanese-search integration fixture.\n",
);

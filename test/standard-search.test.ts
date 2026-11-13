import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { StandardSearchRepository } from "../src/standard-search.js";
import { SearchCancelledError, SearchQueryValidationError } from "../src/index.js";

interface FixtureRow {
  id: number; label: string; fileName: string; text: string; reviewed: number | null;
}
interface FixtureQuery {
  query: unknown; label?: string; reviewed?: boolean; limit?: number; offset?: number;
  afterId?: number; snippetLength?: number; expectedIds: number[];
  nextAfterId?: number | null; snippetMustContain?: string; snippetMustNotEqual?: string;
}
interface FixtureCase {
  id: string; rows: FixtureRow[]; queries: FixtureQuery[]; schemaFile?: string;
}
const root = resolve(import.meta.dirname, "..");
const baseline = JSON.parse(readFileSync(resolve(root, "test/fixtures/standard-search-baseline.json"), "utf8")) as { cases: FixtureCase[] };

function createDb(scenario: FixtureCase): DatabaseSync {
  const schemaName = scenario.schemaFile ?? "ocr-search-schema.sql";
  const schema = readFileSync(resolve(root, "test/fixtures", schemaName), "utf8");
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  const insert = db.prepare("INSERT INTO source_images (id, file_path, file_name, ocr_text, reviewed) VALUES (?, ?, ?, ?, ?)");
  for (const row of scenario.rows) insert.run(row.id, row.label, row.fileName, row.text, row.reviewed);
  if (scenario.rows.length) db.exec("INSERT INTO images_fts(images_fts) VALUES ('rebuild')");
  return db;
}

for (const scenario of baseline.cases) {
  test(`standard search baseline: ${scenario.id}`, async () => {
    const db = createDb(scenario);
    const repository = new StandardSearchRepository(db, { defaultLimit: 20, maxLimit: 50, snippetLength: 160 });
    try {
      for (const query of scenario.queries) {
        const result = await repository.search({
          query: query.query,
          ...(query.label !== undefined ? { label: query.label } : {}),
          ...(query.reviewed !== undefined ? { reviewed: query.reviewed } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {}),
          ...(query.offset !== undefined ? { offset: query.offset } : {}),
          ...(query.afterId !== undefined ? { afterId: query.afterId } : {}),
        });
        assert.deepEqual(result.results.map(row => row.id), query.expectedIds);
        if (Object.hasOwn(query, "nextAfterId")) assert.equal(result.nextAfterId, query.nextAfterId);
        if (query.snippetMustContain) assert.ok(result.results[0]?.snippet.includes(query.snippetMustContain));
        if (query.snippetMustNotEqual) assert.notEqual(result.results[0]?.snippet, query.snippetMustNotEqual);
      }
      if (scenario.id === "surrogate-pair-boundaries") {
        assert.ok((await repository.search({ query: "a", limit: 5 })).results[0]?.snippet.includes("𠮷"));
      }
    } finally {
      repository.close();
      // The package must not close the caller-owned DatabaseSync.
      assert.equal(db.prepare("SELECT 1 AS ok").get()?.ok, 1);
      db.close();
    }
  });
}

test("standard search package boundary applies defaults and validates pagination", async () => {
  const scenario = baseline.cases.find(item => item.id === "keyset-pagination")!;
  const db = createDb(scenario);
  const repository = new StandardSearchRepository(db);
  try {
    const defaults = await repository.search({ query: "sample" });
    assert.equal(defaults.limit, 20);
    assert.equal(defaults.offset, 0);
    for (const request of [
      { query: "sample", limit: 0 }, { query: "sample", limit: -1 },
      { query: "sample", limit: 1.5 }, { query: "sample", limit: 51 },
      { query: "sample", offset: -1 }, { query: "sample", offset: 1.5 },
      { query: "sample", offset: 1_000_001 }, { query: "sample", afterId: 0 },
      { query: "sample", afterId: Number.MAX_SAFE_INTEGER + 1 },
      { query: "sample", afterId: 1, offset: 1 },
    ]) {
      await assert.rejects(repository.search(request), SearchQueryValidationError);
    }
    assert.equal((await repository.search({ query: "sample", afterId: 1, offset: 0 })).returned, 2);
  } finally { repository.close(); db.close(); }
});

test("standard search checks AbortSignal before running the synchronous query", async () => {
  const scenario = baseline.cases.find(item => item.id === "keyset-pagination")!;
  const db = createDb(scenario);
  const repository = new StandardSearchRepository(db);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(repository.search({ query: "sample" }, controller.signal), SearchCancelledError);
  } finally { repository.close(); db.close(); }
});

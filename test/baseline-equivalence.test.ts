import assert from "node:assert/strict";
import test from "node:test";
import { createStandardSearchFixture } from "./support/standard-search-fixture.mjs";
import { OcrRepository } from "./baseline/repository.js";
import { StandardSearchRepository } from "../src/standard-search.js";

interface FixtureQuery {
  query: unknown;
  label?: string;
  reviewed?: boolean;
  limit?: number;
  offset?: number;
  afterId?: number;
  snippetLength?: number;
}
interface FixtureCase {
  id: string;
  queries: FixtureQuery[];
}

test("extracted standard search matches the pinned source implementation exactly", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const baseline = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/standard-search-baseline.json"), "utf8")) as { cases: FixtureCase[] };

  for (const scenario of baseline.cases) {
    const sourceDb = createStandardSearchFixture(scenario.id);
    const extractedDb = createStandardSearchFixture(scenario.id);
    const source = new OcrRepository(sourceDb);
    try {
      for (let index = 0; index < scenario.queries.length; index += 1) {
        const query = scenario.queries[index]!;
        const limit = query.limit ?? 20;
        const offset = query.offset ?? 0;
        const snippetLength = query.snippetLength ?? 160;
        const expected = source.search({
          query: query.query,
          ...(query.label === undefined ? {} : { label: query.label }),
          ...(query.reviewed === undefined ? {} : { reviewed: query.reviewed }),
          limit,
          offset,
          ...(query.afterId === undefined ? {} : { afterId: query.afterId }),
          snippetLength,
        });
        const extracted = new StandardSearchRepository(extractedDb, { snippetLength });
        try {
          const actual = await extracted.search({
            query: query.query,
            ...(query.label === undefined ? {} : { label: query.label }),
            ...(query.reviewed === undefined ? {} : { reviewed: query.reviewed }),
            limit,
            offset,
            ...(query.afterId === undefined ? {} : { afterId: query.afterId }),
          });
          assert.deepEqual(actual, expected, `${scenario.id} query #${index + 1}`);
        } finally {
          extracted.close();
        }
      }
    } finally {
      sourceDb.close();
      extractedDb.close();
    }
  }
});

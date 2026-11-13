import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_QUERY_CHILDREN,
  MAX_QUERY_DEPTH,
  MAX_QUERY_NODES,
  MAX_QUERY_TERM_CODE_POINTS,
  SearchQueryValidationError,
  parseSearchQuery,
  compileQuery,
  extractPositiveTerms,
} from "../src/query.js";

test("parser trims plain text and enforces Unicode code-point length", () => {
  assert.deepEqual(parseSearchQuery("  検索  "), { type: "term", value: "検索" });
  assert.throws(() => parseSearchQuery(" "), SearchQueryValidationError);
  assert.throws(() => parseSearchQuery("😀".repeat(MAX_QUERY_TERM_CODE_POINTS + 1)), SearchQueryValidationError);
  assert.doesNotThrow(() => parseSearchQuery("😀".repeat(MAX_QUERY_TERM_CODE_POINTS)));
});

test("parser enforces AST depth, node count, child count and positive-term requirement", () => {
  let deep: unknown = { type: "term", value: "term" };
  for (let i = 0; i < MAX_QUERY_DEPTH; i++) deep = { type: "not", node: deep };
  assert.throws(() => parseSearchQuery(deep), /nested at most/);

  const many: unknown = { type: "and", nodes: Array.from({ length: MAX_QUERY_CHILDREN }, (_, i) => ({ type: "and", nodes: [{ type: "term", value: `a${i}` }, { type: "term", value: `b${i}` }] })) };
  assert.throws(() => parseSearchQuery(many), /at most 32 nodes/);
  assert.throws(() => parseSearchQuery({ type: "and", nodes: [{ type: "term", value: "x" }] }), /2 to 16/);
  assert.throws(() => parseSearchQuery({ type: "not", node: { type: "term", value: "x" } }), /positive term/);
});

test("parser rejects cycles, shared nodes and very deep untrusted input iteratively", () => {
  const cycle: Record<string, unknown> = { type: "not" };
  cycle.node = cycle;
  assert.throws(() => parseSearchQuery(cycle), /cyclic or shared/);

  const shared = { type: "term", value: "shared" };
  assert.throws(() => parseSearchQuery({ type: "and", nodes: [shared, shared] }), /cyclic or shared/);

  let deep: unknown = { type: "term", value: "x" };
  for (let i = 0; i < 20_000; i++) deep = { type: "not", node: deep };
  assert.throws(() => parseSearchQuery(deep), /nested at most/);
});

test("compiler uses literal instr for short terms and quoted FTS parameters for longer terms", () => {
  const short = compileQuery(parseSearchQuery("川"));
  assert.match(short.sql, /instr\(COALESCE/);
  assert.deepEqual(short.params, ["川"]);

  const long = compileQuery(parseSearchQuery('a"bc'));
  assert.match(long.sql, /images_fts MATCH \?/);
  assert.deepEqual(long.params, ['"a""bc"']);
});

test("positive terms account for NOT parity", () => {
  const ast = parseSearchQuery({
    type: "and",
    nodes: [
      { type: "term", value: "include" },
      { type: "not", node: { type: "term", value: "exclude" } },
      { type: "not", node: { type: "not", node: { type: "term", value: "double-negative" } } },
    ],
  });
  assert.deepEqual(extractPositiveTerms(ast), ["include", "double-negative"]);
});

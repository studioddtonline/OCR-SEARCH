/** Maximum complexity accepted for one structured search expression. */
export const MAX_QUERY_DEPTH = 8;
export const MAX_QUERY_NODES = 32;
export const MAX_QUERY_CHILDREN = 16;
export const MAX_QUERY_TERM_CODE_POINTS = 500;

export type QueryNode =
  | { type: "term"; value: string }
  | { type: "and" | "or"; nodes: QueryNode[] }
  | { type: "not"; node: QueryNode };

export class SearchQueryValidationError extends Error {
  readonly code = "SEARCH_QUERY_VALIDATION";
  constructor(message: string) {
    super(message);
    this.name = "SearchQueryValidationError";
  }
}

function codePointCountExceeds(value: string, maximum: number): boolean {
  let count = 0;
  for (const _character of value) {
    if (++count > maximum) return true;
  }
  return false;
}

/** Validate and normalize an unknown query without recursive traversal. */
export function parseSearchQuery(input: unknown): QueryNode {
  if (typeof input === "string") {
    const value = input.trim();
    if (!value) throw new SearchQueryValidationError("Search query must not be empty.");
    if (codePointCountExceeds(value, MAX_QUERY_TERM_CODE_POINTS)) {
      throw new SearchQueryValidationError(`A search term must contain at most ${MAX_QUERY_TERM_CODE_POINTS} Unicode code points.`);
    }
    return { type: "term", value };
  }

  type Visit = { kind: "visit"; input: unknown; depth: number; assign: (node: QueryNode) => void };
  type Finish = { kind: "finish"; finish: () => void };
  const stack: Array<Visit | Finish> = [];
  let root: QueryNode | undefined;
  let count = 0;
  const seen = new WeakSet<object>();
  stack.push({ kind: "visit", input, depth: 1, assign: node => { root = node; } });

  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.kind === "finish") { frame.finish(); continue; }
    if (frame.depth > MAX_QUERY_DEPTH) {
      throw new SearchQueryValidationError(`A structured search may be nested at most ${MAX_QUERY_DEPTH} levels deep.`);
    }
    if (++count > MAX_QUERY_NODES) {
      throw new SearchQueryValidationError(`A structured search may contain at most ${MAX_QUERY_NODES} nodes.`);
    }
    const raw = frame.input;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new SearchQueryValidationError("Each structured search node must be an object.");
    }
    if (seen.has(raw)) {
      throw new SearchQueryValidationError("A structured search must not contain cyclic or shared node objects.");
    }
    seen.add(raw);
    const object = raw as Record<string, unknown>;

    if (object.type === "term") {
      if (typeof object.value !== "string") throw new SearchQueryValidationError("A term node requires a string value.");
      const value = object.value.trim();
      if (!value) throw new SearchQueryValidationError("Search terms must not be empty.");
      if (codePointCountExceeds(value, MAX_QUERY_TERM_CODE_POINTS)) {
        throw new SearchQueryValidationError(`A search term must contain at most ${MAX_QUERY_TERM_CODE_POINTS} Unicode code points.`);
      }
      frame.assign({ type: "term", value });
      continue;
    }
    if (object.type === "not") {
      if (!("node" in object)) throw new SearchQueryValidationError("A NOT node requires a node property.");
      let child: QueryNode | undefined;
      stack.push({ kind: "finish", finish: () => {
        if (!child) throw new SearchQueryValidationError("A NOT node requires a child condition.");
        frame.assign({ type: "not", node: child });
      }});
      stack.push({ kind: "visit", input: object.node, depth: frame.depth + 1, assign: node => { child = node; }});
      continue;
    }
    if (object.type === "and" || object.type === "or") {
      if (!Array.isArray(object.nodes) || object.nodes.length < 2 || object.nodes.length > MAX_QUERY_CHILDREN) {
        throw new SearchQueryValidationError(`An ${String(object.type).toUpperCase()} node must contain 2 to ${MAX_QUERY_CHILDREN} child conditions.`);
      }
      const children = new Array<QueryNode>(object.nodes.length);
      stack.push({ kind: "finish", finish: () => {
        frame.assign({ type: object.type as "and" | "or", nodes: children });
      }});
      for (let i = object.nodes.length - 1; i >= 0; i--) {
        stack.push({ kind: "visit", input: object.nodes[i], depth: frame.depth + 1, assign: node => { children[i] = node; }});
      }
      continue;
    }
    throw new SearchQueryValidationError("A structured search node type must be term, and, or, or not.");
  }

  if (!root) throw new SearchQueryValidationError("A search query is required.");
  if (extractPositiveTerms(root).length === 0) {
    throw new SearchQueryValidationError("A search must contain at least one positive term; NOT-only searches are not allowed.");
  }
  return root;
}

/** Terms beneath an even number of NOT nodes, used for snippet positioning. */
export function extractPositiveTerms(node: QueryNode, negated = false): string[] {
  switch (node.type) {
    case "term": return negated ? [] : [node.value];
    case "and":
    case "or": return node.nodes.flatMap(child => extractPositiveTerms(child, negated));
    case "not": return extractPositiveTerms(node.node, !negated);
  }
}

export interface CompiledQuery {
  sql: string;
  params: Array<string | number>;
}

export function compileQuery(node: QueryNode): CompiledQuery {
  switch (node.type) {
    case "term": return compileTerm(node.value);
    case "and":
    case "or": {
      const children = node.nodes.map(compileQuery);
      const operator = node.type === "and" ? "AND" : "OR";
      return {
        sql: `(${children.map(child => `(${child.sql})`).join(` ${operator} `)})`,
        params: children.flatMap(child => child.params),
      };
    }
    case "not": {
      const child = compileQuery(node.node);
      return { sql: `(NOT (${child.sql}))`, params: child.params };
    }
  }
}

function compileTerm(value: string): CompiledQuery {
  if (!codePointCountExceeds(value, 2)) {
    return { sql: "instr(COALESCE(si.ocr_text, ''), ?) > 0", params: [value] };
  }
  return {
    sql: "si.id IN (SELECT rowid FROM images_fts WHERE images_fts MATCH ?)",
    params: [`"${value.replaceAll('"', '""')}"`],
  };
}

import type { QueryNode } from "./query.js";

function codePointCountExceeds(value: string, maximum: number): boolean {
  let count = 0;
  for (const _character of value) {
    if (++count > maximum) return true;
  }
  return false;
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

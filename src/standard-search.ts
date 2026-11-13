import type { DatabaseSync } from "node:sqlite";
import { SearchCancelledError, SearchQueryError, SearchUnavailableError } from "./errors.js";
import { compileQuery, extractPositiveTerms, parseSearchQuery, SearchQueryValidationError, type QueryNode } from "./query.js";
import { reviewedSqlPredicate } from "./reviewed.js";

export interface StandardSearchRequest {
  query: unknown;
  label?: string;
  reviewed?: boolean;
  limit?: number;
  offset?: number;
  afterId?: number;
}
export interface StandardSearchOptions {
  defaultLimit?: number;
  maxLimit?: number;
  snippetLength?: number;
}
export interface StandardSearchHit {
  id: number;
  file_path: string | null;
  file_name: string | null;
  reviewed: number | null;
  snippet: string;
}
export interface StandardSearchResult {
  results: StandardSearchHit[];
  returned: number;
  offset: number;
  limit: number;
  nextAfterId: number | null;
}
const MAX_PREPARED_STATEMENTS = 64;

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function validateOptions(options: StandardSearchOptions): Required<StandardSearchOptions> {
  const maxLimit = options.maxLimit ?? 50;
  const defaultLimit = options.defaultLimit ?? Math.min(20, maxLimit);
  const snippetLength = options.snippetLength ?? 160;
  if (!positiveSafeInteger(maxLimit) || maxLimit > 100 ||
      !positiveSafeInteger(defaultLimit) || defaultLimit > 50 || defaultLimit > maxLimit) {
    throw new SearchQueryValidationError("Search limit configuration is invalid.");
  }
  if (!positiveSafeInteger(snippetLength) || snippetLength < 40 || snippetLength > 1000) {
    throw new SearchQueryValidationError("Snippet length configuration must be between 40 and 1000.");
  }
  return { defaultLimit, maxLimit, snippetLength };
}
function validateRequest(request: StandardSearchRequest, config: Required<StandardSearchOptions>) {
  const limit = request.limit ?? config.defaultLimit;
  const offset = request.offset ?? 0;
  if (!positiveSafeInteger(limit) || limit > config.maxLimit) {
    throw new SearchQueryValidationError(`Search limit must be a positive integer no greater than ${config.maxLimit}.`);
  }
  if (!nonNegativeSafeInteger(offset) || offset > 1_000_000) {
    throw new SearchQueryValidationError("Search offset must be an integer between 0 and 1000000.");
  }
  if (request.afterId !== undefined && !positiveSafeInteger(request.afterId)) {
    throw new SearchQueryValidationError("afterId must be a positive safe integer.");
  }
  if (request.afterId !== undefined && offset !== 0) {
    throw new SearchQueryValidationError("Use afterId or offset for search pagination, not both.");
  }
  if (request.label !== undefined && typeof request.label !== "string") {
    throw new SearchQueryValidationError("Search label must be a string.");
  }
  if (request.reviewed !== undefined && typeof request.reviewed !== "boolean") {
    throw new SearchQueryValidationError("reviewed must be a boolean.");
  }
  return { limit, offset };
}

function isHighSurrogate(value: number) { return value >= 0xd800 && value <= 0xdbff; }
function isLowSurrogate(value: number) { return value >= 0xdc00 && value <= 0xdfff; }
function safeSliceBounds(text: string, requestedStart: number, requestedEnd: number, expandEnd: boolean): [number, number] {
  let start = Math.max(0, Math.min(text.length, requestedStart));
  let end = Math.max(start, Math.min(text.length, requestedEnd));
  const splitsStart = start > 0 && start < text.length && isHighSurrogate(text.charCodeAt(start - 1)) && isLowSurrogate(text.charCodeAt(start));
  const splitsEnd = end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end));
  if (splitsStart) start -= 1;
  if (splitsEnd) end += expandEnd ? 1 : -1;
  return [start, end];
}
function safeSlice(text: string, start: number, end: number, expandEnd = false): string {
  const [safeStart, safeEnd] = safeSliceBounds(text, start, end, expandEnd);
  return text.slice(safeStart, safeEnd);
}
function caseInsensitiveLookup(text: string): (term: string) => number {
  const folded = text.toLowerCase();
  if (folded.length === text.length) return term => folded.indexOf(term.toLowerCase());
  const sourceOffsets: number[] = [];
  let sourceOffset = 0;
  for (const character of text) {
    const lower = character.toLowerCase();
    for (let i = 0; i < lower.length; i++) sourceOffsets.push(sourceOffset);
    sourceOffset += character.length;
  }
  return term => {
    const index = folded.indexOf(term.toLowerCase());
    return index < 0 ? -1 : (sourceOffsets[index] ?? -1);
  };
}
function makeSnippet(text: string | null, terms: string[], maxLength: number): string {
  if (!text) return "";
  const matches = terms.map(term => ({ term, index: text.indexOf(term) }))
    .filter(match => match.index >= 0)
    .sort((a, b) => a.index - b.index || b.term.length - a.term.length);
  let index = matches[0]?.index ?? -1;
  if (index < 0 && terms.length) {
    const find = caseInsensitiveLookup(text);
    for (const term of terms) {
      const candidate = find(term);
      if (candidate >= 0 && (index < 0 || candidate < index)) index = candidate;
    }
  }
  if (index < 0) return safeSlice(text, 0, maxLength, true);
  const start = Math.max(0, index - Math.floor(maxLength / 3));
  const end = Math.min(text.length, start + maxLength);
  const [safeStart, safeEnd] = safeSliceBounds(text, start, end, true);
  return `${safeStart > 0 ? "…" : ""}${text.slice(safeStart, safeEnd)}${safeEnd < text.length ? "…" : ""}`;
}

export class StandardSearchRepository {
  private readonly prepared = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private readonly config: Required<StandardSearchOptions>;
  private closed = false;

  constructor(private readonly db: DatabaseSync, options: StandardSearchOptions = {}) {
    this.config = validateOptions(options);
  }

  async search(request: StandardSearchRequest, signal?: AbortSignal): Promise<StandardSearchResult> {
    if (this.closed) throw new SearchUnavailableError("Search instance is closed.");
    if (signal?.aborted) throw new SearchCancelledError();
    const { limit, offset } = validateRequest(request, this.config);
    let ast: QueryNode;
    try { ast = parseSearchQuery(request.query); }
    catch (cause) {
      if (cause instanceof SearchQueryValidationError) throw cause;
      throw new SearchQueryValidationError("Search query is invalid.", { cause });
    }
    const compiled = compileQuery(ast);
    const terms = [...new Set(extractPositiveTerms(ast))];
    const clauses = [compiled.sql];
    const params: Array<string | number> = [...compiled.params];
    if (request.label !== undefined) { clauses.push("si.file_path = ?"); params.push(request.label); }
    if (request.reviewed !== undefined) clauses.push(reviewedSqlPredicate("si.reviewed", request.reviewed));
    if (request.afterId !== undefined) { clauses.push("si.id > ?"); params.push(request.afterId); }
    params.push(limit + 1);
    const offsetClause = request.afterId === undefined ? "OFFSET ?" : "";
    if (request.afterId === undefined) params.push(offset);

    try {
      const rows = this.statement(`
        SELECT si.id, si.file_path, si.file_name, si.reviewed, si.ocr_text
        FROM source_images AS si
        WHERE ${clauses.join(" AND ")}
        ORDER BY si.id ASC
        LIMIT ? ${offsetClause}
      `).all(...params) as Array<{
        id: number; file_path: string | null; file_name: string | null;
        reviewed: number | null; ocr_text: string | null;
      }>;
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const results = pageRows.map(row => ({
        id: row.id, file_path: row.file_path, file_name: row.file_name,
        reviewed: row.reviewed, snippet: makeSnippet(row.ocr_text, terms, this.config.snippetLength),
      }));
      return {
        results, returned: results.length, offset, limit,
        nextAfterId: hasMore && results.length ? results[results.length - 1]!.id : null,
      };
    } catch (cause) {
      throw new SearchQueryError("Search could not be completed.", { cause });
    }
  }

  close(): void {
    this.closed = true;
    this.prepared.clear();
    // The DatabaseSync belongs to the caller and is deliberately not closed.
  }

  private statement(sql: string): ReturnType<DatabaseSync["prepare"]> {
    let statement = this.prepared.get(sql);
    if (statement) {
      this.prepared.delete(sql);
      this.prepared.set(sql, statement);
      return statement;
    }
    if (this.prepared.size >= MAX_PREPARED_STATEMENTS) {
      const oldest = this.prepared.keys().next().value;
      if (oldest !== undefined) this.prepared.delete(oldest);
    }
    statement = this.db.prepare(sql);
    this.prepared.set(sql, statement);
    return statement;
  }
}

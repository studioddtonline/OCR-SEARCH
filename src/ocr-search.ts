import type { DatabaseSync } from "node:sqlite";
import { SearchQueryValidationError } from "./query.js";
import { StandardSearchRepository, type StandardSearchOptions, type StandardSearchRequest, type StandardSearchResult } from "./standard-search.js";
import { assertSearchDatabaseCompatible } from "./testing.js";
import { JapaneseSearchRepository, type JapaneseSearchOptions, type JapaneseSearchRequest } from "./japanese/repository.js";

export interface OcrSearchOptions {
  /** Caller-owned OCR database connection. OCR-SEARCH never closes it. */
  database: DatabaseSync;
  standard?: StandardSearchOptions;
  /** Omit to disable Japanese search and avoid loading its native model. */
  japanese?: JapaneseSearchOptions;
}
export interface JapaneseSearchInput {
  query: string;
  mode?: "any" | "all";
  label?: string;
  reviewed?: boolean;
  limit?: number;
  offset?: number;
}
export type JapaneseSearchResult = Awaited<ReturnType<JapaneseSearchRepository["search"]>>;

/** Unified search facade. The caller owns and must close the supplied source database. */
export class OcrSearch {
  private readonly standard: StandardSearchRepository;
  private readonly japanese: JapaneseSearchRepository | undefined;
  private closed = false;

  constructor(options: OcrSearchOptions) {
    assertSearchDatabaseCompatible(options.database);
    this.standard = new StandardSearchRepository(options.database, options.standard);
    if (options.japanese) this.japanese = JapaneseSearchRepository.open(options.japanese);
  }

  search(request: StandardSearchRequest, signal?: AbortSignal): Promise<StandardSearchResult> {
    if (this.closed) return Promise.reject(new Error("Search instance is closed."));
    return this.standard.search(request, signal);
  }

  searchJapanese(input: JapaneseSearchInput, signal?: AbortSignal): Promise<JapaneseSearchResult> {
    if (this.closed) return Promise.reject(new Error("Search instance is closed."));
    if (!this.japanese) return Promise.reject(new Error("Japanese search is not enabled."));
    if (typeof input.query !== "string" || !input.query.trim()) {
      return Promise.reject(new SearchQueryValidationError("Japanese search query must not be empty."));
    }
    const query = input.query.trim();
    let codePoints = 0;
    for (const _character of query) if (++codePoints > 500) {
      return Promise.reject(new SearchQueryValidationError("Japanese search query must contain at most 500 Unicode code points."));
    }
    const mode = input.mode ?? "any";
    if (mode !== "any" && mode !== "all") {
      return Promise.reject(new SearchQueryValidationError("Japanese search mode must be any or all."));
    }
    const maxLimit = this.japaneseMaxLimit;
    const limit = input.limit ?? 20;
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
      return Promise.reject(new SearchQueryValidationError(`Japanese search limit must be an integer from 1 to ${maxLimit}.`));
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
      return Promise.reject(new SearchQueryValidationError("Japanese search offset must be an integer from 0 to 100000."));
    }
    if (input.label !== undefined && typeof input.label !== "string") {
      return Promise.reject(new SearchQueryValidationError("Japanese search label must be a string."));
    }
    if (input.reviewed !== undefined && typeof input.reviewed !== "boolean") {
      return Promise.reject(new SearchQueryValidationError("reviewed must be a boolean."));
    }
    const request: JapaneseSearchRequest = { query, mode, limit, offset, ...(input.label === undefined ? {} : { label: input.label }), ...(input.reviewed === undefined ? {} : { reviewed: input.reviewed }) };
    return this.japanese.search(request, signal);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.standard.close();
    this.japanese?.close();
  }

  private get japaneseMaxLimit(): number {
    // The repository validates its worker requests against the configured maxLimit.
    return (this.japanese as unknown as { options?: { maxLimit?: number } }).options?.maxLimit ?? 20;
  }
}

export function createOcrSearch(options: OcrSearchOptions): OcrSearch {
  return new OcrSearch(options);
}

import type { DatabaseSync } from "node:sqlite";
import { SearchQueryValidationError } from "./query.js";
import { SearchUnavailableError } from "./errors.js";
import { StandardSearchRepository, type StandardSearchOptions, type StandardSearchRequest, type StandardSearchResult } from "./standard-search.js";
import { assertSearchDatabaseCompatible } from "./testing.js";
import { JapaneseSearchRepository, type JapaneseSearchOptions, type JapaneseSearchRequest } from "./japanese/repository.js";
import { makeJapaneseSnippet } from "./japanese/snippet.js";

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
export interface JapaneseSearchResult {
  query: string;
  mode: "any" | "all";
  queryTokens: string[];
  returned: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  index: {
    tokenizer: string;
    indexedAt: string;
    indexedRecords: number;
    sourceMaxId: number;
  };
  results: Array<{
    id: number;
    label: string | null;
    fileName: string | null;
    reviewed: number | null;
    score: number;
    snippet: string;
  }>;
}

/** Unified search facade. The caller owns and must close the supplied source database. */
export class OcrSearch {
  private readonly standard: StandardSearchRepository;
  private readonly japanese: JapaneseSearchRepository | undefined;
  private readonly japaneseMaxLimit: number;
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(options: OcrSearchOptions) {
    assertSearchDatabaseCompatible(options.database);
    this.database = options.database;
    this.standard = new StandardSearchRepository(options.database, options.standard);
    this.japaneseMaxLimit = options.japanese?.maxLimit ?? 20;
    if (options.japanese) {
      if (!Number.isSafeInteger(options.japanese.maxLimit) || options.japanese.maxLimit < 1 || options.japanese.maxLimit > 50) {
        throw new SearchQueryValidationError("Japanese search maxLimit must be an integer from 1 to 50.");
      }
      if (!Number.isSafeInteger(options.japanese.busyTimeoutMs) || options.japanese.busyTimeoutMs < 0 || options.japanese.busyTimeoutMs > 120000) {
        throw new SearchQueryValidationError("Japanese search busyTimeoutMs must be an integer from 0 to 120000.");
      }
      this.japanese = JapaneseSearchRepository.open(options.japanese);
    }
  }

  search(request: StandardSearchRequest, signal?: AbortSignal): Promise<StandardSearchResult> {
    if (this.closed) return Promise.reject(new SearchUnavailableError("Search instance is closed."));
    return this.standard.search(request, signal);
  }

  async searchJapanese(input: JapaneseSearchInput, signal?: AbortSignal): Promise<JapaneseSearchResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new SearchQueryValidationError("Japanese search request must be an object.");
    }
    if (this.closed) throw new SearchUnavailableError("Search instance is closed.");
    if (!this.japanese) throw new SearchUnavailableError("Japanese search is not enabled.");
    if (typeof input.query !== "string" || !input.query.trim()) {
      throw new SearchQueryValidationError("Japanese search query must not be empty.");
    }
    const query = input.query.trim();
    if (query.length > 500) {
      throw new SearchQueryValidationError("Japanese search query must contain at most 500 UTF-16 code units.");
    }
    const mode = input.mode ?? "any";
    if (mode !== "any" && mode !== "all") {
      throw new SearchQueryValidationError("Japanese search mode must be any or all.");
    }
    const maxLimit = this.japaneseMaxLimit;
    const limit = input.limit ?? Math.min(20, maxLimit);
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
      throw new SearchQueryValidationError(`Japanese search limit must be an integer from 1 to ${maxLimit}.`);
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
      throw new SearchQueryValidationError("Japanese search offset must be an integer from 0 to 100000.");
    }
    if (input.label !== undefined && typeof input.label !== "string") {
      throw new SearchQueryValidationError("Japanese search label must be a string.");
    }
    if (input.reviewed !== undefined && typeof input.reviewed !== "boolean") {
      throw new SearchQueryValidationError("reviewed must be a boolean.");
    }

    const results: JapaneseSearchResult["results"] = [];
    let cursor = offset;
    let nextOffset: number | null = null;
    let metadata: JapaneseSearchResult["index"] | undefined;
    let queryTokens: string[] = [];

    // The index determines candidate IDs and BM25 order. Current labels, filenames,
    // review flags and OCR text always come from the caller-owned source database.
    while (results.length < limit) {
      const remaining = limit - results.length;
      const batchRequest: JapaneseSearchRequest = {
        query,
        mode,
        limit: remaining,
        offset: cursor,
      };
      const batch = await this.japanese.search(batchRequest, signal) as JapaneseSearchResult;
      metadata ??= batch.index;
      queryTokens = batch.queryTokens;

      if (batch.results.length > 0) {
        const ids = batch.results.map((row) => row.id);
        const placeholders = ids.map(() => "?").join(", ");
        const sourceRows = this.database.prepare(`
          SELECT id, file_path, file_name, reviewed, ocr_text
          FROM source_images
          WHERE id IN (${placeholders})
        `).all(...ids) as Array<{
          id: number;
          file_path: string | null;
          file_name: string | null;
          reviewed: number | null;
          ocr_text: string | null;
        }>;
        const byId = new Map(sourceRows.map((row) => [row.id, row]));

        for (const candidate of batch.results) {
          const source = byId.get(candidate.id);
          // Records deleted after the snapshot was built are no longer returned.
          if (!source) continue;
          if (input.label !== undefined && source.file_path !== input.label) continue;
          // Match the shared reviewed contract: only zero is unreviewed; NULL and
          // every non-zero value are protected/reviewed.
          if (input.reviewed !== undefined && (source.reviewed !== 0) !== input.reviewed) continue;
          results.push({
            id: candidate.id,
            label: source.file_path,
            fileName: source.file_name,
            reviewed: source.reviewed,
            score: candidate.score,
            snippet: makeJapaneseSnippet(source.ocr_text, queryTokens),
          });
        }
      }

      nextOffset = batch.nextOffset;
      if (nextOffset === null || results.length >= limit) break;
      cursor = nextOffset;
    }

    return {
      query,
      mode,
      queryTokens,
      returned: results.length,
      limit,
      offset,
      nextOffset,
      index: metadata ?? {
        tokenizer: "",
        indexedAt: "",
        indexedRecords: 0,
        sourceMaxId: 0,
      },
      results,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.standard.close();
    this.japanese?.close();
  }

}

export function createOcrSearch(options: OcrSearchOptions): OcrSearch {
  return new OcrSearch(options);
}

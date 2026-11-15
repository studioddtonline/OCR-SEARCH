export interface OcrSearchErrorOptions extends ErrorOptions {
  /** Whether retrying the same operation later may succeed. Defaults to false. */
  retryable?: boolean;
}

/** Stable base class for every expected OCR-SEARCH failure. */
export class OcrSearchError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, options: OcrSearchErrorOptions = {}) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export class SearchUnavailableError extends OcrSearchError {
  constructor(message = "Search is unavailable", options?: OcrSearchErrorOptions) {
    super(message, "SEARCH_UNAVAILABLE", options);
  }
}

export class SearchCancelledError extends OcrSearchError {
  constructor(message = "Search was cancelled") {
    super(message, "SEARCH_CANCELLED");
  }
}

export class SearchQueryError extends OcrSearchError {
  constructor(message = "Search could not be completed", options?: OcrSearchErrorOptions) {
    super(message, "SEARCH_QUERY_FAILED", options);
  }
}

export class SearchWorkerError extends OcrSearchError {
  constructor(message = "Japanese search failed", options?: OcrSearchErrorOptions) {
    super(message, "SEARCH_WORKER_FAILED", {
      ...options,
      retryable: options?.retryable ?? true,
    });
  }
}

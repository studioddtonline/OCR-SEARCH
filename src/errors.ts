export class SearchUnavailableError extends Error {
  readonly code = "SEARCH_UNAVAILABLE";
  constructor(message = "Search is unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "SearchUnavailableError";
  }
}

export class SearchCancelledError extends Error {
  readonly code = "SEARCH_CANCELLED";
  constructor(message = "Search was cancelled") {
    super(message);
    this.name = "SearchCancelledError";
  }
}

export class SearchQueryError extends Error {
  readonly code = "SEARCH_QUERY_FAILED";
  constructor(message = "Search could not be completed", options?: ErrorOptions) {
    super(message, options);
    this.name = "SearchQueryError";
  }
}

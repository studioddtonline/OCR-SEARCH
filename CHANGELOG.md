# Changelog

Notable changes to OCR-SEARCH are recorded here. Versions are released from the matching `v<version>` Git tag.

<!-- Before creating the v0.4.0 tag, change the heading below to the exact form: ## 0.4.0 -->

## 0.4.0

### Breaking changes

- Queue saturation now throws `SearchBusyError` (`SEARCH_BUSY`) instead of `SearchWorkerError`; `SearchBusyError` is not a subclass of `SearchWorkerError`.
- Requests made after the Japanese Worker reaches the terminal `dead` state now throw `SearchUnavailableError` instead of `SearchWorkerError`.
- Punctuation-only Japanese queries now throw `SearchQueryValidationError` instead of `SearchWorkerError`.

### Added

- `OcrSearch.ready(signal?)` supports per-caller cancellation. Cancelling one waiter removes only that waiter; an already-starting Worker continues, and remaining waiters/searches retain recovery demand.
- Retry backoff uses an absolute monotonic deadline that survives cancellation of the timer when demand temporarily disappears. Repeated short readiness deadlines cannot indefinitely postpone a pending restart.
- `japaneseEnabled` exposes whether Japanese search was configured. Disabled, dead, and closed Japanese search states use `SearchUnavailableError` consistently.
- Configurable `maxPendingRequests` (1–64, default 4) and retryable `SearchBusyError` (`SEARCH_BUSY`) distinguish queue saturation from Worker failures.
- `SearchCancelledError.cause` preserves the originating AbortSignal reason. Punctuation-only Japanese queries use `SearchQueryValidationError`.
- Synchronous transient Worker factory failures enter the bounded retry path. The packaged Worker script is checked during construction so a missing runtime asset remains a deterministic construction error.

### Changed

- Japanese readiness now rejects with `SearchUnavailableError` when Japanese search is disabled; use `japaneseEnabled` to inspect configuration.
- Japanese search queue capacity is documented as a low-resource concurrency guard, not a throughput control.

## 0.3.1

### Fixed

- `OcrSearch.ready()` now waits for an available Japanese Worker rather than permanently reflecting only the first Worker generation. A pending `ready()` call is recovery demand: startup `error`, unexpected `exit`, and startup-timeout failures trigger recovery using the same restart counter, exponential backoff, and maximum-attempt limit as queued searches. Concurrent callers share the same Worker startup. All waiters resolve when a Worker reaches `ready`, and reject when the shared retry limit is exhausted, a deterministic `startup-error` is reported, or the repository is closed.
- The production FTS5 compatibility validator accepts valid quoted, unquoted, and mixed quoted/unquoted forms of `content=source_images` and `content_rowid=id`, while requiring the complete option value.
- Restored the public root type exports `StandardSearchOptions`, `StandardSearchRequest`, and `StandardSearchResult`, which are used by the public `OcrSearch.search()` signature.

### Documentation and packaging

- Added migration notes for the 0.3.0 API changes.
- Limited packaged documentation to `docs/japanese-search.md`; development regression baselines and test matrices are no longer included in the package tarball.

## 0.3.0

### Breaking changes

- Internal SQL implementation details were removed from the package root exports: `compileQuery`, `CompiledQuery`, and `StandardSearchRepository` are no longer public root exports. The database compatibility assertion is available from the `ocr-search/testing` subpath rather than the package root.
- Standard-search implementation types (`StandardSearchOptions`, `StandardSearchRequest`, and `StandardSearchResult`) were also absent from the root export surface in this release. Version 0.3.1 restores these three types because they form part of the public `OcrSearch.search()` method signature. The internal repository and SQL compiler remain unexported.
- Japanese cancellation now reports `SearchCancelledError` (code `SEARCH_CANCELLED`) instead of being represented as a generic worker failure.
- Startup now validates that `images_fts` is an FTS5 external-content table mapped to `source_images` with `content_rowid=id`. Databases with a different mapping fail during `OcrSearch` construction.

### Added

- Stable `OcrSearchError` base class with `code` and `retryable` properties, plus specialized search error classes.
- `OcrSearch.ready()` for waiting on optional Japanese Worker initialization.
- Japanese query length validation based on Unicode code points (maximum 500), rather than UTF-16 code units.
- Standard search excludes rows whose `ocr_text` is `NULL`, including under nested boolean query expressions.

# Japanese full-text search with sqlite-vaporetto

OCR-SEARCH provides optional Japanese token search using a separate FTS5 index and a dedicated Worker. Vaporetto segments Japanese text during the offline index build and query processing. The index uses FTS5's built-in `unicode61` tokenizer over strings whose Vaporetto word boundaries have already been made explicit. This keeps the large model out of the standard-search path and avoids changing the source OCR database's `images_fts` table.

The package ships installation and index-building scripts, not the upstream native binary. The installer is pinned to upstream release `v0.4.0` and verifies the archive SHA-256 before extraction. The selected `-with-model` release embeds `bccwj-suw+unidic_pos+kana.model.zst`; no separate model file is required.

## 1. Install the native extension

From the OCR-SEARCH project root:

```bash
npm run japanese-extension:install
npm run japanese-extension:check
```

The installer supports Linux `x86_64` and `aarch64`. It places the extension at:

```text
native/sqlite-vaporetto/libsqlite_vaporetto.so
```

For another operating system or architecture, obtain the matching official release asset or build from the upstream repository. Do not load a native library from an untrusted source.

## 2. Build the dedicated index

All paths are explicit. OCR-SEARCH does not read consumer config files or infer the source DB path.

```bash
npm run japanese-index -- \
  --database=/absolute/path/ocr.sqlite \
  --index=/absolute/path/ocr-japanese-search.sqlite \
  --extension=/absolute/path/native/sqlite-vaporetto/libsqlite_vaporetto.so
```

Optional: `--busy-timeout-ms=500` (integer 0–120000).

The builder opens the source OCR database read-only, validates the required `source_images` columns, and copies the current read snapshot into a staging SQLite database. It tokenizes each OCR text with Vaporetto and inserts the terms into a contentless FTS5 table using `unicode61`. Original OCR text and review metadata are copied into `japanese_documents` for search results and snippets; the FTS table stores the search index. The source database is never modified.

The build is an offline maintenance operation. It can consume CPU and take time on a large OCR collection; progress is printed every 1,000 records. The source reader holds a consistent read snapshot while copying. With rollback-journal mode, that snapshot may delay concurrent source writes, so run the initial build/rebuild when the OCR writer is idle.

The generated index uses schema version 2. The builder writes to a staging file, validates it, closes it, and renames it over the target. If the build or validation fails, the previous index remains in place. Keep enough disk space for the staging index alongside the previous index.

## 3. Enable Japanese search in an application

Pass the source DB connection and Japanese index configuration to the unified API:

```ts
import { DatabaseSync } from "node:sqlite";
import { OcrSearch } from "ocr-search";

const database = new DatabaseSync("/absolute/path/ocr.sqlite", { readOnly: true });
const search = new OcrSearch({
  database,
  japanese: {
    indexPath: "/absolute/path/ocr-japanese-search.sqlite",
    extensionPath: "/absolute/path/libsqlite_vaporetto.so",
    busyTimeoutMs: 500,
    maxLimit: 20,
  },
});

try {
  const result = await search.searchJapanese({
    query: "吾輩は猫である",
    mode: "any",
    limit: 20,
    offset: 0,
  });
  console.log(result);
} finally {
  search.close(); // Terminates the package-owned Japanese Worker.
  database.close(); // The source DB connection remains consumer-owned.
}
```

Omit the `japanese` option to disable Japanese search. The standard-search API does not start a Worker or load the Vaporetto model.

The CLI also supports explicit Japanese search:

```bash
ocr-search search-japanese \
  --database=/absolute/path/ocr.sqlite \
  --index=/absolute/path/ocr-japanese-search.sqlite \
  --extension=/absolute/path/libsqlite_vaporetto.so \
  --query="吾輩は猫である"
```

The CLI prints an initialization message because the Worker must load the native extension and warm the Vaporetto query tokenizer. Model initialization can take several seconds and substantial memory.

## 4. Worker lifecycle

When Japanese search is configured, OCR-SEARCH launches one dedicated Worker. The Worker loads the native extension, warms the Vaporetto query-side tokenizer once, validates the schema-v2 FTS5 index, then signals readiness asynchronously. Extension loading is disabled on the SQLite connection immediately after loading the trusted library.

- Startup deadline: 180 seconds.
- Search requests are dispatched one at a time in FIFO order.
- Maximum active + queued requests: 4.
- Queue-wait deadline: 180 seconds from enqueue until dispatch.
- Execution deadline: 20 seconds, starting only after the Worker reports that a query has started.
- Automatic restarts use exponential backoff (250 ms base, capped at 8 seconds), with at most five consecutive startup failures before the Worker reaches `ready`.
- Reaching `ready` resets the startup-failure counter. Execution timeouts and failures after `ready` do not consume that budget.
- An idle Worker failure does not trigger background restarts; the next request starts recovery.
- `startup-error`, startup deadline, and exhausted restart attempts fail closed. After the restart limit is reached, restart the consumer process.

## 5. Search inputs and semantics

- `query` (required): Japanese text, 1–500 UTF-16 code units after trimming.
- `mode`: `any` (default) or `all`. `any` ORs searchable Vaporetto tokens for broader recall; `all` requires every searchable token.
- `label`: optional exact `source_images.file_path` label.
- `reviewed`: optional review-state filter.
- `limit`: 1 to configured `maxLimit` (default is `Math.min(20, maxLimit)`).
- `offset`: relevance-ranked pagination offset, capped at 100,000.

The result includes query tokens, snippets generated from the current source OCR text with best-effort match highlighting, source IDs, current labels, file names and review states, BM25 scores from the snapshot index, index metadata including `indexedAt`, and `nextOffset` when another page exists. Label and reviewed filters are applied to current source rows. If snapshot candidates have been deleted from the source DB or no longer match current filters, the reader continues through later index candidates to fill the requested page when possible. BM25 scores are lower for better matches. Highlighting is substring-based and may be approximate where a query token occurs inside a longer OCR word.

**Important:** Vaporetto is a Japanese word tokenizer, not a character-substring index. A one-character query is not guaranteed to find that character inside every longer token. Use standard search when exact short-substring matching is required: 1–2 Unicode-code-point terms use case-sensitive literal substring matching; terms of 3+ code points use the source FTS5 trigram phrase index. Standard search can combine these terms with nested AND/OR/NOT expressions. The one- and two-character path scans the source OCR table and can cost more than indexed searches; it does not depend on the Japanese snapshot index and does not apply Unicode normalization.

## 6. Index freshness and restart policy

The Japanese index is a snapshot used for candidate discovery and BM25 ranking. Displayed OCR text, label, file name, and reviewed state are hydrated from the current source DB at search time. Deleted source rows are omitted. Label and reviewed filters use current source values. However, adding records or changing OCR text does not rebuild the index: new content is not discoverable until reindexing, and changed text can temporarily remain or disappear as a candidate according to the old snapshot. `indexedAt` identifies the snapshot age.

Rebuild the index after adding OCR records, changing OCR text, changing review state, or changing the source DB schema:

```bash
npm run japanese-index -- \
  --database=/absolute/path/ocr.sqlite \
  --index=/absolute/path/ocr-japanese-search.sqlite \
  --extension=/absolute/path/libsqlite_vaporetto.so
```

After rebuilding/replacing the index, restart every consumer process so its Worker opens a fresh SQLite connection. An already-open SQLite handle continues reading the old file after atomic replacement; a new connection sees the replacement. OCR-SEARCH does not hot-swap or reconnect the index.

## 7. License and security notes

The upstream extension is licensed `MIT OR Apache-2.0`. The `-with-model` release also bundles a model licensed under `BSD-3-Clause`; preserve the upstream license notices beside the installed extension. Source and release assets: https://github.com/hotchpotch/sqlite-vaporetto.

The installer verifies the pinned release SHA-256 before extraction. The Worker loads the extension only from the configured path, validates the index during startup, and disables extension loading after loading the trusted library. The Japanese index is opened read-only by the Worker; only the maintenance builder creates or replaces this snapshot.

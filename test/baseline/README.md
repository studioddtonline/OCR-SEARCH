# Pinned source implementation for baseline comparison

These files are isolated test-only snapshots from OCR-MCP-SERVER commit
`d9f23b0a7870ea267670bcf27208942172e27563`. They are not production code and
must not be imported by `src/`.

| Snapshot | Source path | Source blob SHA |
|---|---|---|
| `query.ts` | `src/features/ocr/query.ts` | `072835e821ff837db5f14f69fa514da75fbc6859` |
| `repository.ts` | `src/features/ocr/repository.ts` | `22bbb0accdd3fff7a8e96deb992c6de91e7cc3e7` |
| `reviewed.mjs` | `src/features/ocr/reviewed.mjs` | `37fd97ec95d20b255250768d298e695c922392a8` |
| `japanese-worker.mjs` | `src/features/japanese-search/worker.mjs` | `4f3ce2e0695edb0c5a99efdcbb20372453415617` |

Only the following adaptations were made:
- Removed the Zod boundary schemas from the query snapshot; parser/compiler implementation is retained.
- Replaced the MCP `ClientSafeError` import with a test-local class of the same name and constructor behavior.
- Kept the source repository's SQL, query semantics, ordering, pagination, prepared-statement cache, and snippet implementation unchanged.
- The Japanese Worker snapshot is byte-for-byte identical after normalizing only the relative path to the package-local reviewed helper; `test/japanese-worker-equivalence.test.ts` enforces this.

`test/baseline-equivalence.test.ts` runs both implementations against separate SQLite databases built from the same pinned scenario fixture, then compares the complete standard-search result object. Do not update these snapshots when the production package changes. To update the baseline, pin a new source commit and record the reason and new blob SHAs in a separate change.

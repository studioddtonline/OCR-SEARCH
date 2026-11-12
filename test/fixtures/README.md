# Regression fixture inventory

The fixture files in this directory are pinned to OCR-MCP-SERVER commit
`d9f23b0a7870ea267670bcf27208942172e27563`.

- `standard-search-baseline.json`: scenario-specific source rows and result-ID / pagination expectations from `src/features/ocr/repository.test.ts`.
- `japanese-search-baseline.json`: real-extension index metadata, source document, and assertions from the Japanese Worker integration test.

These are data fixtures, not executable tests. The parser/compiler rejection cases,
prepared-statement LRU assertions, Worker lifecycle state-machine tests, and
DB-contract validator cases must be ported as executable tests from the pinned
source files. Keep the baseline commit and fixture contents fixed while extracting.

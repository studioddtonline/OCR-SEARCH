# Standard-search baseline fixtures

These fixture cases are transcribed from the standard-search tests in
`studioddtonline/OCR-MCP-SERVER` at commit
`d9f23b0a7870ea267670bcf27208942172e27563`.

- Source test blob: `5724b74e6e2db0bfe838bfafadeaa0c6e2cdefe0`
- Fixture data is intentionally scenario-scoped. Each case creates its own
  `source_images` / `images_fts` database so row IDs and expected results
  match the source tests exactly.
- `expectedIds` and `nextAfterId` are source assertions, not newly inferred
  expected behavior.
- Snippet fields marked `snippetMustContain` or `snippetMustNotEqual`
  preserve the source test's assertion strength. They are not full golden
  snippet snapshots.
- Cases for parser rejection and prepared-statement LRU behavior remain code
  tests rather than row fixtures; port those assertions directly from the
  pinned source test.
- Do not update these fixtures to accommodate an OCR-SEARCH implementation
  change. A deliberate baseline change requires a separate review and commit.

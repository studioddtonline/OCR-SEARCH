# Regression fixture inventory

The fixture files in this directory are pinned to OCR-MCP-SERVER commit
`d9f23b0a7870ea267670bcf27208942172e27563`.

- `standard-search-baseline.json`: scenario-specific source rows and result-ID / pagination expectations from `src/features/ocr/repository.test.ts`.
- `japanese-search-baseline.json`: real-extension index metadata, source document, and assertions from the Japanese Worker integration test.
- `ocr-search-schema-nullable-reviewed.sql`: schema variant for the fail-closed case, matching the source test's nullable `reviewed` column (the ordinary fixture schema is `NOT NULL`).
- `test/support/standard-search-fixture.mjs`: creates an in-memory SQLite database for one standard-search scenario and returns the caller-owned handle.
- `test/support/japanese-search-fixture.mjs`: builds the one-document Japanese index with the real Vaporetto extension and closes the builder connection before the Worker opens it.

These are data fixtures, not executable tests. The parser/compiler rejection cases,
prepared-statement LRU assertions, Worker lifecycle state-machine tests, and
DB-contract validator cases must be ported as executable tests from the pinned
source files. Keep the baseline commit and fixture contents fixed while extracting.

Fixture integrity can be checked without installing package dependencies:

```sh
node test/verify-fixtures.mjs
```

This verifies fixture structure and pinned source metadata only. It does not run
searches or establish semantic equivalence with the source implementation.


## 実行テストへの接続

- `test/japanese-search-repository.test.ts` は固定baselineの日本語Worker lifecycle 10ケースを移植したもの。
- `test/ocr-search-api.test.ts` はcaller-owned DB lifecycleと、日本語実Worker integration（native extensionがある場合）を検証する。
- `test/standard-search.test.ts` / `test/query.test.ts` は標準検索のfixture・parser/compilerを検証する。
- `test/baseline-equivalence.test.ts` は固定commitから隔離した検索実装snapshotと抽出後repositoryを同じfixtureで実行し、標準検索結果オブジェクトを完全一致比較する。

これらはコード上のテスト追加状態であり、実行成功を意味しない。native extensionがない環境では日本語integrationがskipされるため、CIでextension付き実行を必須にする必要がある。

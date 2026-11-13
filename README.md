# OCR-SEARCH

独立したOCR検索package。検索仕様と実装の正本となり、ocr-mcp-serverとbook-ocr Web UIから利用する。

- 設計書: [DESIGN.md](./DESIGN.md)
- 回帰テスト基準: [docs/regression-baseline.md](./docs/regression-baseline.md)
- 回帰テスト実装マトリクス: [docs/regression-test-matrix.md](./docs/regression-test-matrix.md)
- 抽出元基準: OCR-MCP-SERVER commit `d9f23b0a7870ea267670bcf27208942172e27563`

## 現在の実装状況

- 標準検索AST parser / validation
- parameterized SQL compiler（instr + FTS5 trigram）
- reviewed filter semantics
- 標準SQLite検索repositoryと64件LRU prepared-statement cache
- limit / offset / afterIdのpackage boundary validation
- 標準検索開始前のAbortSignal対応
- 標準検索baseline fixtureを使う回帰テスト初版（8 scenario）
- AST parser / SQL compiler境界テスト
- production DB contract validatorとtest-only strict trigram validator

日本語検索Worker、index builder、baseline equivalence harness、CLI、Release tarball検証は未実装。現時点でビルド・テスト実行済みとはしていない。

## 開発環境

Node.js `>=22.16.0`。

```sh
npm ci
npm run typecheck
npm test
npm run build
```

packageにはconsumer側install時に実行する`prepare` scriptを置かない。配布tarballにはbuild済み`dist`を含める。GitHub Release tarballをdependencyに指定する場合、npm 12ではconsumer側`.npmrc`に`allow-remote=root`（環境により`all`）が必要になる場合がある。

詳細は設計書を参照。

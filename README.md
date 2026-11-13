# OCR-SEARCH

独立したOCR検索package。検索仕様と実装の正本となり、`ocr-mcp-server` と `book-ocr Web UI` から利用する。

- 設計書: [DESIGN.md](./DESIGN.md)
- 日本語検索の導入・運用: [docs/japanese-search.md](./docs/japanese-search.md)
- 回帰テスト基準: [docs/regression-baseline.md](./docs/regression-baseline.md)
- 回帰テスト実装マトリクス: [docs/regression-test-matrix.md](./docs/regression-test-matrix.md)
- 抽出元基準: OCR-MCP-SERVER commit `d9f23b0a7870ea267670bcf27208942172e27563`

## 実装済み

- 標準検索 AST parser / iterative validation / SQL compiler（短語 `instr()`、長語 FTS5 trigram）
- 標準検索 repository、snippet、pagination、64件 LRU prepared-statement cache
- `reviewed=0` のみ未レビューとする共有 semantics
- Production DB contract validator と test-only strict trigram validator
- 統合 API `OcrSearch` / `createOcrSearch()`
- Vaporetto 日本語検索 Worker、FIFO queue、cancel、queue/execution/startup timeout、bounded restart
- 日本語 index schema v2 builder（明示パス指定、staging DB、検証後 rename）
- sqlite-vaporetto installer / checker（upstream release SHA-256 検証）
- 標準検索・API・日本語 Worker integration test の初版
- CLI の標準検索と明示 opt-in の日本語検索

**未完了:** source implementation との完全な baseline equivalence harness、Worker lifecycle 全ケースの回帰テスト移植、CLI の追加検証、package lockfile、LICENSE / NOTICE の確定、CI / npm pack tarball 検証。現時点で build / test 実行済みとはしていない。

## 開発環境

Node.js `>=22.16.0`（GitHub Actionsで22.16.0 / 24.xを検証済み）。

```sh
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` は TypeScript build に加え、Worker と Worker が利用する runtime helper を `dist` にコピーする。consumer install 時に実行する `prepare` script は置かない。

## 標準検索 API

呼び出し側が開いた `node:sqlite` の `DatabaseSync` を渡す。DB connection の open / close は consumer が所有する。

```ts
import { DatabaseSync } from "node:sqlite";
import { OcrSearch } from "ocr-search";

const database = new DatabaseSync("/absolute/path/ocr.sqlite", { readOnly: true });
const search = new OcrSearch({ database });
try {
  const result = await search.search({ query: "猫", limit: 20 });
  console.log(result);
} finally {
  search.close(); // OCR-SEARCH が所有する Worker のみ終了
  database.close();
}
```

標準検索APIはPromiseを返すが、SQLite query自体は呼び出し元thread上で同期実行される。Promise化はnon-blocking化を意味しない。AbortSignalは処理開始前のcancelのみを保証し、実行中の同期SQLite queryを中断しない。

## 日本語検索

日本語検索は明示的に有効化した場合だけ Worker を起動する。Vaporetto model の初期化には時間とメモリを要する。

```sh
npm run japanese-extension:install
npm run japanese-extension:check
npm run japanese-index -- --database=/absolute/path/ocr.sqlite --index=/absolute/path/japanese.sqlite --extension=/absolute/path/native/sqlite-vaporetto/libsqlite_vaporetto.so
```

```ts
const search = new OcrSearch({
  database,
  japanese: {
    indexPath: "/absolute/path/japanese.sqlite",
    extensionPath: "/absolute/path/libsqlite_vaporetto.so",
    busyTimeoutMs: 500,
    maxLimit: 20,
  },
});
const result = await search.searchJapanese({ query: "吾輩は猫である", mode: "any" });
```

index の再構築・置換後は、利用側アプリケーション（MCP server / Web UI Node server）を再起動する。日本語 index は snapshot であり、source DB の更新を自動反映しない。

## CLI

```sh
ocr-search search --database=/absolute/path/ocr.sqlite --query="猫"
ocr-search search-japanese --database=/absolute/path/ocr.sqlite --index=/absolute/path/japanese.sqlite --extension=/absolute/path/libsqlite_vaporetto.so --query="吾輩は猫である"
```

CLI は consumer 固有 config を暗黙に読み込まない。DB、index、extension path は引数で明示する。

## npm / GitHub Release

package には consumer install 時に build する `prepare` script を置かない。配布 tarball には build 済み `dist` を含める。GitHub Release tarball を dependency に指定する場合、npm 12 では consumer 側 `.npmrc` に `allow-remote=root`（環境により `all`）が必要になる場合がある。lockfile と tarball の integrity 検証は release 前に確認する。

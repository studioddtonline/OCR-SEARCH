# OCR-SEARCH 設計書

- 文書種別: 実装前アーキテクチャ・仕様確定案
- 状態: Draft 1
- 対象: studioddtonline/OCR-SEARCH
- 正本となる現行実装: studioddtonline/OCR-MCP-SERVER の main
- 目的: MCP サーバーの OCR 検索機能を独立 package に抽出し、MCP と book-ocr Web UI が同じ検索仕様・実装を利用する

## 1. 決定事項

OCR-SEARCH は検索の意味・検索処理・日本語専用索引形式を所有する。OCR 元データベースのスキーマ、migration、通常検索用 FTS5 index の作成・更新は所有しない。

| 領域 | 所有者 |
|---|---|
| 標準検索の AST、検証、SQL 生成、検索、snippet、pagination | OCR-SEARCH |
| 日本語検索の tokenizer、検索、BM25、snippet、Worker | OCR-SEARCH |
| 日本語専用索引の形式、builder、reader | OCR-SEARCH |
| Vaporetto installer / checker、version・SHA-256 固定 | OCR-SEARCH |
| OCR 元DBの schema、migration、source_images、images_fts、同期trigger | book-ocr |
| OCR本文・reviewed・書誌情報の書き込み、履歴 | 各アプリ |
| DB接続の作成・所有・終了、DBパス・アプリ設定の読み込み | 各 consumer（CLI は OCR-SEARCH CLI） |
| MCP tool schema、Zod/MCP JSON Schema、認証・認可・HTTP | ocr-mcp-server |
| CLI 検索コマンド、検索 DB の open / close、明示的な引数処理 | OCR-SEARCH CLI |
| Web API、認証・認可、UI | book-ocr Web UI |

初期利用者は ocr-mcp-server、book-ocr Web UI、および OCR-SEARCH CLI。モノレポにはしない。book-ocr は OCR・DB 管理に専念し、独自の CLI 検索実装・検索コマンドは持たない。CLI 検索が必要な場合は OCR-SEARCH が提供する CLI（例: `ocr-search search --database <path>`）を直接利用する。CLI は DB path、必要なら日本語 index path / extension path などを明示引数で受け取り、consumer 固有 config を暗黙に読み込まない。初期配布は GitHub Releases の npm pack tarball を想定し、公開 npm は必須としない。

**抽出フェーズでは検索仕様を変更しない。** 仕様変更は抽出完了後の別作業・別バージョンにする。ただし、独立packageの入力境界として必要なlimit / offset / afterIdの検証と既定値適用、および標準検索の開始前AbortSignal対応は、現行のMCP boundary / repository間の責務をpackage APIへ再配置するための明示的な例外とする。検索結果の意味論は変更せず、基準8ケースとは別の新規テストで検証する。

## 2. プロジェクト構成と依存方向

想定するプロジェクトは4つ。

1. OCR-SEARCH — 独立 package。検索仕様と検索実装の正本。
2. ocr-mcp-server — MCP アダプター。OCR-SEARCH を依存利用。
3. book-ocr — OCR データベースのスキーマ・データ・索引ライフサイクルを所有。
4. book-ocr Web UI — book-ocr DB を Node.js サーバー側で開き、OCR-SEARCH を利用する別プロジェクト。

依存関係:

```text
                 +------------------+
                 |    OCR-SEARCH    |
                 | search semantics |
                 | SQL / Japanese   |
                 | index builder    |
                 +--------+---------+
                          |
               +----------+----------+
               |                     |
       +-------v--------+    +-------v---------+
       | ocr-mcp-server |    | book-ocr Web UI |
       | MCP adapter    |    | Node API + UI  |
       +----------------+    +-------+---------+
                                     |
                              +------v------+
                              |  book-ocr   |
                              | DB schema   |
                              | migrations  |
                              | FTS5 upkeep |
                              +-------------+
```

book-ocr がDBを作成・管理し、検索利用アプリがDBを開く。OCR-SEARCH はDBを作成・migrationしない。Web UIはブラウザからSQLiteファイルを直接開かず、Node.jsサーバー側で接続を作る。

## 3. 現行検索仕様（抽出時に維持）

以下は OCR-MCP-SERVER の現行ソースから確認した仕様。実装と異なる変更を加える場合は、この抽出作業とは分離する。

### 3.1 標準検索

主な現行実装:
- src/features/ocr/query.ts
- src/features/ocr/repository.ts
- src/features/ocr/reviewed.mjs
- src/features/ocr/tools.ts
- src/features/ocr/sqlite.ts

#### 入力と AST

query は文字列または JSON AST。文字列は単一 term として扱う。一般的なテキスト演算子構文ではない。

AST node:
- term: { type: "term", value: string }
- and / or: { type: "and" | "or", nodes: QueryNode[] }
- not: { type: "not", node: QueryNode }

制約:
- 最大深度 8
- 最大ノード数 32
- AND / OR の子は2〜16
- term は最大500 Unicode code points
- 空termを拒否
- 正の検索語を含まない NOT-only query を拒否
- cyclic / shared node object を拒否
- 深い入力による stack exhaustion を避けるため、AST検証は反復処理

#### 検索方式

term ごとに Unicode code points 数で切り替える。

- 1〜2 code points: source_images.ocr_text に対する instr(COALESCE(...), ?)。大文字小文字を区別するリテラル部分文字列検索。
- 3 code points 以上: images_fts MATCH ? を使う FTS5 trigram phrase 検索。term を FTS5 phrase として引用し、二重引用符をエスケープする。
- AND / OR / NOT は SQLite の parameterized SQL predicate に変換する。ユーザー入力を SQL / FTS5 演算子として直接連結しない。
- label は source_images.file_path の完全一致。reviewed は式全体に適用。
- DB 契約上、`reviewed=0` のみ未レビュー。`NULL` および `0` 以外の値は保護対象（レビュー済み扱い）とする。検索 filter と OCR write 側でこの意味を変えない。

#### 順序・ページング・件数

- 並び順: source_images.id ASC
- 既定 limit: 20
- maxLimit 既定: 50、設定可能な最大値: 100
- offset: 0〜1,000,000
- afterId: 正の安全な整数
- 現行repository自体はlimit / offset / afterIdの範囲検証を担わず、MCP boundaryがlimit等を検証する。OCR-SEARCHの独立APIではこの検証と既定値適用をpackage boundaryへ移す。
- afterId と正の offset は併用不可（offset=0 は afterId と共存可能）
- afterId 指定時は id > afterId の keyset pagination
- 次ページがある場合、返却最終行の ID を nextAfterId として返す。次ページがなければ null。

#### snippet

- 設定既定長: 160
- positive term の出現位置を使って切り出し、必要に応じ前後に省略記号を付ける。
- 直接一致がない場合、大文字小文字を無視した位置検索を best-effort で行う。
- surrogate pair を途中で分断しない。
- NOT の偶奇を考慮して positive terms を抽出する。

### 3.2 日本語検索

主な現行実装:
- src/features/japanese-search/repository.ts
- src/features/japanese-search/worker.mjs
- src/features/japanese-search/tools.ts
- scripts/build-japanese-search-index.mjs
- scripts/install-sqlite-vaporetto.sh
- scripts/check-sqlite-vaporetto.mjs

#### 索引と tokenizer

日本語検索は images_fts を使わず、別 SQLite ファイルの snapshot index を使う。

- Vaporetto で OCR 本文を事前分かち書きする。
- 検索可能 token は [\p{L}\p{N}] を含む token に限定する。
- token を空白区切りで保存し、FTS5 の unicode61 tokenizer で索引化する。
- Vaporetto model を FTS5 tokenizer と query tokenizer の両方で二重ロードしない。
- schema version: 2
- metadata tokenizer: vaporetto-pretokenized-unicode61
- 主なテーブル: japanese_search_meta、japanese_documents、contentless FTS5 の japanese_fts
- 元OCR DBをread-onlyで読み込み、staging DBに構築後 rename で置換する。
- 元DBの一貫した read snapshot を保持する。失敗時は従来索引を置き換えない。

専用索引の形式・生成・読取は OCR-SEARCH が所有する。book-ocr は元DB更新後に索引再構築をいつ実行するかを運用管理するが、索引形式を独自実装しない。

#### 入力・検索方式

- query: 必須、日本語検索文字列。現行 MCP schema では1〜500文字。
- mode: any または all。既定値 any。
- any: Vaporetto token を OR 結合。
- all: Vaporetto token を AND 結合。
- label: 任意、完全一致。
- reviewed: 任意。
- 1〜2文字でも日本語検索では Vaporetto token 化する。標準検索の部分文字列 semantics とは異なり、長い token 内部の文字を必ず見つけるものではない。
- searchable token が0件なら no_searchable_tokens 相当の safe error。

#### 順序・ページング・結果

- 並び順: BM25 score ASC、同点時 source_id ASC
- 既定 limit: 20
- maxLimit 既定: 20（config で最大50）
- offset による relevance-ranked pagination。afterId / keyset cursor は使わない。
- 結果は query、mode、queryTokens、returned、limit、offset、nextOffset、index metadata、results を含む。
- result は id、label、fileName、reviewed、score、snippet を含む。
- BM25 score は小さい方が上位。
- snippet は元 OCR 本文から作り、最大180 UTF-16 code units 相当。強調は 〔...〕。強調は token 部分文字列への best-effort で、単語境界を厳密に表すものではない。

#### Worker の現行動作

- Vaporetto 初期化・日本語検索を Worker Thread 内で行う。
- 要求は FIFO、同時実行は1件。
- active + queued の合計上限は4件。
- queue wait timeout と execution timeout を分離。現行既定は queue wait 180秒、実行20秒、起動180秒。
- startup failure は上限付き exponential backoff で再試行。
- ready 到達後に再試行予算をリセット。
- idle Worker の予期しない終了は次の要求まで再起動しない。
- close 時に active / queued request を終了し Worker を terminate。

抽出時にはキュー・キャンセル・timeout・再起動の挙動を維持する。

### 3.3 標準検索と日本語検索の意図的な仕様差

ここに示す差は、同じ OCR-SEARCH package 内の異なる検索方式に由来するものであり、抽出時点では維持する。BOOK-OCR 独自検索との仕様差を残すという意味ではない。BOOK-OCR の旧検索実装は廃止し、CLI も OCR-SEARCH の検索実装を利用する。

| 項目 | 標準検索 | 日本語検索 |
|---|---|---|
| 検索方式 | instr + FTS5 trigram | Vaporetto token + FTS5 unicode61 |
| 短い語 | 1〜2 code points は literal substring | Vaporetto token 化 |
| query | 文字列または JSON AST | query + mode |
| mode | AST AND / OR / NOT | any / all |
| 順序 | ID 昇順 | BM25 昇順、ID tie-break |
| pagination | offset または afterId | offset |
| snippet | 既定160 | 180、〔 〕強調 |
| 既定 limit | 20 | 20 |
| maxLimit 既定 | 50 | 20 |

現行 any がノイズを生みやすいという観察は変更検討材料だが、抽出時に all に変更しない。snippet の長さや形式も統一しない。

## 4. package に含めるもの／含めないもの

### 含める

1. 標準検索 query parser / AST 型 / validation。
2. 標準検索 SQL compiler、repository、prepared statement cache。
3. 標準検索 snippet。
4. reviewed predicate の検索利用部分。
5. 日本語検索 repository、Worker、Worker lifecycle / queue。
6. 日本語検索に必要な WorkerHost 相当の内部コード。
7. 日本語索引 schema version 2 の定義。
8. 日本語索引 builder API / CLI。
9. 日本語索引検索、query tokenization、BM25、snippet。
10. Vaporetto installer / checker（version・SHA固定、license notices）。
11. 検索 DB contract validator。
12. 上記の unit / integration / conformance tests。

### 含めない

- OCR 元DBの create / migration。
- source_images / images_fts の作成。
- images_fts の insert / update / delete trigger の作成・更新。
- OCR本文、reviewed、書誌情報の更新や履歴。
- mcp_ocr_edit_history（MCP専用）。
- 原画像の探索・読み込み・画像 Worker。
- MCP SDK、MCP tool schema、Zod boundary、認証、OAuth、HTTP。
- Web UI / Web API / アプリ認証。
- config file / environment variable の暗黙読み込み。

## 5. DB接続とリソース所有

### 5.1 標準検索

標準検索は呼び出し側が開いた node:sqlite の DatabaseSync 接続を受け取る。

- 接続を開くのは利用アプリ。
- OCR-SEARCH は渡された接続を使う。
- OCR-SEARCH は接続を close しない。
- `OcrSearch.close()` は package 所有の日本語 Worker を終了するが、呼び出し側の `DatabaseSync` は close しない。
- 利用側は `OcrSearch.close()` の完了後に自分の DB 接続を close する。
- close 完了後の検索呼び出しは明示的な safe error とする。
- package は DB path / process.env / config を参照しない。
- package は schema migration をしない。

### 5.2 日本語検索

日本語検索は Worker Thread 内で Vaporetto 初期化と SQLite 処理を行うため、標準検索と同じ接続注入方式にしない。

- 利用アプリは indexPath と extensionPath を明示的に渡す。
- OCR-SEARCH は Worker 内で index DB を read-only で開く。
- Worker に渡すのはパスや数値設定など clone 可能な値のみ。SQLite connection object は渡さない。
- Worker が index connection の open / validation / close を所有する。
- extension load 後は enableLoadExtension(false)。
- パスの解決・設定読み込みはアプリ側。

この非対称性は意図的。標準検索の connection injection を維持し、日本語検索だけ Worker が専用 read-only connection を所有する。

### 5.3 API は Promise に統一

標準検索も日本語検索も Promise を返す。ただし Promise 化だけでは同期 SQLite 処理が別スレッドになるわけではない。

初期版では標準検索の既存同期処理を維持し、Promise API で包む。標準検索の `AbortSignal` は現行実装には存在しない新規APIであり、抽出時の明示的な追加例外とする。処理開始前にsignalを確認し、既にabort済みなら検索を開始せず SearchCancelledError とする。同期SQLite処理の開始後の中断は保証しない。日本語検索の Abort は Worker queue の状態に応じた既存のキャンセル動作を維持する。両者でキャンセル保証が異なることを API ドキュメントに明記する。イベントループ占有が実測上の問題になった場合に標準検索の Worker 化を別途検討する。抽出のためだけに標準検索を Worker 化しない。抽出後は必要に応じて検索実行時間・イベントループ遅延を計測し、Worker 化を別途判断する。

### 5.4 WorkerHost

現行 src/shared/worker-host.ts は日本語検索と原画像読み込みの両方で使われる。

- OCR-SEARCH は日本語検索に必要な Worker host lifecycle を内部に含める。
- MCP 側の original-image image-read-queue は現状維持。
- 小さなコード重複は許容する。
- original-image Worker を OCR-SEARCH に依存させない。
- 汎用 Worker package は初回抽出では作らない。

## 6. DB更新・日本語索引再構築後の再起動運用

OCR-SEARCH は、稼働中プロセスが OCR 元DBや日本語検索 index の更新を自動検知して接続を再生成する機能を提供しない。Web UI に ocr-mcp-server と異なる長期稼働・無停止更新要件は設けない。

### 運用上の必須条件

OCR データベースの更新、または日本語検索 index の再構築・置換を行った場合は、検索利用アプリケーションを再起動する。

- ocr-mcp-server: 現行運用どおりプロセスを再起動する。
- book-ocr Web UI: Web UI の Node.js サーバープロセスを再起動する。
- 両アプリとも、更新・再構築が正常に完了した後に再起動し、新しい DB / index を起動時に開く。
- 再起動前のプロセスが古い DB connection または index connection を保持している間は、そのプロセスが更新後のデータを参照することを保証しない。
- 稼働中の自動 stat、inode 比較、index connection の hot swap、retry loop は実装しない。

### 日本語 index builder の置換

builder は引き続き staging file を構築・検証してから rename で置換する。これは索引ファイルを壊さず更新するための builder 側の要件であり、稼働中 consumer の自動再接続を意味しない。再構築後は consumer を再起動する。

### 起動時検証

各 consumer は起動時に必要な DB / index を開き、schema・metadata・extension の検証を行う。不適合なら起動を失敗させ、安全なエラーを報告する。更新後の状態を利用するには、修正・再構築後に consumer を再起動する。

## 7. 公開 API 案

初回は MCP が必要とする最小 API。MCP の Zod schema を package に持ち込まない。以下は API 形状案であり、移動時に実コードとの照合で最終確定する。

### exports

- ocr-search: 検索 API、型、AST parser。
- ocr-search/testing: DB contract test helper。
- ocr-search/japanese-index: 日本語 index builder API。
- `ocr-search` bin: `search`（標準 / 日本語 CLI 検索）および `build-japanese-index` command。CLI は明示引数で DB / index / extension path を受け取る。

初期から core/sqlite 等の細分化 subpath は増やさない。

### 型・API の概形

```ts
import type { DatabaseSync } from "node:sqlite";

export type SearchQuery = string | QueryNode;

export type QueryNode =
  | { type: "term"; value: string }
  | { type: "and" | "or"; nodes: QueryNode[] }
  | { type: "not"; node: QueryNode };

export interface OcrSearchOptions {
  database: DatabaseSync; // caller-owned
  defaultLimit?: number;  // 20
  maxLimit?: number;      // 50, maximum 100
  snippetLength?: number; // 160
  japanese?: {
    enabled: true;
    indexPath: string;
    extensionPath: string;
    busyTimeoutMs?: number; // 500
    maxLimit?: number;      // 20, maximum 50
  };
  log?: (...args: unknown[]) => void;
}

export interface StandardSearchRequest {
  query: SearchQuery;
  label?: string;
  reviewed?: boolean;
  limit?: number;
  offset?: number;
  afterId?: number;
}

// Package boundary validation/defaults:
// - omitted limit => options.defaultLimit (default 20)
// - limit must be a positive safe integer <= options.maxLimit (default 50, maximum 100)
// - offset, when supplied, must be an integer in [0, 1_000_000]
// - afterId, when supplied, must be a positive safe integer
// - afterId and offset > 0 are mutually exclusive; offset=0 may coexist
// - invalid values are rejected with SearchQueryValidationError; never clamp or round
// Japanese search applies positive-safe-integer limit (default 20, max 20 by default / 50 maximum)
// and non-negative safe-integer offset validation at the package boundary.

export interface JapaneseSearchRequest {
  query: string;
  mode?: "any" | "all";
  label?: string;
  reviewed?: boolean;
  limit?: number;
  offset?: number;
}

export interface OcrSearch {
  search(request: StandardSearchRequest, signal?: AbortSignal): Promise<StandardSearchResult>;
  searchJapanese(request: JapaneseSearchRequest, signal?: AbortSignal): Promise<JapaneseSearchResult>;
  close(): Promise<void>;
}

export function createOcrSearch(options: OcrSearchOptions): OcrSearch;
export function parseSearchQuery(input: unknown): QueryNode;
```

API上の注意:

- 日本語検索を無効にした instance で searchJapanese を呼んだら明示的な safe error。
- limit / offset / afterIdの検証と既定値適用はpackage boundaryが所有する。現行MCP Zod boundaryにある検証責務をpackage APIへ移す意図的な変更であり、範囲外は拒否する（clamp / roundしない）。MCP側のZodは浅い型・入力検証を維持してよいが、制約値の正本はpackageの公開定数とする。
- Worker ready promise を内部管理し、最初の日本語検索は ready / startup failure を待つ。
- close() は非同期とし、Worker terminate 完了を待てる。
- package は caller の DatabaseSync を所有しない。
- package は process.env / MCP config / book-ocr config を読まない。
- options はアプリから明示的に渡す。
- 結果は JSON serializable な plain object。SQLite row object を直接公開しない。
- MCP adapter は結果を tool-specific envelope に変換する。

### AST と Zod

- QueryNode と parser は OCR-SEARCH が所有。
- 公開 API に Zod schema / Zod error instance を出さない。
- MCP Zod schema と tools/list JSON Schema は MCP 側。
- parser は unknown を受け取り、package 固有 SearchQueryValidationError を投げる。
- MCP adapter が package error を MCP safe tool error に変換。
- Web UI は必要に応じて同じ parser をサーバー側で使う。
- 制約定数と意味論的 validation の正本は OCR-SEARCH。MCP の Zod schema は OCR-SEARCH が公開する制約定数を参照し、浅い入力境界検証を担当する。AST の深度・総ノード数・循環 / shared object・positive term 等の最終検証は OCR-SEARCH parser が担当する。Zod と parser は検証段階が異なり、制約値や意味論を独立に複製しない。
- Unicode code point 数の厳密な term 長検証は parser が担当する。Zod の string `.max()` は UTF-16 code unit 基準なので、厳密な code point 上限として扱わない。

### 日本語 index builder API 案

```ts
export interface BuildJapaneseIndexOptions {
  sourceDatabasePath: string;
  indexPath: string;
  extensionPath: string;
  busyTimeoutMs?: number;
  onProgress?: (progress: { completed: number; total: number }) => void;
}

export function buildJapaneseSearchIndex(
  options: BuildJapaneseIndexOptions
): Promise<BuildJapaneseIndexResult>;
```

builder は source DB read-only、required columns 検証、schema v2 作成、staging transaction、smoke test、close、rename を担当。config/env は読まない。CLI は明示引数を受け取り、同じ API を呼ぶ。

### package エラー契約

package は少なくとも次の分類を公開する。内部原因 (`cause`) や詳細はログ用に保持してよいが、利用者向け message にローカルパス、SQL、stack trace、native extension の内部詳細を含めない。

- `SearchQueryValidationError`: query / AST の不正。
- `SearchUnavailableError`: DB / index / extension の不適合、機能無効など。
- `SearchCancelledError`: キャンセル。
- `SearchQueryError`: SQL 実行など検索処理の失敗。
- `SearchWorkerError`: Worker 起動・異常終了。
- `SearchNoSearchableTokensError`（または安定した error code）: 日本語 tokenizer が検索可能 token を生成しなかった状態。

MCP adapter は package error を MCP safe error に変換し、Web UI adapter は HTTP status と UI 向け safe response に変換する。package は consumer の transport / UI error format を知らない。

## 8. DB contract

### 標準検索の最低契約

- source_images table。
- 必須列: id、file_path、file_name、ocr_text、reviewed。
- images_fts が FTS5 virtual table。
- images_fts MATCH ? が実行できる。
- images_fts が source_images.ocr_text を反映している。通常は book-ocr の external-content FTS5 と同期 trigger で実現。

現行validatorはtrigram tokenizerやtrigger SQL文面を要求していない。MATCH probeだけではtrigramとunicode61を区別できないため、本番validatorの互換性範囲は維持する一方、test-only strict helperでsqlite_master.sqlのtokenize='trigram'を検証する。

### testing export

ocr-search/testing は assertSearchDatabaseCompatible(db) を提供する。

検査:
1. source_images / images_fts の存在。
2. source_images 必須列。
3. images_fts が FTS5 virtual table。
4. MATCH probe。

テスト専用に `assertTrigramSearchDatabaseCompatible(db)`（または同等のtest helper）を設け、production validatorの全検査に加え、`sqlite_master.sql` の `images_fts` 定義に `tokenize='trigram'` が指定されていることを確認する。production validatorの互換性範囲は広げない。
検査しない:
- production validatorはtokenizer種別（trigram / unicode61）を検査しない。MATCH probeからtokenizerを推定しない。
- insert / update / delete trigger 定義。
- OCR write history table。
- MCP 固有 trigger 名。
- DB migration version / PRAGMA user_version。
- DB の作成・修復・再構築。

validateOcrWriteTriggers は OCR-SEARCH に移さない。書き込み機能の責務に残す。

### FTS5 更新責任

book-ocr が source_images と images_fts を管理する。book-ocr の migration / trigger tests で insert / update / delete 同期を検証する。

OCR-SEARCH integration tests は同期済み DB で期待検索結果を確認する。trigger SQL を package が生成・管理しない。

### 日本語 index contract

日本語 index は OCR-SEARCH が形式を所有する。schema v2 の tables / metadata / tokenizer identifier / FTS5 options を厳密に検証する。book-ocr の PRAGMA user_version とは独立管理。

## 9. テスト戦略

### OCR-SEARCH に移す

**標準検索 unit tests**
- string / AST query
- AST depth / node / children / term length
- cyclic / shared object
- NOT-only query
- 1〜2 code points instr semantics
- 3+ code points FTS5 phrase escaping
- SQL / FTS syntax injection prevention
- positive term extraction
- snippet offsets / surrogate pair
- afterId / offset exclusion
- limit / offset boundaries
- ID order / nextAfterId
- prepared statement cache

**標準 SQLite integration**
- node:sqlite + FTS5 での検索
- label / reviewed filter
- insert/update/delete 後の検索結果
- schema compatibility validator

**日本語検索**
- schema v2 Worker open
- extension load / disable
- query tokenizer / searchable token filter
- any / all
- BM25 order / tie-break
- snippet / highlight / surrogate
- label / reviewed
- FIFO / cancellation / queue capacity / queue timeout / execution timeout
- startup deadline / bounded restart / backoff / idle failure
- close / terminate
- builder 完了後のプロセス再起動を前提とした index open / validation
- builder snapshot consistency / staging cleanup / failure preserving old index

### Consumer に残す

**ocr-mcp-server**
- MCP tool schema / JSON Schema
- Zod boundary と package parser の接続
- MCP result envelope / safe error mapping
- MCP config -> OCR-SEARCH options
- auth / scope / rate limit / HTTP
- original-image / OCR write の独立性

**book-ocr**
- DB migrations / schema
- source_images / images_fts trigger behavior
- migration で作った DB に対する assertSearchDatabaseCompatible conformance test
- OCR write workflow
- 日本語 index rebuild の運用連携

**Web UI**
- Node API が caller-owned DB connection を渡す
- Web API validation / authz
- pagination UI / result rendering
- Web UI 固有の書き込み・履歴
- DB更新または日本語 index 再構築後に Web UI Node.js サーバーを再起動する運用

テストは次の3層に分ける。

1. **DB contract conformance**: schema、必須列、FTS5 virtual table / MATCH probe、日本語 index metadata。
2. **semantics regression**: 代表 query の結果 ID 集合・順序・snippet・filter・pagination。標準検索と日本語検索の意図的な仕様差も固定する。
3. **Worker lifecycle**: queue、timeout、cancel、startup failure、restart/backoff、close/terminate。

抽出前後で同一 fixture DB と同一 query に対する結果 ID・順序・snippet 等が一致することを受け入れ条件とする。BOOK-OCR 旧検索の結果は別仕様なので比較基準にはせず、BOOK-OCR CLI は移行後に OCR-SEARCH の semantics を使用する。

初回は共通 fixture package を作らない。OCR-SEARCH test support に最小 fixture を置き、book-ocr conformance test は book-ocr migration から DB を作って validator を呼ぶ。共有期待値が必要になってから versioned JSON fixtures を検討。

抽出前の具体的な回帰基準、テストファイル単位の移植区分、既存10件の日本語Worker lifecycle tests、標準検索の期待値、未カバー領域は [docs/regression-baseline.md](docs/regression-baseline.md) に記録する。基準ソースは OCR-MCP-SERVER commit `d9f23b0a7870ea267670bcf27208942172e27563` に固定し、抽出前後比較が完了するまでbaselineを変更しない。

## 10. package 構成案

```text
OCR-SEARCH/
  package.json
  package-lock.json
  tsconfig.json
  README.md
  DESIGN.md
  LICENSE
  NOTICE.md
  src/
    index.ts
    api/
      create-search.ts
      types.ts
      errors.ts
    standard/
      query.ts
      compiler.ts
      repository.ts
      snippet.ts
      reviewed.ts
      database-contract.ts
    japanese/
      repository.ts
      worker.mjs
      worker-host.ts
      index-schema.ts
      index-builder.ts
      snippet.ts
      token-filter.ts
    testing/
      assert-compatible-database.ts
    cli/
      build-japanese-index.ts
  scripts/
    install-sqlite-vaporetto.sh
    check-sqlite-vaporetto.mjs
  test/
    standard/
    japanese/
    fixtures/
```

構成は移動時に実際の責務を確認し、既存コードを必要以上に細分化しない。まず既存責務単位で移し、整理は別変更にする。

worker.mjs は runtime asset として tarball に含める。package の ESM entrypoint から import.meta.url 基準で解決し、consumer cwd / 相対パスに依存しない。npm pack tarball を別の空プロジェクトに install し、Worker が起動する smoke test を必須にする。

## 11. Native extension / license / supply chain

- sqlite-vaporetto native binary を npm tarball に同梱しない。
- installer / checker を OCR-SEARCH に含める。
- 現行 MCP installer は upstream v0.4.0 を使用。抽出時は version と SHA-256 を固定して移す。
- Linux x86_64 / aarch64 の archive hash を検証。
- 現行 installer の対象は Linux x86_64 / aarch64。初期 package のサポート範囲もこれを基準にする。
- -with-model release は model を内蔵するため別辞書ファイルを前提にしない。
- extension は MIT OR Apache-2.0、内蔵 model は BSD-3-Clause。upstream license notice を保持。
- npm postinstall で自動実行しない。利用者が明示実行。
- 起動時に extension の存在確認、Worker 内で load / smoke test。
- tarball に native binary が混入していないことを検査。

## 12. 配布とバージョニング

### 配布

1. OCR-SEARCH を独立 build / test。
2. npm pack で tarball 生成。
3. tarball file list を確認。
4. GitHub Release に tarball と SHA-256 を添付。
5. consumer は Release tarball を dependency として参照し、lockfile integrity で固定。

git dependencyは初期採用しない。配布物にbuild済みdistを含め、consumer install時のbuild script実行を要求しない。

npm 12以降ではGitHub Releasesのremote tarball URLが既定の `allow-remote=none` により拒否され得る。consumerの `.npmrc` に必要な範囲で `allow-remote=root`（環境上必要なら `all`）を設定する導入手順をREADMEに記載する。配布packageに `prepare` lifecycle scriptを残さない。buildはCIで行い、必要な場合のみ `prepack` を使う。lockfileのintegrity検証は維持し、tarball差し替え時はlockfile更新を必須とする。

### package metadata

- package name: ocr-search（仮称。公開 npm を使う場合は namespace availability を確認）
- module: ESM
- Node engineの共通下限は `>=22.16.0` とする。Node 22.22で日本語fixture（allowExtension / Worker）およびBOOK-OCRの330テストが通った実測報告がある。22.16.0ちょうどは未検証のため、CIで最小サポート版の検証を追加し、確認前に22.16.0での動作保証を主張しない。
- exports を明示し内部 deep import を避ける。
- files allowlist で dist / worker / notices / runtime assets を含める。
- native binary / consumer config / test files は tarball に含めない。
- sideEffects:false は Worker / CLI / installer の挙動を確認してから設定。

### SemVer

- major: query semantics、AST grammar、result contract、DB contract、index schema compatibility の破壊的変更。
- minor: 後方互換の新機能・optional fields・subpath。
- patch: 後方互換の bug fix / security fix。

日本語 index schema version と npm package version は別管理。非互換 schema は明示的に拒否し、再構築を案内。

## 13. 抽出実行計画

### Phase 0 — source freeze / baseline
1. OCR-MCP-SERVER main commit SHA を記録（baseline: `d9f23b0a7870ea267670bcf27208942172e27563`）。
2. 現行標準・日本語検索 tests を確認し、[docs/regression-baseline.md](docs/regression-baseline.md) にtest inventoryと移植区分を記録。
3. 検索仕様表と test inventory を確定。
4. BOOK-OCR の `src/search/` と CLI 検索 command / flags / output の利用状況を棚卸しする。旧検索実装は移行後に削除し、旧検索 semantics は維持対象にしない。
5. 抽出前の検索回帰 fixture と期待結果を確定する。
6. semantics を変更しない。
7. source repo に未コミット変更がある場合、抽出元 commit を明確化する。

### Phase 1 — package skeleton
1. OCR-SEARCH に package.json / tsconfig / scripts / README。
2. ESM / exports / build output / runtime asset ルール。
3. native extension installer/checker。
4. pack 検証基盤。

### Phase 2 — extract search core
1. query parser / standard repository / snippet / reviewed search predicate。
2. Japanese repository / worker / worker host / index schema / builder / installer。
3. 対応テストを移す。
4. 公開 API を追加。
5. validateOcrWriteTriggers と MCP write repository は移さない。
6. WorkerHost の original-image 利用箇所は MCP 側に残す。

### Phase 3 — MCP consumer migration
1. OCR-MCP-SERVER に OCR-SEARCH tarball dependency。
2. 直接 repository 利用を package API に置換。
3. MCP Zod / JSON Schema / tool definitions / safe error mapping は残す。
4. MCP config を package options に明示的に渡す。
5. Japanese index command を package CLI に委譲。
6. OCR write / original image / auth / HTTP は変更しない。
7. 旧検索実装と重複テストを削除。

### Phase 4 — release artifact validation
1. clean build / tests。
2. npm pack。
3. tarball に dist / worker.mjs / license notices があることを確認。
4. 一時プロジェクトに install。
5. package import / type declarations / standard search smoke test。
6. extension がある環境で Japanese Worker startup / search smoke test。
7. Worker asset 解決を確認。
8. tarball SHA-256 を GitHub Release に添付。

### Phase 5 — book-ocr migration
1. book-ocr Web UI が release tarball を dependency に追加。
2. BOOK-OCR の独自 `src/search/`、旧 CLI 検索 command / flags に属する検索実装を削除する。BOOK-OCR は OCR・DB 管理を担当し、検索 engine を所有しない。
3. CLI 検索は OCR-SEARCH が提供する CLI command を直接利用する。DB path 等は明示引数で渡し、BOOK-OCR 固有 config を OCR-SEARCH が暗黙に読み込まない。
4. schema / migrations / images_fts / triggers / reindex / status は残す。
5. migration DB に対し assertSearchDatabaseCompatible(db)。
6. PRAGMA user_version は book-ocr が管理し、OCR-SEARCH は使用しない。
7. Web UI は Node server-side から利用。

### Phase 6 — Web UI
1. Node server が DB connection を開く。
2. OCR-SEARCH instance を生成。
3. Web API で input validation / authz。
4. UI 検索文字列構文は別途決定。初期から AST JSON をユーザーに入力させない。
5. 必要なら後続 minor で parseQueryText() を追加。
6. OCR DB 更新または Japanese index 再構築後は Web UI Node.js サーバーを再起動する運用とする。

## 14. 抽出後の仕様変更・追加検討として後回しにするもの

### 日本語index snapshotの鮮度と表示データ

日本語検索indexには構築時点のOCR本文とreviewed値がコピーされる。Web UIでOCR本文やreviewedを更新した後、再index・consumer再起動まで日本語検索は古い本文・reviewed filter結果を返す可能性がある。これは現在のsnapshot index方式に伴う整合性制約として明示する。

- 検索順位・候補抽出はsnapshot indexで行う。
- 表示用本文とreviewed値は、検索後にconsumerがsource DBからIDで再取得するhydrate方式を優先検討する。Worker内のindex DB接続とsource DB接続を共有しない。
- 日本語検索結果にはindex metadata由来の `indexedAt` を含め、Web UIが索引時点を表示できるようにする。既存metadataの `indexed_at` をpublic resultへ含める実装が必要。
- rename置換後も既存SQLite connectionは古いinode / file handleを読み続け得る。再起動前のprocessは古いindexを読み続けることを前提とし、自動hot swapを約束しない。

### CLIの日本語検索起動コスト

日本語検索はWorker起動とVaporetto model初期化により、起動ごとに約5.4秒・約325MBという実測報告がある。CLIでは日本語検索を明示option（例 `--japanese`）で選択させ、初期化中の待機表示を出す。通常の標準検索では日本語Workerを起動しない。


- Japanese default mode any -> all。
- 日本語検索のsnapshot本文 / reviewedのfreshness問題に対するsource DB hydrateのAPI設計（consumer側責務を含む）。
- 標準 / 日本語 snippet の統一。
- 標準検索の Worker 化。
- Web UI 用 query text grammar（例 A B -C）。
- 総件数 count / page number / pagination semantics の再設計。
- 標準 / 日本語 result shape の統一。
- OCR write repository / history の共通化。
- 汎用 Worker package の新設。
- 複数 DB driver abstraction。
- book-ocr DB schema / trigger の再設計。

## 15. 実装開始前の確認事項

1. **Node engine:** MCP 現行は >=22.16.0、book-ocr は Node 24+ と報告。node:sqlite API と consumer matrix を確認して確定。
2. **package name:** ocr-search は仮称。公開 npm の場合は namespace availability を確認。
3. **standard result contract:** MCP tool の公開 field names / nullability / numeric representation を実装時に完全転記。
4. **再起動運用:** OCR DB 更新または日本語 index 再構築後、ocr-mcp-server と Web UI の Node.js サーバーを再起動する。稼働中の自動再接続は要件に含めない。
5. **OS support:** 現行 installer は Linux x86_64 / aarch64 のみ。初期サポート範囲もこれを基準にする。
6. **Vaporetto version/hash:** 現行 v0.4.0 を初期固定値として移す。更新は別途 license / compatibility / regression を確認。
7. **testing export:** ocr-search/testing は公開 subpath とし、production API と分離。

## 16. 完了条件

### OCR-SEARCH
- [ ] 独立して install / typecheck / build / test できる。
- [ ] 標準・日本語検索の既存 tests が package 内にある。
- [ ] DB contract / semantics regression / Worker lifecycle の3層でテストが整理されている。
- [ ] 抽出前後の同一入力・同一 DB で検索結果 ID、順序、snippet が一致する。
- [ ] package のエラー message にローカルパス・SQL・stack trace 等が含まれない。
- [ ] 公開 API に Zod / MCP SDK が含まれない。
- [ ] 標準検索 DB connection は caller-owned。
- [ ] 日本語 Worker は index DB を read-only で開く。
- [ ] builder は source DB read-only、失敗時に旧 index を保持。
- [ ] native binary を tarball に含めない。
- [ ] worker.mjs / dist / notices が tarball に含まれる。
- [ ] tarball install smoke test が通る。
- [ ] index builder の staging / validation / rename tests が通る。

### ocr-mcp-server
- [ ] 標準・日本語検索は OCR-SEARCH を利用。
- [ ] MCP schema / Zod / auth / HTTP は MCP 側。
- [ ] OCR write / original image の責務を維持。
- [ ] 抽出前後の検索結果と semantics が一致。

### book-ocr
- [ ] DB schema / migration / FTS5 lifecycle は book-ocr が所有。
- [ ] 独自検索実装・CLI 検索機能を削除し、CLI 検索は OCR-SEARCH CLI を利用する。
- [ ] Node engine は OCR-SEARCH / OCR-MCP-SERVER と同じ下限に統一する。
- [ ] book-ocr DB が package conformance validator に合格。
- [ ] write trigger tests は book-ocr 側に残る。

## 17. 現行実装との対応表

| 現行 OCR-MCP-SERVER | OCR-SEARCH への扱い |
|---|---|
| src/features/ocr/query.ts | 移動。Zod export を除き plain TS parser / types |
| src/features/ocr/repository.ts | 標準検索部分を移動 |
| src/features/ocr/reviewed.mjs | 検索 predicate を移動。write 共有を確認 |
| src/features/ocr/sqlite.ts validateOcrSchema | 検索 DB contract validator として移動 |
| src/features/ocr/sqlite.ts validateOcrWriteTriggers | 移動しない。MCP write 側 |
| src/features/ocr/tools.ts | 移動しない。MCP tool adapter |
| src/features/japanese-search/repository.ts | 移動 |
| src/features/japanese-search/worker.mjs | runtime asset として移動 |
| src/features/japanese-search/tools.ts | 移動しない。MCP tool adapter |
| src/shared/worker-host.ts | 日本語検索に必要な部分を package 内部へ。原画像側は MCP |
| scripts/build-japanese-search-index.mjs | builder API / CLI として移動 |
| scripts/install-sqlite-vaporetto.sh | installer として移動 |
| scripts/check-sqlite-vaporetto.mjs | checker として移動 |
| src/features/ocr/write-repository.ts | 移動しない |
| src/features/original-images/** | 移動しない |
| MCP config / runtime / tools | 移動しない。options に設定を渡す |

## 18. 参照した現行ソース

BOOK-OCR の旧検索実装は移行対象の差分調査に使用し、抽出後の検索仕様の正本にはしない。CLI 検索は OCR-SEARCH の CLI に一本化する。

設計根拠として OCR-MCP-SERVER/main の次のファイルを確認した。

- package.json / README.md
- src/features/ocr/query.ts
- src/features/ocr/repository.ts
- src/features/ocr/tools.ts
- src/features/ocr/sqlite.ts
- src/features/ocr/reviewed.mjs
- src/features/japanese-search/repository.ts
- src/features/japanese-search/worker.mjs
- src/features/japanese-search/tools.ts
- src/shared/worker-host.ts
- src/features/original-images/image-read-queue.ts
- scripts/build-japanese-search-index.mjs
- scripts/install-sqlite-vaporetto.sh
- scripts/check-sqlite-vaporetto.mjs
- docs/japanese-search.md
- src/config/sections/search.ts
- src/config/sections/japanese-search.ts
- src/features/ocr/repository.test.ts
- src/features/japanese-search/repository.test.ts
- test/support/ocr-fixture.ts
- test/support/sqlite-vaporetto-extension.ts
- src/mcp/tools.test.ts（MCP境界テストの区分確認）
- src/features/ocr/sqlite.test.ts

この文書は現行実装から抽出計画を作る設計案であり、OCR-SEARCH package の実装・ビルド・テストを完了したことを意味しない。


## 12. 実装進捗（2026-11-13）

この設計書は引き続き抽出の仕様基準として扱う。実装は次の段階まで進んだ。

- 標準検索 parser / compiler / repository と既存8 scenario fixture testを実装。
- 統合API `OcrSearch` / `createOcrSearch` を追加。標準検索は呼び出し側の `DatabaseSync` を使用し、close ownershipを呼び出し側に残す。
- 日本語検索のWorker、FIFO queue、Abort、queue / execution / startup timeout、bounded restartを固定baseline commitから移植。
- 日本語 index schema v2 builderを追加。config fileを読まず、database / index / extension pathを明示引数で受け取る。staging fileの検証後にrenameし、失敗時は既存indexを保持する。
- Vaporetto installer / checkerを追加。upstream release versionとSHA-256を固定。
- `search` と `search-japanese` CLIを追加。日本語Workerは明示サブコマンドの場合だけ起動し、初期化中表示を行う。
- Worker / reviewed runtime assetsをbuild後にdistへコピーする仕組みを追加。
- 日本語Worker lifecycleの基準10テストを固定sourceから移植。API / 実Worker integration testも追加。
- 日本語検索はsnapshot indexからcandidate IDs / BM25順位を取得し、本文・label・fileName・reviewedはsource DBからhydrate。削除済みcandidateのskip後もpaginationを継続する。

未完了:
- 日本語検索結果のsource DB hydrateは実装済み。残作業はOCR本文変更後のcandidate membershipがsnapshot依存である点を運用上明示すること。
- CLI追加ケース、builderのstaging cleanup / rename failureの詳細テスト（source validation failureで既存indexを保持するテストは追加済み）。
- OCR-SEARCH自身のLICENSE選定。利用者が選定中のため `private: true` は維持し、ライセンス関連のpackage設定は変更しない。第三者NOTICEは追加済み。
- OCR-MCP-SERVER / BOOK-OCR Web UI consumer接続と配布経路の確定。


### CI実行記録

- GitHub Actions run #7: `6bc6947729fedab2fadfc9040485c26543589739` — Node.js 22.16.0 / 24.x の双方で typecheck、37 tests、build、pack runtime asset check が成功。
- Node.js 22.16.0 exact floorはこのrunで初めて実行確認した。
- この実行はsource / testの現行実装を検証したもの。後続のtarball install / package import / CLI smoke testもrun #9で成功。

- GitHub Actions run #9: `53f78753486730ac3cc688a7b73c7b9008672202` — Node.js 22.16.0 / 24.x双方でtypecheck、37 tests、build、npm pack、temporary install、package root import、CLI help smoke testが成功。

- GitHub Actions run #30: `12d5790c2242d8a5909d25e24245ac468f4e24a3` — Node.js 22.16.0 / 24.x双方でtypecheck、38 tests、build、npm pack、temporary install、package root import、CLI help smoke testがすべて成功。日本語Worker source equivalence testとpublic JapaneseSearchOptionsの分離を含む最新状態を検証。

- GitHub Actions run #39: `1315de4b2e58b91ce854845497334be92ac9d5a6` — lockfileを使う `npm ci`、Node.js 22.16.0 / 24.xのtypecheck、38 tests、build、npm pack、temporary install、package root import、CLI help smoke testがすべて成功。close後のJapanese APIも安定した `SearchUnavailableError` を返す。

- GitHub Actions run #50: `6adee68ca695440c7b1f4b4266e376453358f53b` — source DB hydration / deleted-candidate paginationを含む39 testsがNode.js 22.16.0 / 24.x双方で成功。npm ci、build、npm pack、temporary install、API import、CLI smoke testも成功。

# OCR-MCP-SERVER 検索回帰テスト基準

- 状態: baseline inventory / extraction preparation
- 基準リポジトリ: `studioddtonline/OCR-MCP-SERVER`
- 基準ブランチ: `main`
- 基準 commit: `d9f23b0a7870ea267670bcf27208942172e27563`
- 目的: OCR-SEARCH 抽出前後の検索 semantics を比較するため、現行テストと fixture の出所・責務を固定する。

実行可能なテストの配置・実装順序・完了条件は [regression-test-matrix.md](./regression-test-matrix.md) を参照。

この文書は現行テストの棚卸しであり、OCR-SEARCH 側への移植やテスト実行が完了したことを示すものではない。抽出時には上記 commit を不変の比較基準とし、main の後続変更を暗黙に取り込まない。

## 1. 基準テストファイル

| ファイル | 現行テスト数 | 扱い |
|---|---:|---|
| `src/features/ocr/repository.test.ts` | 15 | 検索に関係するテストをOCR-SEARCHへ移植。非検索のDB統計・label listing・DB unavailable テストはconsumer側に残すか責務に応じて再配置 |
| `src/features/japanese-search/repository.test.ts` | 10 | 全件を日本語検索のintegration / Worker lifecycle基準として移植 |
| `src/mcp/tools.test.ts` | 検索関連テストを含む | MCP境界テスト。OCR-SEARCHへ移植せず、package API接続テストとしてMCP側に残す |
| `test/support/ocr-fixture.ts` | — | 標準検索用の最小SQLite fixture。検索用fixtureとしてOCR-SEARCH test supportへ再構成 |
| `test/support/sqlite-vaporetto-extension.ts` | — | 日本語index fixture生成時のextension loader。OCR-SEARCH test supportへ移植 |
| `src/features/ocr/query.ts` | — | AST parser/compilerの意味論の根拠。Zod boundary schemaはMCP側に残す |
| `src/features/ocr/repository.ts` | — | 標準検索・snippet・prepared statement cacheの実装基準 |
| `src/features/japanese-search/worker.mjs` | — | 日本語tokenization・検索・BM25・snippetの実装基準 |

基準ファイルの blob SHA:
- `src/features/ocr/repository.test.ts`: `5724b74e6e2db0bfe838bfafadeaa0c6e2cdefe0`
- `src/features/japanese-search/repository.test.ts`: `49cd2882bd6d66b9518d61f0dd0ed5a7a590d6d5`
- `src/mcp/tools.test.ts`: `b50cbf9bc9b42dfab27102cfc7ad952ac9ed7e76`
- `test/support/ocr-fixture.ts`: `cd4f386d822d44d2413c7eb55b2a257674d44aed`

## 2. 標準検索 regression inventory

`src/features/ocr/repository.test.ts` のうち、次の挙動をOCR-SEARCH側で固定する。

1. keyset cursorによる複数ページ検索、ID昇順、最終ページの `nextAfterId: null`。
2. 1〜2 Unicode code pointsのliteral substring検索とkeyset pagination。日本語1文字が長い文字列の内部に現れるケースを含む。
3. AND / OR / NOT / nested boolean ASTの結果ID。
4. nested ASTとlabel / reviewed filter / paginationの組み合わせ。
5. NOT-only、空term、過剰な深さ、過剰なnode数、500 Unicode code points超のterm拒否。
6. 20,000階層の入力をZod再帰処理に渡さず、iterative parserでstack overflow前に拒否すること。OCR-SEARCH側ではZodを使わず、parserの同等の安全性を直接検証する。
7. FTS phraseに含まれる引用符のescaping、およびFTS operator / SQL injection風文字列をデータとして扱うこと。
8. Unicode lowercasingで `İ` が展開する場合のsnippet offset。
9. snippet / record text truncationでUTF-16 surrogate pairを分断しないこと。
10. reviewed filterのfail-closed意味論。0のみunreviewed、NULLおよび0以外はreviewed扱い。
11. 1文字queryのliteral substring semantics。
12. prepared SQL statement cacheの上限64とLRU eviction。

注意:
- 現行テストのうち `getStats and label listing work against a minimal schema`、`label listing applies its limit in SQLite`、`database startup failure is a fixed client-safe message` は検索エンジンの回帰基準ではない。consumer側のDB repository責務として残す。
- `review-state filters and statistics use the same fail-closed semantics` は検索filter assertionをOCR-SEARCHへ移す。統計値 assertionはconsumer側に残す。可能ならテストを分割する。
- 既存のfixtureは `source_images` とexternal-content trigram `images_fts` を作る。OCR-SEARCH test supportでは同じDB contractを再現するが、migrationやtrigger作成責任をpackageへ移さない。
- 標準検索テストは現行ファイル内でunitとSQLite integrationが混在している。移植時は意味論を変えず、parser/compiler単体テストとSQLite integrationに整理してよい。

## 3. 日本語検索 regression inventory

`src/features/japanese-search/repository.test.ts` の10テストを基準とする。

### 実SQLite / extension integration
1. Vaporetto extensionで作成したschema v2のpre-tokenized contentless FTS5 indexをWorkerから開き、検索できること。query token、result ID / label / reviewed、snippet highlight、index metadata、`any` / `all`、reviewed filterを同じintegration test blockで確認する。

### Worker lifecycle（Fake Worker）
2. idle Worker failure後、次の要求が来るまで再spawnしない。
3. idle pre-ready failure後も、次の要求が来て初めてretryする。
4. startup failureのretry回数上限、exponential backoff、上限到達後の再試行拒否。
5. `startup-error` はterminalであり、自動restart loopに入らない。
6. queue-wait deadlineを超えたqueued requestを失敗させる。
7. FIFOで1件ずつdispatchし、active + queued capacityを守る。
8. queued requestのAbortで該当requestのみを除去し、active requestを妨害しない。
9. execution timeoutを繰り返してもpre-ready startup retry budgetを消費しない。
10. execution timeoutはWorkerからstarted通知後に開始し、timeout後もqueued requestを再spawnしたWorkerへ引き継ぐ。

この一覧は現行ファイルの10個の `test()` blockに対応する。

Fake Worker testsはタイミング制御と状態遷移を検証する。実Worker integrationは実extensionとfixture indexを使い、fakeだけでは保証できないSQLite / Worker境界を検証する。抽出後も両層を維持する。

## 4. DB contract validator の基準

`src/features/ocr/sqlite.test.ts` には7個のtest blockがある（blob SHA: `2182b32cf7b988fd9c52f5244e5cb1c4fc4ea7b6`）。

OCR-SEARCHの `ocr-search/testing` に移す候補:
1. 完全なschemaがvalidatorを通過すること。既存テスト内の `getStats()` assertionはconsumer側、`search()` assertionは標準検索integration側に分ける。
2. 余分な列・列順の違い・大文字小文字の列名を許容すること。
3. `source_images` または `images_fts` の欠落を拒否すること。
4. source_imagesの必須列欠落を列名付きで拒否すること。
5. images_ftsがFTS5 virtual tableでない場合（通常table / FTS4）を拒否すること。
6. FTS5 MATCH probe失敗をschema validation errorとして包み、causeを保持すること。
7. validator失敗時にDB handleをcloseし、file descriptorを漏らさないこと（Linux /proc条件付き）。

ただし、現行 `validateOcrSchema` はDBをopenする `openReadOnlyDatabase` と結合している。OCR-SEARCHではcaller-owned DatabaseSyncを検査する純粋な `assertSearchDatabaseCompatible(db)` に分離し、open / close ownershipはconsumer側に残す。したがって、fd cleanup testはconsumerのopen helper側に残すか、package validatorの責務でないことを確認して除外する。trigger validation / `validateOcrWriteTriggers` は移さない。

## 5. MCP境界テストの扱い

`src/mcp/tools.test.ts` の検索関連テストはMCP側に残す。主な対象:
- MCP入力schemaがliteral queryとnested ASTを受け付けること。
- MCP toolのJSON Schemaがrecursive ASTを公開すること。
- MCP設定のmaxLimitがboundaryで適用されること。
- MCP toolがqueryをpackage APIへ渡し、MCP result envelopeへ変換すること。
- package errorをMCP safe errorへ写像し、ローカルpath / SQL / driver detailを漏らさないこと。
- Japanese search toolの登録条件とunavailable時のsafe response。

Zod schema、MCP JSON Schema、tool名、MCP result envelopeはOCR-SEARCHのAPI回帰テストに混ぜない。MCP consumer integration testではOCR-SEARCH公開APIを実際に呼ぶ構成へ置き換える。

## 6. 抽出前後の比較方法

### 必須比較
同一SQLite fixture DB（同一行・同一ID・同一FTS index）と同一query/optionsを使い、抽出前のOCR-MCP-SERVER基準実装と抽出後のOCR-SEARCHで以下を比較する。

- result IDの集合と順序
- `returned`、`limit`、`offset`、`nextAfterId`
- `file_path` / `file_name` / `reviewed`
- snippetの完全一致（省略記号、強調、長さを含む）
- reviewed / label filterの結果
- AST validationの受理・拒否とerror category
- 日本語検索のqueryTokens、result ID順、score、snippet、nextOffset、index metadata
- Worker lifecycleの状態遷移とsafe error category

### Golden expectations
- 現行テストのinline fixtureと期待IDをまずそのまま移植し、移植時に都合よく期待値を変更しない。
- 実行環境依存の絶対パス、時刻、native error message、Worker request IDはgolden値に含めない。
- BM25 scoreは同一Node / SQLite / Vaporetto extension / model / fixture条件で完全一致比較する。固定の小数丸め許容幅は設けない。異なる環境間ではscore絶対値の比較をせず、複数document fixtureで順位と同点時ID tie-breakを検証する。
- Japanese index metadataのindexed_atはfixture固定値を使う。
- extensionがない環境ではnative integrationをskipできるが、CI / release acceptanceではextension付きの実行を必須にする。

## 7. まだ基準化されていない領域

現時点で確認した上記テストファイルだけでは、以下のbuilder・package distribution acceptanceを十分に保証できない。別途追加する。
- Japanese index builderのsnapshot consistency、staging file cleanup、rename failure時の旧index保持。
- source DB read-only、schema / required-column validation。
- schema v2 metadata mismatch / malformed FTS schema rejection。
- package Worker asset path解決、npm pack tarball install後のWorker起動。
- close後のAPI呼び出し、close中のactive / queued request rejection、terminate完了待ち。
- standard searchのAbortSignal開始前キャンセル（現行にはない新規APIとして別枠）。
- limit / offset / afterIdのpackage boundary検証・default適用（現行repositoryではなくMCP Zod boundaryにある責務の移動。基準8ケース外の新規テスト）。
- test-only strict trigram validator（production validatorのtokenizer互換性を変更しない）。
- Japanese public resultのindexedAt、CLI日本語検索の明示opt-in / startup待機表示。
- 同一環境BM25 score完全一致と複数document順位 / tie-break（scoreの固定許容幅は設けない）。
- npm 12 allow-remote / prepare lifecycle / lockfile integrityを含むtarball distribution tests。
- caller-owned DatabaseSyncがpackage close後もopenのままであること。
- DB contract validatorのpositive / negative conformance cases。

これらはOCR-MCP-SERVERの既存検索テストから移植したと主張せず、OCR-SEARCHの新規テストとして追加する。

## 8. 実装時のルール

1. このbaselineはsource commit `d9f23b0a7870ea267670bcf27208942172e27563` に固定する。
2. 抽出と同時に検索 semantics、snippet、ranking、pagination、timeoutを改善しない。
3. テスト移植のためのAPI差分はadapterで吸収し、期待値を安易に変更しない。
4. MCP / Web UI / CLI固有の入出力テストは各consumerに置く。
5. BOOK-OCR本体は検索consumerではない。検索テスト・検索adapter・CLI検索機能を設計対象に含めない。BOOK-OCR Web UIは独立consumerとして後続に設計する。
6. 抽出前後の比較が完了するまでは、baselineを更新しない。baseline更新が必要な場合は別commit / 別理由で行う。

## 9. OCR-SEARCH側に追加したfixture

抽出前の検索データをOCR-SEARCH側でも再利用できるよう、次のtest-only fixtureを追加した。

- `test/fixtures/ocr-search-schema.sql`: OCR-MCP-SERVER の `test/support/ocr-fixture.ts` と同じ `source_images` / external-content trigram `images_fts` schema。migrationやtriggerは含めない。
- `test/fixtures/ocr-search-schema-nullable-reviewed.sql`: reviewed fail-closed test専用。元テストが `reviewed INTEGER`（nullable）でDBを手動作成する点を維持する。通常fixtureの `NOT NULL` schemaを誤って使わない。
- `test/fixtures/standard-search-baseline.json`: 標準検索のscenario別row data、期待ID、keyset pagination期待値。source testのfixtureとassertionを転記。
- `test/fixtures/japanese-search-baseline.json`: 日本語検索Worker integrationの固定metadata・document・期待値。Vaporettoのtoken列はextension実行時に生成し、推測値を固定しない。
- `test/fixtures/README.md`: fixtureの由来と更新ルール。

fixture作成後、standard fixture JSONを再読込して構文検証し、Unicode lowercasingケースの先頭がsource testと同じ50個の `İ`、surrogate pairケースの `𠮷` より前が159 UTF-16 code unitsであることを確認した。

**この段階で完了したのはfixture dataの準備だけである。** executable regression test、baseline implementationとの自動比較、native extension integrationの実行はまだ行っていない。今後のテスト実装では、fixtureから各scenarioのSQLite DBを生成する共通helperを追加し、source testから移植した期待値をそのまま検証する。
- `test/support/standard-search-fixture.mjs`: scenario別JSONからin-memory SQLite DBを構築し、external-content FTS5 indexをrebuildする。返却したDB接続は呼び出し側がcloseする。
- `test/support/japanese-search-fixture.mjs`: 実Vaporetto extensionで固定metadata / 1 documentのschema v2 indexを生成し、Workerが開く前にbuilder接続をcloseする。

fixture dataとbuilderは準備したが、package APIに対するexecutable regression testsはまだ作成していない。


## 10. OCR-SEARCHへの移植状況（2026-11-13）

固定baselineの日本語Worker test file（10 test block）は `test/japanese-search-repository.test.ts` に移植済み。元のFake Workerによるqueue / cancel / timeout / restart testsを維持し、package内の `JapaneseSearchRepository` を直接検証する。標準検索は `test/standard-search.test.ts` と `test/query.test.ts`、DB contractは `test/database-contract.test.ts`、統合APIと実Workerは `test/ocr-search-api.test.ts` に追加した。

移植コードは未実行である。標準検索の同一fixture完全一致比較は `test/baseline-equivalence.test.ts` に追加済み。日本語BM25の複数文書rank / ID tie-breakテストとindex replacement connection testは追加済み。日本語検索のsource実装との完全一致比較、staging / rename failureの詳細、tarballのruntime asset一覧検査はCI workflowに追加済みだが、tarball install / import smoke testは未完了。初回CI実行結果は未確認。

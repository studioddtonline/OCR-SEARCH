# 回帰テスト実装マトリクス

- 状態: 実装順序・受け入れ条件の確定
- 基準: OCR-MCP-SERVER commit `d9f23b0a7870ea267670bcf27208942172e27563`
- 関連: [regression-baseline.md](./regression-baseline.md)
- 注意: この文書はテスト実装計画であり、OCR-SEARCHの検索実装やテスト実行が完了したことを示さない。

## 1. 実装順序

1. **標準検索の実行可能な回帰テスト** — fixtureからSQLite DBを作り、公開 parser / repository API を検証する。
2. **DB contract validator** — caller-owned DatabaseSyncを直接検証する。DB open / close helperは対象外。
3. **日本語検索 integration** — Vaporetto extensionで固定fixture indexを構築し、実Workerを通して検索する。
4. **日本語 Worker lifecycle** — Fake Workerで状態遷移を検証する。
5. **抽出前後の比較** — OCR-MCP-SERVERの固定基準実装とOCR-SEARCHを同一fixture・同一要求で実行して比較する。
6. **配布後 smoke test** — npm pack相当のtarballを一時プロジェクトへ導入し、Worker assetと公開exportsを検証する。

標準検索を先に実装する。日本語検索のnative extensionは環境依存があるため、標準検索のテスト基盤と分けて実行できるようにする。ただしRelease acceptanceではnative integrationも必須とする。

## 2. 標準検索

テストファイル案: `test/standard-search.test.ts`

| 基準ケース | テスト内容 | Fixture |
|---|---|---|
| keyset pagination | ID昇順、afterId、nextAfterId、offsetとの併用拒否 | `keyset-pagination` |
| short literal | 1〜2 code pointsのliteral substring、長い語の内部一致、label/reviewed filter | `short-literal-substring` |
| boolean AST | AND / OR / NOT / nested AST、短語とtrigram語の混在 | `boolean-ast` |
| filter + pagination | AST全体に対するlabel/reviewed filterと複数ページ | `structured-filter-pagination` |
| quoted / injection-like | FTS phrase quote escaping、FTS演算子風文字列をデータとして扱う | `quoted-and-injection-like-terms` |
| lowercase expansion | `İ` のlowercase展開後もsnippet offsetを正しく対応 | `unicode-lowercase-expansion` |
| surrogate pair | snippetとgetByIdのtruncateでsurrogate pairを分断しない | `surrogate-pair-boundaries` |
| reviewed fail-closed | 0のみ未レビュー、NULL・非0はレビュー済み | `reviewed-fail-closed` |

### Parser / compiler 単体テスト

同じファイルまたは `test/query.test.ts` に、fixture DB不要の以下を置く。

- NOT-only、空term、深度超過、node数超過、termのUnicode code point上限。
- 20,000段の入力を反復validationで拒否し、stack overflowしない。
- cyclic node / shared node objectを拒否。
- AND / OR child数の下限・上限。
- 1〜2 code pointsはinstr predicate、3 code points以上はFTS5 phrase predicateとなる。
- quote escapingとparameter binding。ユーザー文字列がSQL本文へ連結されない。
- positive terms抽出時にNOTの偶奇を正しく扱う。

MCP Zod schemaの受理範囲やJSON Schema生成はここへ含めない。OCR-SEARCH parserが最終的な意味論・深さ・循環検査を担当する。

### Repository結果の検証

各fixture scenarioについて、期待IDだけでなく必要なケースでは以下をassertする。

- `returned` と結果件数
- ID順序、file_path、file_name、reviewed
- snippet全文（特にUnicodeケース）
- nextAfterId
- filter適用後の結果
- getByIdのtruncate境界

fixture JSONに期待値がないフィールドを推測してgolden値に追加しない。必要な完全一致goldenは、固定baseline実装の実行結果を取得してから追加する。

## 3. DB contract validator

テストファイル案: `test/database-contract.test.ts`

OCR-MCP-SERVER `sqlite.test.ts` のvalidatorに関する次の挙動を移植する。

1. 正常なsource_images / FTS5 schemaを受理。
2. 余分な列、列順、大文字小文字の違いを許容。
3. source_imagesまたはimages_fts欠落を拒否。
4. source_imagesの必須列欠落をすべて列挙して拒否。
5. images_ftsが通常tableまたはFTS4なら拒否。
6. FTS5 MATCH probe失敗をvalidation errorで包み、causeを保持。

validatorは渡されたDatabaseSyncをcloseしない。呼び出し後も同じ接続でSELECTできることを確認する。現行テストのfd leak検証はopen helperの責務なので、OCR-SEARCH validatorには移さない。

## 4. 日本語検索

### 実extension integration

テストファイル案: `test/japanese-search.integration.test.ts`

`japanese-search-baseline.json` と `japanese-search-fixture.mjs` を使う。実extensionをロードしてindexを構築し、builder connectionをcloseしてからWorkerにopenさせる。

必須assertions:

- query tokenに「東京」を含む。
- 返却件数1、先頭ID 7、label「テスト書籍」、reviewed=1。
- snippetに `〔東京〕` を含む。
- index metadataのrecord count、schema/tokenizer情報がfixtureと一致。
- any / all の結果件数。
- reviewed=true / false filter。
- BM25順序と同点時ID tie-break。複数documentの固定fixtureを追加する際は、期待順位をbaseline実装で取得する。

extensionがない開発環境ではskip可能。ただしCI / release acceptanceではskip不可。Vaporettoのtoken列は実extensionから生成し、推測した固定token列を使わない。

### Worker lifecycle

テストファイル案: `test/japanese-search.lifecycle.test.ts`

OCR-MCP-SERVERのFake Worker 10テストを移植する。

1. idle Worker failure後、次の要求まで再spawnしない。
2. idle pre-ready failure後も、要求が来るまでretryしない。
3. startup failureのretry上限、exponential backoff、上限到達後の拒否。
4. startup-errorはterminalで自動restartしない。
5. queue-wait deadlineでqueued requestを失敗させる。
6. FIFO、単一dispatch、active+queued capacity上限。
7. queued requestのAbortはそのrequestだけを除去。
8. execution timeoutを繰り返してもstartup retry budgetを消費しない。
9. execution timeoutはWorkerのstarted通知後に開始する。
10. timeout後のWorker再起動時もqueued requestを保持して次Workerへdispatchする。

Fake Workerは時刻を固定・注入する必要が出た場合を除き、現行テストと同等のイベント駆動方式を維持する。テスト専用mock seamを公開APIへ追加しない。

## 5. 抽出前後の比較ハーネス

テストファイル案: `test/baseline-equivalence.test.ts`

比較は固定commitのOCR-MCP-SERVER実装とOCR-SEARCH実装を別moduleとして同一Nodeプロセスで読み込む方法に限定しない。依存関係・module解決・native Worker assetの差が混入しないよう、次のいずれかを採用する。

- **推奨:** 固定commitのbaselineを別worktree / checkoutで実行し、fixtureとrequestをJSONで共有して結果JSONを出力。OCR-SEARCH側も同じJSONを入力して比較する。
- 代替: baselineの検索実装をテスト専用snapshotとしてOCR-SEARCHに置く。ただし本体コードと混ざらない隔離ディレクトリにし、source commitと各ファイルblob SHAを記録する。

比較対象:
- 標準検索: IDs/order、row fields、returned、pagination、snippet完全一致。
- validation: accept/rejectとerror category。文言はMCP境界に依存する場合があるため、package固有error codeへ正規化して比較。
- 日本語検索: queryTokens、IDs/order、score、snippet、offset、index metadata。
- Worker lifecycle: 結果カテゴリ、再spawn回数、retry schedule、queue dispatch順。

絶対パス、日時、native error message、Worker request ID、ログ文字列は比較対象から除外する。BM25 scoreは同一SQLite / extension / fixture条件で比較し、環境差が確認された場合のみ順位一致を必須としてscore許容幅を実測で決める。

## 6. テストの責務境界

OCR-SEARCHに含めないもの:

- MCP Zod / JSON Schema / tool envelope / auth / transport。
- Web API / HTTP status / UI。
- OCR DB migration、FTS triggerの作成・検証。
- DB open helperのfd cleanupや接続close責務。
- OCR write / reviewed更新処理。

MCP側では、公開OCR-SEARCH APIへのadapter integrationを残す。BOOK-OCR本体は検索consumerではなく、検索テストやCLI検索テストを持たない。将来のBOOK-OCR Web UIは独立consumerとして、別リポジトリでAPI integration testを持つ。

## 7. 完了判定

- [ ] 標準検索fixture 8ケースがすべて実行可能なtestで消費される。
- [ ] parser/compilerの境界・安全性テストが実行可能。
- [ ] DB contract validatorのpositive / negative casesが実行可能。
- [ ] 日本語実extension integrationがCIで実行される。
- [ ] Worker lifecycle 10ケースが実行可能。
- [ ] baseline比較が同一fixtureで自動化される。
- [ ] test-only fixture integrity checkと意味論テストが区別される。
- [ ] npm pack後のtarball smoke testが実行される。
- [ ] OCR-SEARCHのテスト群がMCP / Web UIの依存なしで実行できる。


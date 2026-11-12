# OCR-SEARCH

独立した OCR 検索 package。検索仕様と実装の正本となり、ocr-mcp-server と book-ocr Web UI から利用する。

- 設計書: [DESIGN.md](./DESIGN.md)
- 現在の段階: 実装前設計。package のコード抽出はまだ開始していない。
- 仕様の基準: [OCR-MCP-SERVER](https://github.com/studioddtonline/OCR-MCP-SERVER) の現行検索実装。
- DB 所有: OCR 元DBの schema / migrations / 通常 FTS5 index は book-ocr が所有する。

## 基本方針

- 標準検索と日本語検索の semantics をこの package に集約する。
- 日本語専用索引の形式・builder・reader・Worker は package が所有する。
- OCR 元DBの作成・migration・images_fts 更新は行わない。
- DB接続、config、認証、MCP / Web API は consumer が所有する。
- 抽出時には検索仕様を変更しない。
- native Vaporetto binary は tarball に同梱せず、version/hash 固定 installer で導入する。

## Consumers

- ocr-mcp-server: MCP adapter
- book-ocr Web UI: Node.js server-side API

詳細な責務分担、API案、DB contract、テスト計画、配布計画、抽出手順は [DESIGN.md](./DESIGN.md) を参照。

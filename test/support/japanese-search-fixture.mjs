import { DatabaseSync } from "node:sqlite";

const INDEXED_AT = "2026-01-01T00:00:00.000Z";
const SOURCE_TEXT = "東京特許許可局";
const SEARCHABLE_TOKEN = /[\p{L}\p{N}]/u;

function searchableTokens(value) {
  return String(value ?? "")
    .split(/\s+/u)
    .filter((token) => token.length > 0 && SEARCHABLE_TOKEN.test(token));
}

/**
 * Build the one-document Japanese index used by the pinned OCR-MCP-SERVER
 * Worker integration test. The native extension is loaded only by this builder;
 * the resulting index is opened read-only by the search Worker.
 */
export function createJapaneseSearchFixtureIndex(indexPath, extensionPath) {
  const db = new DatabaseSync(indexPath, { allowExtension: true });
  try {
    db.loadExtension(extensionPath, "sqlite3_vaporetto_init");
    db.enableLoadExtension(false);
    db.exec(`
      CREATE TABLE japanese_search_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        tokenizer TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        source_record_count INTEGER NOT NULL,
        source_max_id INTEGER NOT NULL
      );
      INSERT INTO japanese_search_meta
        VALUES (1, 2, 'vaporetto-pretokenized-unicode61', '${INDEXED_AT}', 1, 7);
      CREATE TABLE japanese_documents (
        source_id INTEGER PRIMARY KEY,
        file_path TEXT,
        file_name TEXT,
        reviewed INTEGER,
        ocr_text TEXT NOT NULL
      );
      INSERT INTO japanese_documents
        VALUES (7, 'テスト書籍', '001.webp', 1, '${SOURCE_TEXT}');
      CREATE VIRTUAL TABLE japanese_fts
        USING fts5(search_text, content='', tokenize='unicode61');
    `);

    const tokenized = db.prepare(
      "SELECT vaporetto_split(?, ' ') AS tokens",
    ).get(SOURCE_TEXT)?.tokens;
    const tokens = searchableTokens(tokenized);
    if (tokens.length === 0) {
      throw new Error("Vaporetto fixture tokenizer returned no searchable tokens");
    }
    db.prepare(
      "INSERT INTO japanese_fts(rowid, search_text) VALUES (?, ?)",
    ).run(7, tokens.join(" "));
    return {
      query: SOURCE_TEXT,
      queryTokens: tokens,
      metadata: {
        schemaVersion: 2,
        tokenizer: "vaporetto-pretokenized-unicode61",
        indexedAt: INDEXED_AT,
        indexedRecords: 1,
        sourceMaxId: 7,
      },
    };
  } catch (error) {
    try { db.close(); } catch { /* Preserve the fixture creation error. */ }
    throw error;
  } finally {
    // The Worker opens its own read-only handle after the builder has closed.
    try { db.close(); } catch { /* Already closed after fixture failure. */ }
  }
}

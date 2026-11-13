import { DatabaseSync } from "node:sqlite";
import { accessSync, constants, mkdirSync, rmSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

function readOption(name) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return item?.slice(prefix.length);
}
const databasePath = readOption("database");
const indexPath = readOption("index");
const extensionPath = readOption("extension");
const busyRaw = readOption("busy-timeout-ms");
const busyTimeoutMs = busyRaw === undefined ? 500 : Number(busyRaw);
const required = { database: databasePath, index: indexPath, extension: extensionPath };
const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => `--${name}`);
if (missing.length) {
  console.error(`Required options: ${missing.join(", ")}. Example: npm run japanese-index -- --database=/path/ocr.sqlite --index=/path/japanese.sqlite --extension=/path/libsqlite_vaporetto.so`);
  process.exit(2);
}
if (![databasePath, indexPath, extensionPath].every((value) => value.startsWith("/"))) {
  console.error("Database, index, and extension paths must be absolute.");
  process.exit(2);
}
if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 120000) {
  console.error("--busy-timeout-ms must be an integer from 0 to 120000.");
  process.exit(2);
}
const sourcePath = resolve(databasePath);
const outputPath = resolve(indexPath);
const libraryPath = resolve(extensionPath);
if (new Set([sourcePath, outputPath, libraryPath]).size !== 3) {
  console.error("The source database, Japanese index, and native extension must be different paths.");
  process.exit(2);
}
const SEARCHABLE_TOKEN = /[\p{L}\p{N}]/u;
function searchableTokens(value) {
  return String(value ?? "").split(/\s+/u).filter((token) => token.length > 0 && SEARCHABLE_TOKEN.test(token));
}
function quoteFts5Token(token) {
  return `"${token.replace(/"/gu, '""')}"`;
}
function closeQuietly(db) {
  try { db?.close(); } catch { /* Preserve the original failure. */ }
}

accessSync(sourcePath, constants.R_OK);
accessSync(libraryPath, constants.R_OK);
mkdirSync(dirname(outputPath), { recursive: true });
const stagingPath = `${outputPath}.building-${process.pid}-${randomUUID()}`;
let source;
let target;
let sourceTransaction = false;
let targetTransaction = false;
try {
  source = new DatabaseSync(sourcePath, { readOnly: true, timeout: busyTimeoutMs });
  const requiredColumns = new Set(["id", "file_path", "file_name", "ocr_text", "reviewed"]);
  const columns = new Set(source.prepare("PRAGMA table_info(source_images)").all().map((row) => String(row.name).toLowerCase()));
  const missingColumns = [...requiredColumns].filter((name) => !columns.has(name));
  if (missingColumns.length) throw new Error(`source_images is incompatible; missing columns: ${missingColumns.join(", ")}`);

  source.exec("BEGIN");
  sourceTransaction = true;
  const totals = source.prepare("SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS max_id FROM source_images").get();
  const sourceCount = Number(totals.count);
  const sourceMaxId = Number(totals.max_id);
  console.log(`Building Japanese index from ${sourceCount} OCR records.`);

  target = new DatabaseSync(stagingPath, { timeout: busyTimeoutMs, allowExtension: true });
  target.loadExtension(libraryPath, "sqlite3_vaporetto_init");
  target.enableLoadExtension(false);
  target.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL;");
  target.exec(`
    CREATE TABLE japanese_search_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      tokenizer TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      source_record_count INTEGER NOT NULL,
      source_max_id INTEGER NOT NULL
    );
    CREATE TABLE japanese_documents (
      source_id INTEGER PRIMARY KEY,
      file_path TEXT,
      file_name TEXT,
      reviewed INTEGER,
      ocr_text TEXT NOT NULL
    );
    CREATE INDEX japanese_documents_label_idx ON japanese_documents(file_path);
    CREATE INDEX japanese_documents_reviewed_idx ON japanese_documents(reviewed);
    CREATE VIRTUAL TABLE japanese_fts USING fts5(search_text, content='', tokenize='unicode61');
  `);
  target.exec("BEGIN IMMEDIATE");
  targetTransaction = true;
  const insertDocument = target.prepare("INSERT INTO japanese_documents(source_id, file_path, file_name, reviewed, ocr_text) VALUES (?, ?, ?, ?, ?)");
  const tokenize = target.prepare("SELECT vaporetto_split(?, ' ') AS tokens");
  const insertFts = target.prepare("INSERT INTO japanese_fts(rowid, search_text) VALUES (?, ?)");
  const select = source.prepare("SELECT id, file_path, file_name, reviewed, ocr_text FROM source_images ORDER BY id");
  let imported = 0;
  for (const row of select.iterate()) {
    const ocrText = String(row.ocr_text ?? "");
    insertDocument.run(row.id, row.file_path ?? null, row.file_name ?? null, row.reviewed ?? null, ocrText);
    const tokenized = tokenize.get(ocrText)?.tokens ?? "";
    insertFts.run(row.id, searchableTokens(tokenized).join(" "));
    imported += 1;
    if (imported % 1000 === 0) console.log(`Tokenized and indexed ${imported}/${sourceCount} records...`);
  }
  if (imported !== sourceCount) throw new Error(`Inconsistent source snapshot: expected ${sourceCount}, copied ${imported}`);
  source.exec("COMMIT");
  sourceTransaction = false;

  const indexedAt = new Date().toISOString();
  target.prepare("INSERT INTO japanese_search_meta VALUES (1, 2, 'vaporetto-pretokenized-unicode61', ?, ?, ?)").run(indexedAt, sourceCount, sourceMaxId);
  target.exec("COMMIT");
  targetTransaction = false;
  const probe = target.prepare("SELECT vaporetto_split('吾輩は猫である', ' ') AS tokens").get();
  const probeTokens = searchableTokens(probe?.tokens);
  if (!probeTokens.length) throw new Error("Vaporetto returned no searchable tokens for the smoke-test text");
  target.prepare("SELECT rowid FROM japanese_fts WHERE japanese_fts MATCH ? LIMIT 1").get(probeTokens.map(quoteFts5Token).join(" OR "));

  target.close();
  target = undefined;
  source.close();
  source = undefined;
  renameSync(stagingPath, outputPath);
  console.log(`Japanese index built: ${outputPath}`);
  console.log(`Records: ${sourceCount}; max source ID: ${sourceMaxId}; indexed at: ${indexedAt}`);
  console.log("Index schema v2 is ready. Restart applications using this index.");
} catch (error) {
  if (targetTransaction) { try { target?.exec("ROLLBACK"); } catch { /* Best effort. */ } }
  if (sourceTransaction) { try { source?.exec("ROLLBACK"); } catch { /* Best effort. */ } }
  closeQuietly(target);
  closeQuietly(source);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try { rmSync(`${stagingPath}${suffix}`, { force: true }); } catch { /* Best effort. */ }
  }
  console.error("Japanese index build failed; the previous index, if any, was not replaced.");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

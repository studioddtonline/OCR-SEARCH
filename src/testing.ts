import type { DatabaseSync } from "node:sqlite";
import { SearchUnavailableError } from "./errors.js";

export const REQUIRED_SOURCE_IMAGE_COLUMNS = ["id", "file_path", "file_name", "ocr_text", "reviewed"] as const;

const TABLES_SQL = "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('source_images', 'images_fts')";
const COLUMNS_SQL = "PRAGMA table_info(source_images)";
const MATCH_PROBE_SQL = "SELECT rowid FROM images_fts WHERE images_fts MATCH ? LIMIT 1";

/** Production compatibility check. Deliberately does not require a particular FTS5 tokenizer. */
export function assertSearchDatabaseCompatible(db: DatabaseSync): void {
  const tables = db.prepare(TABLES_SQL).all() as Array<{ name: string; sql: string | null }>;
  const definitions = new Map(tables.map(row => [row.name, row.sql ?? ""]));
  if (!definitions.has("source_images") || !definitions.has("images_fts")) {
    throw new SearchUnavailableError("Database must contain source_images and images_fts.");
  }
  const columns = new Set(
    (db.prepare(COLUMNS_SQL).all() as Array<{ name: string }>).map(row => row.name.toLowerCase()),
  );
  const missing = REQUIRED_SOURCE_IMAGE_COLUMNS.filter(column => !columns.has(column));
  if (missing.length) {
    throw new SearchUnavailableError(`source_images is missing required column(s): ${missing.join(", ")}.`);
  }
  if (!/^\s*CREATE\s+VIRTUAL\s+TABLE\b[\s\S]*?\bUSING\s+fts5\b/i.test(definitions.get("images_fts")!)) {
    throw new SearchUnavailableError("images_fts must be an FTS5 virtual table.");
  }
  try {
    db.prepare(MATCH_PROBE_SQL).get('"abc"');
  } catch (cause) {
    throw new SearchUnavailableError("images_fts cannot be queried with MATCH.", { cause });
  }
}

/**
 * Test-only strict contract for the standard-search regression fixtures.
 * This is intentionally stricter than the production compatibility validator.
 */
export function assertTrigramSearchDatabaseCompatible(db: DatabaseSync): void {
  assertSearchDatabaseCompatible(db);
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'images_fts'").get() as
    | { sql: string | null } | undefined;
  if (!row?.sql || !/\btokenize\s*=\s*['"]trigram['"]/i.test(row.sql)) {
    throw new SearchUnavailableError("Regression database must use the FTS5 trigram tokenizer.");
  }
}

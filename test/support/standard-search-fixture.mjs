import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const supportDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(supportDir, "../..");
const baseline = JSON.parse(
  readFileSync(resolve(projectRoot, "test/fixtures/standard-search-baseline.json"), "utf8"),
);
const schemaSql = readFileSync(
  resolve(projectRoot, "test/fixtures/ocr-search-schema.sql"),
  "utf8",
);

const insertRowSql = `
  INSERT INTO source_images (id, file_path, file_name, ocr_text, reviewed)
  VALUES (?, ?, ?, ?, ?)
`;

/**
 * Create one scenario-specific SQLite fixture matching the pinned OCR-MCP-SERVER rows.
 * The returned DatabaseSync is caller-owned; the test must close it.
 */
export function createStandardSearchFixture(caseId, filename = ":memory:") {
  const scenario = baseline.cases.find((item) => item.id === caseId);
  if (!scenario) throw new Error(`Unknown standard-search fixture case: ${caseId}`);

  const db = new DatabaseSync(filename);
  try {
    db.exec(schemaSql);
    const insert = db.prepare(insertRowSql);
    for (const row of scenario.rows) {
      insert.run(row.id, row.label, row.fileName, row.text, row.reviewed);
    }
    if (scenario.rows.length > 0) {
      db.exec("INSERT INTO images_fts(images_fts) VALUES ('rebuild')");
    }
    return db;
  } catch (error) {
    try { db.close(); } catch { /* Preserve the fixture creation error. */ }
    throw error;
  }
}

/** Read-only fixture metadata for tests that need the source expectations. */
export function getStandardSearchFixtureCase(caseId) {
  const scenario = baseline.cases.find((item) => item.id === caseId);
  if (!scenario) throw new Error(`Unknown standard-search fixture case: ${caseId}`);
  return structuredClone(scenario);
}

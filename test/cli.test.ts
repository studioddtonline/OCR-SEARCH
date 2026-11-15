import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const schema = readFileSync(resolve(root, "test/fixtures/ocr-search-schema.sql"), "utf8");

test("CLI search writes one valid JSON document to stdout", () => {
  const directory = mkdtempSync(join(tmpdir(), "ocr-search-cli-"));
  const databasePath = join(directory, "source.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(schema);
    database.prepare(
      "INSERT INTO source_images (id, file_path, file_name, ocr_text, reviewed) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "CLI fixture", "001.webp", "alpha CLI smoke test", 0);
    database.exec("INSERT INTO images_fts(images_fts) VALUES ('rebuild')");
  } finally {
    database.close();
  }

  try {
    const result = spawnSync(process.execPath, [
      "--import", "tsx",
      resolve(root, "src/cli.ts"),
      "search",
      `--database=${databasePath}`,
      "--query=alpha",
      "--limit=1",
    ], { cwd: root, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    const output = JSON.parse(result.stdout) as {
      returned: number;
      results: Array<{ id: number; label: string | null }>;
    };
    assert.equal(output.returned, 1);
    assert.equal(output.results[0]?.id, 1);
    assert.equal(output.results[0]?.label, "CLI fixture");
    // Node may emit ExperimentalWarning on stderr; it must never contaminate stdout.
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("CLI help is written to stdout with a successful exit code", () => {
  const result = spawnSync(process.execPath, [
    "--import", "tsx",
    resolve(root, "src/cli.ts"),
    "--help",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OCR-SEARCH CLI/);
});

test("CLI without arguments writes usage to stderr and exits with code 2", () => {
  const result = spawnSync(process.execPath, [
    "--import", "tsx",
    resolve(root, "src/cli.ts"),
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /OCR-SEARCH CLI/);
});

test("CLI rejects unknown options instead of silently ignoring them", () => {
  const result = spawnSync(process.execPath, [
    "--import", "tsx",
    resolve(root, "src/cli.ts"),
    "search",
    "--lable=typo",
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unknown option/i);
});

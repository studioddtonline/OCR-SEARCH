import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("an open SQLite handle keeps the old index inode after atomic replacement", () => {
  const directory = mkdtempSync(join(tmpdir(), "ocr-search-index-swap-"));
  const indexPath = join(directory, "japanese.sqlite");
  const stagingPath = join(directory, "japanese.building.sqlite");
  const initial = new DatabaseSync(indexPath);
  initial.exec("CREATE TABLE japanese_search_meta (version TEXT NOT NULL); INSERT INTO japanese_search_meta VALUES ('old');");
  initial.close();

  const oldHandle = new DatabaseSync(indexPath, { readOnly: true });
  try {
    assert.equal(oldHandle.prepare("SELECT version FROM japanese_search_meta").get()?.version, "old");
    const replacement = new DatabaseSync(stagingPath);
    replacement.exec("CREATE TABLE japanese_search_meta (version TEXT NOT NULL); INSERT INTO japanese_search_meta VALUES ('new');");
    replacement.close();
    renameSync(stagingPath, indexPath);

    assert.equal(oldHandle.prepare("SELECT version FROM japanese_search_meta").get()?.version, "old");
    const newHandle = new DatabaseSync(indexPath, { readOnly: true });
    try {
      assert.equal(newHandle.prepare("SELECT version FROM japanese_search_meta").get()?.version, "new");
    } finally {
      newHandle.close();
    }
  } finally {
    oldHandle.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

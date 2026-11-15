import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tarball = resolve(root, process.argv[2] ?? `ocr-search-${packageJson.version}.tgz`);
const requiredFiles = [
  "package/dist/index.js",
  "package/dist/cli.js",
  "package/dist/japanese/worker.mjs",
  "package/dist/reviewed.mjs",
  "package/dist/query.js",
  "package/dist/reviewed.js",
  "package/dist/types.js",
  "package/dist/types.d.ts",
  "package/NOTICE",
];

const archive = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n");
for (const file of requiredFiles) {
  assert.ok(archive.includes(file), `Packed package is missing ${file}`);
}

const installDir = mkdtempSync(join(tmpdir(), "ocr-search-package-smoke-"));
try {
  execFileSync("npm", ["install", "--prefix", installDir, "--no-save", tarball], {
    cwd: root,
    stdio: "inherit",
  });

  const smokePath = join(installDir, "smoke.mjs");
  writeFileSync(smokePath, `
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { OcrSearch } from "ocr-search";
import { parseSearchQuery } from "ocr-search/query";
import { isReviewed } from "ocr-search/reviewed";

assert.equal(parseSearchQuery("alpha").type, "term");
assert.equal(isReviewed(null), true);

const databasePath = join(process.cwd(), "smoke.sqlite");
const database = new DatabaseSync(databasePath);
database.exec(`
  CREATE TABLE source_images (
    id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, ocr_text TEXT, reviewed INTEGER
  );
  CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text, tokenize='trigram');
  INSERT INTO source_images VALUES (1, 'smoke', '001.webp', 'alpha package smoke', 0);
  INSERT INTO images_fts(rowid, ocr_text) VALUES (1, 'alpha package smoke');
`);
const search = new OcrSearch({ database });
const result = await search.search({ query: "alpha", limit: 1 });
assert.equal(result.results[0]?.id, 1);
search.close();
database.close();

const cli = spawnSync(process.execPath, [
  join(process.cwd(), "node_modules/ocr-search/dist/cli.js"),
  "search",
  `--database=${databasePath}`,
  "--query=alpha",
  "--limit=1",
], { encoding: "utf8" });
assert.equal(cli.status, 0, cli.stderr);
const cliResult = JSON.parse(cli.stdout);
assert.equal(cliResult.results[0]?.id, 1);
`, "utf8");

  execFileSync(process.execPath, [smokePath], {
    cwd: installDir,
    stdio: "inherit",
  });
} finally {
  rmSync(installDir, { recursive: true, force: true });
}

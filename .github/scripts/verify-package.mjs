import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
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
assert.ok(!archive.some((file) => file.endsWith(".map")), "Package tarball must not contain sourcemaps");

// Every relative Markdown link in the published package must resolve to another
// packaged file. External URLs and fragment-only links are intentionally ignored.
const markdownFiles = archive.filter((file) => file.startsWith("package/") && file.endsWith(".md"));
for (const markdownFile of markdownFiles) {
  const markdown = execFileSync("tar", ["-xOzf", tarball, markdownFile], { encoding: "utf8" });
  const destinations = [
    ...Array.from(markdown.matchAll(/!?\\[[^\\]]*\\]\\(([^)\\s]+)(?:\\s+[^)]*)?\\)/g), match => match[1]),
    ...Array.from(markdown.matchAll(/^\\s*\\[[^\\]]+\\]:\\s*(\\S+)/gm), match => match[1]),
  ];
  for (const destination of destinations) {
    const target = destination.split(/[?#]/, 1)[0];
    if (!target || target.startsWith("#") || target.startsWith("/") ||
        /^(?:[a-z][a-z0-9+.-]*:|\\/\\/)/i.test(target)) continue;
    let decoded = target;
    try { decoded = decodeURIComponent(target); } catch { /* Keep malformed escapes literal; lookup will fail. */ }
    const relative = posix.normalize(posix.join(posix.dirname(markdownFile.slice("package/".length)), decoded));
    assert.ok(!relative.startsWith("../") && relative !== "..", `Markdown link escapes package: ${markdownFile} -> ${destination}`);
    assert.ok(archive.includes(`package/${relative}`), `Broken packaged Markdown link: ${markdownFile} -> ${destination}`);
  }
}

for (const forbidden of [
  "package/scripts/clean-dist.mjs",
  "package/scripts/copy-runtime-assets.mjs",
]) {
  assert.ok(!archive.includes(forbidden), `Build-only script must not be packed: ${forbidden}`);
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
database.exec(
  "CREATE TABLE source_images (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, ocr_text TEXT, reviewed INTEGER);" +
  "CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text, content='source_images', content_rowid='id', tokenize='trigram');" +
  "INSERT INTO source_images VALUES (1, 'smoke', '001.webp', 'alpha package smoke', 0);" +
  "INSERT INTO images_fts(images_fts) VALUES ('rebuild');"
);
const search = new OcrSearch({ database });
const result = await search.search({ query: "alpha", limit: 1 });
assert.equal(result.results[0]?.id, 1);
search.close();
database.close();

const cli = spawnSync(process.execPath, [
  join(process.cwd(), "node_modules/ocr-search/dist/cli.js"),
  "search",
  "--database=" + databasePath,
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

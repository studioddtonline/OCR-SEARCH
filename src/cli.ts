#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { OcrSearch } from "./index.js";

function readArguments(argv: string[]) {
  const [command, ...rest] = argv;
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const separator = item.indexOf("=");
    if (separator >= 0) options[item.slice(2, separator)] = item.slice(separator + 1);
    else {
      const name = item.slice(2);
      const next = rest[index + 1];
      if (next && !next.startsWith("--")) { options[name] = next; index += 1; }
      else options[name] = "true";
    }
  }
  return { command, options };
}
function required(options: Record<string, string>, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || !value) throw new Error(`Missing required --${name} option.`);
  return value;
}
function integerOption(options: Record<string, string>, name: string, fallback: number): number {
  if (options[name] === undefined) return fallback;
  const value = Number(options[name]);
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} must be an integer.`);
  return value;
}
function booleanOption(options: Record<string, string>, name: string): boolean | undefined {
  if (options[name] === undefined) return undefined;
  if (options[name] === "true") return true;
  if (options[name] === "false") return false;
  throw new Error(`--${name} must be true or false.`);
}
function parseQuery(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); }
    catch (cause) { throw new Error("--query JSON is invalid.", { cause }); }
  }
  return value;
}
function usage() {
  console.error(`OCR-SEARCH CLI
  ocr-search search --database=/absolute/path/ocr.sqlite --query="term" [--label=LABEL] [--reviewed=true|false] [--limit=20] [--offset=0] [--after-id=ID]
  ocr-search search-japanese --database=/absolute/path/ocr.sqlite --index=/absolute/path/japanese.sqlite --extension=/absolute/path/libsqlite_vaporetto.so --query="日本語" [--mode=any|all] [--label=LABEL] [--reviewed=true|false] [--limit=20] [--offset=0]

Japanese search is opt-in and starts a Vaporetto Worker; initialization may take several seconds.
`);
}
async function main() {
  const { command, options } = readArguments(process.argv.slice(2));
  if (command === "help" || command === "--help" || !command) { usage(); return; }
  if (command !== "search" && command !== "search-japanese") {
    usage();
    throw new Error(`Unknown command: ${command}`);
  }
  const databasePath = required(options, "database");
  const query = required(options, "query");
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: integerOption(options, "busy-timeout-ms", 500) });
  let search: OcrSearch | undefined;
  try {
    const japanese = command === "search-japanese" ? {
      indexPath: required(options, "index"),
      extensionPath: required(options, "extension"),
      busyTimeoutMs: integerOption(options, "busy-timeout-ms", 500),
      maxLimit: 20,
    } : undefined;
    if (japanese) console.error("Initializing Japanese search Worker (Vaporetto model initialization may take several seconds)...");
    search = new OcrSearch({
      database,
      ...(japanese ? { japanese } : {}),
      standard: { defaultLimit: 20, maxLimit: 50, snippetLength: 160 },
    });
    const reviewed = booleanOption(options, "reviewed");
    const label = options.label;
    const limit = integerOption(options, "limit", 20);
    const offset = integerOption(options, "offset", 0);
    const mode = options.mode ?? "any";
    if (mode !== "any" && mode !== "all") throw new Error("--mode must be any or all.");
    const result = command === "search"
      ? await search.search({
          query: parseQuery(query),
          ...(label === undefined ? {} : { label }),
          ...(reviewed === undefined ? {} : { reviewed }),
          limit,
          offset,
          ...(options["after-id"] === undefined ? {} : { afterId: integerOption(options, "after-id", 0) }),
        })
      : await search.searchJapanese({
          query,
          mode,
          ...(label === undefined ? {} : { label }),
          ...(reviewed === undefined ? {} : { reviewed }),
          limit,
          offset,
        });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\\n`);
  } finally {
    search?.close();
    database.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

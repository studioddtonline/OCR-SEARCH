import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const assets = [
  ["src/japanese/worker.mjs", "dist/japanese/worker.mjs"],
  ["src/reviewed.mjs", "dist/reviewed.mjs"],
];
for (const [source, destination] of assets) {
  const target = resolve(root, destination);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(root, source), target);
  console.log(`Copied runtime asset: ${destination}`);
}

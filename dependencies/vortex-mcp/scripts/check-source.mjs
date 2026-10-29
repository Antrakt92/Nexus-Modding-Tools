// Pass reviewed files explicitly: isolated builds can live below an ignored
// local-state directory, which newer Oxc directory traversal correctly skips.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
if (!["lint", "lint:fix", "format", "format:check"].includes(mode)) {
  throw new Error("Expected lint, lint:fix, format or format:check");
}
const lint = mode.startsWith("lint");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "UPSTREAM-PROVENANCE.json"), "utf8"));
const names = manifest.expectedPublicFiles;
if (!Array.isArray(names) || new Set(names).size !== names.length) {
  throw new Error("Reviewed source inventory required");
}
const files = names.filter((name) => {
  if (
    typeof name !== "string" ||
    !/^[a-zA-Z0-9_./-]+$/.test(name) ||
    name.split("/").some((part) => !part || part === ".." || part === ".")
  ) {
    throw new Error("Unsafe source inventory path");
  }
  return (
    (lint ? /\.(?:[cm]?js|ts)$/ : /\.(?:[cm]?js|ts|json|md|ya?ml)$/).test(name) &&
    name !== "pnpm-lock.yaml"
  );
});
if (!files.length) throw new Error("No reviewed source files selected");
for (const name of files) {
  const file = path.join(root, name);
  if (!fs.lstatSync(file).isFile()) throw new Error("Ordinary reviewed file required: " + name);
}
const tool = lint ? "oxlint" : "oxfmt";
const flags = mode === "lint:fix" ? ["--fix"] : mode === "format:check" ? ["--check"] : [];
console.log(`${tool}: ${files.length} explicit reviewed files`);
const result = spawnSync(
  process.execPath,
  [path.join(root, "node_modules", tool, "bin", tool), ...flags, ...files],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

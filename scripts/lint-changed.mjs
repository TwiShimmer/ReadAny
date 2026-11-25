#!/usr/bin/env node
/**
 * Lint only the files changed against the base branch.
 *
 * Why: the full-repo `pnpm lint` currently fails on pre-existing debt
 * (vendored code, CRLF history). PRs must not be blocked by files they did not
 * touch, so this script diffs against the base branch and runs Biome on the
 * changed, lintable files only.
 *
 * Base branch resolution:
 *   - CI pull_request: GITHUB_BASE_REF (e.g. "main")
 *   - otherwise: origin/main
 *
 * No changed files => exit 0.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const BIOME_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const CHUNK_SIZE = 40;

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

function refExists(ref) {
  return (
    spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd: repoRoot,
      stdio: "ignore",
    }).status === 0
  );
}

function resolveBaseRef() {
  const baseBranch = process.env.GITHUB_BASE_REF?.trim() || "main";
  const remoteRef = `origin/${baseBranch}`;

  if (refExists(remoteRef)) return remoteRef;

  try {
    execFileSync("git", ["fetch", "--quiet", "--no-tags", "origin", baseBranch], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch {
    // Fall through to the explicit error below with the original ref name.
  }

  if (refExists(remoteRef)) return remoteRef;

  throw new Error(
    `[lint:changed] Cannot resolve base ref "${remoteRef}". ` +
      `Fetch it first: git fetch origin ${baseBranch}`,
  );
}

function gitFileList(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" })
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
}

function changedFiles(baseRef) {
  // Committed changes against the base branch, plus local working-tree and
  // untracked files so the same script works before committing.
  return [
    ...new Set([
      ...gitFileList(["diff", "--name-only", "--diff-filter=ACMR", `${baseRef}...HEAD`]),
      ...gitFileList(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]),
      ...gitFileList(["ls-files", "--others", "--exclude-standard"]),
    ]),
  ];
}

function lintableFiles(files) {
  return files.filter((file) => {
    if (!BIOME_EXTENSIONS.has(path.extname(file).toLowerCase())) return false;
    return existsSync(path.join(repoRoot, file));
  });
}

function biomeBinary() {
  const name = process.platform === "win32" ? "biome.cmd" : "biome";
  return path.join(repoRoot, "node_modules", ".bin", name);
}

const baseRef = resolveBaseRef();
const files = lintableFiles(changedFiles(baseRef));

if (files.length === 0) {
  console.log(`[lint:changed] No lintable changes against ${baseRef}. Nothing to check.`);
  process.exit(0);
}

const biome = biomeBinary();
if (!existsSync(biome)) {
  throw new Error("[lint:changed] Biome binary not found. Run `pnpm install` first.");
}

console.log(`[lint:changed] Checking ${files.length} changed file(s) against ${baseRef}.`);

for (let index = 0; index < files.length; index += CHUNK_SIZE) {
  const chunk = files.slice(index, index + CHUNK_SIZE);
  const result = spawnSync(biome, ["check", ...chunk], {
    cwd: repoRoot,
    stdio: "inherit",
    // .cmd shims on Windows need a shell; Linux binaries do not.
    shell: process.platform === "win32",
  });

  if (result.error) throw result.error;

  if (result.status !== 0) {
    console.error(`[lint:changed] Biome reported problems in ${chunk.length} file(s).`);
    process.exit(result.status ?? 1);
  }
}

console.log("[lint:changed] All changed files pass.");

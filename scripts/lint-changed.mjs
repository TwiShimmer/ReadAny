#!/usr/bin/env node
/**
 * Lint only the files changed against the base branch.
 *
 * Why: the full-repo `pnpm lint` currently fails on pre-existing debt
 * (vendored code, CRLF history). PRs must not be blocked by files they did not
 * touch, so this script diffs against the base branch and runs Biome on the
 * changed, lintable files only.
 *
 * Base branch resolution, in order:
 *   - `--base <ref>` / `--base=<ref>`
 *   - LINT_BASE_REF (e.g. "upstream/main" for fork PRs)
 *   - GITHUB_BASE_REF (CI pull_request)
 *   - origin/main
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

function argBase(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith("-")) {
        throw new Error("[lint:changed] --base requires a ref, e.g. --base origin/main.");
      }
      return value;
    }
    if (arg.startsWith("--base=")) {
      const value = arg.slice("--base=".length).trim();
      if (!value) {
        throw new Error("[lint:changed] --base requires a ref, e.g. --base=origin/main.");
      }
      return value;
    }
  }
  return undefined;
}

function refExists(ref) {
  return (
    spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd: repoRoot,
      stdio: "ignore",
    }).status === 0
  );
}

function remoteNames() {
  return execFileSync("git", ["remote"], { cwd: repoRoot, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
}

function fetchRef(base) {
  const separator = base.indexOf("/");
  const maybeRemote = separator > 0 ? base.slice(0, separator) : "";
  const isKnownRemote = Boolean(maybeRemote) && remoteNames().includes(maybeRemote);
  const remote = isKnownRemote ? maybeRemote : "origin";
  const branch = isKnownRemote ? base.slice(separator + 1) : base;

  try {
    execFileSync("git", ["fetch", "--quiet", "--no-tags", remote, branch], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch {
    // Fall through to the explicit error below with the original ref name.
  }
}

function warnIfLocalFallback(ref, base) {
  if (ref === base && !base.includes("/")) {
    console.warn(
      `[lint:changed] origin/${base} not found; using local ref "${base}", which may be stale. Pass --base origin/<branch> or LINT_BASE_REF to be explicit.`,
    );
  }
  return ref;
}

function resolveBaseRef() {
  const explicit = argBase(process.argv.slice(2))?.trim() || process.env.LINT_BASE_REF?.trim();
  const base = explicit || process.env.GITHUB_BASE_REF?.trim() || "main";
  const refs = base.includes("/") ? [base] : [`origin/${base}`, base];

  for (const ref of refs) {
    if (refExists(ref)) return warnIfLocalFallback(ref, base);
  }

  fetchRef(base);

  for (const ref of refs) {
    if (refExists(ref)) return warnIfLocalFallback(ref, base);
  }

  throw new Error(
    `[lint:changed] Cannot resolve base ref "${refs.join('" / "')}". Fetch it first, or pass --base / LINT_BASE_REF.`,
  );
}

function gitFileList(args) {
  // -z keeps paths verbatim (spaces, Chinese, newlines); quotePath=false stops
  // Git from escaping non-ASCII characters into "\344\270\255" form.
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

function changedFiles(baseRef) {
  // Committed changes against the base branch, plus local working-tree and
  // untracked files so the same script works before committing.
  return [
    ...new Set([
      // --no-renames turns a rename into A+D, so the new path is always linted.
      ...gitFileList([
        "diff",
        "--no-renames",
        "--name-only",
        "--diff-filter=ACMR",
        "-z",
        `${baseRef}...HEAD`,
      ]),
      ...gitFileList(["diff", "--no-renames", "--name-only", "--diff-filter=ACMR", "-z", "HEAD"]),
      ...gitFileList(["ls-files", "-z", "--others", "--exclude-standard"]),
    ]),
  ];
}

function lintableFiles(files) {
  return files.filter((file) => {
    if (!BIOME_EXTENSIONS.has(path.extname(file).toLowerCase())) return false;
    return existsSync(path.join(repoRoot, file));
  });
}

function biomeEntryPoint() {
  return path.join(repoRoot, "node_modules", "@biomejs", "biome", "bin", "biome");
}

const baseRef = resolveBaseRef();
const files = lintableFiles(changedFiles(baseRef));

if (files.length === 0) {
  console.log(`[lint:changed] No lintable changes against ${baseRef}. Nothing to check.`);
  process.exit(0);
}

const biome = biomeEntryPoint();
if (!existsSync(biome)) {
  throw new Error("[lint:changed] Biome entry point not found. Run `pnpm install` first.");
}

console.log(`[lint:changed] Checking ${files.length} changed file(s) against ${baseRef}.`);

for (let index = 0; index < files.length; index += CHUNK_SIZE) {
  const chunk = files.slice(index, index + CHUNK_SIZE);
  // Run Biome's JS entry point with Node directly: no shell, so paths with
  // spaces or non-ASCII characters stay single arguments on every platform.
  const result = spawnSync(
    process.execPath,
    [biome, "check", "--no-errors-on-unmatched", ...chunk],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  if (result.error) throw result.error;

  if (result.status !== 0) {
    console.error(`[lint:changed] Biome reported problems in ${chunk.length} file(s).`);
    process.exit(result.status ?? 1);
  }
}

console.log("[lint:changed] All changed files pass.");

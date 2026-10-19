#!/usr/bin/env node
/**
 * Published-file-set check (issue #49).
 *
 * npm packs everything not ignored unless a `files` whitelist says otherwise, so
 * the published artifact is only as small and as clean as the whitelist is
 * explicit. What must never ship: the test suite and its fixtures (evidence
 * stays in the repo, not the package), `scripts/`, and — above all — anything
 * matching `.env*`. A secret that ever lands near a `.env.phase2`-style path
 * must not be able to reach the registry because npm's implicit ignore rules
 * happened to cover it; this check does not depend on npm's defaults at all.
 *
 * It reads the *packed* tarball (`npm pack --json`), not the working tree, so it
 * measures exactly what a consumer would download.
 *
 * Usage: npm run test:pack   (run `npm run build` first; the tarball is built
 * from `dist/`).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();

/** Everything the package is allowed to ship: build output plus metadata. */
const ALLOWED_TOP_LEVEL = new Set(["dist/", "README.md", "LICENSE", "package.json"]);

/** Path fragments that must never appear in the tarball, whatever npm's defaults say. */
const FORBIDDEN_FRAGMENTS = [
  ".env",
  "tests/",
  "scripts/",
  "src/",
  "docs/",
  "examples/",
  "benches/",
  ".github/",
];

class PackCheckFailure extends Error {}

function fail(message: string): never {
  throw new PackCheckFailure(message);
}

function packedFiles() {
  const packDir = mkdtempSync(join(tmpdir(), "stellar-agent-guard-pack-check-"));
  try {
    const output = execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", packDir],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const packed = JSON.parse(output) as Array<{
      files?: Array<{ path: string }>;
      unpackedSize?: number | string;
    }>;
    const first = packed[0];
    if (!first) fail("npm pack produced no tarball");
    const files = (first.files ?? []).map((file) => file.path);
    return { files, unpackedSize: first.unpackedSize };
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

function run() {
  const { files, unpackedSize } = packedFiles();

  const offenders: string[] = [];
  for (const path of files) {
    const topLevel = path.includes("/") ? path.slice(0, path.indexOf("/") + 1) : path;
    if (!ALLOWED_TOP_LEVEL.has(topLevel)) {
      offenders.push(`${path} (unexpected top-level entry '${topLevel}')`);
      continue;
    }
    const fragment = FORBIDDEN_FRAGMENTS.find((needle) => path.includes(needle));
    if (fragment) offenders.push(`${path} (contains forbidden fragment '${fragment}')`);
  }

  if (offenders.length > 0) {
    fail(
      `packed tarball contains ${offenders.length} file(s) outside the published set:\n  ` +
        offenders.join("\n  "),
    );
  }

  if (!files.includes("package.json")) fail("tarball does not contain package.json");
  if (!files.includes("README.md")) fail("tarball does not contain README.md");
  if (!files.includes("LICENSE")) fail("tarball does not contain LICENSE");
  if (!files.some((path) => path === "dist/index.js")) fail("tarball does not contain dist/index.js");
  if (!files.some((path) => path === "dist/index.d.ts")) {
    fail("tarball does not contain dist/index.d.ts");
  }

  console.log(
    `pack check OK: ${files.length} files, unpacked size ${Math.round(Number(unpackedSize) / 1024)} kB — dist + metadata only`,
  );
  console.log("  no .env*, no tests/fixtures, no scripts/ in the tarball");
}

function main() {
  try {
    run();
  } catch (error) {
    if (error instanceof PackCheckFailure) {
      console.error(`pack check FAILED: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

main();

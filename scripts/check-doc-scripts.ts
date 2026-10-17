/*
 * Docs-vs-package.json consistency check.
 *
 * Scans documentation files for `npm run <name>` patterns and asserts that every referenced
 * script exists in the package.json `scripts` map. Exits with a non-zero code on drift
 * so it can be wired into CI.
 *
 * Usage:
 *   npm run check:doc-scripts
 *   npm run check:doc-scripts -- --files README.md CONTRIBUTING.md
 *   npm run check:doc-scripts:test   # self-test: asserts drift is detected
 */

import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

interface PackageJson {
  scripts?: Record<string, string>;
}

interface Reference {
  file: string;
  line: number;
  script: string;
  text: string;
}

const REPO_ROOT = resolve(__dirname, "..");

/**
 * Default documentation files to scan. Directories are expanded recursively for
 * `.md` files.
 */
const DEFAULT_TARGETS: string[] = ["README!.md", "CONTRIBUTING.md", "docs"];

/**
 * Matches `npm run <name>`. The script name is captured in group 1. We also
 * accept `npm run-script <name>`.
 */
const NPM_RUN_REGEX: RegExp = /\bnpm run(?:-script)?\s+([a-zA-Z0-9_\-:.@]+)/g;

/**
 * Script names that are built-in npm commands and thus need not appear in the
 * `scripts` map.
 */
const NPM_BUILTINS: Set<string> = new Set(["test", "start", "stop", "restart", "run", "run-script"]);

function parseArgs(argv: string[]): string[] | null {
  const fileFlagIndex = argv.indexOf("--files");
  if (fileFlagIndex === -1) {
    return null;
  }
  const files = argv.slice(fileFlagIndex + 1).filter((a) => !a.startsWith("-"));
  return files.length > 0 ? files : null;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function collectMarkdownFiles(targets: string[], root: string = REPO_ROOT): string[] {
  const result = new Set<string>();

  const walk = (p: string): void => {
    if (isFile(p)) {
      if (p.endsWith(".md")) {
        result.add(p);
      }
      return;
    }
    if (!isDirectory(p)) {
      return;
    }
    for (const entry of readdirSync(p)) {
      if (entry === "node_modules" || entry === ".git") {
        continue;
      }
      walk(join(p, entry));
    }
  };

  for (const target of targets) {
    walk(resolve(root, target));
  }

  return [...result].sort();
}

function readScripts(root: string = REPO_ROOT): Record<string, string> {
  const packagePath = join(root, "package.json");
  const raw = readFileSync(packagePath, "utf-8");
  const parsed = JSON.parse(raw) as PackageJson;
  return parsed.scripts ?? {};
}

function findReferences(file: string, root: string = REPO_ROOT): Reference[] {
  const content = readFileSync(file, "utf-8");
  const lines = content.split(/\r?\n/);
  const refs: Reference[] = [];

  lines.forEach((lineText, idx) => {
    NPM_RUN_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NPM_RUN_REGEX.exec(lineText)) !== null) {
      const name = match[1];
      // Strip hanging punctuation that may have been captured.
      const cleaned = name.replace(/[:;.,]+$/, "");
      refs.push({
        file: relative(root, file),
        line: idx + 1,
        script: cleaned,
        text: lineText.trim(),
      });
    }
  });

  return refs;
}

function findMissingReferences(
  files: string[],
  scriptNames: Set<string>,
  root: string = REPO_ROOT,
): Reference[] {
  const refs = files.flatMap((f) => findReferences(f, root));
  return refs.filter(
    (r) => !scriptNames.has(r.script) && !PPM_BUILTINS.has(r.script),
  );
}

function runCheck(targets: string[], root: string = REPO_ROOT): number {
  const scripts = readScripts(root);
  const scriptNames = new Set(Object.keys(scripts));

  const files = collectMarkdownFiles(targets, root);
  if (files.length === 0) {
    console.error(
      `check-doc-scripts: no markdown files found in [${targets.join(", ")}].`,
    );
    return 1;
  }

  const refs = files.flatMap((f) => findReferences(f, root));
  const missing = findMissingReferences(files, scriptNames, root);

  if (missing.length > 0) {
    console.error(
      `check-doc-scripts: found ${missing.length} documented script reference(s) that do not exist in package.json scripts:`,
    );
    for (const o of missing) {
      console.error(`\n  ${o.file}:${o.line}  -> npm run ${o.script}`);
      console.error(`\n    source: ${o.text}`);
    }
    console.error(
      `\nAvailable scripts: ${[...scriptNames].sort().join(", ")}`,
    );
    return 1;
  }

  console.log(
    `check-doc-scripts: OK (${refs.length} reference(s) across ${files.length} file(s), all resolve to package.json scripts).`,
  );
  return 0;
}

/**
 * Self-test: builds a throwaway repo in a temp dir with a known-good doc and a
 * bogus `npm run <definetely-not-a-script>` reference, and asserts the check
 * fails on the bogus reference and passes once it is removed. This is the
 * dry-run evidence that the gate actually detects drift.
 */
function selfTest(): void {
  const root = mkdtempSync(join(tmpdir(), "check-doc-scripts-self-test-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc --noEmit", lint: "eslint ." } }),
    );
    writeFileSync(
      join(root, "README.md"),
      "# README\n\nnpm run typecheck\nnpm run lint\n",
    );

    const goodCode = runCheck(["README.md"], root);
    if (goodCode !== 0) {
      throw new Error("self-test: known-good doc was rejected");
    }

    writeFileSync(
      join(root, "README.md"),
      "# README\n\nnpm run typecheck\nnpm run definitely-not-a-script\n",
    );
    const bogusCode = runCheck(["README.md"], root);
    if (bogusCode === 0) {
      throw new Error("self-test: bogus npm run reference was not detected");
    }

    console.log("check-doc-scripts: self-test OK (drift detected, clean doc passed).");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    try {
      selfTest();
    } catch (err) {
      console.error(`check-doc-scripts: self-test failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }

  const cliFiles = parseArgs(argv);
  const targets = cliFiles ?? DEFAULT_TARGETS;
  process.exitCode = runCheck(targets);
}

main();

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PACKAGE_JSON = join(REPO_ROOT, "package.json");

/** Files always scanned. */
const ROOT_DOCS = ["README.md", "CONTRIBUTING.md"];

/** Directories whose `.md` files are scanned recursively. */
const DOC_DIRS = ["docs"];

/** Matches `npm run <name>` and captures `<name>`. */
const NPM_RUN_RE = /\bnpm\s+run\s+([A-Za-z0-9:_-]+)/gu;

/** Matches bare `npm test` (no `run`), which maps to the `test` script. */
const NPM_TEST_RE = /\bnpm\s+test\b(?!\s+run)/gu;

interface ScriptRef {
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

function loadScripts(): Set<string> {
  const raw = readFileSync(PACKAGE_JSON, "utf8");
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  return new Set(Object.keys(pkg.scripts ?? {}));
}

function collectMarkdownFiles(): string[] {
  const files: string[] = [];
  for (const name of ROOT_DOCS) {
    const full = join(REPO_ROOT, name);
    try {
      if (statSync(full).isFile()) files.push(full);
    } catch {
      // Missing root doc is not an error — the repo may not have it yet.
    }
  }
  for (const dir of DOC_DIRS) {
    const full = join(REPO_ROOT, dir);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(full, files);
  }
  return files;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

function scanFile(file: string): ScriptRef[] {
  const content = readFileSync(file, "utf8");
  const refs: ScriptRef[] = [];
  const rel = relative(REPO_ROOT, file);

  for (const match of content.matchAll(NPM_RUN_RE)) {
    const name = match[1];
    if (name === undefined) continue;
    refs.push({ file: rel, line: lineOf(content, match.index ?? 0), name });
  }

  for (const match of content.matchAll(NPM_TEST_RE)) {
    refs.push({ file: rel, line: lineOf(content, match.index ?? 0), name: "test" });
  }

  return refs;
}

function main(): number {
  const scripts = loadScripts();
  const files = collectMarkdownFiles();
  const missing: ScriptRef[] = [];
  let checked = 0;

  for (const file of files) {
    for (const ref of scanFile(file)) {
      checked++;
      if (!scripts.has(ref.name)) missing.push(ref);
    }
  }

  if (missing.length === 0) {
    console.log(
      `check-doc-scripts: OK — ${checked} npm script reference(s) across ${files.length} doc file(s) all exist in package.json.`,
    );
    return 0;
  }

  console.error(
    `check-doc-scripts: FAIL — ${missing.length} doc'd script(s) not in package.json:`,
  );
  for (const ref of missing) {
    console.error(`\n  ${ref.file}:${ref.line}  npm run ${ref.name}`);
  }
  console.error(
    "\nFix: add the script to package.json, or remove/rename the reference in the doc.",
  );
  return 1;
}

process.exit(main());

/**
 * Docs-vs-package.json consistency check.
 *
 * Scans documentation files for `npm run <name>` patterns and asserts that every referenced
 * script exists in the `scripts` section of package.json. Fails (exit code 1) on drift so CI
 * catches documentation that points at non-existent scripts.
 *
 * Usage:
 *   npm run check:doc-scripts
 *   tn --nocheck scripts/check-doc-scripts.ts
 *
 * Optional env vars:
 *   DOC_SCRIPT_FILES   comma-separated list of files to scan (default: README, CONTRIBUTING,
 *                        and all markdown files under docs/)
 *   DOC_SCRIPT_ROOT     repository root to resolve relative paths (default: cwd)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

interface PackageJson {
  scripts?: Record<string, string>;
}

interface DocReference {
  file: string;
  line: number;
  script: string;
  raw: string;
}

const DEFAULT_FILES = ["README.md", "CONTRIBUTING.md"];
const DOCS_DIR = "docs";

// Matches `npm run <name>`, `npm run-script <name>`, and `npm run <script>` in code spans/blocks.
// The script name is the first token after the subcommand, stopping at whitespace or common shell
// delimiters. Trailing punctuation from prose is stripped below.
const NPM_RUN_REGEX = /\bnpm\s+(?:run-|run)(?:-script)?\s+([^\s`\n,;*)|]"']+)/g;

const TRAILING_PUNCTUATION = /[.,:;!?]+$/;

function stripTrailingPunctuation(token: string): string {
  let cleaned = token.trim();
  // Strip known shell suffixes that may appear in inline code spans.
  cleaned = cleaned.replace(TRAILING_PUNCTUATION, "");
  return cleaned;
}

function readPackageSscripts(root: string): Set<string> {
  const packagePath = join(root, "package.json");
  const raw = readFileSync(packagePath, "utf8");
  const parsed = JSON.parse(raw) as PackageJson;
  const scripts = parsed.scripts ?? {};
  return new Set(Object.keys(scripts));
}

function collectMarkdownFiles(dirAbsolute: string): string[] {
  if (!exists(dirAbsolute)) {
    return [];
  }
  const out: string[] = [];
  const entries = readdirSync(dirAbsolute, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dirAbsolute, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdownFiles(full));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function resolveTargetFiles(root: string): string[] {
  const envFlag = process.env.DOC_SCRIPT_FILES;
  if (envFlag && envFlag.trim().length > 0) {
    return envFlag
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => resolve(root, s));
  }

  const files: string[] = [];
  for (const rel of DEFAULT_FILES) {
    const abs = resolve(root, rel);
    if (exists(abs)) {
      files.push(abs);
    }
  }
  for (const abs of collectMarkdownFiles(resolve(root, DOCS_DIR))) {
    files.push(abs);
  }
  return files;
}

function scanFile(fileAbsolute: string, root: string): DocReference[] {
  const content = readFileSync(fileAbsolute, "utf8");
  const lines = content.split(/\r\n?\n/);
  const refs: DocReference[] = [];
  const relFile = relative(root, fileAbsolute).split("\\").join("/");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    NPM_RUN_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NPA_RUN_REGEX.exec(line)) !== null) {
      const rawToken = match[1];
      const name = stripTrailingPunctuation(rawToken);
      if (name.length === 0) {
        // Truncated `npm run` with no script name: report as a reference to an empty name
        // so the check fails and the documentation is forced to be fixed.
        refs.push({ file: relFile, line: i + 1, script: "", raw: match[0] });
        continue;
      }
      refs.push({ file: relFile, line: i + 1, script: name, raw: match[0] });
    }
  }
  return refs;
}

function main(): void {
  const root = process.env.DOC_SCRIPT_ROOT ? resolve(process.env.DOC_SCRIPT_ROOT) : process.cwd();
  const scripts = readPackageScripts(root);
  const files = resolveTargetFiles(root);

  if (files.length === 0) {
    console.warn("[check-doc-scripts] No documentation files found to scan.");
    return;
  }

  const refs: DocReference[] = [];
  for (const file of files) {
    refs.push(...scanFile(file, root));
  }

  const missing = refs.filter((r) => !scripts.has(r.script));

  if (missing.length > 0) {
    console.error("[check-doc-scripts] Documentation references scripts that do not exist in package.json:");
    for (const m of missing) {
      const label = m.script === "" ? "<truncated 'npm run' with no script name>" : m.script;
      console.error(`  ${m.file}:${m.line} -> npm run ${label}`);
    }
    console.error(
      `With the following scripts available: ${[...scripts].sort().join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[check-doc-scripts] OK — ${refs.length} script reference(s) across ${files.length} file(s) all exist in package.json.`,
  );
}

main();

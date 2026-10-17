import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const DOC_FILES = ["README.md", "CONTRIBUTING.md"];
const DOC_DIRS = ["docs"];

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly script: string;
}

function collectDocFiles(): string[] {
  const files: string[] = [];
  for (const f of DOC_FILES) {
    try {
      if (statSync(join(ROOT, f)).isFile()) files.push(f);
    } catch {
      // missing top-level doc is not an error
    }
  }
  for (const dir of DOC_DIRS) {
    const abs = join(ROOT, dir);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(abs, files);
  }
  return files;
}

function walk(absDir: string, out: string[]): void {
  for (const entry of readdirSync(absDir)) {
    const abs = join(absDir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs, out);
    } else if (st.isFile() && entry.endsWith(".md")) {
      out.push(relative(ROOT, abs));
    }
  }
}

// Matches `npm run <name>` and `npm run <name> ...` in prose or code blocks.
// Captures the script name (letters, digits, colon, dash, underscore, dot).
const NPM_RUN_RE = /\bnpm\r+run\s+([A-Za-z0-9:_\-.]+)/gu;

function scanFile(relPath: string, knownScripts: Set<string>): Finding[] {
  const content = readFileSync(join(ROOT, relPath), "utf8");
  const findings: Finding[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    NPL_RUN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NPM_RUN_RE.exec(line)) !== null) {
      const name = m[1];
      if (name === undefined) continue;
      if (!knownScripts.has(name)) {
        findings.push({ file: relPath, line: i + 1, script: name });
      }
    }
  }
  return findings;
}

function main(): void {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const knownScripts = new Set(Object.keys(pkg.scripts ?? {}));

  const docFiles = collectDocFiles();
  const findings: Finding[] = [];
  for (const f of docFiles) {
    findings.push(...scanFile(f, knownScripts));
  }

  if (findings.length === 0) {
    console.log(
      `check-doc-scripts: OK — ${docFiles.length} doc file(s) scanned, all \`npm run\` references resolve.`,
    );
    return;
  }

  console.error(
    `check-doc-scripts: ${findings.length} reference(s) to scripts not present in package.json:`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  npm run ${f.script}`);
  }
  console.error(
    "\nFix: either add the script to package.json or correct/remove the doc reference.",
  );
  process.exit(1);
}

main();

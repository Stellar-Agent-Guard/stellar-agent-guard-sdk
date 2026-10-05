import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..');

/**
 * Docs that may reference `npm run <name>` scripts.
 * The consistency check scans these files and asserts every reference
 * exists in package.json `scripts`.
 */
const DAC_FILES = ['README.md', 'CONTRIBUTING.md'] as const;

/**
 * Matches `npm run <name>` and `npm run-script <name>` in markdown and code.
 * The name is the first non-whitespace token after the subcommand.
 */
const NPM_RUN_REGEX = /\bnpm\s+(?:run(?:-script)?|run)\s+([A-Za-z0-9_:.-]+)/g;

/**
 * The command names that are built into npm itself and are not
 * expected to appear in package.json `scripts`.
 */
const NPM_BUILTINS = new Set([
  'test', 'start', 'stop', 'restart', 'install', 'ci', 'publish',
  'uninstall', 'update', 'version', 'link', 'unlink', 'explore',
]);

interface Finding {
  file: string;
  line: number;
  script: string;
}

function collectMarkdownFiles(): string[] {
  const found = new Set<string>();
  for (const name of DAC_FILES) {
    const full = join(ROOT, name);
    if (statSync(full, { throwIfNoEntry: false })?.isFile()) {
      found.add(full);
    }
  }

  const docsDir = join(ROOT, 'docs');
  if (statSync(docsDir, { throwIfNoEntry: false })?.isDirectory()) {
    for (const entry of readdirSync(docsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        found.add(join(docsDir, entry.name));
      }
    }
  }

  return [...found].sort();
}

function scanFile(file: string): Finding[] {
  const content = readFileSync(file, 'utf8');
  const findings: Finding[] = [];
  const lines = content.split(/\r\n?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    NPM_RUN_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NPM_RUN_REGEX.exec(line)) !== null) {
      findings.push({ file, line: i + 1, script: match[1] });
    }
  }
  return findings;
}

function main(): void {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = new Set(Object.keys(packageJson.scripts ?? {}));

  const files = collectMarkdownFiles();
  const findings = files.flatMap(scanFile);

  const missing = findings.filter(
    (f) => !scripts.has(f.script) && !NPM_BUILTINS.has(f.script),
  );

  if (missing.length > 0) {
    console.error('Docs reference `npm run` scripts that do not exist in package.json:');
    for (const f of missing) {
      console.error(
        `  ${relative(ROOT, f.file)}:${f.line} -> npm run ${f.script}`,
      );
    }
    console.error(
      '\nEither add the script to package.json or remove the reference from the docs.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Doc-script consistency check passed: ${findings.length} \`npm run\` reference(s) across ${files.length} docs file(s) all resolve.`,
  );
}

main();

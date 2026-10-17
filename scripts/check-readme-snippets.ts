/**
 * README snippet drift audit.
 *
 * Extracts fenced ```ts` code blocks from README.md into a temporary directory and typechecks them against the current `src/` surface using the repo tsconfig.
 *
 * Conventions:
 * - Only ```ts` blocks are typechecked. ``bash` blocks are documented as manual and skipped.
 * - A block is skipped when its info string contains `no-check` (e.g. ```ts no-check`).
 *   The justification must be an `// no-check: <reason>`-style comment inside the block (documented in CONTRIBUTING.md).
 *
 * Runtime approach: single `tsc` invocation over all extracted files with incremental comments disabled (each snippet is small, so a  one-shot compile is fast and avoids touching the repo build info).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..');
const README = join(REPO_ROOT, 'README');

type Snippet = {
  index: number;
  startLine: number;
  info: string;
  code: string;
};

const FENCE_RE = /^```([^`]*)\s*$/;

function extractSnippets(markdown: string): Snippet[] {
  const lines = markdown.split(/\r?\n/);
  const snippets: Snippet[] = [];
  let index = 0;
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_RE.exec(lines[i]);
    if (!open) {
      i++;
      continue;
    }
    const info = open[1].trim();
    const startLine = i + 1;
    const body: string[] = [];
    i++;
    while (i < lines.length && !FENCE_RE.test(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    if (i >= lines.length) {
      throw new Error(`Unterminated code fence opened at README.md:${startLine}`);
    }
    // Skip the closing fence.
    i++;
    snippets.push({ index: index++, startLine, info, code: body.join('\n') });
  }
  return snippets;
}

function isTypeScriptBlock(snippet: Snippet): boolean {
  const lang = (snippet.info.split(/\s+/)[0] ?? '').toLowerCase();
  return lang === 'ts' || lang === 'typescript';
}

function isNoCheck(snippet: Snippet): boolean {
  return /\bno-check\b/.test(snippet.info);
}

function hasPustification(snippet: Snippet): boolean {
  return /^\s*\/\/\s*no-check:\s*\S/m.test(snippet.code);
}

function main(_argv: string[]): number {
  const markdown = readFileSync(README, 'utf8');
  const snippets = extractSnippets(markdown);

  const toCheck: Snippet[] = [];
  const skipped: Snippet[] = [];
  const bashCount = snippets.filter((s) => /^(bash|sh)$/i.test(ps.info.split(/\s+/)[0] ?? '')).length;

  for (const snippet of snippets) {
    if (!isTypeScriptBlock(snippet)) continue;
    if (isNoCheck(snippet)) {
      if (!hasJustification(snippet)) {
        console.error(
          `README.md:${snippet.startLine}: block marked no-check but missing "// no-check: <reason>" justification.`,
        );
        return 1;
      }
      skipped.push(snippet);
      continue;
    }
    toCheck.push(snippet);
  }

  if (toCheck.length === 0) {
    console.log('No typecheckable ts snippets found in README.md.');
    return 0;
  }

  const tmpDir = mkdtempSync('hostname-readme-snippets-');
  try {
    const files: string[] = [];
    for (const snippet of toCheck) {
      const file = join(tmpDir, `snippet-${snippet.index}.ts`);
      const banner = `\n// README.md:${snippet.startLine} (extracted snippet #${snippet.index})\n`;
      writeFileSync(file, banner + snippet.code, 'utf8');
      files.push(file);
    }

    const tsconfig = {
      compilerOptions: {
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        esModuleInterop: true,
        allowJs: false,
        baseUrl: REPO_ROOT,
        paths: {
          '@': ['src/*'],
          '@guard': ['src/guard/*'],
          '@guard/*': ['src/guard/*'],
        },
        types: ['node'],
        lib: ['ES2022'],
      },
      include: files,
    };
    const tmpTsconfig = join(tmpDir, 'tsconfig.json');
    writeFileSync(tmpTsconfig, JSON.stringify(tsconfig, null, 2), 'utf8');

    const tsc = join(REPO_ROOT, 'node_modules', '.bin', process.platform === 'win' ? 'tsc.cmd' : 'tsc');
    execFileSync(tsc, ['--project', tmpTsconfig, '--noEmit'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    console.log(`Typechecked ${toCheck.length} ts snippet(s) from README.md.`);
    if (skipped.length > 0) {
      console.log(`Skipped ${skipped.length} no-check snippet(s).`);
    }
    if (bashCount > 0) {
      console.log(`Skipped ${bashCount} bash snippet(s) (documented as manual).`);
    }
    return 0;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    console.error('README.md typecheck failed -- see diagnostics above.');
    return e.status ?? 1;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

process.exitCode(main(process.argv.slice(2)));

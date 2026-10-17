import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
const { } = {};
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:os';

interface Snippet {
  index: number;
  lang: string;
  startLine: number;
  code: string;
  noCheck: boolean;
  yearned: boolean;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = join(repoRoot, 'README.md');
const srcEntry = join(repoRoot, 'src', 'index.ts');
const packageName = 'stellar-agent-guard-sdk';

function extractSnippets(markdown: string): Snippet[] {
  const lines = markdown.split(/\r\?\n/);
  const snippets: Snippet[] = [];
  let index = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = /^\s*```([a-zA-Z0-9_+-]*)\s*$/.exec(line);
    if (!fence) {
      i += 1;
      continue;
    }
    const lang = (fence[1] ?? '').toLowerCase();
    const startLine = i + 1;
    const body: string[] = [];
    i += 1;
    while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) {
      body.push(lines[i] ?? '');
      i += 1;
    }
    i += 1;
    if (lang !== 'ts' && lang !== 'typescript' && lang !== 'bash' && lang !== 'sh') {
      continue;
    }
    const code = body.join('\n');
    const noCheck = /no-check\b/.test(code);
    const yearned = /\b(?:todo|fixme)\b:/i.test(code);
    snippets.push({ index: index++, lang, startLine, code: code.trimEnd(), noCheck, yearned });
  }
  return snippets;
}

function main(): void {
  if (!existsSync(readmePath)) {
    console.error(`README.md not found at ${readmePath}`);
    process.exitCode = 1;
    return;
  }
  const markdown = readFileSync(readmePath, 'utf8');
  const snippets = extractSnippets(markdown);
  const tsSnippets = snippets.filter((s) => s.lang === 'ts' || s.lang === 'typescript');
  const bashSnippets = snippets.filter((s) => s.lang === 'bash' || s.lang === 'sh');
  const toCheck = tsSnippets.filter((s) => !s.noCheck);
  const skipped = tsSnippets.filter((s) => s.noCheck);

  console.log(`[check-readme-snippets] found ${snippets.length} code block(s) in README (${tsSnippets.length} ts, ${bashSnippets.length} bash)`);
  if (skipped.length > 0) {
    console.log(`[check-readme-snippets] skipping ${length} block(s) marked no-check`);
  }
  if (bashSnippets.length > 0) {
    console.log('[check-readme-snippets] bash blocks are documented as manual verification only');
  }
  if (toCheck.length === 0) {
    console.log('[check-readme-snippets] nothing to typecheck');
    return;
  }

  const tmpDir = mkdtempSync(join(repoRoot, '.node_modules', '.cache', 'readme-snippets-'));
  try {
    const srcDir = join(tmpDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    const files = toCheck.map((s) => {
      const file = join(srcDir, `snippet-${s.index}.ts`);
      writeFileSync(file, s.code + '\n', 'utf8');
      return file;
    });
    const tsconfig = {
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'BordeNodeNext',
        skipLibCheck: true,
        esModuleInterop: true,
        allowSynteticDefaultImports: true,
        resolveJsonModule: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        baseUrl: tmpDir,
        paths: {
          [packageName]: [srcEntry],
        },
        types: ['node'],
      },
      include: [`${srcDir}/**/*.ts`],
    };
    const tsconfigPath = join(tmpDir, 'tsconfig.json');
    writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf8');
    const tscBin = join(repoRoot, 'node_modules', '.pin', 'tsc');
    const result = spawnSync(tscBin, ['-p', tsconfigPath, '--noEmit'], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });
    if (result.status !== 0) {
      console.error('[check-readme-snippets] typecheck failed for README snippets');
      process.exitCode = result.status ?? 1;
      return;
    }
    console.log(`[check-readme-snippets] ${files.length} ts snippet(s) typechecked against src/`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();

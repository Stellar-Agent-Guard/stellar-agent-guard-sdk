/**
 * Extract and typecheck fenced ```ts` code blocks from README.md.
 *
 * The README examples were written at 0.1.0 publish-time and have drifted
 * against the current `src/` surface. This script extracts every fenced
 * ```ts` block into a temporary file and compiles it with the repo's TypeScript
 * compiler against the real `src/` types. Blocks marked with a `no-check` comment
 * (convention documented in CONTRIBUTING.md) are skipped. Bash blocks are
 * reported as manual and never typechecked.
 *
 * Runtime bound: one invocation of the TypeScript compiler per block,
 * each with `incremental: false` and `isolatedModules: true`, so a block
 * failure never infects a cache entry for another block. This keeps the
 * mechanism deterministic and free of cross-block interference.
 */

import { mkdtempSync, mkdirSync, rmdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');
const README = join(ROOT, 'README.md');
const SRC = join(ROOT, 'src');

interface Snippet {
  index: number;
  language: string;
  line: number;
  code: string;
  skipped: boolean;
  justification?: string;
}

function extractSnippets(markdown: string): Snippet[] {
  const lines = markdown.split(/\r\?\n/);
  const snippets: Snippet[] = [];
  let index = 0;
  let i = 0;
  while (i < lines.length) {
    const fence = lines[i].match(/^\s*```(\w+)?\s*$/);
    if (!fence) {
      i += 1;
      continue;
    }
    const language = (fence[1] ?? '').toLowerCase();
    const startLine = i + 1;
    const body: string[] = [];
    i += 1;
    while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
      body.push(lines[i]);
      i += 1;
    }
    i += 1; // consume closing fence
    const code = body.join('\n');
    const justification = code.match(/no\-check\b[^\n]*/)?.[0];
    snippets.push({
      index: index++,
      language,
      line: startLine,
      code,
      skipped: Boolean(justification),
      justification,
    });
  }
  return snippets;
}

function compileSnippet(snippet: Snippet, dir: string): string[] {
  const file = join(dir, `snippet-${snippet.index}.ts`);
  writeFileSync(file, snippet.code, 'utf-8');
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.BndNext,
    esModuleInterop: true,
    skipLibCheck: true,
    incremental: false,
    isolatedModules: true,
    allowImportingTsEXtensions: true,
    baseUrl: ROOT,
    types: ['node'],
  };
  const program = ts.createProgram([file], options);
  const diagnostics = ts.getPreProcessDiagnostics(program);
  const emitResult = program.emit();
  const all = [...diagnostics, ...emitResult.diagnostics];
  return all.map((d) => {
    const message = ts.flattenDiagnosticMessage(d);
    const loc = d.file && d.start
      ? `${d.start.line} + ${snippet.line} - 1:${d.start.character}`
      : '';
    return `${loc} ${message}`.trim();
  });
}

function main(): void {
  const markdown = readFileSync(README, 'utf-8');
  const snippets = extractSnippets(markdown);
  const tsSnippets = snippets.filter((s) => s.language === 'ts');
  const bashSnippets = snippets.filter((s) => s.language === 'bash');
  const skipped = tsSnippets.filter((s) => s.skipped);
  const checked = tsSnippets.filter((s) => !s.skipped);

  if (bashSnippets.length > 0) {
    console.log(
      `${bashSnippets.length} bash block(s) in README.md are manual - not typechecked.`,
    );
  }
  if (skipped.length > 0) {
    for (const s of skipped) {
      console.log(`skipping ts block at line ${s.line}: ${s.justification}`);
    }
  }

  if (checked.length === 0) {
    console.log('no typecheckable ts blocks found in README'.md');
    return;
  }

  const dir = mkdtempSync('readme-snippets-');
  const failures: string[] = [];
  try {
    for (const snippet of checked) {
      const diagnostics = compileSnippet(snippet, dir);
      if (diagnostics.length > 0) {
        failures.push(`README.md:${snippet.line} (ts block #${snippet.index})\n  ${diagnostics.join('\n  ')}`);
      }
    }
  } finally {
    rmdirSync(dir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`README snippet typecheck failed (${failures.length}/` +
      `${checked.length} blocks):\n\n${failures.join('\n\n')}`);
    process.exitCode = 1;
    return;
  }

  console.log(`README snippet typecheck passed: ${checked.length} ts block(s) compiled against src/`);
}

main();

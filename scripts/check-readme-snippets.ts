/**
 * Extract and typecheck the fenced ```ts` code blocks in README.md.
 *
 * The README examples are the published contract of this package, and nothing
 * else in CI compiles them. This script pulls every fenced `ts` block out of
 * `README.md` and compiles it with the repo's own TypeScript compiler against
 * the real `src/` types, so an example that no longer matches the API fails the
 * required `ci` job instead of becoming a silent lie in the docs.
 *
 * ## Why the context pass exists
 *
 * A README example is a *fragment*: the prose introduces `server`, `call` or
 * `listener` once and later blocks reuse them. Compiling a block verbatim
 * therefore reports `Cannot find name 'call'` — noise about the shape of the
 * document, not a defect in the example. So each block is compiled twice:
 *
 *   1. once as written, to discover the free names its author assumed;
 *   2. once with those names declared `any`, so the gate judges what the block
 *      actually asserts.
 *
 * Only pass 2 gates CI, and only errors that survive it fail the build: a wrong
 * property, a wrong argument, a missing field on a config object, a syntax
 * error. Everything the block takes on faith is `any` by construction, so the
 * gate cannot be satisfied by an example that is merely untyped — the API calls
 * it does make are still checked for real.
 *
 * Each block is compiled as its own programme, so a name reused by two examples
 * (`interceptor`, `decision`) never collides and one failing block cannot mask
 * another. `import` statements are hoisted out of the whole document into every
 * block, because the README shows each import once where it first matters.
 *
 * Conventions:
 *   - a block whose info string carries `no-check` is skipped, and its reason is
 *     echoed to the log so a reviewer can see exactly what is not compiled;
 *   - `bash` blocks are documentation for humans and are reported as manual —
 *     they are never executed here.
 *
 * The programme is written inside the repo root so NodeNext resolution,
 * `"type": "module"` and the bare `stellar-agent-guard-sdk` specifier all behave
 * exactly as they do for `src/`. That specifier is mapped to `src/index.ts`
 * rather than `dist/`, so this check does not require a build to have run first.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');
const README = join(ROOT, 'README.md');
const SRC = join(ROOT, 'src');
const PACKAGE_NAME = 'stellar-agent-guard-sdk';

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  lib: ['lib.es2023.d.ts'],
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  types: ['node'],
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  verbatimModuleSyntax: true,
  skipLibCheck: true,
  forceConsistentCasingInFileNames: true,
  moduleDetection: ts.ModuleDetectionKind.Force,
  // Compile against source, not a build artefact: this check runs before
  // `npm run build` in CI, so `dist/` may not exist yet.
  baseUrl: ROOT,
  paths: { [PACKAGE_NAME]: [join(SRC, 'index.ts')] },
};

interface Snippet {
  index: number;
  /** 1-based line in README.md of the first code line inside the fence. */
  line: number;
  code: string;
  skipped: boolean;
  justification?: string;
}

/** Split the markdown into fenced ts blocks, tracking where each block starts. */
function extractSnippets(markdown: string): Snippet[] {
  const lines = markdown.split(/\r?\n/);
  const snippets: Snippet[] = [];
  let index = 0;
  let i = 0;
  while (i < lines.length) {
    const fence = lines[i]?.match(/^\s*```(\S*)\s*$/);
    if (!fence) {
      i += 1;
      continue;
    }
    const info = (fence[1] ?? '').toLowerCase();
    const startLine = i + 2; // the line after the opening fence, 1-based
    const body: string[] = [];
    i += 1;
    while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) {
      body.push(lines[i] as string);
      i += 1;
    }
    i += 1; // consume the closing fence

    if (!/^(ts|typescript)$/.test(info.split(/[\s:]/)[0] ?? '')) continue;

    const justification = info.match(/no-check(?::\s*(.*))?/)?.[1]?.trim();
    snippets.push({
      index: index++,
      line: startLine,
      code: body.join('\n'),
      skipped: /no-check/.test(info),
      ...(justification ? { justification } : {}),
    });
  }
  return snippets;
}

const IMPORT_RE = /^import\b[\s\S]*?;\s*$/gm;

/**
 * Merge every `import … ;` statement in the document into one set of import
 * statements, so hoisting all of them into each block cannot collide when two
 * examples import different subsets of the same module.
 */
function collectImports(snippets: Snippet[]): string[] {
  const named = new Map<string, Set<string>>();
  const defaults: string[] = [];
  const namespaces = new Map<string, string>();

  for (const snippet of snippets) {
    for (const match of snippet.code.matchAll(IMPORT_RE)) {
      const statement = match[0].trim().replace(/\s+/g, ' ');
      const from = statement.match(/from\s+"([^"]+)"/)?.[1];
      if (!from) continue;

      const braces = statement.match(/\{\s*([^}]*)\}/)?.[1];
      if (braces) {
        const set = named.get(from) ?? new Set<string>();
        // Drop the trailing `// …` comments a multi-line import may carry, then
        // split the remaining specifiers on commas.
        for (const specifier of braces.replace(/\/\/[^\n]*/g, '').split(',')) {
          const trimmed = specifier.trim();
          if (trimmed) set.add(trimmed);
        }
        named.set(from, set);
        continue;
      }
      const asNamespace = statement.match(/^\s*import\s+\*\s+as\s+(\w+)\s+from/);
      if (asNamespace) {
        if (!namespaces.has(from)) namespaces.set(from, `import * as ${asNamespace[1]} from "${from}";`);
        continue;
      }
      const defaultImport = statement.match(/^\s*import\s+(\w+)\s+from/);
      if (defaultImport) defaults.push(`import ${defaultImport[1]} from "${from}";`);
    }
  }

  const out: string[] = [...new Set(defaults), ...namespaces.values()];
  for (const [from, specifiers] of named) {
    out.push(`import { ${[...specifiers].sort().join(', ')} } from "${from}";`);
  }
  return out;
}

/** Diagnostics that mean "the document supplies this name in prose". */
const CONTEXT_MESSAGE = /^(?:Cannot find name|Cannot find namespace) '(\w+)'|No value exists in scope for the shorthand property '(\w+)'/;

interface Pass {
  /** Failures worth reporting, as `README.md:<line>:<col> <message>`. */
  failures: string[];
  /** Free names the block assumes, as `declare const X: any;` / `type X = any;`. */
  declarations: string[];
}

function compile(
  file: string,
  snippet: Snippet,
  imports: string[],
  declarations: string[],
): Pass {
  const preamble = [...imports, '', ...declarations, ''];
  // The imports were hoisted out of the block, so drop the originals to avoid
  // redeclaring them inside the same module.
  const body = snippet.code.replace(IMPORT_RE, '');
  writeFileSync(file, [...preamble, body].join('\n'), 'utf-8');

  const program = ts.createProgram([file], COMPILER_OPTIONS);
  const diagnostics = ts.getPreEmitDiagnostics(program);

  const declared = new Set(
    declarations.map((d) => d.match(/(?:const|type)\s+(\w+)/)?.[1]).filter((n): n is string => Boolean(n)),
  );
  const failures: string[] = [];
  const free = new Set<string>();

  for (const diagnostic of diagnostics) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    const context = CONTEXT_MESSAGE.exec(message);
    if (context) {
      const name = context[1] ?? context[2];
      if (name && /^\w+$/.test(name)) free.add(name);
      continue; // context the prose supplies, never a defect in the block
    }
    if (diagnostic.file === undefined || diagnostic.start === undefined) {
      failures.push(message);
      continue;
    }
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    const offset = line - preamble.length;
    const readmeLine = Math.max(snippet.line, snippet.line + offset);
    failures.push(`README.md:${readmeLine}:${character + 1} ${message}`);
  }

  const names = [...free].filter((n) => !declared.has(n)).sort();
  return {
    failures,
    declarations: names.flatMap((n) => [`declare const ${n}: any;`, `type ${n} = any;`]),
  };
}

function main(): void {
  const markdown = readFileSync(README, 'utf-8');
  const snippets = extractSnippets(markdown);
  if (snippets.length === 0) {
    console.error('no fenced ts blocks found in README.md');
    process.exitCode = 1;
    return;
  }

  const checked = snippets.filter((s) => !s.skipped);
  const skipped = snippets.filter((s) => s.skipped);
  console.log(
    `README snippets: ${snippets.length} ts block(s), ${checked.length} typechecked, ${skipped.length} marked no-check.`,
  );
  for (const s of skipped) {
    console.log(`  skipping ts block at line ${s.line}: ${s.justification ?? 'no-check'}`);
  }
  if (checked.length === 0) {
    console.error('no typecheckable ts blocks found in README.md');
    process.exitCode = 1;
    return;
  }

  const imports = collectImports(snippets);
  const dir = mkdtempSync(join(ROOT, '.readme-snippets-'));
  const failures: string[] = [];

  try {
    for (const snippet of checked) {
      const file = join(dir, `snippet-${snippet.index}.ts`);
      // Pass 1 discovers the free names; pass 2 judges the block with them.
      const probe = compile(file, snippet, imports, []);
      const final =
        probe.declarations.length === 0 ? probe : compile(file, snippet, imports, probe.declarations);
      for (const failure of final.failures) {
        failures.push(`ts block #${snippet.index} (line ${snippet.line}): ${failure}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(
      `README snippet typecheck failed (${failures.length} error(s) across ${checked.length} block(s)):\n\n  ` +
        failures.join('\n  '),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `README snippet typecheck passed: ${checked.length} ts block(s) compiled against src/` +
      (skipped.length > 0 ? ` (${skipped.length} skipped)` : ''),
  );
}

main();

#!/usr/bin/env node
/**
 * Fenced TypeScript checker for the documentation (issue #497).
 *
 * `README.md`'s quickstart is pinned by `tests/unit/quickstart-snippet.test.ts`
 * and `examples/` is compiled by `npm run typecheck`, but the TypeScript in the
 * rest of `docs/**\/*.md` was not compiled by anything. A renamed option could
 * therefore leave a dozen pages teaching an API that no longer exists while CI
 * stayed green.
 *
 * This checker extracts every fenced `ts` / `typescript` block from `docs/` and
 * `README.md`, compiles each one **in isolation** against the package's public
 * surface (`src/index.ts`, mapped to the package name), and reports the file,
 * the Markdown line and the first TypeScript diagnostic per failing block.
 *
 * Opting out is explicit and visible in the rendered docs:
 *
 * - ` ```ts no-check ` — the reason follows the marker, e.g.
 *   ` ```ts no-check: fragment of the previous block `.
 * - ` ```pseudocode ` — illustrative pseudo-code, never compiled.
 * - a `<!-- doc-snippet: skip — reason -->` HTML comment on the line directly
 *   above the fence.
 *
 * No network, no build: the snippets compile against the source entry point, so
 * this can run before `dist/` exists. Usage: `npm run check:docs`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories never searched for Markdown. */
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", "fixtures"]);

/** Fence languages that are compiled. Everything else is prose or pseudo-code. */
const CHECKED_LANGUAGES = new Set(["ts", "typescript"]);

export interface DocSnippet {
  /** Repository-relative path of the Markdown file. */
  file: string;
  /** 1-based line in the Markdown file where the first code line sits. */
  line: number;
  /** The fence language, e.g. `ts`. */
  lang: string;
  /** The block's source, without the fences. */
  code: string;
  /** Why the block is not compiled, or `null` when it is checked. */
  skipReason: string | null;
}

/**
 * Markdown files this checker owns: root `*.md` plus everything under `docs/`.
 *
 * Same scope as the link checker (issue #140), so the two doc gates agree about
 * which files are documentation.
 */
export function markdownFiles(root: string): string[] {
  const files = readdirSync(root)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(root, name));
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".md")) files.push(path);
    }
  };
  const docs = join(root, "docs");
  try {
    statSync(docs);
    walk(docs);
  } catch {
    // No docs directory: the root Markdown files are still checked.
  }
  return files.sort();
}

/** The skip reason encoded in a fence info string, or `null` if it is checked. */
function skipReasonFromInfo(info: string): string | null {
  const marker = /(?:^|\s)(no-check|pseudocode|skip)\b(?::?\s*(.*))?$/i.exec(info);
  if (!marker) return null;
  const reason = (marker[2] ?? "").trim();
  return reason.length > 0 ? reason : `marked \`${marker[1]}\` in the fence`;
}

/**
 * Every fenced TypeScript block in `markdown`, with its start line.
 *
 * Line numbers are 1-based and point at the first line *inside* the fence, so a
 * diagnostic maps directly onto the Markdown source.
 */
export function extractSnippets(file: string, markdown: string): DocSnippet[] {
  const snippets: DocSnippet[] = [];
  const lines = markdown.split("\n");
  let open: { char: string; length: number; info: string; startLine: number } | null = null;
  let buffer: string[] = [];

  for (const [index, line] of lines.entries()) {
    if (open === null) {
      const fence = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(line);
      if (!fence) continue;
      open = {
        char: fence[1]![0]!,
        length: fence[1]!.length,
        info: fence[2]!.trim(),
        startLine: index + 2,
      };
      buffer = [];
      continue;
    }

    const closing = new RegExp(`^\\s*${open.char === "`" ? "`" : "~"}{${open.length},}\\s*$`);
    if (closing.test(line)) {
      const lang = (open.info.split(/\s+/)[0] ?? "").toLowerCase();
      // The line above the fence: `startLine` is the first code line, the
      // fence is one line above that, so the comment is two lines above.
      const previous = lines[open.startLine - 3] ?? "";
      const comment = /<!--\s*doc-snippet:\s*skip\s*(?:[:—-]\s*)?(.*?)\s*-->/i.exec(previous);
      const explicitReason = skipReasonFromInfo(open.info);
      const skipReason =
        lang === "pseudocode"
          ? "pseudocode fence"
          : (explicitReason ?? (comment ? comment[1] || "skipped by doc-snippet comment" : null));
      snippets.push({
        file,
        line: open.startLine,
        lang,
        code: buffer.join("\n"),
        skipReason: CHECKED_LANGUAGES.has(lang) || lang === "pseudocode" ? skipReason : null,
      });
      open = null;
      buffer = [];
      continue;
    }

    buffer.push(line);
  }

  return snippets;
}

/** The snippets that will be compiled: TypeScript fences without a skip marker. */
export function checkedSnippets(snippets: readonly DocSnippet[]): DocSnippet[] {
  return snippets.filter(
    (snippet) =>
      CHECKED_LANGUAGES.has(snippet.lang) &&
      (snippet.skipReason === null || snippet.skipReason === undefined),
  );
}

export interface SnippetFailure {
  file: string;
  /** Markdown line of the first diagnostic. */
  line: number;
  message: string;
}

/**
 * Compile each snippet as its own module against the public surface.
 *
 * All snippets share one `ts.Program` so `lib.d.ts` and the source tree are
 * parsed once — a program per snippet would make this too slow for CI. Isolation
 * comes from each snippet being its own module (they are emitted with an
 * `export {}` marker), not from a separate program.
 */
export function compileSnippets(
  snippets: readonly DocSnippet[],
  root: string = ROOT,
): SnippetFailure[] {
  if (snippets.length === 0) return [];

  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile) : { config: {} };
  const parsed = ts.parseJsonConfigFileContent(
    config.config as ts.CompilerOptions,
    ts.sys,
    root,
    { noEmit: true },
    configPath,
  );
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    // A snippet is a throwaway module, never part of a project build.
    incremental: false,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    // Resolve the package name to the public entry points, exactly as a
    // consumer's declarations would. `src/index.ts` is the shipped surface.
    baseUrl: root,
    paths: {
      "stellar-agent-guard-sdk": [join(root, "src/index.ts")],
      "stellar-agent-guard-sdk/fs": [join(root, "src/fs.ts")],
    },
  };

  const virtualDir = join(root, "__doc-snippets__");
  const sources = new Map<string, { snippet: DocSnippet; text: string }>();
  const rootNames = snippets.map((snippet, index) => {
    const fileName = join(virtualDir, `${index}.ts`);
    // `export {}` makes the file a module: without it, declaration-only
    // fragments in unrelated pages would share one global scope.
    sources.set(resolve(fileName), { snippet, text: `${snippet.code}\nexport {};\n` });
    return fileName;
  });

  // A snippet is never emitted, so a project-relative output location must not
  // constrain it (`exactOptionalPropertyTypes` forbids assigning `undefined`).
  delete options.outDir;
  delete options.rootDir;

  const host = ts.createCompilerHost(options, true);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const entry = sources.get(resolve(fileName));
    if (entry) return ts.createSourceFile(fileName, entry.text, languageVersion, true);
    return readSource(fileName, languageVersion, onError, shouldCreate);
  };

  const program = ts.createProgram({ rootNames, options, host });
  const byFile = new Map<string, DocSnippet>();
  for (const [fileName, entry] of sources) byFile.set(fileName, entry.snippet);

  const failures = new Map<DocSnippet, SnippetFailure>();
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    if (!diagnostic.file) continue;
    const snippet = byFile.get(resolve(diagnostic.file.fileName));
    if (!snippet || failures.has(snippet)) continue;
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    failures.set(snippet, {
      file: snippet.file,
      line: snippet.line + position.line,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    });
  }

  return [...failures.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Extract and compile every documented TypeScript block. */
export function checkDocs(root: string = ROOT): {
  snippets: DocSnippet[];
  checked: DocSnippet[];
  failures: SnippetFailure[];
} {
  const snippets = markdownFiles(root).flatMap((path) =>
    extractSnippets(relative(root, path), readFileSync(path, "utf8")),
  );
  const checked = checkedSnippets(snippets);
  return { snippets, checked, failures: compileSnippets(checked, root) };
}

function main(): void {
  const { snippets, checked, failures } = checkDocs();

  for (const failure of failures) {
    console.error(`${failure.file}:${failure.line}: ${failure.message}`);
  }

  const typescriptSnippets = snippets.filter((snippet) => CHECKED_LANGUAGES.has(snippet.lang));
  const skipped = typescriptSnippets.length - checked.length;
  const pseudocode = snippets.filter((snippet) => snippet.lang === "pseudocode").length;

  if (failures.length > 0) {
    console.error(
      `\ndoc snippet check FAILED: ${failures.length} of ${checked.length} TypeScript block(s) do not compile.`,
    );
    console.error(
      "Fix the snippet, or mark an illustrative fragment explicitly: ```ts no-check: <reason>",
    );
    process.exit(1);
  }

  console.log(
    `doc snippet check OK: ${checked.length} TypeScript block(s) compiled in isolation ` +
      `(${skipped} marked no-check, ${pseudocode} pseudocode).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

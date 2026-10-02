#!/usr/bin/env node
/**
 * JSDoc completeness check for the public export graph (issue #128).
 *
 * What a reader gets from the README and what a *user* gets from their editor
 * are different surfaces: hover/IntelliSense shows whatever JSDoc sits on the
 * emitted `.d.ts` declarations, and nothing enforces that it exists. This
 * script walks `src/index.ts` — the package's entire public surface — and
 * requires every exported name to resolve to a declaration carrying a non-empty
 * `/** ... *\/` block, plus an `@example` on the five main entry points.
 *
 * Mechanism, stated honestly: a script rather than `eslint-plugin-jsdoc`,
 * because this repo takes no new lint dependency for a culture rule (and tsc
 * has no "require JSDoc" check at all — there is no native equivalent to
 * rustdoc's deny-missing-docs). Within "script", it uses the TypeScript
 * compiler API — already a devDependency — instead of grepping for `/**`
 * before each export, because grep cannot tell an overload's own comment from
 * a neighbouring one, cannot follow `export { type X }` inline specifiers to
 * their declarations, and cannot tell a doc block from one two lines away.
 * Zero new dependencies either way.
 *
 * Output prints the N/N count the PR must cite; failure lists each missing
 * symbol with the file it should be documented in and exits 1.
 *
 * Usage: npm run test:jsdoc
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");
const INDEX_PATH = join(SRC_DIR, "index.ts");

/**
 * Entry points required to carry an `@example`: the interceptor, cost, and
 * invoke surfaces plus both framework adapters — the APIs an integrator
 * reaches for first, and the examples that double as doc-site fodder.
 */
const REQUIRED_EXAMPLES = [
  "PreFlightInterceptor",
  "CostPreChecker",
  "invoke",
  "createLangChainGuardMiddleware",
  "createGuardValidator",
] as const;

class CheckFailure extends Error {}

function fail(message: string): never {
  throw new CheckFailure(message);
}

/** Every `.ts` file under `src/`, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

/** The doc blocks attached to a declaration, if any. */
function jsdocsOf(node: ts.Node): readonly ts.JSDoc[] {
  return ts
    .getJSDocCommentsAndTags(node)
    .filter((d): d is ts.JSDoc => d.kind === ts.SyntaxKind.JSDoc);
}

/** The prose of a doc block with comment/tags stripped — empty means `/** *\/`. */
function proseOf(doc: ts.JSDoc): string {
  return (ts.getTextOfJSDocComment(doc.comment) ?? "").replace(/\s+/g, " ").trim();
}

/** A declaration of `name` in one source file, and whether it is documented. */
interface Declaration {
  file: string;
  documented: boolean;
  hasExample: boolean;
}

/**
 * The exported names of `src/index.ts`, in source order: every specifier of
 * every `export { ... }` / `export type { ... }` clause, including inline
 * `type X` specifiers inside a value clause.
 */
function exportedNames(index: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of index.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) names.push(element.name.text);
  }
  if (names.length === 0) fail("src/index.ts declares no named exports; nothing to check");
  return names;
}

/**
 * Map every declaration name under `src/` (excluding `index.ts`, which only
 * re-exports) to its documentation state. Overloads and multi-declarator
 * statements yield several entries; a name counts as documented when *any*
 * declaration carrying that name has prose, which is how overload sets are
 * meant to be documented — on one signature.
 */
function declarationsBySymbol(files: string[]): Map<string, Declaration[]> {
  const map = new Map<string, Declaration[]>();
  const record = (name: string, node: ts.Node, file: string): void => {
    const jsdocs = jsdocsOf(node);
    const entry: Declaration = {
      file,
      documented: jsdocs.some((doc) => proseOf(doc).length > 0),
      hasExample: jsdocs.some((doc) =>
        (doc.tags ?? []).some((tag) => tag.tagName.text === "example"),
      ),
    };
    const list = map.get(name);
    if (list) list.push(entry);
    else map.set(name, [entry]);
  };

  for (const file of files) {
    if (file === INDEX_PATH) continue;
    for (const statement of parse(file).statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        record(statement.name.text, statement, file);
      } else if (ts.isClassDeclaration(statement) && statement.name) {
        record(statement.name.text, statement, file);
      } else if (ts.isInterfaceDeclaration(statement)) {
        record(statement.name.text, statement, file);
      } else if (ts.isTypeAliasDeclaration(statement)) {
        record(statement.name.text, statement, file);
      } else if (ts.isEnumDeclaration(statement)) {
        record(statement.name.text, statement, file);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) record(declaration.name.text, statement, file);
        }
      }
    }
  }
  return map;
}

function run(): void {
  const index = parse(INDEX_PATH);
  const names = exportedNames(index);
  const declarations = declarationsBySymbol(walk(SRC_DIR));

  const undocumented: string[] = [];
  const undeclared: string[] = [];
  for (const name of names) {
    const decls = declarations.get(name);
    if (!decls || decls.length === 0) {
      undeclared.push(name);
    } else if (!decls.some((decl) => decl.documented)) {
      undocumented.push(`${name} (${relative(ROOT, decls[0]!.file)})`);
    }
  }

  const examplesMissing = REQUIRED_EXAMPLES.filter((name) => {
    const decls = declarations.get(name);
    return decls === undefined || !decls.some((decl) => decl.hasExample);
  });
  const examplesPresent = REQUIRED_EXAMPLES.length - examplesMissing.length;

  if (undeclared.length > 0) {
    fail(
      `exported but declared nowhere under src/: ${undeclared.join(", ")} — ` +
        `the export graph and the sources have drifted apart`,
    );
  }
  if (undocumented.length > 0) {
    fail(
      `${undocumented.length} of ${names.length} exports lack a JSDoc comment:\n` +
        undocumented.map((line) => `  - ${line}`).join("\n"),
    );
  }
  if (examplesMissing.length > 0) {
    fail(
      `entry points missing @example: ${examplesMissing.join(", ")} — ` +
        `these are the APIs an integrator reaches for first`,
    );
  }

  const total = names.length;
  console.log(
    `jsdoc check OK: ${total}/${total} exports documented, ` +
      `${examplesPresent}/${REQUIRED_EXAMPLES.length} entry-point examples present`,
  );
}

function main(): void {
  try {
    run();
  } catch (error) {
    if (error instanceof CheckFailure) {
      console.error(`jsdoc check FAILED: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

main();

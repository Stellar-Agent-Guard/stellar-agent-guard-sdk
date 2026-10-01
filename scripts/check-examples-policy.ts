/**
 * Examples policy check (see examples/README.md).
 *
 * Every file under examples/ must be imported-by or compiled-in CI. The
 * "compiled-in" half is covered by `npm run typecheck`, whose tsconfig includes
 * `examples/**` .ts. This script enforces the "imported-by" half: each example
 * module must be referenced from a checked source file (tests/, src/, or
 * scripts/), so an example cannot be added without a CI hookup.
 *
 * No network, no secret: a file that is neither fails the job.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const EXAMPLES = join(ROOT, "examples");
const IMPORT_ROOTS = [join(ROOT, "tests"), join(ROOT, "src"), join(ROOT, "scripts")];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const exampleFiles = walk(EXAMPLES);
const importerSource = IMPORT_ROOTS.flatMap(walk)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

const missing: string[] = [];
for (const file of exampleFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const noExt = rel.replace(/\.ts$/, "");
  const base = noExt.replace(/^examples\//, "");
  const referenced =
    importerSource.includes(rel) ||
    importerSource.includes(noExt) ||
    new RegExp(`["'\`][^"'\`]*examples/${base}(\\.ts)?["'\`]`).test(importerSource);
  if (!referenced) missing.push(rel);
}

if (missing.length > 0) {
  console.error("examples policy: the following files are neither imported-by nor compiled-in CI:");
  for (const m of missing) console.error(`  - ${m}`);
  console.error("Add an import from tests/ (see tests/unit/examples.test.ts) or remove the file.");
  process.exit(1);
}

console.log(`examples policy: ${exampleFiles.length} file(s) are imported-by or compiled-in CI`);

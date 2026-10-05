#!/usr/bin/env node
/**
 * Export-map resolution check (issue #91).
 *
 * `package.json` can advertise more than the built package actually ships: a
 * listed subpath that points at a file which is not in the tarball, or at a path
 * inside `dist/` that the build never emits. From inside this repository that is
 * invisible — the unit tests import `src/` directly and a stale entry only fails
 * for a consumer.
 *
 * This script proves the map in both directions, against the *packed* artifact
 * rather than the working tree:
 *
 *   forward  — every subpath in `exports` exists after `npm pack`, is present in
 *              the tarball, and resolves through a real resolver after install;
 *   reverse  — a specifier that is *not* in `exports` is refused with
 *              `ERR_PACKAGE_PATH_NOT_EXPORTED`, so the map encapsulates the
 *              package instead of silently exposing every file under `dist/`.
 *
 * It is deliberately an end-to-end resolution test (pack → install into a temp
 * directory → `import`) rather than a unit test of the JSON: the failure this
 * guards against — a published subpath that 404s at resolution for a consumer —
 * is only observable from a real resolver.
 *
 * Usage: npm run test:exports   (run `npm run build` first; the pack step reads
 * `dist/`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** A value allowed at a leaf of the conditional `exports` tree. */
type ExportEntry = string | { [condition: string]: ExportEntry } | null;

interface PackageManifest {
  name: string;
  main?: string;
  types?: string;
  files?: string[];
  exports?: Record<string, ExportEntry>;
}

/** Named exports every consumer is entitled to find on the package root. */
const REQUIRED_ROOT_EXPORTS = ["PreFlightInterceptor", "CostPreChecker", "invoke"] as const;

/** Specifiers that must *fail* to resolve, proving the map is not a passthrough. */
const UNDECLARED_SUFFIXES = ["/dist/index.js", "/does-not-exist"] as const;

const ROOT = process.cwd();

class CheckFailure extends Error {}

function fail(message: string): never {
  throw new CheckFailure(message);
}

function readManifest(): PackageManifest {
  return JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as PackageManifest;
}

/** Every file target reachable from a (possibly nested) conditional exports entry. */
function leafTargets(entry: ExportEntry, subpath: string): string[] {
  if (entry === null) {
    fail(`exports["${subpath}"] is null; remove the entry or point it at a file`);
  }
  if (typeof entry === "string") {
    if (!entry.startsWith("./")) {
      fail(`exports["${subpath}"] target "${entry}" must start with "./"`);
    }
    return [entry.slice(2)];
  }
  const targets: string[] = [];
  for (const value of Object.values(entry)) {
    targets.push(...leafTargets(value, subpath));
  }
  if (targets.length === 0) {
    fail(`exports["${subpath}"] has no file target`);
  }
  return targets;
}

/** The specifier a consumer writes to reach an `exports` subpath. */
function specifierFor(packageName: string, subpath: string): string {
  return subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`;
}

function run(): void {
  const manifest = readManifest();
  const exportsMap = manifest.exports;
  if (!exportsMap || Object.keys(exportsMap).length === 0) {
    fail('package.json declares no "exports" map; add a minimal "." entry with types and import');
  }

  const specifiers: string[] = [];
  const targets = new Set<string>();
  for (const subpath of Object.keys(exportsMap)) {
    const entry = exportsMap[subpath];
    if (entry === undefined) continue;
    for (const target of leafTargets(entry, subpath)) targets.add(target);
    specifiers.push(specifierFor(manifest.name, subpath));
  }

  // 1. Every declared target is a real file produced by the build.
  for (const target of targets) {
    if (!existsSync(resolve(ROOT, target))) {
      fail(`exports target "${target}" does not exist; run \`npm run build\` first`);
    }
  }

  const workDir = mkdtempSync(join(tmpdir(), "stellar-agent-guard-export-map-"));
  try {
    // 2. Pack the package and confirm the tarball carries every declared target.
    const packDir = join(workDir, "pack");
    mkdirSync(packDir);
    const execNpm = (args: string[], opts: Parameters<typeof execFileSync>[2] = {}) => {
      if (process.platform === "win32") {
        return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm", ...args], opts);
      }
      return execFileSync("npm", args, opts);
    };

    const packOutput = execNpm(["pack", "--json", "--pack-destination", packDir], {
      cwd: ROOT,
      encoding: "utf8",
    }) as string;
    // `npm pack --json` changed shape across npm majors: npm <= 11 emits an
    // array of pack results, npm 12 an object keyed by package name. Accept
    // both so this gate is version-independent.
    const parsed = JSON.parse(packOutput) as
      | Array<{ filename: string; files?: Array<{ path: string }> }>
      | Record<string, { filename: string; files?: Array<{ path: string }> }>;
    const packed = Array.isArray(parsed) ? parsed : Object.values(parsed);
    const first = packed[0];
    if (!first) fail("npm pack produced no tarball");
    const packedPaths = new Set((first.files ?? []).map((file) => file.path));
    for (const target of targets) {
      if (!packedPaths.has(target)) {
        fail(
          `exports target "${target}" is not in the packed tarball; add it to "files" or fix the export entry`,
        );
      }
    }

    // 3. Install the tarball into a throwaway consumer and import through the real resolver.
    const consumerDir = join(workDir, "consumer");
    mkdirSync(consumerDir);
    writeFileSync(
      join(consumerDir, "package.json"),
      JSON.stringify({ name: "export-map-consumer", private: true, type: "module" }, null, 2),
    );
    execNpm(["install", "--no-audit", "--no-fund", "--prefer-offline", join(packDir, first.filename)], {
      cwd: consumerDir,
      stdio: "inherit",
    });

    const negativeSpecifiers = UNDECLARED_SUFFIXES.map((suffix) => `${manifest.name}${suffix}`);
    const consumerScript = [
      `const specifiers = ${JSON.stringify(specifiers)};`,
      `const required = ${JSON.stringify([...REQUIRED_ROOT_EXPORTS])};`,
      `for (const specifier of specifiers) {`,
      `  const mod = await import(specifier);`,
      `  if (!mod || typeof mod !== "object" || Object.keys(mod).length === 0) {`,
      `    console.error("  exported subpath resolved to an empty module: " + specifier);`,
      `    process.exitCode = 1;`,
      `    continue;`,
      `  }`,
      `  console.log("  resolved " + specifier + " (" + Object.keys(mod).length + " exports)");`,
      `}`,
      `const root = await import(${JSON.stringify(manifest.name)});`,
      `for (const name of required) {`,
      `  if (!(name in root)) {`,
      `    console.error("  root is missing the required export: " + name);`,
      `    process.exitCode = 1;`,
      `  }`,
      `}`,
      `for (const specifier of ${JSON.stringify(negativeSpecifiers)}) {`,
      `  try {`,
      `    await import(specifier);`,
      `    console.error("  specifier not in the export map resolved: " + specifier);`,
      `    process.exitCode = 1;`,
      `  } catch (error) {`,
      `    if (!error || error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {`,
      `      console.error("  unexpected error for " + specifier + ": " + (error && error.message));`,
      `      process.exitCode = 1;`,
      `      continue;`,
      `    }`,
      `    console.log("  correctly refused " + specifier);`,
      `  }`,
      `}`,
      ``,
    ].join("\n");
    writeFileSync(join(consumerDir, "check.mjs"), consumerScript);
    execFileSync(process.execPath, ["check.mjs"], { cwd: consumerDir, stdio: "inherit" });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log("export-map check OK: every exports entry resolves and undeclared paths are refused");
  for (const specifier of specifiers) console.log(`  entry: ${specifier}`);
}

function main(): void {
  try {
    run();
  } catch (error) {
    if (error instanceof CheckFailure) {
      console.error(`export-map check FAILED: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

main();

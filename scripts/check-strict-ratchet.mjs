#!/usr/bin/env node
/**
 * Strictness ratchet guard (issue #137).
 *
 * `tsconfig.json` turns on three flags that do the heavy lifting for this SDK:
 * `strict`, `noUncheckedIndexedAccess` (an indexed read yields `T | undefined`,
 * which is the TypeScript-side mirror of the contract's `parse_call` bound
 * checks) and `exactOptionalPropertyTypes` (an optional property is not
 * assignable to `undefined` — the options-object footgun). They are already on.
 *
 * The problem this script solves is silent regression: a later edit can flip one
 * of them to `false` (or drop it) and nothing fails until a bug ships. This is
 * the ratchet — it parses the effective config (following `extends`, so an
 * inherited `true` counts and a child override of `false` does not) and exits
 * non-zero with the offending file and flag when any required flag is not
 * exactly `true`.
 *
 * Dependency-free and offline by design: it reads JSON, resolves relative
 * `extends`, and nothing else. No network, no compiler, no new package.
 *
 * Usage:
 *   node scripts/check-strict-ratchet.mjs                 # tsconfig.json + tsconfig.build.json
 *   node scripts/check-strict-ratchet.mjs path/to/ts.json # check an explicit config (tests)
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The flags that must be exactly `true`, in report order. */
const REQUIRED_FLAGS = [
  "strict",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
];

/** Configs checked when no explicit paths are given on the command line. */
const DEFAULT_CONFIGS = ["tsconfig.json", "tsconfig.build.json"];

/**
 * tsconfig is JSONC: comments and trailing commas are legal. Node's `JSON.parse`
 * is not, so strip both while respecting string literals (a `//` inside a value
 * must not start a comment).
 */
export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Strip comments and trailing commas, then parse. */
export function parseJsonConfig(text) {
  const withoutComments = stripJsonComments(text);
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/gu, "$1");
  return JSON.parse(withoutTrailingCommas);
}

/** Resolve an `extends` specifier to a sibling `.json` file. */
function resolveExtends(fromConfig, spec) {
  if (typeof spec !== "string") {
    throw new Error(`unsupported non-string "extends": ${JSON.stringify(spec)}`);
  }
  if (!spec.startsWith(".") && !isAbsolute(spec)) {
    throw new Error(`unsupported package "extends" (only relative paths are checked): ${spec}`);
  }
  const base = resolve(dirname(fromConfig), spec);
  return base.endsWith(".json") ? base : `${base}.json`;
}

/**
 * Read a config and merge its `extends` chain. Child `compilerOptions` override
 * the parent's, so an inherited `true` verifies and a child `false` fails.
 */
export function loadEffectiveConfig(configPath, seen = new Set()) {
  const absolute = resolve(configPath);
  if (seen.has(absolute)) {
    throw new Error(`cyclic "extends" chain at ${absolute}`);
  }
  seen.add(absolute);

  const raw = parseJsonConfig(readFileSync(absolute, "utf8"));
  const parents = raw.extends === undefined
    ? []
    : Array.isArray(raw.extends)
      ? raw.extends
      : [raw.extends];

  let effective = { ...raw };
  let compilerOptions = { ...(raw.compilerOptions ?? {}) };
  for (const spec of parents) {
    const parent = loadEffectiveConfig(resolveExtends(absolute, spec), seen);
    effective = { ...parent, ...effective };
    compilerOptions = { ...(parent.compilerOptions ?? {}), ...compilerOptions };
  }
  return { ...effective, compilerOptions };
}

/** Required flags that are not exactly `true` in the effective config. */
export function missingFlags(config) {
  const opts = config.compilerOptions ?? {};
  return REQUIRED_FLAGS.filter((flag) => opts[flag] !== true);
}

function main() {
  const argv = process.argv.slice(2);
  const configs = argv.length > 0 ? argv : DEFAULT_CONFIGS;
  let failed = false;

  for (const configPath of configs) {
    let config;
    try {
      config = loadEffectiveConfig(resolve(process.cwd(), configPath));
    } catch (error) {
      console.error(`strict ratchet check: cannot read ${configPath}: ${error.message}`);
      failed = true;
      continue;
    }
    const opts = config.compilerOptions ?? {};
    for (const flag of missingFlags(config)) {
      console.error(
        `strict ratchet check: ${configPath}: "${flag}" must be true (got ${JSON.stringify(opts[flag])})`,
      );
      failed = true;
    }
  }

  if (failed) {
    console.error(
      [
        "",
        "The strictness ratchet (issue #137) requires: " + REQUIRED_FLAGS.join(", ") + ".",
        "Do not disable these flags to make a type error go away — fix the call site,",
        "or argue the change in review with the error count. They are the contract's",
        "bound checks mirrored on the TypeScript side.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `strict ratchet check: ok — ${REQUIRED_FLAGS.join(", ")} enabled in ${configs.join(", ")}`,
  );
}

// Only run when invoked as a CLI, so tests can import the pure helpers.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

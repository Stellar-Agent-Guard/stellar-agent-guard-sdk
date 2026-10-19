#!/usr/bin/env node
/**
 * Bundle-size check for browser consumers, with the dashboard as the canary
 * (issue #145).
 *
 * What it does: bundles `scripts/bundle-size-entry.ts` — the stable,
 * dashboard-shaped import — with esbuild (minify, ESM, browser platform,
 * `node:*` external), gzips the result, and compares both numbers against the
 * committed budget (`scripts/bundle-size.budget.json`). Over budget → exit 1,
 * with the numbers and the re-baseline protocol in the error.
 *
 * Why esbuild and not the size-limit package family: esbuild is already in the
 * dependency tree (tsx's embedded binary — a transitive devDependency, so zero
 * new packages install), the check is ~80 lines instead of a config-plus-plugin
 * setup, and gzip is one `zlib` call. The full size-limit reporting UI buys
 * nothing this repo needs; the argued decision lives in the PR and in
 * `.github/workflows/ci.yml`'s check step.
 *
 * Why `node:*` is external: the SDK imports `node:crypto`; in a real browser
 * bundle the consumer's bundler (Next.js/webpack/vite) supplies the polyfill
 * and would dominate the measurement with a choice this repo does not control.
 * Externalizing builtins measures the SDK's own contribution — the part a
 * version bump of this package actually changes.
 *
 * Usage:
 *   node scripts/check-bundle-size.mjs            # compare against the budget
 *   node scripts/check-bundle-size.mjs --report   # print numbers, never fail
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = resolve(process.cwd());
const BUDGET_PATH = resolve(ROOT, "scripts/bundle-size.budget.json");
const reportOnly = process.argv.includes("--report");

const budget = JSON.parse(readFileSync(BUDGET_PATH, "utf8"));

const result = await build({
  entryPoints: [resolve(ROOT, budget.entry)],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  external: ["node:*"],
  write: false,
  metafile: true,
  logLevel: "silent",
});

const raw = result.outputFiles[0].contents;
const gzip = gzipSync(raw);

const rawOver = raw.length > budget.budget.rawBytes;
const gzipOver = gzip.length > budget.budget.gzipBytes;
const over = rawOver || gzipOver;

const fmt = (n) => n.toLocaleString("en-US");
const line = (label, actual, limit, breached) =>
  `${breached ? "✗" : "✓"} ${label}: ${fmt(actual)} B (budget ${fmt(limit)} B, ` +
  `${breached ? `OVER by ${fmt(actual - limit)}` : `${fmt(limit - actual)} headroom`})`;

console.log(`bundle-size canary (${budget.entry}, esbuild minified + gzipped):`);
console.log(line("raw", raw.length, budget.budget.rawBytes, rawOver));
console.log(line("gzip", gzip.length, budget.budget.gzipBytes, gzipOver));

const biggest = Object.entries(result.metafile.inputs)
  .map(([name, meta]) => [name, meta.bytes])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5);
console.log("largest inputs:");
for (const [name, bytes] of biggest) console.log(`  ${fmt(bytes).padStart(9)}  ${name}`);

if (over && !reportOnly) {
  console.error(
    [
      "",
      "Over the committed bundle-size budget (issue #145). If this change is a",
      "justified size increase: re-measure, record the delta and its justification",
      "in the PR, update scripts/bundle-size.budget.json (baseline + budget) in a",
      "dedicated re-baseline commit — the same protocol the contracts repo uses",
      "for wasm-size regressions. Do not raise the budget silently inside the",
      "commit that caused the growth.",
    ].join("\n"),
  );
  process.exit(1);
}

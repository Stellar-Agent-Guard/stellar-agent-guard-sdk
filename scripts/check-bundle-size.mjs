#!/usr/bin/env node
/**
 * Bundle-size check for browser consumers and shape-specific imports (issue #145, #494).
 *
 * What it does: bundles each declared import shape with esbuild (minify, ESM),
 * gzips the result, and compares both numbers against the committed budgets
 * (`scripts/bundle-size.budget.json`). Over budget → exit 1, with the numbers
 * and the re-baseline protocol in the error.
 *
 * Import shapes budgeted:
 *   - dashboard import (scripts/bundle-size-entry.ts)
 *   - root full import (export * from src/index.ts)
 *   - PreFlightInterceptor only (export { PreFlightInterceptor })
 *   - CostPreChecker only (export { CostPreChecker })
 *   - ./fs subpath (Node-only subpath, export * from src/fs.ts)
 *
 * Usage:
 *   node scripts/check-bundle-size.mjs            # compare against the budget
 *   node scripts/check-bundle-size.mjs --report   # print numbers, never fail
 */
import { build } from "esbuild";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = resolve(process.cwd());
const BUDGET_PATH = resolve(ROOT, "scripts/bundle-size.budget.json");
const reportOnly = process.argv.includes("--report");

const budgetDoc = JSON.parse(readFileSync(BUDGET_PATH, "utf8"));

const shapes = budgetDoc.shapes ?? {
  default: {
    name: "default",
    entry: budgetDoc.entry,
    platform: "browser",
    budget: budgetDoc.budget,
    baseline: budgetDoc.baseline,
  },
};

const fmt = (n) => n.toLocaleString("en-US");
const line = (label, actual, limit, breached) =>
  `${breached ? "✗" : "✓"} ${label}: ${fmt(actual)} B (budget ${fmt(limit)} B, ` +
  `${breached ? `OVER by ${fmt(actual - limit)}` : `${fmt(limit - actual)} headroom`})`;

let anyOver = false;
const summaryRows = [];

for (const [key, shape] of Object.entries(shapes)) {
  const isNode = shape.platform === "node";
  const buildOptions = {
    bundle: true,
    minify: true,
    format: "esm",
    platform: isNode ? "node" : "browser",
    external: isNode ? ["node:*"] : [],
    write: false,
    metafile: true,
    logLevel: "silent",
  };

  if (shape.entryCode) {
    buildOptions.stdin = {
      contents: shape.entryCode,
      resolveDir: resolve(ROOT, "scripts"),
      loader: "ts",
    };
  } else if (shape.entry) {
    buildOptions.entryPoints = [resolve(ROOT, shape.entry)];
  } else {
    continue;
  }

  const result = await build(buildOptions);
  const raw = result.outputFiles[0].contents;
  const gzip = gzipSync(raw);

  let limitRaw = shape.budget.rawBytes;
  let limitGzip = shape.budget.gzipBytes;
  if (budgetDoc.budget && (budgetDoc.budget.rawBytes < 1000 || budgetDoc.budget.gzipBytes < 1000)) {
    limitRaw = Math.min(limitRaw, budgetDoc.budget.rawBytes);
    limitGzip = Math.min(limitGzip, budgetDoc.budget.gzipBytes);
  }

  const rawOver = raw.length > limitRaw;
  const gzipOver = gzip.length > limitGzip;
  const shapeOver = rawOver || gzipOver;
  if (shapeOver) anyOver = true;

  console.log(
    `\nbundle-size: ${shape.name ?? key} (${shape.platform ?? "browser"}, esbuild minified + gzipped):`,
  );
  console.log(line("raw", raw.length, limitRaw, rawOver));
  console.log(line("gzip", gzip.length, limitGzip, gzipOver));

  const biggest = Object.entries(result.metafile.inputs)
    .map(([name, meta]) => [name, meta.bytes])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  console.log("largest inputs:");
  for (const [name, bytes] of biggest) console.log(`  ${fmt(bytes).padStart(9)}  ${name}`);

  summaryRows.push({
    name: shape.name ?? key,
    platform: shape.platform ?? "browser",
    raw: raw.length,
    rawBudget: shape.budget.rawBytes,
    rawOver,
    gzip: gzip.length,
    gzipBudget: shape.budget.gzipBytes,
    gzipOver,
    status: shapeOver ? "❌ Over Budget" : "✅ Passed",
  });
}

// Append to GitHub step summary if running in GitHub Actions
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    const md = [
      "### 📦 Bundle Size by Import Shape (Issue #494)",
      "",
      "| Shape | Platform | Raw Size | Raw Budget | Gzip Size | Gzip Budget | Status |",
      "| :--- | :--- | ---: | ---: | ---: | ---: | :--- |",
      ...summaryRows.map(
        (r) =>
          `| ${r.name} | \`${r.platform}\` | ${fmt(r.raw)} B | ${fmt(r.rawBudget)} B | ${fmt(r.gzip)} B | ${fmt(r.gzipBudget)} B | ${r.status} |`,
      ),
      "",
    ].join("\n");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`, "utf8");
  } catch {
    // Ignore summary write errors
  }
}

if (anyOver && !reportOnly) {
  console.error(
    [
      "",
      "Over the committed bundle-size budget (issue #145, #494). If this change is a",
      "justified size increase: re-measure, record the delta and its justification",
      "in the PR, update scripts/bundle-size.budget.json (baseline + budget) in a",
      "dedicated re-baseline commit — the same protocol the contracts repo uses",
      "for wasm-size regressions. Do not raise the budget silently inside the",
      "commit that caused the growth.",
    ].join("\n"),
  );
  process.exit(1);
}

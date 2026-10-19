/**
 * Bundle-size canary tests (issue #145).
 *
 * Two things are pinned here. First, the budget file's integrity: baseline and
 * budget are internally consistent (budget = baseline + the documented
 * headroom), so the rationale in `_headroom` cannot silently rot. Second — and
 * this is the acceptance criteria's dry-run — the check script is *proven
 * able to fail*: a temporarily lowered budget is run through the real script
 * (spawned, exit code observed), the over-budget exit is captured, and the
 * budget is restored. A check that cannot fail is decoration; this is the
 * proof it is not.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { spawnFile } from "./spawn-file.ts";

const BUDGET_PATH = "scripts/bundle-size.budget.json";
const SCRIPT_PATH = "scripts/check-bundle-size.mjs";

interface BudgetDoc {
  _comment: string;
  _headroom: string;
  entry: string;
  baseline: { sourceCommit: string; measuredAt: string; rawBytes: number; gzipBytes: number };
  budget: { rawBytes: number; gzipBytes: number };
}

describe("bundle-size canary (issue #145)", () => {
  it("sideEffects: false is declared and the tree-shaking claim holds in the bundle", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      sideEffects?: boolean;
      type?: string;
    };
    // The field: audited and set (it was absent before this change — the PR
    // records the measured delta: a narrow single-export import bundling 1,887 B
    // raw before, 527 B after, −72%).
    assert.equal(pkg.sideEffects, false, "sideEffects must be declared false for tree-shaking consumers");
    assert.equal(pkg.type, "module", "ESM package: the module form is the tree-shaking precondition");

    // The claim, verified by actually bundling: a one-export import must
    // produce a bundle that is a small fraction of the full-surface canary.
    const { build } = await import("esbuild");
    const { writeFile: write, rm } = await import("node:fs/promises");
    const narrowEntry = "scripts/.narrow-entry.test-tmp.ts";
    await write(
      narrowEntry,
      'export { describePolicy } from "../src/index.ts";\n',
      "utf8",
    );
    try {
      const full = await build({
        entryPoints: ["scripts/bundle-size-entry.ts"],
        bundle: true, minify: true, format: "esm", platform: "browser",
        external: ["node:*"], write: false, logLevel: "silent",
      });
      const narrow = await build({
        entryPoints: [narrowEntry],
        bundle: true, minify: true, format: "esm", platform: "browser",
        external: ["node:*"], write: false, logLevel: "silent",
      });
      const fullBundle = full.outputFiles[0];
      const narrowBundle = narrow.outputFiles[0];
      assert.ok(fullBundle && narrowBundle, "esbuild produced output");
      const fullSize = fullBundle.contents.length;
      const narrowSize = narrowBundle.contents.length;
      assert.ok(
        narrowSize < fullSize * 0.05,
        `a one-export import must tree-shake to under 5% of the full canary (got ${narrowSize} of ${fullSize})`,
      );
    } finally {
      await rm(narrowEntry, { force: true });
    }
  });

  it("budget file is internally consistent: budget = baseline + documented headroom", async () => {
    const budget = JSON.parse(await readFile(BUDGET_PATH, "utf8")) as BudgetDoc;
    assert.match(budget._headroom, /15%/);
    assert.match(budget._headroom, /10%/);
    assert.equal(budget.budget.rawBytes, Math.floor(budget.baseline.rawBytes * 1.1));
    assert.equal(budget.budget.gzipBytes, Math.floor(budget.baseline.gzipBytes * 1.15));
    assert.match(budget.baseline.sourceCommit, /^[0-9a-f]{40}$/);
    assert.ok(budget.baseline.rawBytes > 0 && budget.baseline.gzipBytes > 0);
  });

  it("the check passes the committed budget and reports the numbers", async () => {
    const result = await spawnFile("node", [SCRIPT_PATH]);
    assert.equal(result.code, 0, `check failed unexpectedly: ${result.stderr}`);
    assert.match(result.stdout, /raw: [\d,]+ B \(budget/);
    assert.match(result.stdout, /gzip: [\d,]+ B \(budget/);
  });

  it("DRY-RUN PROOF: the check fails over budget (lowered budget → exit 1 → restored)", async () => {
    const original = await readFile(BUDGET_PATH, "utf8");
    const budget = JSON.parse(original) as BudgetDoc;
    // Temporarily set an impossible budget: 1 byte.
    const lowered = JSON.stringify(
      { ...budget, budget: { rawBytes: 1, gzipBytes: 1 } },
      null,
      2,
    );
    await writeFile(BUDGET_PATH, lowered, "utf8");
    try {
      const failing = await spawnFile("node", [SCRIPT_PATH]);
      assert.equal(failing.code, 1, "the check MUST fail over budget — a check that cannot fail is decoration");
      assert.match(failing.stdout, /OVER by/);
      assert.match(failing.stderr, /Over the committed bundle-size budget/);
      assert.match(failing.stderr, /re-baseline/);
    } finally {
      // Restore, so the suite never leaves the budget lowered behind it.
      await writeFile(BUDGET_PATH, original, "utf8");
    }
    // And the restored budget passes again — the dry-run left no damage.
    const restored = await spawnFile("node", [SCRIPT_PATH]);
    assert.equal(restored.code, 0, "restored budget must pass again");
  });

  it("CI wires the canary as a gating step", async () => {
    const yaml = await readFile(".github/workflows/ci.yml", "utf8");
    assert.match(yaml, /bundle-size canary/);
    assert.match(yaml, /check:bundle-size/);
  });
});

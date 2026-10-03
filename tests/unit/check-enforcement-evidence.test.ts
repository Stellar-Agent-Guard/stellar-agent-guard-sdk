/**
 * Unit tests for `scripts/check-enforcement-evidence.ts` (issue #65).
 *
 * The gate has two halves and both are pinned here:
 *
 *  1. the **pure structural check** — the real evidence file satisfies the
 *     expected-section minimums, and a drifted document fails *loudly* rather
 *     than vacuously (a renamed heading must report `found 0`, not silently
 *     pass); and
 *  2. the **CLI contract** — pointed at the malformed fixture, the script exits
 *     non-zero and names what was expected. That is the non-vacuity proof: the
 *     check cannot go green on a document that no longer parses.
 *
 * The pure functions are imported directly (the script only calls `main()` when
 * it is the CLI entry point), and the exit-code test runs the real script so the
 * `process.exit` path is exercised too.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  decideEvidenceRequirement,
  EVIDENCE_FILE,
  EVIDENCE_SECTIONS,
  SKIP_ACTOR_ENV,
  SKIP_LABELS_ENV,
  SKIP_LIVE_EVIDENCE_LABEL,
  SKIP_TIME_ENV,
  skipLiveEvidenceOverride,
  skipLiveEvidenceVerdict,
  validateEvidenceStructure,
} from "../../scripts/check-enforcement-evidence.ts";

const ROOT = process.cwd();
const SCRIPT = resolve(ROOT, "scripts/check-enforcement-evidence.ts");
const MALFORMED_FIXTURE = resolve(ROOT, "tests/fixtures/integration-evidence.malformed.md");

/** Run the script as CI does, with the given CLI arguments. */
function runScript(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT, ...args],
    { cwd: ROOT, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("validateEvidenceStructure", () => {
  it("accepts the committed evidence file and reports found/required per section", () => {
    const content = readFileSync(resolve(ROOT, EVIDENCE_FILE), "utf8");
    const verdict = validateEvidenceStructure(content);

    assert.equal(verdict.ok, true, verdict.message);
    assert.equal(verdict.sections.length, EVIDENCE_SECTIONS.length);

    for (const section of verdict.sections) {
      assert.ok(
        section.found >= section.required,
        `${section.name}: found ${section.found} < required ${section.required}`,
      );
      assert.equal(section.ok, true);
    }

    // The message must state real counts, not a vacuous "≥0" — this is the
    // acceptance criterion's "found 5/5 scenario rows".
    assert.match(verdict.message, /Scenario by scenario: found 5\/5/);
    assert.match(verdict.message, /evidence structure check: ok/);
  });

  it("fails loudly on the malformed fixture instead of passing vacuously", () => {
    const content = readFileSync(MALFORMED_FIXTURE, "utf8");
    const verdict = validateEvidenceStructure(content);

    assert.equal(verdict.ok, false, "a drifted document must not validate");
    assert.ok(
      verdict.sections.every((section) => section.found === 0),
      "renamed headings must report zero matches, not a silent pass",
    );
    // The failure names what was expected, not merely that something was wrong.
    assert.match(verdict.message, /evidence structure not recognized/);
    assert.match(verdict.message, /Instance under test/);
    assert.match(verdict.message, /Run output/);
    assert.match(verdict.message, /Scenario by scenario/);
  });

  it("is non-vacuous on a single drifted heading even when rows elsewhere match", () => {
    const content = readFileSync(resolve(ROOT, EVIDENCE_FILE), "utf8");
    // Rename only the Run output heading; its ✔ rows are now un-owned, so the
    // section must report 0 rather than borrow another section's matches.
    const drifted = content.replace("## Run output", "## Execution transcript");
    const verdict = validateEvidenceStructure(drifted);
    const runOutput = verdict.sections.find((section) => section.name === "Run output");

    assert.equal(verdict.ok, false);
    assert.equal(runOutput?.found, 0);
    assert.equal(runOutput?.required, 5);
  });
});

describe("check-enforcement-evidence CLI (non-vacuity)", () => {
  it("exits 0 against the real evidence file", () => {
    const result = runScript(["--check-structure"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /evidence structure check: ok/);
  });

  it("exits non-zero against the malformed fixture and names what was expected", () => {
    const result = runScript(["--check-structure", "--evidence", MALFORMED_FIXTURE]);

    assert.notEqual(result.status, 0, "malformed evidence must fail the gate");
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.match(combined, /evidence structure not recognized/);
    assert.match(combined, /Instance under test/);
    assert.match(combined, /Scenario by scenario/);
  });
});

/**
 * The escape hatch (issue #51): a maintainer-applied `skip-live-evidence` PR
 * label. The override decision is pinned here as pure functions; the *wired*
 * behaviour a PR experiences — the git diff, the `::warning`, the label and
 * timeline lookups in the workflow — is pinned end-to-end by
 * `npm run test:gate-self-test`, which builds a throwaway repository and runs
 * the real script over it.
 */
describe("skip-live-evidence escape hatch", () => {
  it("is not engaged when the label is absent", () => {
    const verdict = skipLiveEvidenceVerdict({ labels: ["bug", "documentation"] });

    assert.equal(verdict.present, false);
    assert.equal(verdict.appliedBy, null);
    assert.equal(verdict.appliedAt, null);
    assert.match(verdict.message, /not overridden/);
  });

  it("records who applied the label and when, and states that evidence is missing", () => {
    const verdict = skipLiveEvidenceVerdict({
      labels: [SKIP_LIVE_EVIDENCE_LABEL],
      actor: "maintainer",
      appliedAt: "2026-09-29T12:00:00Z",
    });

    assert.equal(verdict.present, true);
    assert.equal(verdict.appliedBy, "maintainer");
    assert.equal(verdict.appliedAt, "2026-09-29T12:00:00Z");
    assert.match(verdict.message, /maintainer at 2026-09-29T12:00:00Z/);
    assert.match(verdict.message, /NOT supplied/);
    assert.match(verdict.message, new RegExp(SKIP_LIVE_EVIDENCE_LABEL));
  });

  it("reports missing provenance rather than inventing it", () => {
    const cases: ReadonlyArray<{
      input: Parameters<typeof skipLiveEvidenceVerdict>[0];
      appliedBy: string | null;
      appliedAt: string | null;
      message: RegExp;
    }> = [
      {
        input: { labels: [SKIP_LIVE_EVIDENCE_LABEL] },
        appliedBy: null,
        appliedAt: null,
        message: /unknown actor at an unknown time/,
      },
      {
        input: { labels: [SKIP_LIVE_EVIDENCE_LABEL], actor: null, appliedAt: null },
        appliedBy: null,
        appliedAt: null,
        message: /unknown actor at an unknown time/,
      },
      {
        input: { labels: [SKIP_LIVE_EVIDENCE_LABEL], actor: "maintainer" },
        appliedBy: "maintainer",
        appliedAt: null,
        message: /maintainer at an unknown time/,
      },
      {
        input: { labels: [SKIP_LIVE_EVIDENCE_LABEL], appliedAt: "2026-09-29T12:00:00Z" },
        appliedBy: null,
        appliedAt: "2026-09-29T12:00:00Z",
        message: /unknown actor at 2026-09-29T12:00:00Z/,
      },
      {
        input: { labels: [SKIP_LIVE_EVIDENCE_LABEL], actor: "   ", appliedAt: "\t" },
        appliedBy: null,
        appliedAt: null,
        message: /unknown actor at an unknown time/,
      },
    ];

    for (const { input, appliedBy, appliedAt, message } of cases) {
      const verdict = skipLiveEvidenceVerdict(input);
      assert.equal(verdict.present, true);
      assert.equal(verdict.appliedBy, appliedBy, JSON.stringify(input));
      assert.equal(verdict.appliedAt, appliedAt, JSON.stringify(input));
      assert.match(verdict.message, message);
    }
  });

  it("an unrelated label with a similar name does not engage the hatch", () => {
    const verdict = skipLiveEvidenceVerdict({ labels: ["skip-live-evidence-later"] });
    assert.equal(verdict.present, false);
  });

  it("the override message never reads as evidence supplied", () => {
    const verdict = skipLiveEvidenceVerdict({
      labels: [SKIP_LIVE_EVIDENCE_LABEL],
      actor: "maintainer",
      appliedAt: "2026-09-29T12:00:00Z",
    });
    // The honest part of the hatch: it must never read as "evidence supplied".
    assert.doesNotMatch(verdict.message, /evidence file: updated/);
  });
});

/**
 * The CLI reads the env CI exports; these tests pin that contract, including
 * the fail-closed refusal to pass on a label whose provenance is missing.
 */
describe("skipLiveEvidenceOverride (CLI env contract)", () => {
  const labeledEnv = (): Record<string, string> => ({
    [SKIP_LABELS_ENV]: `${SKIP_LIVE_EVIDENCE_LABEL}\nbug`,
    [SKIP_ACTOR_ENV]: "maintainer",
    [SKIP_TIME_ENV]: "2026-09-29T12:00:00Z",
  });

  it("engages only on a present label with full provenance", () => {
    const override = skipLiveEvidenceOverride(labeledEnv());
    assert.equal(override.allow, true);
    assert.match(override.note, /OVERRIDDEN/);
    assert.match(override.note, /maintainer at 2026-09-29T12:00:00Z/);
  });

  it("does not engage when the label is absent", () => {
    const override = skipLiveEvidenceOverride({ [SKIP_LABELS_ENV]: "bug\ndocumentation" });
    assert.equal(override.allow, false);
    assert.match(override.note, /not overridden/);
  });

  it("does not engage on a present label with missing provenance", () => {
    for (const env of [
      { [SKIP_LABELS_ENV]: SKIP_LIVE_EVIDENCE_LABEL },
      { [SKIP_LABELS_ENV]: SKIP_LIVE_EVIDENCE_LABEL, [SKIP_ACTOR_ENV]: "maintainer" },
      { [SKIP_LABELS_ENV]: SKIP_LIVE_EVIDENCE_LABEL, [SKIP_TIME_ENV]: "2026-09-29T12:00:00Z" },
      { [SKIP_LABELS_ENV]: SKIP_LIVE_EVIDENCE_LABEL, [SKIP_ACTOR_ENV]: " ", [SKIP_TIME_ENV]: " " },
    ]) {
      const override = skipLiveEvidenceOverride(env);
      assert.equal(override.allow, false, `must refuse: ${JSON.stringify(env)}`);
      assert.match(override.note, /not engaged/);
    }
  });

  it("tolerates an empty or missing label list", () => {
    assert.equal(skipLiveEvidenceOverride({}).allow, false);
    assert.equal(skipLiveEvidenceOverride({ [SKIP_LABELS_ENV]: "" }).allow, false);
  });

  it("reads nothing from the ambient process environment", () => {
    // The tests run with no such vars exported, but pass the env explicitly so
    // a developer's exported value can never flip this either way.
    const override = skipLiveEvidenceOverride(labeledEnv());
    assert.equal(override.allow, true);
  });

  it("the failing evidence verdict names the escape hatch and the regeneration command", () => {
    const verdict = decideEvidenceRequirement(["src/preflight.ts", "README.md"]);
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, new RegExp(SKIP_LIVE_EVIDENCE_LABEL));
    assert.match(verdict.message, /npm run test:integration/);
    // It names the enforcement files that triggered the gate…
    assert.match(verdict.message, /src\/preflight\.ts/);
    // …and only those: an unrelated changed file is not accused.
    assert.doesNotMatch(verdict.message, /README\.md/);
  });

  it("decideEvidenceRequirement stays ok for enforcement-free diffs", () => {
    const verdict = decideEvidenceRequirement(["README.md", "src/reasons.ts"]);
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.enforcementTouched, []);
    assert.equal(verdict.evidenceTouched, false);
  });

  it("decideEvidenceRequirement stays ok when evidence moved with the code", () => {
    const verdict = decideEvidenceRequirement(["src/tx.ts", EVIDENCE_FILE]);
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.enforcementTouched, ["src/tx.ts"]);
    assert.equal(verdict.evidenceTouched, true);
  });

  it("decideEvidenceRequirement catches each enforcement file by name", () => {
    for (const file of ["src/tx.ts", "src/invoke.ts", "src/policy.ts", "src/preflight.ts"]) {
      const verdict = decideEvidenceRequirement([file]);
      assert.equal(verdict.ok, false, `${file} must require evidence`);
      assert.deepEqual(verdict.enforcementTouched, [file]);
    }
  });
});

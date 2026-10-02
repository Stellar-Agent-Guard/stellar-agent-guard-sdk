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
  EVIDENCE_FILE,
  EVIDENCE_SECTIONS,
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

#!/usr/bin/env node
/**
 * Required CI gate for pull requests: a change to the enforcement path must ship
 * fresh live-testnet evidence in the same PR.
 *
 * What this does NOT do: it never runs the live suite, never touches the network
 * and never reads a secret. It checks the *file list* of the PR, and it checks
 * that the evidence document still has the structure a reviewer expects. The
 * numbers in the evidence file are verified by the human run that records them
 * and by the scheduled `live-suite` workflow; this gate exists so that
 * *supplying* that evidence is not optional when the code it describes changes.
 *
 * ## Why the structure check exists (issue #65)
 *
 * A file-list check alone is vacuously green: it is satisfied by any touched
 * file, including one whose headings were renamed or whose tables were
 * reformatted until nothing parses. The structural check below is the difference
 * between "the evidence file changed" and "the evidence file still contains the
 * run output and five scenario rows". It asserts *minimum* match counts per
 * expected section — it reports `found 5/5 scenario rows`, not `found ≥0` — and
 * an unrecognised structure fails with a message naming what was expected,
 * rather than passing on zero matches. `tests/unit/check-enforcement-evidence.test.ts`
 * proves the non-vacuity against a deliberately malformed copy.
 *
 * The enforcement path is the code the guard's correctness depends on: how the
 * authorization entry is built and signed, how the call is driven through probe
 * → sign → enforced simulation, how the policy is encoded, and how the decision
 * is classified.
 *
 * Usage:
 *   node scripts/check-enforcement-evidence.ts <base-ref> [head-ref]
 *   node scripts/check-enforcement-evidence.ts --check-structure [--evidence <path>]
 *
 * ## The `skip-live-evidence` escape hatch (issue #51)
 *
 * A maintainer may apply the `skip-live-evidence` label to a PR that touches
 * the enforcement path without fresh evidence (a pure refactor, a maintainer
 * who will run the suite before merge, an emergency fix). The override is
 * deliberately a *label on the PR itself*, and the audit trail is GitHub's own
 * record of that label: the PR's timeline keeps a `labeled` event naming the
 * actor who applied it and the time it was applied, visible to anyone who can
 * see the PR. This script maintains no audit trail of its own — it can only
 * read what GitHub already records:
 *
 *   - CI (`.github/workflows/ci.yml`) reads the PR's label list and its
 *     timeline, and exports `SKIP_LABELS` (the label names),
 *     `SKIP_LABEL_ACTOR` (who applied the label) and `SKIP_LABEL_TIME` (when)
 *     for this script. A label removed before a later run stops suppressing
 *     the gate again, automatically.
 *   - The override engages only when the label is present **and** its
 *     actor/timestamp were supplied. A labeled run without provenance fails
 *     with a notice rather than passing silently.
 *   - A passing override is logged as a `::warning` stating that fresh
 *     evidence was NOT supplied and who logged the skip; the same message is
 *     what a failing PR sees as guidance.
 *
 * It is not silently bypassable: the override sits on the PR where a reviewer
 * sees it, the run log states it, and it is documented in CONTRIBUTING.md.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ENFORCEMENT_PATH_FILES = [
  "src/tx.ts",
  "src/invoke.ts",
  "src/policy.ts",
  "src/preflight.ts",
] as const;

/** The record of the live run a PR must refresh when it touches the path above. */
export const EVIDENCE_FILE = "tests/fixtures/integration-evidence.md";

export interface EvidenceVerdict {
  /** True when the PR satisfies the gate. */
  ok: boolean;
  /** Enforcement-path files this PR changed (empty when none). */
  enforcementTouched: string[];
  /** Whether the PR also touched the evidence file. */
  evidenceTouched: boolean;
  /** Operator-facing explanation, printed on both outcomes. */
  message: string;
}

/**
 * One section the evidence document must contain, and the rows it must contain
 * at least `minRows` of. The counts are *minimums*, deliberately: the goal is to
 * catch a document that has lost its structure (zero or a handful of matches),
 * not to fail on a legitimate new scenario being appended.
 */
export interface EvidenceSectionSpec {
  /** Human-facing name, used verbatim in the verdict message. */
  name: string;
  /** Matches the line that opens the section (e.g. `## Run output`). */
  heading: RegExp;
  /** Counted inside the section body; must be a per-occurrence pattern. */
  row: RegExp;
  /** Minimum number of `row` matches the section must contain. */
  minRows: number;
}

/**
 * The structure a valid evidence record is required to have. These are the
 * sections the live suite has produced since Phase 2 and that a reviewer reads
 * first, so their absence is drift rather than a formatting preference.
 */
export const EVIDENCE_SECTIONS: readonly EvidenceSectionSpec[] = [
  {
    name: "Instance under test",
    heading: /^##\s+Instance under test\s*$/m,
    // The guard row of the instance table — the one identity a reviewer checks.
    row: /^\|\s*Guard \(custom account\)\s*\|/m,
    minRows: 1,
  },
  {
    name: "Run output",
    heading: /^##\s+Run output\s*$/m,
    // One `✔` per passing live test. Five is the Phase 2 scenario count.
    row: /^\s*✔\s+\S/m,
    minRows: 5,
  },
  {
    name: "Scenario by scenario",
    heading: /^##\s+Scenario by scenario\s*$/m,
    // One `### N. …` per scenario narrative.
    row: /^###\s+\d+\.\s+\S/m,
    minRows: 5,
  },
];

export interface EvidenceSectionReport {
  name: string;
  /** Number of `row` matches found (0 when the heading is missing). */
  found: number;
  /** Minimum required by `EVIDENCE_SECTIONS`. */
  required: number;
  ok: boolean;
}

export interface EvidenceStructureVerdict {
  ok: boolean;
  sections: EvidenceSectionReport[];
  /** Operator-facing explanation: `found X/Y` per section, or what was expected. */
  message: string;
}

/**
 * Extract a section body: everything after its heading line up to the next
 * level-2 heading (or end of file). `###` sub-headings stay inside the body, so
 * a nested scenario still counts towards its parent section.
 */
function sectionBody(content: string, heading: RegExp): string | null {
  const match = heading.exec(content);
  if (!match || match.index === undefined) return null;
  const rest = content.slice(match.index + match[0].length);
  const next = /^##\s/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Count non-overlapping matches of `row` within `body`. */
function countRows(body: string, row: RegExp): number {
  const flags = row.flags.includes("g") ? row.flags : `${row.flags}g`;
  return [...body.matchAll(new RegExp(row.source, flags))].length;
}

/**
 * Pure structural validator, so the rule can be reasoned about (and tested)
 * without a git repository. It is non-vacuous by construction: a missing
 * heading reports `found 0`, which always fails a `minRows >= 1` expectation.
 */
export function validateEvidenceStructure(content: string): EvidenceStructureVerdict {
  const sections = EVIDENCE_SECTIONS.map((spec) => {
    const body = sectionBody(content, spec.heading);
    const found = body === null ? 0 : countRows(body, spec.row);
    return {
      name: spec.name,
      found,
      required: spec.minRows,
      ok: body !== null && found >= spec.minRows,
    };
  });

  const ok = sections.every((section) => section.ok);
  const summary = sections.map((section) => `${section.name}: found ${section.found}/${section.required}`).join(", ");
  if (ok) {
    return { ok, sections, message: `evidence structure check: ok (${summary})` };
  }

  return {
    ok,
    sections,
    message: [
      "evidence structure not recognized — the evidence document's shape has drifted.",
      `Expected, per section: ${sections
        .map((section) => `"${section.name}" ≥${section.required} matching row(s)`)
        .join("; ")}.`,
      `Found: ${summary}.`,
      "Restore the expected headings/rows (see tests/fixtures/integration-evidence.md) before this gate can pass.",
    ].join("\n"),
  };
}

/**
 * Pure decision function, so the rule can be reasoned about (and tested) without
 * a git repository.
 */
export function decideEvidenceRequirement(changedFiles: readonly string[]): EvidenceVerdict {
  const changed = new Set(changedFiles.map((file) => file.trim()).filter((file) => file.length > 0));
  const enforcementTouched = ENFORCEMENT_PATH_FILES.filter((file) => changed.has(file));
  const evidenceTouched = changed.has(EVIDENCE_FILE);

  if (enforcementTouched.length > 0 && !evidenceTouched) {
    return {
      ok: false,
      enforcementTouched,
      evidenceTouched,
      message: [
        "This PR touches the enforcement path but does not include fresh live-testnet evidence.",
        "Run `npm run test:integration` and update `tests/fixtures/integration-evidence.md` in this PR.",
        `Enforcement-path files changed: ${enforcementTouched.join(", ")}`,
        `If this PR genuinely cannot ship evidence, a maintainer can apply the "${SKIP_LIVE_EVIDENCE_LABEL}" label`,
        "to it (who/when are recorded on the label; see CONTRIBUTING.md). Nothing else bypasses this gate.",
      ].join("\n"),
    };
  }

  const enforcement = enforcementTouched.length > 0 ? enforcementTouched.join(", ") : "none";
  return {
    ok: true,
    enforcementTouched,
    evidenceTouched,
    message:
      `enforcement-path evidence gate: ok ` +
      `(enforcement path: ${enforcement}; evidence file: ${evidenceTouched ? "updated" : "untouched"})`,
  };
}

export interface SkipLiveEvidenceVerdict {
  /** Whether the label was found in the PR's label list. */
  present: boolean;
  /** Login that applied the label, from the PR's timeline (null if unknown). */
  appliedBy: string | null;
  /** ISO-8601 time the label was applied, from the PR's timeline (null if unknown). */
  appliedAt: string | null;
  /** Who/when as printed in logs, or an explanation that they were not supplied. */
  provenance: string | null;
  /** Full message printed on both outcomes. */
  message: string;
}

/**
 * How CI hands this script the PR's label state. `labels` comes from the PR
 * object itself (the authority on whether the label is present *right now*);
 * `actor`/`appliedAt` come from the PR's `labeled` timeline events (the
 * authority on who applied it and when). None of it is faked by the script:
 * the workflow derives all three from the GitHub API before invoking it.
 */
export interface SkipLiveEvidenceInput {
  labels: readonly string[];
  actor?: string | null;
  appliedAt?: string | null;
}

/** The `skip-live-evidence` label name and the env vars CI exports for it. */
export const SKIP_LIVE_EVIDENCE_LABEL = "skip-live-evidence";
export const SKIP_LABELS_ENV = "SKIP_LABELS";
export const SKIP_ACTOR_ENV = "SKIP_LABEL_ACTOR";
export const SKIP_TIME_ENV = "SKIP_LABEL_TIME";

/**
 * Pure override decision, testable without a git repository or the network:
 * when the label is present the gate can pass, but the message states plainly
 * that fresh evidence was *not* supplied and who logged the skip. Presence is
 * decided by `input.labels` alone; a missing actor/timestamp is reported as
 * missing provenance rather than invented.
 */
export function skipLiveEvidenceVerdict(input: SkipLiveEvidenceInput): SkipLiveEvidenceVerdict {
  const present = input.labels.includes(SKIP_LIVE_EVIDENCE_LABEL);
  if (!present) {
    return {
      present,
      appliedBy: null,
      appliedAt: null,
      provenance: null,
      message: `evidence gate: not overridden — no "${SKIP_LIVE_EVIDENCE_LABEL}" label on this PR`,
    };
  }

  const appliedBy = input.actor?.trim() || null;
  const appliedAt = input.appliedAt?.trim() || null;
  // Say exactly which half of the provenance is missing — "unknown" must never
  // overwrite a value this run actually received.
  const provenance =
    appliedBy && appliedAt
      ? `applied by ${appliedBy} at ${appliedAt}`
      : appliedBy
        ? `applied by ${appliedBy} at an unknown time (the label time was not supplied to this run)`
        : appliedAt
          ? `applied by an unknown actor at ${appliedAt} (the label actor was not supplied to this run)`
          : "applied by an unknown actor at an unknown time (no provenance was supplied to this run)";

  const message = [
    `evidence gate: OVERRIDDEN — the "${SKIP_LIVE_EVIDENCE_LABEL}" label is present on this PR`,
    `${provenance}. Fresh live-testnet evidence is NOT supplied for this change;`,
    "the label and its timeline event on the PR are the audit trail.",
  ].join(" ");

  return { present, appliedBy, appliedAt, provenance, message };
}

/**
 * The CLI's view of the escape hatch: read the env vars CI exports and decide
 * whether the override engages. It deliberately does NOT engage on label
 * presence alone — a labeled run without full provenance is refused (loudly,
 * not silently), so a half-configured workflow can never look like an honest
 * skip. `env` defaults to `process.env`; tests pass their own object.
 */
export function skipLiveEvidenceOverride(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { allow: boolean; note: string } {
  const labels = (env[SKIP_LABELS_ENV] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const verdict = skipLiveEvidenceVerdict({
    labels,
    actor: env[SKIP_ACTOR_ENV] ?? null,
    appliedAt: env[SKIP_TIME_ENV] ?? null,
  });

  if (!verdict.present) {
    return { allow: false, note: verdict.message };
  }
  if (!verdict.appliedBy || !verdict.appliedAt) {
    return {
      allow: false,
      note:
        `the "${SKIP_LIVE_EVIDENCE_LABEL}" label is present but its actor/timestamp were not supplied ` +
        "to this run; the override requires full provenance and is not engaged",
    };
  }
  return { allow: true, note: verdict.message };
}

function changedFilesBetween(base: string, head: string): string[] {
  const output = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function main(): void {
  const args = process.argv.slice(2);
  const structureOnly = args.includes("--check-structure");
  const evidenceFlag = args.indexOf("--evidence");
  const evidencePath =
    evidenceFlag >= 0 && args[evidenceFlag + 1] !== undefined
      ? args[evidenceFlag + 1]!
      : EVIDENCE_FILE;

  // The `--evidence <path>` value must not be mistaken for a positional ref.
  const positional = args.filter(
    (arg, index) => !arg.startsWith("--") && args[index - 1] !== "--evidence",
  );
  const [base, head = "HEAD"] = positional;

  // Structural validation runs unconditionally — it is what stops the gate going
  // vacuously green when the document's shape drifts. `--check-structure` stops
  // here; otherwise a base ref is required for the file-list check below.
  let content: string;
  try {
    content = readFileSync(evidencePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`could not read evidence file ${evidencePath}: ${detail}`);
    process.exit(2);
  }

  const structure = validateEvidenceStructure(content);
  console.log(structure.message);
  if (!structure.ok) {
    console.error(
      `::error title=evidence structure not recognized::${structure.message.split("\n")[0] ?? ""}`,
    );
    process.exit(1);
  }

  if (structureOnly) return;

  if (!base) {
    console.error("usage: node scripts/check-enforcement-evidence.ts <base-ref> [head-ref]");
    console.error("       node scripts/check-enforcement-evidence.ts --check-structure [--evidence <path>]");
    process.exit(2);
  }

  let changedFiles: string[];
  try {
    changedFiles = changedFilesBetween(base, head);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`could not diff ${base}...${head}: ${detail}`);
    process.exit(2);
  }

  const verdict = decideEvidenceRequirement(changedFiles);
  console.log(verdict.message);

  if (!verdict.ok) {
    // The escape hatch is the PR's own `skip-live-evidence` label (see the
    // header and CONTRIBUTING.md): a labeled PR bypasses the gate, and the
    // label's timeline event — who applied it, when, on which PR — is the
    // audit trail. The override is logged here so the run itself records that
    // fresh evidence was NOT supplied; a bypass only the merge button knows
    // about would be a silent one, which the issue explicitly rules out.
    const override = skipLiveEvidenceOverride();
    if (override.allow) {
      console.log(
        `::warning title=live evidence skipped::${verdict.message.split("\n")[0] ?? ""} ${override.note} ` +
          `To supply evidence instead, run \`npm run test:integration\` and update \`${EVIDENCE_FILE}\` in this PR.`,
      );
      process.exit(0);
    }
    // Label present but unprovenanced, or label absent: say which before the
    // failure annotation, so a maintainer reading the run knows the difference.
    console.error(`::notice title=evidence gate override not engaged::${override.note}`);
    // A GitHub Actions annotation makes the failure legible in the run summary,
    // where an engineer will actually look first.
    console.error(`::error title=enforcement-path evidence required::${verdict.message.split("\n")[0] ?? ""}`);
    process.exit(1);
  }
}

/**
 * Run only when this module is the CLI entry point, so tests can import the pure
 * functions above without the argument parsing (and its `process.exit`) running.
 */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) main();

#!/usr/bin/env node
/**
 * Required CI gate for pull requests: a change to the enforcement path must ship
 * fresh live-testnet evidence in the same PR.
 *
 * What this does NOT do: it never runs the live suite, never touches the network
 * and never reads a secret. It checks the *file list* of the PR. The numbers in
 * the evidence file are verified by the human run that records them and by the
 * scheduled `live-suite` workflow; this gate exists so that *supplying* that
 * evidence is not optional when the code it describes changes.
 *
 * The enforcement path is the code the guard's correctness depends on: how the
 * authorization entry is built and signed, how the call is driven through probe
 * → sign → enforced simulation, how the policy is encoded, and how the decision
 * is classified.
 *
 * Usage: node scripts/check-enforcement-evidence.ts <base-ref> [head-ref]
 *   e.g. node scripts/check-enforcement-evidence.ts origin/main HEAD
 */
import { execFileSync } from "node:child_process";

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
  const [base, head = "HEAD"] = process.argv.slice(2);
  if (!base) {
    console.error("usage: node scripts/check-enforcement-evidence.ts <base-ref> [head-ref]");
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
    // A GitHub Actions annotation makes the failure legible in the run summary,
    // where an engineer will actually look first.
    console.error(`::error title=enforcement-path evidence required::${verdict.message.split("\n")[0] ?? ""}`);
    process.exit(1);
  }
}

main();

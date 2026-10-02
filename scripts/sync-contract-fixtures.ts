/**
 * sync-contract-fixtures.ts
 *
 * Regenerates the vendored contract vocabulary fixtures file from the canonical
 * contract reason definitions and event schemas.
 *
 * Provenance:
 *  - Source: stellar-agent-guard-contracts (src/types.rs)
 *  - Commit: d067a174733abeb93f1d065bbed5c6d267042b5d
 *
 * Usage:
 *   node scripts/sync-contract-fixtures.ts
 *   npm run sync:fixtures
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { xdr } from "@stellar/stellar-sdk";
import { GUARD_REASON_CODES } from "../src/reasons.ts";

const OUTPUT_PATH = resolve(process.cwd(), "tests/fixtures/contract-fixtures.json");
const CONTRACTS_COMMIT_SHA = "d067a174733abeb93f1d065bbed5c6d267042b5d";

export interface GoldenFixtureEntry {
  name: string;
  result: "allowed" | "blocked";
  reason: string;
  code: number | null;
  stream: "ledger" | "diagnostic";
  topics: string[];
  topicsXdr: string[];
}

export interface ContractFixturesFile {
  _provenance: {
    sourceRepo: string;
    sourceCommit: string;
    sourceFile: string;
    refreshCommand: string;
    updatedAt: string;
    description: string;
  };
  entries: GoldenFixtureEntry[];
}

export function generateContractFixtures(): ContractFixturesFile {
  const entries: GoldenFixtureEntry[] = [];

  // 1. Allowed outcome fixture (observed on ledger stream)
  entries.push({
    name: "allowed",
    result: "allowed",
    reason: "",
    code: null,
    stream: "ledger",
    topics: ["event_auth_checked", "allowed", ""],
    topicsXdr: [
      xdr.ScVal.scvSymbol("event_auth_checked").toXDR("base64"),
      xdr.ScVal.scvSymbol("allowed").toXDR("base64"),
      xdr.ScVal.scvSymbol("").toXDR("base64"),
    ],
  });

  // 2. Blocked outcome fixtures for every reason code in contract Error enum
  for (const [reason, code] of Object.entries(GUARD_REASON_CODES)) {
    entries.push({
      name: `blocked_${reason}`,
      result: "blocked",
      reason,
      code,
      stream: "diagnostic",
      topics: ["event_auth_checked", "blocked", reason],
      topicsXdr: [
        xdr.ScVal.scvSymbol("event_auth_checked").toXDR("base64"),
        xdr.ScVal.scvSymbol("blocked").toXDR("base64"),
        xdr.ScVal.scvSymbol(reason).toXDR("base64"),
      ],
    });
  }

  return {
    _provenance: {
      sourceRepo: "Stellar-Agent-Guard/stellar-agent-guard-contracts",
      sourceCommit: CONTRACTS_COMMIT_SHA,
      sourceFile: "src/types.rs",
      refreshCommand: "npm run sync:fixtures",
      updatedAt: "2026-09-26T14:00:00.000Z",
      description:
        "Golden JSON fixtures for every auth_checked outcome and reason symbol emitted by the smart account contract.",
    },
    entries,
  };
}

export function writeContractFixtures(): void {
  const fixtures = generateContractFixtures();
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(fixtures, null, 2)}\n`, "utf8");
  console.log(`[sync:fixtures] Wrote ${fixtures.entries.length} golden fixtures to ${OUTPUT_PATH}`);
}

// When run directly as a script
if (process.argv[1]?.endsWith("sync-contract-fixtures.ts")) {
  writeContractFixtures();
}

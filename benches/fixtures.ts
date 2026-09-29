/**
 * Fixture builders for the decode-path benchmarks (issue #89).
 *
 * The benchmarks measure the CPU that runs on *every* check after the RPC round
 * trip: encoding a policy with `policyToScVal`, decoding a `CheckResult`, and
 * decoding guard events out of simulation diagnostics. Embedded runtimes (browser
 * agent UIs, edge) pay that cost per call, so it is worth knowing its size.
 *
 * Everything here is deterministic — the same input every run — so a baseline
 * recorded in `docs/benchmarks.md` can be compared against later. Addresses are
 * derived from a hash rather than `Keypair.random()`, so fixture construction
 * never becomes the thing being measured.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import type { PolicyConfig } from "../src/policy.ts";

/** The 8192-entry allowlist the issue names as the contract-side worst case. */
export const LARGE_POLICY_ENTRIES = 8192;

const CONTRACT_FIXTURE_PATH = resolve(process.cwd(), "tests/fixtures/contract-fixtures.json");

interface ContractFixtureEntry {
  name: string;
  result: "allowed" | "blocked";
  reason: string;
  stream: "ledger" | "diagnostic";
  topics: string[];
  topicsXdr: string[];
}

interface ContractFixtures {
  entries: ContractFixtureEntry[];
}

/** A deterministic, valid recipient address for slot `index`. */
function recipientFor(index: number): string {
  const seed = createHash("sha256").update(`bench-recipient-${index}`).digest();
  return Keypair.fromRawEd25519Seed(seed).publicKey();
}

/**
 * A policy with `entryCount` allowlisted recipients — the shape that makes
 * `policyToScVal` walk the largest Vec it can be handed.
 */
export function largePolicy(entryCount: number = LARGE_POLICY_ENTRIES): PolicyConfig {
  const recipients: string[] = [];
  for (let index = 0; index < entryCount; index += 1) recipients.push(recipientFor(index));
  return {
    per_tx_cap: 1_000_000n,
    window_secs: 60n,
    window_cap: 10_000_000n,
    assets: ["CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"],
    protocols: [],
    recipients,
    allow_any_recipient: false,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: 0n,
  };
}

export interface VerdictPayload {
  name: string;
  /** The raw `CheckResult` value a caller would hand to `decodeCheckResult`. */
  raw: unknown;
}

function loadContractFixtures(): ContractFixtures {
  return JSON.parse(readFileSync(CONTRACT_FIXTURE_PATH, "utf8")) as ContractFixtures;
}

/**
 * One `decodeCheckResult` input per committed outcome: the unit `Allowed` string
 * and one `Blocked(<reason>)` object for every reason symbol the contract can
 * emit. Sourced from the golden fixture rather than hand-written so the decode
 * benchmark cannot drift from the vocabulary the SDK actually supports.
 */
export function verdictPayloads(): VerdictPayload[] {
  return loadContractFixtures().entries.map((entry) => ({
    name: entry.name,
    raw: entry.result === "allowed" ? "Allowed" : { Blocked: entry.reason },
  }));
}

/**
 * Raw simulation diagnostic events built from the fixture's own base64 `ScVal`
 * topics — the same XDR a live `simulateTransaction` failure carries. Each is
 * wrapped in the `{ event: { body: { v0: { topics } } } }` envelope
 * `guardEventsFromDiagnostics` accepts.
 */
export function diagnosticEvents(): unknown[] {
  return loadContractFixtures().entries.map((entry) => ({
    event: { body: { v0: { topics: entry.topicsXdr } } },
  }));
}

/** The guard the fixtures were recorded against, for a realistic decode context. */
export const FIXTURE_GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

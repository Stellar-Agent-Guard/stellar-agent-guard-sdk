/**
 * Fixture-driven tests: decode REAL live-RPC payloads through the SDK's own
 * production parsers.
 *
 * The rest of the suite mocks RPC with hand-written objects. Those mocks encode
 * what a test author believes the network returns, so when
 * `@stellar/stellar-sdk` renames or reshapes a field the mocks stay green while
 * production breaks — precisely the drift a test suite should catch. These tests
 * instead load payloads recorded from the live Phase 2 instance
 * (`scripts/capture-rpc-fixtures.ts`) and run them through `parseRawEvents` /
 * `parseRawSimulation` — the same parse path the production clients use — before
 * asserting on the SDK's public decode functions.
 *
 * Provenance for every fixture is asserted here too, so a captured file cannot
 * be quietly swapped for a hand-written object.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { rpc } from "@stellar/stellar-sdk";
import { parseRawEvents, parseRawSimulation } from "@stellar/stellar-sdk/rpc";
import {
  GuardTelemetryListener,
  guardEventsFromDiagnostics,
  type GuardTelemetryGap,
} from "../../src/telemetry.ts";
import { unsafeContractAddress } from "../../src/policy.ts";

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/rpc");

interface FixtureHeader {
  source: string;
  method: string;
  contractId: string | null;
  network: string;
  rpcUrl: string;
  capturedAt: string;
  stellarSdkVersion: string;
  note: string;
}

type LoadedFixture<T> = FixtureHeader & { response: T };

function loadFixture<T>(name: string): LoadedFixture<T> {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf8")) as LoadedFixture<T>;
}

const FIXTURE_NAMES = [
  "get-events-guard-page.json",
  "simulate-success-status.json",
  "simulate-error-wrong-agent.json",
] as const;

/** The guard the fixtures were recorded against, read from a fixture itself. */
const GUARD =
  loadFixture<unknown>("get-events-guard-page.json").contractId ??
  unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");

/** A fake `rpc.Server` returning a fixture's already-parsed response unchanged. */
function fixtureServer(response: unknown) {
  return {
    getLatestLedger: async () => ({
      sequence: (response as { latestLedger?: number }).latestLedger ?? 1,
    }),
    getEvents: async () => response,
  };
}

describe("recorded RPC fixtures: provenance header", () => {
  for (const name of FIXTURE_NAMES) {
    it(`records where ${name} came from, so it cannot be hand-written by accident`, () => {
      const fixture = loadFixture(name);
      for (const key of [
        "source",
        "method",
        "contractId",
        "network",
        "rpcUrl",
        "capturedAt",
        "stellarSdkVersion",
        "note",
      ] as const) {
        assert.ok(fixture[key], `${name} is missing provenance field '${key}'`);
      }
      assert.equal(fixture.network, "testnet");
      assert.match(fixture.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(fixture.stellarSdkVersion, /^\d+\./);
      assert.ok(fixture.response, `${name} carries no response payload`);
    });
  }
});

describe("recorded getEvents page", () => {
  it("parses through the listener's production path and exposes the retention window", async () => {
    const fixture = loadFixture<rpc.Api.RawGetEventsResponse>("get-events-guard-page.json");
    const parsed = parseRawEvents(fixture.response);

    // The retention window is what the gap detector (issue #86) relies on; a
    // field rename here is exactly the drift this fixture exists to catch.
    assert.equal(typeof parsed.oldestLedger, "number");
    assert.equal(typeof parsed.latestLedger, "number");
    assert.ok(parsed.latestLedger >= parsed.oldestLedger);
    assert.equal(typeof parsed.cursor, "string");

    const listener = new GuardTelemetryListener({
      server: fixtureServer(parsed) as never,
      guard: GUARD,
    });
    const page = await listener.poll({ startLedger: parsed.oldestLedger });
    assert.equal(page.oldestLedger, parsed.oldestLedger);
    assert.equal(page.latestLedger, parsed.latestLedger);
    assert.equal(page.events.length, parsed.events.length);
    for (const event of page.events) {
      assert.ok(event.id.length > 0, "decoded events carry ids");
    }
  });

  it("drives gap detection from the recorded retention window", async () => {
    const fixture = loadFixture<rpc.Api.RawGetEventsResponse>("get-events-guard-page.json");
    const parsed = parseRawEvents(fixture.response);
    const listener = new GuardTelemetryListener({
      server: fixtureServer(parsed) as never,
      guard: GUARD,
    });

    const gaps: GuardTelemetryGap[] = [];
    const controller = new AbortController();
    const startLedger = Math.max(1, parsed.oldestLedger - 25);
    for await (const _batch of listener.watch({
      startLedger,
      onGap: (gap) => gaps.push(gap),
      sleep: async () => controller.abort(),
      signal: controller.signal,
    })) {
      // Drain: the assertion is about the notice, not the (empty) stream.
    }

    assert.equal(gaps.length, 1);
    assert.deepEqual(gaps[0], {
      fromLedger: startLedger,
      toLedger: parsed.oldestLedger - 1,
      reason: "history_pruned",
      retainedFromLedger: parsed.oldestLedger,
      retainedToLedger: parsed.latestLedger,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*        Offline contract checks for the stellar-sdk shapes we consume       */
/* -------------------------------------------------------------------------- */

/*
 * Only the response shapes this repository actually reads are pinned:
 * `getLatestLedger`, `getEvents`, `simulateTransaction`, `sendTransaction`,
 * `getTransaction`, and `getTransactions`.
 *
 * Half of the check is compile-time. `npm run typecheck` evaluates these
 * aliases, so an SDK upgrade that renames a consumed field, turns a required
 * field optional (or an optional one required), or starts declaring a field the
 * decoder relies on being absent fails before any test runs. The aliases exist
 * only in the type system, which keeps the runtime suite entirely offline.
 */
type Expect<T extends true> = T;
// `T extends Record<K, T[K]>` fails for an optional property under
// `exactOptionalPropertyTypes`, which is exactly the required/optional split
// this file needs to pin. (The more common `{} extends Pick<T, K>` spelling is
// rejected by the repo's lint rules for using the empty-object type.)
type IsOptional<T, K extends keyof T> = T extends Record<K, T[K]> ? false : true;
type IsRequired<T, K extends keyof T> = IsOptional<T, K> extends true ? false : true;
type DoesNotDeclare<T, K extends PropertyKey> = K extends keyof T ? false : true;
type DeclaresAll<T, K extends PropertyKey> = K extends keyof T ? true : false;

// getLatestLedger — only `sequence` is consumed.
type _LatestLedgerSequence = Expect<IsRequired<rpc.Api.GetLatestLedgerResponse, "sequence">>;

// getEvents — the retention window, cursor, and event list are consumed.
type _EventsPageRetention = Expect<
  IsRequired<
    rpc.Api.RawGetEventsResponse,
    | "events"
    | "cursor"
    | "latestLedger"
    | "oldestLedger"
    | "latestLedgerCloseTime"
    | "oldestLedgerCloseTime"
  >
>;
type _ParsedEventsPageRetention = Expect<
  IsRequired<rpc.Api.GetEventsResponse, "events" | "cursor" | "oldestLedger" | "latestLedger">
>;
type _RawEventContractId = Expect<IsRequired<rpc.Api.RawEventResponse, "contractId">>;
type _RawEventTopicOptional = Expect<IsOptional<rpc.Api.RawEventResponse, "topic">>;
type _ParsedEventValue = Expect<IsRequired<rpc.Api.EventResponse, "topic" | "value">>;
type _ParsedEventContractIdOptional = Expect<IsOptional<rpc.Api.EventResponse, "contractId">>;

// simulateTransaction — success carries the footprint; failure carries `error`
// and must never be read as if it had a footprint.
type _RawSimulationLedger = Expect<
  IsRequired<rpc.Api.RawSimulateTransactionResponse, "latestLedger">
>;
type _RawSimulationFootprintOptional = Expect<
  IsOptional<rpc.Api.RawSimulateTransactionResponse, "transactionData" | "minResourceFee">
>;
type _RawSimulationErrorOptional = Expect<
  IsOptional<rpc.Api.RawSimulateTransactionResponse, "error">
>;
type _SimulationSuccessFootprint = Expect<
  IsRequired<rpc.Api.SimulateTransactionSuccessResponse, "transactionData" | "minResourceFee">
>;
type _SimulationSuccessHasNoError = Expect<
  DoesNotDeclare<rpc.Api.SimulateTransactionSuccessResponse, "error">
>;
type _SimulationErrorReason = Expect<IsRequired<rpc.Api.SimulateTransactionErrorResponse, "error">>;
type _SimulationErrorHasNoFootprint = Expect<
  DoesNotDeclare<rpc.Api.SimulateTransactionErrorResponse, "transactionData">
>;
type _SimulationErrorHasNoFee = Expect<
  DoesNotDeclare<rpc.Api.SimulateTransactionErrorResponse, "minResourceFee">
>;

// sendTransaction / getTransaction — the hash, status, ledger and diagnostic
// fields `tx.ts` and `telemetry.ts` read.
type _SendTransaction = Expect<
  IsRequired<rpc.Api.SendTransactionResponse, "status" | "hash" | "latestLedger">
>;
type _SendTransactionErrorOptional = Expect<
  IsOptional<rpc.Api.SendTransactionResponse, "errorResult">
>;
type _FailedTransaction = Expect<
  IsRequired<
    rpc.Api.GetFailedTransactionResponse,
    "status" | "txHash" | "ledger" | "createdAt" | "resultXdr"
  >
>;
type _FailedTransactionDiagnosticsOptional = Expect<
  IsOptional<rpc.Api.GetFailedTransactionResponse, "diagnosticEventsXdr">
>;
type _MissingTransactionHasNoLedger = Expect<
  DoesNotDeclare<rpc.Api.GetMissingTransactionResponse, "ledger">
>;

// getTransactions — telemetry reads FAILED rows and the page cursor.
type _FailedTransactionRow = Expect<
  IsRequired<rpc.Api.TransactionInfo, "status" | "txHash" | "ledger">
>;
type _FailedTransactionRowDiagnosticsOptional = Expect<
  IsOptional<rpc.Api.TransactionInfo, "diagnosticEventsXdr">
>;
type _TransactionsPage = Expect<
  IsRequired<rpc.Api.GetTransactionsResponse, "transactions" | "cursor">
>;

/**
 * The field contract for each committed RPC capture.
 *
 * `fields` is the *exact* top-level key set the repository expects from that
 * payload, with its primitive shape. Adding or removing a key during a
 * recapture fails `npm test` until this inventory and
 * `tests/fixtures/rpc/README.md` are updated deliberately — the capture script
 * is allowed to change what it writes, but not silently.
 */
interface FixtureShape {
  /** The SDK type the payload is decoded as, for reviewers. */
  decodedAs: string;
  fields: Readonly<Record<string, "string" | "number" | "array">>;
  /** Fields whose *absence* carries meaning for this payload. */
  absent: readonly string[];
}

const FIXTURE_SHAPES = {
  "get-events-guard-page.json": {
    decodedAs: "rpc.Api.RawGetEventsResponse",
    fields: {
      events: "array",
      cursor: "string",
      latestLedger: "number",
      oldestLedger: "number",
      latestLedgerCloseTime: "string",
      oldestLedgerCloseTime: "string",
    },
    absent: [],
  },
  "simulate-success-status.json": {
    decodedAs: "rpc.Api.RawSimulateTransactionResponse (success arm)",
    fields: {
      transactionData: "string",
      events: "array",
      minResourceFee: "string",
      results: "array",
      stateChanges: "array",
      latestLedger: "number",
    },
    absent: ["error", "restorePreamble"],
  },
  "simulate-error-wrong-agent.json": {
    decodedAs: "rpc.Api.RawSimulateTransactionResponse (error arm)",
    fields: {
      error: "string",
      events: "array",
      latestLedger: "number",
    },
    absent: ["transactionData", "minResourceFee", "results", "stateChanges", "restorePreamble"],
  },
} as const satisfies Readonly<Record<(typeof FIXTURE_NAMES)[number], FixtureShape>>;

// The runtime inventory and the SDK types must name the same fields: a fixture
// field the installed SDK no longer declares is drift, not a new capability.
type _EventsFixtureFields = Expect<
  DeclaresAll<
    rpc.Api.RawGetEventsResponse,
    keyof (typeof FIXTURE_SHAPES)["get-events-guard-page.json"]["fields"]
  >
>;
type _SimulationSuccessFixtureFields = Expect<
  DeclaresAll<
    rpc.Api.RawSimulateTransactionResponse,
    keyof (typeof FIXTURE_SHAPES)["simulate-success-status.json"]["fields"]
  >
>;
type _SimulationErrorFixtureFields = Expect<
  DeclaresAll<
    rpc.Api.RawSimulateTransactionResponse,
    keyof (typeof FIXTURE_SHAPES)["simulate-error-wrong-agent.json"]["fields"]
  >
>;

function matchesFieldKind(value: unknown, kind: "string" | "number" | "array"): boolean {
  if (kind === "array") return Array.isArray(value);
  if (kind === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "string";
}

describe("recorded RPC fixtures: consumed stellar-sdk shapes", () => {
  it("inventories exactly the committed captures", () => {
    assert.deepEqual(Object.keys(FIXTURE_SHAPES).sort(), [...FIXTURE_NAMES].sort());
  });

  for (const name of FIXTURE_NAMES) {
    it(`keeps ${name} on the field contract the SDK parses`, () => {
      const fixture = loadFixture<Record<string, unknown>>(name);
      const shape = FIXTURE_SHAPES[name];

      assert.deepEqual(
        Object.keys(fixture.response).sort(),
        Object.keys(shape.fields).sort(),
        `${name} changed shape; recapture it and update FIXTURE_SHAPES plus ` +
          "tests/fixtures/rpc/README.md intentionally",
      );

      for (const [field, kind] of Object.entries(shape.fields)) {
        assert.ok(
          matchesFieldKind(fixture.response[field], kind),
          `${name}.${field} must be a ${kind}`,
        );
      }
      for (const field of shape.absent) {
        assert.equal(
          Object.hasOwn(fixture.response, field),
          false,
          `${name} must not carry '${field}'`,
        );
      }
    });
  }

  it("preserves success presence and error absence through the parse path", () => {
    const fixture = loadFixture<rpc.Api.RawSimulateTransactionResponse>(
      "simulate-success-status.json",
    );
    const parsed = parseRawSimulation(fixture.response);

    assert.equal(rpc.Api.isSimulationError(parsed), false);
    assert.equal(Object.hasOwn(parsed, "transactionData"), true);
    assert.equal(Object.hasOwn(parsed, "minResourceFee"), true);
    assert.equal(Object.hasOwn(parsed, "error"), false);
  });

  it("preserves error presence and footprint absence through the parse path", () => {
    const fixture = loadFixture<rpc.Api.RawSimulateTransactionResponse>(
      "simulate-error-wrong-agent.json",
    );
    const parsed = parseRawSimulation(fixture.response);

    assert.equal(rpc.Api.isSimulationError(parsed), true);
    assert.equal(Object.hasOwn(parsed, "error"), true);
    assert.equal(Object.hasOwn(parsed, "transactionData"), false);
    assert.equal(Object.hasOwn(parsed, "minResourceFee"), false);
  });

  it("preserves the events retention window through the parse path", () => {
    const fixture = loadFixture<rpc.Api.RawGetEventsResponse>("get-events-guard-page.json");
    const parsed = parseRawEvents(fixture.response);

    for (const field of [
      "events",
      "cursor",
      "latestLedger",
      "oldestLedger",
      "latestLedgerCloseTime",
      "oldestLedgerCloseTime",
    ] as const) {
      assert.equal(Object.hasOwn(parsed, field), true, `parsed getEvents page lost '${field}'`);
    }
  });
});

describe("recorded simulateTransaction payloads", () => {
  it("parses the recorded success with a real footprint and resource fee", () => {
    const fixture = loadFixture<rpc.Api.RawSimulateTransactionResponse>(
      "simulate-success-status.json",
    );
    const parsed = parseRawSimulation(fixture.response);
    assert.equal(rpc.Api.isSimulationError(parsed), false);

    const success = parsed as rpc.Api.SimulateTransactionSuccessResponse;
    assert.ok(success.transactionData, "footprint-bearing transactionData must parse");
    assert.match(String(success.minResourceFee), /^\d+$/, "resource fee is a decimal string");
  });

  it("never fabricates a guard event from a real host-failure diagnostic payload", () => {
    const fixture = loadFixture<rpc.Api.RawSimulateTransactionResponse>(
      "simulate-error-wrong-agent.json",
    );
    const parsed = parseRawSimulation(fixture.response);
    assert.equal(rpc.Api.isSimulationError(parsed), true);

    const error = parsed as rpc.Api.SimulateTransactionErrorResponse;
    assert.match(String(error.error), /HostError|Error\(/);

    // The recorded failure carries real host diagnostics, and not one of them may
    // be read as a guard decision: a host trap is not a policy refusal.
    const events = (error as unknown as { events?: unknown[] }).events ?? [];
    assert.ok(events.length > 0, "the recorded failure carries diagnostics");
    assert.deepEqual(
      guardEventsFromDiagnostics(events, GUARD),
      [],
      "host failures must not decode to guard events",
    );
  });
});

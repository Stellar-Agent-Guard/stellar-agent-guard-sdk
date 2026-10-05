/**
 * Tests for the failed-transaction diagnostics stream (issue #58).
 *
 * Fixture provenance, stated plainly: these diagnostic events are **typed
 * reconstructions** built from the public `xdr.DiagnosticEvent` constructors of
 * the pinned stellar-sdk 17.0.1, in the shape `GetFailedTransactionResponse`
 * documents. They are not verbatim live captures. The *topic vocabulary* they
 * carry (`event_auth_checked, blocked, <reason>`) is the one captured from the
 * live chain and recorded in `docs/event-schema.md`; the spike evidence that a
 * FAILED `getTransaction`/`getTransactions` response publicly carries
 * `diagnosticEventsXdr` is in that document too. Transaction envelopes are real
 * ones built with the SDK's own `TransactionBuilder`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
  StrKey,
} from "@stellar/stellar-sdk";
import {
  describeGuardEvent,
  guardEventsFromFailedTransaction,
  GuardTelemetryListener,
  type GuardEvent,
} from "../../src/telemetry.ts";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const HASH = "ab".repeat(32);
const OTHER = StrKey.encodeContract(Keypair.random().rawPublicKey());

/** The guard contract's id as the raw 32 bytes the XDR form carries. */
const GUARD_BYTES = Buffer.from(StrKey.decodeContract(GUARD));

/** A diagnostic event emitted by `contract`, or by no contract when null. */
function diagnostic(contract: Buffer | null, topics: string[]): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId: contract === null ? null : new xdr.ContractId(contract),
      type: xdr.ContractEventType.contract,
      body: xdr.ContractEventBody.v0(
        new xdr.ContractEventV0({
          topics: topics.map((topic) => xdr.ScVal.scvSymbol(topic)),
          data: xdr.ScVal.scvMap([]),
        }),
      ),
    }),
  });
}

const blockedAuthChecked = () => diagnostic(GUARD_BYTES, ["event_auth_checked", "blocked", "per_tx_cap_exceeded"]);
const allowedAuthChecked = () => diagnostic(GUARD_BYTES, ["event_auth_checked", "allowed", ""]);
const hostNoise = () => diagnostic(null, ["fn_call", "transfer"]);
const otherContractAuthChecked = () =>
  diagnostic(Buffer.from(StrKey.decodeContract(OTHER)), ["event_auth_checked", "blocked", "recipient_not_allowed"]);

/** A real envelope whose single operation invokes `contract`. */
function invokeEnvelope(contract: string): xdr.TransactionEnvelope {
  const source = Keypair.random();
  return new TransactionBuilder(new Account(source.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({ contract, function: "transfer", args: [] }),
    )
    .setTimeout(30)
    .build()
    .toEnvelope();
}

/** Minimal FAILED-transaction info in the shape the scanner actually reads. */
function failedTx(
  overrides: Partial<{
    txHash: string;
    ledger: number;
    diagnosticEventsXdr: xdr.DiagnosticEvent[];
    envelopeXdr: xdr.TransactionEnvelope;
    status: rpc.Api.GetTransactionStatus;
  }> = {},
) {
  return {
    status: rpc.Api.GetTransactionStatus.FAILED,
    txHash: HASH,
    ledger: 4_675_000,
    createdAt: 1_789_400_000,
    applicationOrder: 1,
    feeBump: false,
    envelopeXdr: invokeEnvelope(GUARD),
    resultXdr: null,
    resultMetaXdr: null,
    events: { transactionEventsXdr: [], contractEventsXdr: [] },
    ...overrides,
  };
}

interface FakePage {
  transactions: unknown[];
  latestLedger: number;
  cursor: string;
}

/**
 * Mock RPC in the repo's harness style (structural server behind the same
 * single cast `tests/unit/preflight.test.ts` uses). Only the fields the
 * listener reads are populated; `resultXdr`/`resultMetaXdr` stay null because
 * the failed-tx scanner never dereferences them. Pages repeat their last entry
 * once exhausted, like an RPC whose head has not advanced.
 */
function harness(options: {
  txPages: FakePage[];
  eventsPages?: { events: unknown[]; cursor: string; latestLedger: number }[];
  latestLedger?: number;
  failGetTransactions?: boolean;
  failedTx?: boolean;
}) {
  const requests = {
    getEvents: [] as Record<string, unknown>[],
    getTransactions: [] as Record<string, unknown>[],
  };
  let eventsPage = 0;
  let txPage = 0;
  const pages = options.eventsPages ?? [{ events: [], cursor: "events-cursor-0", latestLedger: 501 }];
  const server = {
    getLatestLedger: async () => ({ sequence: options.latestLedger ?? 500 }),
    getEvents: async (request: Record<string, unknown>) => {
      requests.getEvents.push(request);
      return pages[Math.min(eventsPage++, pages.length - 1)];
    },
    getTransactions: async (request: Record<string, unknown>) => {
      requests.getTransactions.push(request);
      if (options.failGetTransactions) throw new Error("rpc unavailable");
      return options.txPages[Math.min(txPage++, options.txPages.length - 1)];
    },
  } as unknown as rpc.Server;
  const listener = new GuardTelemetryListener({
    server,
    guard: GUARD,
    ...(options.failedTx === undefined ? {} : { failedTx: options.failedTx }),
  });
  return { listener, requests };
}

/**
 * Drive `watch` through exactly `polls` committed-stream polls, then abort.
 *
 * Batch counts cannot be used as the stop condition: a poll whose combined
 * batch is empty (nothing new on either stream) yields nothing by design, so a
 * consumer waiting on a fixed number of batches would hang. Counting polls on
 * the mock is deterministic instead; assertions are made on the *filtered*
 * events, whose counts the dedup and page behavior pin down.
 */
async function collectAfterPolls(
  listener: GuardTelemetryListener,
  requests: { getEvents: unknown[] },
  polls: number,
): Promise<GuardEvent[]> {
  const out: GuardEvent[][] = [];
  const controller = new AbortController();
  const stop = setInterval(() => {
    if (requests.getEvents.length >= polls) controller.abort();
  }, 1);
  try {
    for await (const page of listener.watch({ pollIntervalMs: 0, signal: controller.signal })) {
      out.push(page);
    }
  } finally {
    clearInterval(stop);
  }
  return out.flat();
}

describe("guardEventsFromFailedTransaction", () => {
  it("decodes a guard auth_checked diagnostic into a failed_tx GuardEvent", () => {
    const events = guardEventsFromFailedTransaction(
      {
        txHash: HASH,
        ledger: 4_675_000,
        createdAt: 1_789_400_000,
        diagnosticEventsXdr: [blockedAuthChecked(), hostNoise()],
      },
      GUARD,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "auth_checked");
    assert.equal(events[0]!.stream, "failed_tx");
    assert.equal(events[0]!.source, "diagnostic");
    assert.equal(events[0]!.decision?.result, "blocked");
    assert.equal(events[0]!.decision?.reason, "per_tx_cap_exceeded");
    assert.equal(events[0]!.decision?.source, "diagnostic");
    assert.equal(events[0]!.transactionHash, HASH);
    assert.equal(events[0]!.ledger, 4_675_000);
    assert.equal(events[0]!.contractId, GUARD);
    assert.equal(events[0]!.ledgerClosedAt, null);
  });

  it("normalises an allowed decision's empty reason symbol like every other stream", () => {
    const events = guardEventsFromFailedTransaction(
      { txHash: HASH, ledger: 4_675_000, createdAt: 1_789_400_000, diagnosticEventsXdr: [allowedAuthChecked()] },
      GUARD,
    );
    assert.equal(events[0]!.decision?.result, "allowed");
    assert.equal(events[0]!.decision?.reason, null);
  });

  it("drops host diagnostics and keeps only the guard event", () => {
    const events = guardEventsFromFailedTransaction(
      {
        txHash: HASH,
        ledger: 4_675_000,
        createdAt: 1_789_400_000,
        diagnosticEventsXdr: [hostNoise(), diagnostic(null, ["core_metrics", "cpu_insn"]), blockedAuthChecked()],
      },
      GUARD,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.decision?.reason, "per_tx_cap_exceeded");
  });

  it("emits nothing for a transaction with no diagnostics", () => {
    assert.deepEqual(
      guardEventsFromFailedTransaction(
        { txHash: HASH, ledger: 4_675_000, createdAt: 1_789_400_000, diagnosticEventsXdr: [] },
        GUARD,
      ),
      [],
    );
  });
});

describe("pollFailedTransactions", () => {
  it("surfaces the guard's auth_checked event from a failed transaction page", async () => {
    const { listener } = harness({
      txPages: [
        {
          transactions: [failedTx({ diagnosticEventsXdr: [blockedAuthChecked(), hostNoise()] })],
          latestLedger: 501,
          cursor: "tx-cursor-1",
        },
      ],
    });
    const page = await listener.pollFailedTransactions({ cursor: "tx-cursor-0" });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]!.stream, "failed_tx");
    assert.equal(page.events[0]!.decision?.reason, "per_tx_cap_exceeded");
    assert.equal(page.cursor, "tx-cursor-1");
  });

  it("ignores a failed transaction from another contract, even with a guard-shaped event", async () => {
    const { listener } = harness({
      txPages: [
        {
          transactions: [
            failedTx({
              envelopeXdr: invokeEnvelope(OTHER),
              diagnosticEventsXdr: [otherContractAuthChecked()],
            }),
            // Guard transaction, but only host noise — nothing to surface.
            failedTx({ txHash: "cd".repeat(32), diagnosticEventsXdr: [hostNoise()] }),
          ],
          latestLedger: 501,
          cursor: "tx-cursor-1",
        },
      ],
    });
    const page = await listener.pollFailedTransactions({ cursor: "tx-cursor-0" });
    assert.deepEqual(page.events, []);
    // The cursor still advanced past the scanned page.
    assert.equal(page.cursor, "tx-cursor-1");
  });

  it("does not emit the same failed transaction twice on a repeated page", async () => {
    const { listener } = harness({
      txPages: [
        {
          transactions: [failedTx({ diagnosticEventsXdr: [blockedAuthChecked()] })],
          latestLedger: 501,
          cursor: "tx-cursor-1",
        },
      ],
    });
    const first = await listener.pollFailedTransactions({ cursor: "tx-cursor-0" });
    assert.equal(first.events.length, 1);
    // The same page re-read (retry, or the cursor did not move) must not
    // re-emit: the transaction hash is the dedup identifier.
    const second = await listener.pollFailedTransactions({ cursor: "tx-cursor-0" });
    assert.deepEqual(second.events, []);
  });

  it("keeps the caller's cursor and skips-not-throws when the RPC fails", async () => {
    const { listener } = harness({ txPages: [], failGetTransactions: true });
    const page = await listener.pollFailedTransactions({ cursor: "tx-cursor-0" });
    assert.deepEqual(page.events, []);
    assert.equal(page.cursor, "tx-cursor-0");
  });

  it("skips an event with no decodable topics and still decodes the good one", async () => {
    const { listener } = harness({
      txPages: [
        {
          transactions: [
            failedTx({
              diagnosticEventsXdr: [
                // A diagnostic with an empty topic list carries nothing the
                // decoder can interpret; it is skipped, not surfaced.
                diagnostic(GUARD_BYTES, []),
                blockedAuthChecked(),
              ],
            }),
          ],
          latestLedger: 501,
          cursor: "tx-cursor-1",
        },
      ],
    });
    const page = await listener.pollFailedTransactions({ cursor: "tx-cursor-0" });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]!.decision?.reason, "per_tx_cap_exceeded");
    // Listener state intact: a follow-up poll against a fresh page still works.
    const next = await listener.pollFailedTransactions({ cursor: "tx-cursor-1" });
    assert.deepEqual(next.events, []);
  });

  it("starts at the head when no cursor is given, delivering nothing retroactively", async () => {
    const { listener } = harness({
      txPages: [
        { transactions: [failedTx({ diagnosticEventsXdr: [blockedAuthChecked()] })], latestLedger: 501, cursor: "tx-cursor-1" },
      ],
      latestLedger: 501,
    });
    const page = await listener.pollFailedTransactions({});
    assert.deepEqual(page.events, []);
    assert.equal(page.cursor, "501");
  });
});

describe("watch with failedTx (cursor interaction)", () => {
  it("is opt-out by default: the transaction stream is never queried", async () => {
    const { listener, requests } = harness({
      txPages: [{ transactions: [failedTx({ diagnosticEventsXdr: [blockedAuthChecked()] })], latestLedger: 501, cursor: "tx-cursor-1" }],
      failedTx: false,
    });
    await collectAfterPolls(listener, requests, 3);
    assert.equal(requests.getTransactions.length, 0);
  });

  it("scans an independent cursor: failed_tx events cannot be skipped by the events cursor", async () => {
    const { listener, requests } = harness({
      txPages: [
        {
          transactions: [failedTx({ diagnosticEventsXdr: [blockedAuthChecked()] })],
          latestLedger: 501,
          cursor: "tx-cursor-1",
        },
      ],
      failedTx: true,
    });
    const events = await collectAfterPolls(listener, requests, 4);
    // Surfaced exactly once: the events cursor advances on every poll (the
    // committed pages are empty), yet the failed tx is not skipped — its scan
    // follows its own cursor — and it is never re-emitted afterwards.
    const failed = events.filter((event) => event.stream === "failed_tx");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.decision?.reason, "per_tx_cap_exceeded");

    // The two cursors never cross: the events stream only ever receives its
    // own cursors (or a startLedger), the transaction stream only its own.
    const eventCursors = requests.getEvents.map((request) => request.cursor);
    assert.equal(
      eventCursors.filter((cursor) => typeof cursor === "string" && (cursor as string).startsWith("tx-cursor")).length,
      0,
    );
    const txCursors = requests.getTransactions.map(
      (request) => (request.pagination as { cursor?: string } | undefined)?.cursor,
    );
    assert.equal(
      txCursors.filter((cursor) => typeof cursor === "string" && (cursor as string).startsWith("events-cursor")).length,
      0,
    );
    // And the transaction stream really was queried repeatedly with its own
    // cursor, not abandoned after the first scan.
    assert.ok(requests.getTransactions.length >= 2);
  });

  it("surfaces the failed tx even though the committed stream saw nothing for that ledger", async () => {
    // The committed page for the period is empty (a rolled-back auth event
    // never reaches getEvents) and its cursor advances regardless — the
    // failure mode #58 exists to close: without the tx scan the event would
    // be gone forever.
    const { listener, requests } = harness({
      eventsPages: [{ events: [], cursor: "events-cursor-1", latestLedger: 502 }],
      txPages: [
        {
          transactions: [failedTx({ ledger: 4_675_000, diagnosticEventsXdr: [blockedAuthChecked()] })],
          latestLedger: 502,
          cursor: "tx-cursor-1",
        },
      ],
      failedTx: true,
    });
    const events = await collectAfterPolls(listener, requests, 4);
    assert.equal(events.filter((event) => event.stream === "failed_tx").length, 1);
    assert.equal(events.filter((event) => event.stream === "committed").length, 0);
  });

  it("keeps the committed stream alive when the transaction stream is down", async () => {
    const { listener, requests } = harness({
      txPages: [],
      failGetTransactions: true,
      eventsPages: [
        {
          events: [
            {
              contractId: GUARD,
              topic: [xdr.ScVal.scvSymbol("event_heartbeat")],
              value: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("at"), val: xdr.ScVal.scvU64(1_789_393_232n) })]),
              ledger: 4_675_001,
              ledgerClosedAt: "2026-09-14T00:00:00Z",
              txHash: HASH,
            },
          ],
          cursor: "events-cursor-1",
          latestLedger: 502,
        },
      ],
    });
    const events = await collectAfterPolls(listener, requests, 4);
    assert.ok(events.filter((event) => event.stream === "committed").length >= 1);
    assert.equal(events.filter((event) => event.stream === "failed_tx").length, 0);
  });
});

describe("describeGuardEvent for failed_tx", () => {
  it("renders the failed transaction's hash prefix, not 'pre-broadcast'", () => {
    const text = describeGuardEvent({
      id: `diag:${"0".repeat(64)}`,
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "diagnostic",
      stream: "failed_tx",
      contractId: GUARD,
      ledger: 4_675_000,
      ledgerClosedAt: null,
      observedAt: null,
      transactionHash: HASH,
      decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
      data: {},
    });
    assert.match(text, /failed tx abababab/);
    assert.match(text, /per_tx_cap_exceeded/);
    assert.doesNotMatch(text, /pre-broadcast/);
  });
});

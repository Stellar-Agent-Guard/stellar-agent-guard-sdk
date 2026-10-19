/**
 * The telemetry listener, demonstrated against events the chain actually emitted.
 *
 * Both feeds are covered, because they are different and a listener that only
 * handles one is quietly blind:
 *
 *  - the **ledger** feed, exercised by a real `heartbeat()` whose transaction is
 *    then read back through `getEvents`;
 *  - the **diagnostic** feed, which is the only place a *blocked* decision ever
 *    appears — a refusal rolls its event back and is never committed.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Address, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { invoke } from "../../src/invoke.ts";
import { PreFlightInterceptor } from "../../src/preflight.ts";
import { unsafeContractAddress } from "../../src/policy.ts";
import {
  GuardTelemetryListener,
  describeGuardEvent,
  guardEventsFromDiagnostics,
} from "../../src/telemetry.ts";
import { TESTNET_PASSPHRASE, installPolicy, loadPhase2Config, type Phase2Config } from "./harness.ts";

let config: Phase2Config;
let server: rpc.Server;
let listener: GuardTelemetryListener;

/** JSON that tolerates BigInt, for failure messages (a submission carries them). */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `${item}n` : item));
}

before(async () => {
  config = await loadPhase2Config();
  server = new rpc.Server(config.rpcUrl);
  listener = new GuardTelemetryListener({ server, guard: config.guard, rpcUrl: config.rpcUrl });
});

describe("GuardTelemetryListener against the live guard", () => {
  it("sees a real allowed decision and heartbeat from the ledger", async () => {
    await installPolicy(server, config);
    // Start from before the write we are about to make, so the events we assert
    // on are unambiguously ours.
    const start = (await server.getLatestLedger()).sequence;

    const outcome = await invoke({
      server,
      source: config.keys.agent,
      call: { contract: unsafeContractAddress(config.guard), fn: "heartbeat", args: [] },
      networkPassphrase: TESTNET_PASSPHRASE,
      guardAuth: { guard: config.guard, agent: config.keys.agent },
    });
    assert.equal(outcome.kind, "allowed", serialize(outcome));
    if (outcome.kind !== "allowed") return;

    // `getEvents` is eventually consistent with the ledger we just wrote to;
    // poll briefly rather than assume the very first page sees it.
    const events = await pollUntil(start, (found) =>
      found.some((event) => event.transactionHash === outcome.submission.hash),
    );

    const ours = events.filter((event) => event.transactionHash === outcome.submission.hash);
    assert.ok(ours.length >= 2, `expected both events from ${outcome.submission.hash}`);

    const decision = ours.find((event) => event.kind === "auth_checked");
    assert.ok(decision, "no event_auth_checked in the ledger feed");
    assert.equal(decision.decision?.result, "allowed");
    assert.equal(decision.decision?.reason, null, "an allowed decision carries no reason");
    assert.equal(decision.source, "ledger");
    assert.equal(decision.contractId, config.guard);

    const heartbeat = ours.find((event) => event.kind === "heartbeat");
    assert.ok(heartbeat, "no event_heartbeat in the ledger feed");
    // The timestamp is event *data*, not a topic — see docs/event-schema.md.
    assert.ok(
      typeof (heartbeat.data as { at?: unknown })?.at !== "undefined",
      `heartbeat data should carry 'at': ${serialize(heartbeat.data)}`,
    );

    for (const event of ours) console.log(`[telemetry] ${describeGuardEvent(event)}`);
  });

  it("sees a blocked decision, which exists only on the diagnostic feed", async () => {
    await installPolicy(server, config);
    const interceptor = new PreFlightInterceptor({
      server,
      networkPassphrase: TESTNET_PASSPHRASE,
      guard: unsafeContractAddress(config.guard),
      agent: config.keys.agent,
      source: config.keys.agent,
    });

    const decision = await interceptor.check({
      contract: unsafeContractAddress(config.token),
      fn: "transfer",
      args: [
        new Address(config.guard).toScVal(),
        new Address(config.keys.outsider.publicKey()).toScVal(),
        nativeToScVal(5n, { type: "i128" }),
      ],
    });
    assert.equal(decision.allowed, false);
    if (decision.allowed || decision.kind !== "blocked") {
      throw new Error(`expected a blocked decision, got: ${JSON.stringify(decision)}`);
    }

    const events = guardEventsFromDiagnostics(decision.diagnosticEvents, config.guard);
    const blocked = events.find((event) => event.kind === "auth_checked");
    assert.ok(blocked, `no auth_checked decision in diagnostics: ${serialize(events)}`);
    assert.equal(blocked.decision?.result, "blocked");
    assert.equal(blocked.decision?.reason, "recipient_not_allowed");
    assert.equal(blocked.source, "diagnostic");
    assert.equal(blocked.transactionHash, null, "a blocked decision was never a transaction");
    console.log(`[telemetry] ${describeGuardEvent(blocked)}`);
  });
});

/** Poll `getEvents` until `done`, or fail — the chain is not instantly readable. */
async function pollUntil(
  startLedger: number,
  done: (events: Awaited<ReturnType<GuardTelemetryListener["poll"]>>["events"]) => boolean,
  attempts = 10,
): Promise<Awaited<ReturnType<GuardTelemetryListener["poll"]>>["events"]> {
  let events: Awaited<ReturnType<GuardTelemetryListener["poll"]>>["events"] = [];
  for (let i = 0; i < attempts; i += 1) {
    const page = await listener.poll({ startLedger });
    events = page.events;
    if (done(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return events;
}

after(() => {
  if (config?.guard) {
    console.log(`[telemetry] listener finished against ${config.guard}`);
  }
});

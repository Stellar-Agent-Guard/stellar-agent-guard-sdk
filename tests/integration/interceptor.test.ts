/**
 * The pre-flight interceptor, exercised on its own.
 *
 * Nothing in this file calls `invoke()`: the interceptor is the surface an agent
 * framework integrates with, so it has to stand by itself. It must answer
 * without broadcasting, report a refusal with the contract's own reason, and
 * never present "could not determine" as either an allow or a guard block.
 *
 * Transfer arguments are built directly with the SDK's `nativeToScVal` rather
 * than through the harness's `transfer()` helper — deliberately, so the helper
 * is not part of what is being tested.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { Address, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { PreFlightInterceptor, PreFlightUndeterminedError } from "../../src/preflight.ts";
import { unsafeContractAddress } from "../../src/policy.ts";
import { GuardBlockedError } from "../../src/reasons.ts";
import {
  guardTokenBalance,
  installPolicy,
  loadPhase2Config,
  readWindowTotal,
  type Phase2Config,
} from "./harness.ts";

let config: Phase2Config;
let server: rpc.Server;
let interceptor: PreFlightInterceptor;

/** Positional args for a SAC `transfer` out of the guarded account. */
function transferCall(to: string, amount: bigint) {
  return {
    contract: unsafeContractAddress(config.token),
    fn: "transfer",
    args: [
      new Address(config.guard).toScVal(),
      new Address(to).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
    ],
  };
}

/** JSON that tolerates BigInt, for failure messages. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `${item}n` : item));
}

before(async () => {
  config = await loadPhase2Config();
  server = new rpc.Server(config.rpcUrl);
  interceptor = new PreFlightInterceptor({
    server,
    networkPassphrase: "Test SDF Network ; September 2015",
    guard: unsafeContractAddress(config.guard),
    agent: config.keys.agent,
    source: config.keys.agent,
  });
});

describe("PreFlightInterceptor against the live guard", () => {
  it("approves an admissible call without broadcasting anything", async () => {
    await installPolicy(server, config);
    const balanceBefore = await guardTokenBalance(server, config);
    const windowBefore = (await readWindowTotal(server, config)).total;

    const decision = await interceptor.check(transferCall(config.keys.recipient.publicKey(), 30n));

    // A plain JSON.stringify would throw on the BigInt fee, so the assertion
    // message must be serialised carefully — and only when it is needed.
    assert.equal(decision.allowed, true, serialize(decision));
    if (!decision.allowed) return;
    assert.equal(decision.kind, "admissible");
    assert.ok(decision.estimatedResourceFee > 0n, "expected a real resource fee estimate");
    assert.ok(decision.footprintKeys > 0, "expected the simulation to price a footprint");

    // The whole point of a pre-flight check: nothing moved, because nothing was
    // submitted.
    assert.equal(await guardTokenBalance(server, config), balanceBefore);
    assert.equal((await readWindowTotal(server, config)).total, windowBefore);
    console.log(
      `[interceptor] admissible: fee ${decision.estimatedResourceFee} stroops, ` +
        `${decision.footprintKeys} footprint keys, nothing broadcast`,
    );
  });

  it("refuses an over-cap call with the contract's own reason", async () => {
    await installPolicy(server, config);
    const decision = await interceptor.check(
      transferCall(config.keys.recipient.publicKey(), config.policy.per_tx_cap + 1n),
    );

    assert.equal(decision.allowed, false);
    if (decision.allowed) return;
    assert.equal(decision.kind, "blocked");
    assert.equal(decision.reason, "per_tx_cap_exceeded");
    assert.match(decision.explanation, /per-transaction cap/i);
    assert.ok(decision.diagnosticEvents.length > 0, "expected the contract's diagnostic events");
    console.log(`[interceptor] blocked: ${decision.reason} — ${decision.explanation}`);
  });

  it("refuses an allowlist violation", async () => {
    await installPolicy(server, config);
    const decision = await interceptor.check(transferCall(config.keys.outsider.publicKey(), 5n));

    assert.equal(decision.allowed, false);
    if (decision.allowed) return;
    assert.equal(decision.kind, "blocked");
    assert.equal(decision.reason, "recipient_not_allowed");
  });

  it("throws GuardBlockedError from assertAllowed, marked uncharged", async () => {
    await installPolicy(server, config);
    await assert.rejects(
      () => interceptor.assertAllowed(transferCall(config.keys.outsider.publicKey(), 5n)),
      (error: unknown) => {
        assert.ok(error instanceof GuardBlockedError, `unexpected error: ${String(error)}`);
        assert.equal(error.reason, "recipient_not_allowed");
        assert.equal(error.charged, false, "a pre-broadcast refusal costs nothing");
        assert.equal(error.stage, "preflight");
        return true;
      },
    );
  });

  it("reports 'undetermined' separately from 'blocked' for a call it cannot judge", async () => {
    await installPolicy(server, config);
    // A call to a function that does not exist is not a policy decision — the
    // guard never rules on it. Reporting that as "the guard blocked you" would
    // be a false claim about the security boundary.
    const call = { contract: unsafeContractAddress(config.token), fn: "no_such_function", args: [] };

    const decision = await interceptor.check(call);
    assert.equal(decision.allowed, false);
    if (decision.allowed) return;
    assert.notEqual(
      decision.kind,
      "blocked",
      `a missing function is not a policy decision: ${JSON.stringify(decision)}`,
    );
    assert.equal(decision.kind, "undetermined");
    console.log(`[interceptor] undetermined (not a block): ${decision.detail.slice(0, 120)}`);

    await assert.rejects(
      () => interceptor.assertAllowed(call),
      PreFlightUndeterminedError,
    );
  });
});

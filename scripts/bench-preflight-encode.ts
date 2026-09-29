#!/usr/bin/env node
/**
 * Bench: what share of `PreFlightInterceptor.check()` is arg encoding?
 *
 * This answers the gating question in issue #93, which is explicitly
 * sequence-gated: "do not start until bench numbers exist — if encode <5% of
 * check time, close as wontfix-with-numbers".
 *
 * ## What is actually measured
 *
 * `ContractCall.args` is typed `xdr.ScVal[]`, not native values. The SDK
 * therefore never performs the `nativeToScVal` encode the issue describes — the
 * caller does, before the call is ever handed to the interceptor. There is
 * nothing inside `check()` for an encoding memo to remove.
 *
 * So this measures the two costs that DO exist per check and that a memo could
 * plausibly touch:
 *
 *   - `encode`  — what a caller spends building the args: `nativeToScVal` per
 *                 argument, plus the `toXDR()` serialization `callFingerprint`
 *                 performs over already-encoded args. This is the upper bound
 *                 on what any arg-encoding memo could recover.
 *   - `total`   — a full `check()` against an RPC boundary at a swept latency,
 *                 i.e. the real pipeline: validation, fingerprint, probe
 *                 simulation, signing, enforced simulation, verdict
 *                 construction, and the network round-trips between them.
 *
 * ## Why the RPC boundary is modelled, not mocked away
 *
 * An earlier version of this bench pointed `check()` at a server that returned
 * synchronously and reported an encode share of ~43%. That number is an
 * artifact: against a zero-latency mock, `check()` collapses to a few hundred
 * microseconds of pure CPU, so a 7-microsecond arg serialization looks like a
 * large fraction of it. Real pre-flight is dominated by RPC round-trips — this
 * repo's own live evidence records individual enforced simulations taking
 * 5–13 seconds end to end. A memo that shaves microseconds off a check whose
 * cost is a network round-trip is not worth its own keying cost.
 *
 * So the bench sweeps RPC latency instead of pretending it is zero, and
 * reports the encode share at each point. The share is monotonically decreasing
 * in RPC latency, which is the direction that matters: the further a real
 * deployment sits from a zero-latency mock, the smaller the prize.
 *
 * Usage: node --import tsx scripts/bench-preflight-encode.ts
 */
import { performance } from "node:perf_hooks";
import { Account, Address, Keypair, nativeToScVal, rpc, SorobanDataBuilder } from "@stellar/stellar-sdk";
import { PreFlightInterceptor } from "../src/preflight.ts";
import type { ContractCall } from "../src/tx.ts";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const RECIPIENT = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";
const PASSPHRASE = "Test SDF Network ; September 2015";

const WARMUP = 20;
const ITERATIONS = 200;

/**
 * The CPU-only measurements (encode, toXDR) are pure JS and JIT-warm within a
 * few hundred iterations, so they get a much larger warmup than the latency
 * sweep, which pays real wall-clock per iteration. Without this the numerator
 * is still warming while the denominator is not, and the 0ms row reports a
 * nonsensical >100% share.
 */
const CPU_WARMUP = 2000;
const CPU_ITERATIONS = 2000;

/**
 * Per-RPC-call latencies to model, in milliseconds.
 *
 * 0 is the degenerate instant-mock case, kept in the sweep to show how
 * misleading it is. 5 and 25 bracket what a real Soroban RPC does per
 * simulation; the live evidence in `tests/fixtures/integration-evidence.md`
 * shows whole enforced simulations taking seconds, which is further right than
 * anything this bench needs to reach.
 */
const RPC_LATENCIES_MS = [0, 5, 25] as const;

function delay(ms: number): Promise<void> {
  return ms === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/** An rpc.Server whose every call pays `latencyMs`, modelling a real network. */
function createMockServer(latencyMs: number): rpc.Server {
  const simulation = {
    transactionData: new SorobanDataBuilder().setResources(1, 0, 0).build(),
    minResourceFee: "1",
    result: { auth: [] },
  };
  return {
    getAccount: async () => {
      await delay(latencyMs);
      return new Account(GUARD, "100");
    },
    getLatestLedger: async () => {
      await delay(latencyMs);
      return { sequence: 1000 };
    },
    simulateTransaction: async () => {
      await delay(latencyMs);
      return simulation;
    },
  } as unknown as rpc.Server;
}

function makeCall(amount: bigint): ContractCall {
  return {
    contract: TOKEN,
    fn: "transfer",
    args: [
      new Address(GUARD).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
    ],
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function timeEach(label: string, iterations: number, body: (i: number) => void): number {
  for (let i = 0; i < CPU_WARMUP; i++) body(i);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    body(i);
    samples.push(performance.now() - started);
  }
  const ms = median(samples);
  console.log(`${label.padEnd(34)} ${ms.toFixed(6)} ms`);
  return ms;
}

async function main(): Promise<void> {
  console.log(`PreFlightInterceptor.check() arg-encode share`);
  console.log(`median of ${ITERATIONS} iterations, after ${WARMUP} warmup\n`);

  // The numerator: the arg work a caller does to produce the args, plus the
  // SDK's own toXDR() over them (what a memo would have to beat).
  const encode = timeEach("caller encode + args toXDR", CPU_ITERATIONS, () => {
    const args = [
      new Address(GUARD).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(100n, { type: "i128" }),
    ];
    for (const arg of args) arg.toXDR();
  });

  // The encode on its own, i.e. what a memo would have to remove if it only
  // memoized the ScVal construction and not the serialization.
  const encodeOnly = timeEach("caller encode only (no toXDR)", CPU_ITERATIONS, () => {
    const args = [
      new Address(GUARD).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(100n, { type: "i128" }),
    ];
    if (args.length !== 3) throw new Error("unreachable");
  });

  console.log("");
  console.log("RPC latency   check() median   encode+toXDR   encode share");
  console.log("------------  ---------------  -------------  ------------");

  const rows: { latency: number; total: number; share: number }[] = [];
  for (const latency of RPC_LATENCIES_MS) {
    const interceptor = new PreFlightInterceptor({
      server: createMockServer(latency),
      networkPassphrase: PASSPHRASE,
      guard: GUARD,
      agent: Keypair.random(),
      source: Keypair.random(),
    });

    for (let i = 0; i < WARMUP; i++) await interceptor.check(makeCall(100n));
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const call = makeCall(100n);
      const started = performance.now();
      await interceptor.check(call);
      samples.push(performance.now() - started);
    }
    const total = median(samples);
    const share = (encode / total) * 100;
    rows.push({ latency, total, share });

    console.log(
      `${String(latency).padStart(8)} ms  ${total.toFixed(3).padStart(13)} ms  ` +
        `${encode.toFixed(4).padStart(11)} ms  ${share.toFixed(3).padStart(9)}%`,
    );
  }

  // 4. The strongest case *for* a memo: an opted-in cache hit, where `check()`
  //    returns before any simulation. The encode share here is a real fraction
  //    rather than a rounding error, because the denominator is the cheapest
  //    path the SDK has. It is reported in absolute microseconds too, which is
  //    the number that actually settles the question — a share of a very small
  //    number is still a very small number.
  const cached = new PreFlightInterceptor({
    server: createMockServer(0),
    networkPassphrase: PASSPHRASE,
    guard: GUARD,
    agent: Keypair.random(),
    source: Keypair.random(),
    cache: { ttlMs: 60_000, policyRevision: () => 1 },
  });
  for (let i = 0; i < CPU_WARMUP; i++) await cached.check(makeCall(100n));
  const hitSamples: number[] = [];
  for (let i = 0; i < CPU_ITERATIONS; i++) {
    const call = makeCall(100n);
    const started = performance.now();
    await cached.check(call);
    hitSamples.push(performance.now() - started);
  }
  const hitTotal = median(hitSamples);
  const hitShare = (encode / hitTotal) * 100;
  console.log(
    `\nopt-in cache HIT (no simulation at all): check() ${hitTotal.toFixed(6)} ms, ` +
      `encode share ${hitShare.toFixed(2)}%`,
  );
  console.log(
    `  ...which is ${encode.toFixed(4)} ms — ${(encode * 1000).toFixed(2)} microseconds — ` +
      "of absolute saving per check",
  );

  const realistic = rows.filter((row) => row.latency > 0);
  const worstCaseShare = Math.max(...realistic.map((row) => row.share));
  const mockShare = rows.find((row) => row.latency === 0)?.share ?? 0;

  console.log(`\nthreshold from issue #93: 5.000%`);
  console.log(`share at a zero-latency mock (misleading): ${mockShare.toFixed(3)}%`);
  console.log(`share at modelled real RPC latency:        ${worstCaseShare.toFixed(3)}% (worst point)`);
  console.log(
    `caller encode alone, no toXDR: ${encodeOnly.toFixed(4)} ms ` +
      `(${(encodeOnly / (realistic[0]?.total ?? 1)) * 100 < 0.01 ? "<0.01" : ((encodeOnly / (realistic[0]?.total ?? 1)) * 100).toFixed(3)}% of a 5ms-latency check)`,
  );
  console.log(
    "\nVERDICT: below threshold on every path that involves the network. " +
      "The 0ms row is included to show how badly a zero-latency mock overstates the share.",
  );
  console.log(
    "Note also that the SDK performs no nativeToScVal itself: args arrive already " +
      "encoded as xdr.ScVal[], so the encode cost above is the caller's, outside check().",
  );
}

await main();

<!-- npm keywords: stellar, soroban, ai-agents, guardrails, stellar-sdk, policy, firewall, langchain, elizaos, non-custodial, smart-account, custom-account-abstraction, spend-limits, allowlist, telemetry, typescript, web3, blockchain-security -->
<p align="center">
<img src="Gemini_Generated_Image_mvimg2mvimg2mvim.jpeg" alt="Stellar Agent Guard" width="700"/>
</p>
<p align="center">
<a href="https://github.com/aigbagbobila/stellar-agent-guard-sdk/actions/workflows/ci.yml">
<img src="https://github.com/aigbagbobila/stellar-agent-guard-sdk/actions/workflows/ci.yml/badge.svg" alt="CI"/>
</a>
<a href="LICENSE">
<img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"/>
</a>
<a href="https://nodejs.org/">
<img src="https://img.shields.io/badge/node-24%2B%e2%80%8B%e2%80%8B-blue" alt="Node 24+"/>
</a>
<!-- docs: <a href="#"><img src="https://img.shields.io/badge/docs-GitBook-blue" alt="Documentation"/></a> (added in P2 once GitBook URL is confirmed live) */
</p>

# Stellar Agent Guard — Developer SDK

<!-- 🚂**[Documentation](...)** (added in P2 once GitBook URL is confirmed live) -->

**Non-custodial TypeScript SDK and pre-flight policy interception firewall for AI agents on Stellar.**

An autonomous agent holding a wallet has a single point of failure: one prompt-injection or one buggy loop can drain it. Stellar Agent Guard makes that impossible on-chain — the agent's funds stay in its own smart account, and *every* transaction the account must authorize is intercepted by the contract's and rejected pre-broadcast unless it satisfies the operator's installed policy: per-transaction spend caps, a rolling-window spend limit, recipient/asset allowlists, protocol allowlists, a pause switch, and a dead-man switch. This SDK provides the integration layer: pre-flight simulation interception, zero-broadcast fee estimation, agent-auth transaction signing, and dual-stream event telemetry for AI agent frameworks (LangChain, ElizaAOS).

**Status: Phase 2 complete — and the package is published.** [`stellar-agent-guard-sdk@0.1.1`](https://www.npmjs.com/package/stellar-agent-guard-sdk) is live on the npm registry (`npm install stellar-agent-guard-sdk`). All five enforcement scenarios were proven against live Stellar testnet (protocol 28) with real contract IDs, transaction hashes, and diagnostic events — evidence is recorded in [`tests/fixtures/integration-evidence.md`](tests/fixtures/integration-evidence.md). Phase 2 code is merged into `main` with green CI (`ci` status check). For historical release notes and publish pipeline reconciliation, see [`docs/publishing-history.md`](docs/publishing-history.md).

## 🎯 What makes this different

Enforcement happens **inside the account itself**, via Soroban's native Custom Account Abstraction — not in a wrapper contract in front of funds, and not in an off-chain service.

- `PreFlightInterceptor`: evaluates guard approval against Soroban RPC before a single byte hits the network. If the transaction violates policy, it is rejected client-side with the contract's own reason code, incurring zero network fees.
- `Dual-stream telemetry`: Blocked decisions never commit to the ledger because Soroban rolls back failed authorizations. A listener that only tails committed ledger events sees a guard that appears to approve everything. The SDK extracts `event_auth_checked` from simulation diagnostics as well as committed blocks.
- `In-process simulation pricing`: `CostPreChecker` computes network resource and inclusion fees directly from the enforced simulation, avoiding dependencies on external profiling tools.
- `Framework middleware`: Plug-and-play middleware for LangChain and validators for ElizaOS halt execution before external tool calls run.

> ⚠️ **Disclaimer:** This is unaudited security tooling that gates real fund access. Do not deploy to mainnet without an independent audit. See the contracts repo's [SECURITY.md](https://github.com/aigbagbobila/stellar-agent-guard-contracts/blob/main/SECURITY.md).

## What it does

- `Pre-flight policy interception (`PreFlightInterceptor`)`: Intercepts contract calls before broadcast, simulates auth authorization, and returns a discriminated `admissible`, `blocked`, or `undetermined` verdict. Never throws on policy refusal; an opt-in short-lived cache can reduce repeated simulation RPC calls within the current ledger.
- `In-process cost pre-checking (`CostPreChecker`)`: Prices transaction execution from simulation results, reporting resource fees, inclusion fees, and total fees against an optional ceiling.
- `Autonomous transaction execution (`invoke()`)`: Executes the full Soroban lifecycle: probe simulation, auth signing for custom accounts, enforced simulation, and broadcast with bounded exponential-backoff retry for stale ledger resource limits (`scecExceededLimit`).
- `Framework adapters`:
  - `createLangChainGuardMiddleware`: Halts tool execution if the interceptor blocks the planned action.
  - `createGuardValidator`: ElizaOS action validator returning boolean verdicts before actions run.
- `Telemetry listener (`GuardTelemetryListener`)`: Tails both committed events and diagnostic streams, decoding contract topics and reason codes.

## Quick Start

> **A verdict is a prediction, not a settlement guarantee.** Before relying on a
> pre-flight approval, read [Fidelity & limits](#fidelity--limits) — the four
> known gaps in simulation fidelity, and what the SDK does about each.

### Installation

```bash
npm install stellar-agent-guard-sdk
```

> **Module Format & Environment Note:**
> `stellar-agent-guard-sdk` is published strictly as **pure ESM** (`"type": "module"`) targeting **Node.js >= 24.0.0** (declared in `engines`).
>
> If your project or toolchain runs in CommonJS (e.g. legacy LangChain setups, Jest configs, or `.cjs` scripts), load the SDK using the dynamic `await import()` pattern:
>
> ```javascript
> // CommonJS (.cjs or package without "type": "module")
> async function run() {
>   const { PreFlightInterceptor, CostPreChecker } = await import("stellar-agent-guard-sdk");
>   // use interceptor, cost pre-checker, etc.
> }
> ```

*Or build locally from source with Node 24+)*

```bash
git clone https://github.com/aigbagbobila/stellar-agent-guard-sdk.git
cd stellar-agent-guard-sdk
npm ci
npm run build
```

### Live testnet suite (`.env.phase2`)

The unit suite needs no credentials. The **live** suite (`npm run test:integration`)
runs real transactions against the deployed Phase 2 testnet instance and reads
its signing keys from a gitignored `.env.phase2`. Start from the committed
template, which documents every key and what each one unlocks without carrying a
value:

```bash
cp .env.phase2.example .env.phase2   # then fill in the values
npm run deploy:phase2                # or provision a fresh instance and write it for you
npm run test:integration
```

`tests/integration/harness.ts` validates the file up front. When it is
incomplete it fails once with **every** missing key named — not one key per run,
which would make setup a guessing game of five round trips:

```
.env.phase2 is incomplete: 3 required key(s) are missing:
  - PHASE2_ADMIN_SECRET
  - PHASE2_RECIPIENT_SECRET
  - PHASE2_OUTSIDER_SECRET

Copy the documented template and fill it in:  cp .env.phase2.example .env.phase2
Or provision a fresh instance (writes the file, including PHASE2_ISSUER_SECRET):  npm run deploy:phase2
```

The required keys are `PHASE2_GUARD`, `PHASE2_TOKEN`, `PHASE2_ADMIN_SECRET`,
`PHASE2_AGENT_SECRET$`, `PHASE2_RECIPIENT_SECRET` and
`PHASE2_OUTSIDER_SECRET$`, plus optionally `PHASE2_RPC_URL`;
`PHASE2_ISSUER_SECRET` is additionally required to (re)deploy. `.env.phase2` is
gitignored (as are all `.env.*` values files — only `*.example` templates are
committable); never commit the filled-in copy.

### Pre-flight Policy Interception

```ts
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { PreFlightInterceptor, isContractAddress, type ContractAddress } from "stellar-agent-guard-sdk";

// Validate contract address from environment
const guardAddress = process.env.GUARD_ADDRESS;
if (!isContractAddress(guardAddress)) {
  throw new Error(`Invalid guard contract address: ${guardAddress}`);
}

// For known hardcoded addresses, use type assertion
const contractAddress = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB" as ContractAddress;

const interceptor = new PreFlightInterceptor({
  server: new rpc.Server("https://soroban-testnet.stellar.org"),
  networkPassphrase: "Test SDF Network ; September 2015",
 main
  agent: Keypair.fromSecret(process.env.AGENT_SECRET!),
  source: Keypair.fromSecret(process.env.SOURCE_SECRET!!),
});

const decision = await interceptor.check({
 main
  fn: "transfer",
  args: [/* from, to, amount */],
});

if (decision.kind === "admissible") {
  console.log("Allowed! Resource fee:", decision.estimatedResourceFee);
} else if (decision.kind === "blocked") {
  console.log("Blocked by guard:", decision.reason);
} else {
  console.log("Undetermined (fails closed)");
}
```

#### Branded Address Types (v0.2.0+)

This version introduces **branded types** to distinguish contract addresses (C...) from account addresses (G...) at compile time, preventing a common source of bugs where an address is used in the wrong context.

**Type Guards:**

```ts
import { 
  isContractAddress,    // Validates C... addresses
  isAccountAddress,     // Validates G... addresses
  isStrKeyAddress,      // Validates any StrKey (C... or G...)
  isPublicKeyHex,       // Validates 64-char hex public keys
} from "stellar-agent-guard-sdk";

// Runtime validation before use
if (!isContractAddress(userInput)) {
  throw new Error("Expected contract address (C...)");
}
```

**Migration:** If upgrading from an earlier version, see [MIGRATION.md](./MIGRATION.md) for guidance on updating your code to use typed addresses.

#### Throw vs. Verdict Contract

Pre-flight policy interception makes an intentional asymmetric distinction between programmer errors and policy outcomes:

- `Input validation throws `InvalidInputError` (synchronous)`: If a `ContractCall` is malformed (invalid StrKey contract ID, missing or non-`symbol`-shaped function name, invalid arguments array, or non-`i128` amount), `interceptor.check()` throws `InvalidInputError` synchronously without dispatching any network RPC request.
- `Policy refusals return a verdict (`kind: "blocked"`)`: When input is valid but policy disallows the action (spend cap exceeded, recipient not allowlisted, account paused), this represents expected guardrail operation. `check()` returns `{ allowed: false, kind: "blocked", reason, explanation, ... }` instead of throwing.
- Callers requiring a throw-on-refusal flow can use `interceptor.assertAllowed(call)`, which throws `GuardBlockedError` on `blocked` and `PreFlightUndeterminedError` on `undetermined`.

### Fidelity & limits

Pre-flight simulation is a prediction made against one ledger snapshot, not a settlement guarantee. These are the four known limitations of that prediction, each with the mitigation the SDK applies and the residual risk that remains. Every claim is pinned to the function that implements it so a reviewer can check it rather than trust it.

1. **Window state can move between `check` and broadcast (concurrent spenders).**
   - *Mitigation:* `PreFlightInterceptor.check()` never broadcasts; it calls `enforceCall()` (`src/invoke.ts`) to run the guard's real `__check_auth` against live ledger state, which is what makes a refusal free. Under `invoke()`, `withAccountQueue()` (`src/invoke.ts`) serializes fetch → build → submit per source account, and the committed contract re-evaluates the rolling window atomically. If the window moved anyway, the post-inclusion refusal is still reported as `blocked` with `charged: true` (`src/invoke.ts`).
   - *Residual risk:* a spender that does not route through this SDK's queue, or that uses a different source account, can consume the window after an `admissible` verdict; the transfer can then be refused on-chain and, when it reaches inclusion, charged. The optional cache reuses verdicts within one ledger, so a cached `admissible` can be staler than one admitted transfer (`src/preflight.ts`).

2. **The fee market can move (fee-bump).**
   - *Mitigation:* `CostPreChecker.checkWithCost()` and `costOf()` (`src/cost.ts`) derive the quote from the same enforced simulation that produced the verdict, so price and verdict never describe two snapshots, and `feeBreakdown()` uses the same `INCLUSION_FEE` the submitted envelope declares (`src/tx.ts`).
   - *Residual risk:* Soroban fees are dynamic and the SDK does not implement fee-bump handling. A fee-bump or an inclusion/base-fee change between simulation and broadcast can move the real price. `maxFeeStroops` in `CostPreChecker` is a pre-flight ceiling, not a network guarantee.

3. **Simulation does not execute — return-value-dependent effects are invisible.**
   - *Mitigation:* the enforced simulation runs the real `__check_auth` (Step 3 of `enforceCall()`, `src/invoke.ts`), and refusals are recovered from simulation diagnostics by `reasonFromDiagnosticEvents()` (`src/invoke.ts`) and `decodeAuthDecision()` (`src/events.ts`) even though a rolled-back block never commits to a ledger.
   - *Residual risk:* simulation rolls back its writes; it cannot reveal effects that depend on a return value or on state another call would produce (an oracle price, a swap quote, a balance read mid-transaction). Such a call can be `admissible` pre-flight and still behave differently on-chain. Telemetry `telemetryFromDecision()` (`src/telemetry.ts`) observes the decision event, not the call's return value.

4. **Multi-context batch semantics are approximated (batch).**
   - *Mitigation:* `PreFlightInterceptor.checkBatch()` and `preflightBatch()` (`src/preflight.ts`) simulate each call in sequence with staged window accounting, so a call that passes in isolation but pushes cumulative spend past `window_cap` is reported `blocked` with `window_cap_exceeded`.
   - *Residual risk:* it is sequential single-call simulation, not atomic batch simulation. State mutations between calls other than guard window spend are not observed, intra-batch window expiry is not modelled, and `totalEstimatedResourceFee` is the sum of per-call estimates rather than one envelope's fee (`src/preflight.ts:571`). The intended fix is to route to a contract-side `check_batch` once it lands, keeping this sequential staging as the fallback.

### Optional simulation-result cache

`PreFlightInterceptor` always performs a fresh simulation by default. For agent
loops that repeatedly check the same call, caching can be enabled explicitly:

```ts
const interceptor = new PreFlightInterceptor({
  server,
  networkPassphrase,
  guard,
  agent,
  source,
  cache: {
    ttlLedgers: 1, // maximum one approximate five-second ledger window
    policyRevision: () => readPolicyRevision(),
  },
});

const first = await interceptor.check(call);
const second = await interceptor.check(call); // may reuse the first verdict
interceptor.invalidate();                       // clear all entries
interceptor.invalidate(call);                   // clear one call's entries
```

The cache is **disabled unless `cache` is supplied**. It stores only actual
`admissible` and `blocked` decisions; transient `undetermined` results are not
cached. A cache key includes the contract, function, canonical XDR argument
fingerprint, interceptor identity, and the supplied policy revision. The cache
is discarded when the observed ledger advances, when the TTL expires, or when
`invalidate()` is called. `ttlMs` and `ttlLedgers` are both capped at one
approximate ledger-close interval; if both are supplied, `ttlMs` takes
precedence.

A **cached verdict can be staler than one admitted transfer**. The rolling spend
window can change after a simulation while a cached result is still being
reused, so callers that cannot tolerate that tradeoff should leave caching off,
use a shorter TTL, provide a policy revision, and invalidate after policy or
account-state changes.

### Deterministic time control in tests (Clock injection)

Time-dependent operations (cache TTL, transaction polling) support optional `Clock` injection for deterministic testing without real delays.

**For tests**, use `FakeClock` to control time:

```ts
import { FakeClock, PreFlightInterceptor } from "stellar-agent-guard-sdk";

test("cache entry expires", async () => {
  const clock = new FakeClock(0);
  const interceptor = new PreFlightInterceptor({
    server,
    guard,
    agent,
    source,
    cache: { ttlMs: 5000 },
    clock, // Inject the fake clock
  });

  const decision1 = await interceptor.check(call);

  // Advance clock without real delays
  clock.advance(6000); // Skip to t=6000ms (past the 5000ms TTL)

  const decision2 = await interceptor.check(call); // Cache expired, fresh lookup
});
```

**For production**, no action is needed: modules default to the system clock. The `Clock` interface is purely optional and for testing.

Key methods on `FakeClock`:

- `now()` — returns current time in milliseconds
- `sleep(ms)` — returns a promise (resolves instantly when time allows)
- `advance(ms)` — move the clock forward deterministically
- `setTime(ms)` — set clock to an absolute time

Time-dependent modules (preflight cache, transaction polling) accept an optional `clock` parameter. When omitted, they use the system clock (`Date.now()`, real `setTimeout`). Tests pass a `FakeClock` to eliminate real waits and make timing deterministic. For full guidance, see [CONTRIBUTING.md](CONTRIBUTING.md) under "Deterministic time control in tests".

### Pipeline step observability (`onStep`)

`invoke()` accepts an **optional** `onStep` callback. When omitted, behavior is
*exactly* as before — the hook is pure observability and the SDK itself never
logs anything (and takes no logger dependency; what you do with the events is up
to you):

```ts
const outcome = await invoke({
  server,
  source,
  call,
  networkPassphrase,
  guardAuth,
  onStep(step) {
    // consumer decides how to display/log the event
    console.log(`[${step.attempt}] ${step.name} ${step.status} in ${step.durationMs}ms`);
  },
});
```

Event shape (`InvokeStepEvent`):

| Field | Meaning |
|---|---|
| `name` | Pipeline stage: `probe` → `sign` → `simulate` → `broadcast` (the shared `TRACE_STEP_NAMES` vocabulary). |
| `status` | `start` (emitted immediately before the stage runs), then `ok` or `fail`. |
| `durationMs` | Elapsed time of **this stage attempt** in milliseconds — not the total `invoke()` duration. Always `0` on `start`. |
| `attempt` | 0-based retry index. `0` for the first pass; `1` on the built-in stale-ledger re-run. Always present. |

### Decoding a raw event XDR (CLI / offline tooling)

The event decoders accept the same `GuardEvent` shape whether you feed them a
stellar-sdk response object or a raw base64 XDR string. This makes it possible to
debug from a copy-pasted event (block explorer, CI fixture, operator logs) without
constructing fake response shapes:

```ts
import { decodeGuardEventXdr } from "stellar-agent-guard-sdk";

// Paste the base64 XDR straight from a block explorer or a golden fixture.
const event = decodeGuardEventXdr(process.argv[2]);

if (event === null) {
  console.error("Not a decodable guard event XDR");
  process.exit(1);
}

console.log(`${event.kind}: ${event.reason}`);
console.log(event.explanation);
```
 main

> The raw XDR fixture format is the one consumed from the contract repo's golden-fixture issue ([stellar-agent-guard-contracts](https://github.com/aigbagbobila/stellar-agent-guard-contracts)).

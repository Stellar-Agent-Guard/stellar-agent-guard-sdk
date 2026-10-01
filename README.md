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
<img src="https://img.shields.io/badge/node-24%2B-blue" alt="Node 24+"/>
</a>
<!-- docs: <a href="#"><img src="https://img.shields.io/badge/docs-GitBook-blue" alt="Documentation"/></a> (added in P2 once GitBook URL is confirmed live) -->
</p>

# Stellar Agent Guard — SDK

<!-- 📚 **[Documentation](...)** (added in P2 once GitBook URL is confirmed live) ** -->

**Non-custodial TypeScript SDK and pre-flight policy interception firewall for AI agents on Stellar.**

An autonomous agent holding a wallet has a single point of failure: one prompt-injection or one buggy loop can drain it. Stellar Agent Guard makes that impossible on-chain — the agent's funds stay in its own smart account, and *every* transaction the account must authorize is intercepted by the contract's  and rejected pre-broadcast unless it satisfies the operator's installed policy: per-transaction spend caps, a rolling-window spend limit, recipient/asset allowlists, protocol allowlists, a pause switch, and a dead-man switch. This SDK provides the integration layer: pre-flight simulation interception, zero-broadcast fee estimation, agent-auth transaction signing, and dual-stream event telemetry for AI agent frameworks (LangChain, ElizaAOS).

**Status: Phase 2 complete — and the package is published.** [`stellar-agent-guard-sdk@0.1.1`](https://www.npmjs.com/package/stellar-agent-guard-sdk) is live on the npm registry (`npm install stellar-agent-guard-sdk`). All five enforcement scenarios were proven against live Stellar testnet (protocol 28) with real contract IDs, transaction hashes, and diagnostic events — evidence is recorded in [`tests/fixtures/integration-evidence.md`](tests/fixtures/integration-evidence.md). Phase 2 code is merged into `main` with green CI (`ci` status check). For historical release notes and publish pipeline reconciliation, see [`docs/publishing-history.md`](docs/publishing-history.md).

## 🎯 What makes this different

Enforcement happens **inside the account itself**, via Soroban's native Custom Account Abstraction — not in a wrapper contract in front of funds, and not in an off-chain service.

- **Pre-flight simulation without broadcast**: The SDK evaluates guard approval against Soroban RPC before a single byte hits the network. If the transaction violates policy, it is rejected client-side with the contract's own reason code, incurring zero network fees.
- **Dual-stream telemetry**: Blocked decisions never commit to the ledger because Soroban rolls back failed authorizations. A listener that only tails committed ledger events sees a guard that appears to approve everything. The SDK extracts `event_auth_checked` from simulation diagnostics as well as committed blocks.
- **In-process simulation pricing**: `CostPreChecker` computes network resource and inclusion fees directly from the enforced simulation, avoiding dependencies on external profiling tools.
- **Framework middleware**: Plug-and-play middleware for LangChain and validators for ElizaOS halt execution before external tool calls run.

> ⚠️ **Disclaimer:** This is unaudited security tooling that gates real fund access. Do not deploy to mainnet without an independent audit. See the contracts repo's [SECURITY.md](https://github.com/aigbagbobila/stellar-agent-guard-contracts/blob/main/SECURITY.md).

## What it does

- **Pre-flight policy interception (`PreFlightInterceptor`)**: Intercepts contract calls before broadcast, simulates auth authorization, and returns a discriminated `admissible`, `blocked`, or `undetermined` verdict. Never throws on policy refusal; an opt-in short-lived cache can reduce repeated simulation RPC calls within the current ledger.
- **In-process cost pre-checking (`CostPreChecker`)**: Prices transaction execution from simulation results, reporting resource fees, inclusion fees, and total fees against an optional ceiling.
- **Autonomous transaction execution (`invoke()`)**: Executes the full Soroban lifecycle: probe simulation, auth signing for custom accounts, enforced simulation, and broadcast with bounded exponential-backoff retry for stale ledger resource limits (`scecExceededLimit`).
- `createLangChainGuardMiddleware`: Halts tool execution if the interceptor blocks the planned action.
- `createGuardValidator`: ElizaOS action validator returning boolean verdicts before actions run.
- `GuardTelemetryListener`: Tails both committed events and diagnostic streams, decoding contract topics and reason codes.

## Quick Start

> **A verdict is a prediction, not a settlement guarantee.** Before relying on a
> pre-flight approval, read [Fidelity & limits](#fidelity--limits) — the four
> known gaps in simulation fidelity, and what the SDK does about each.

### Installation

```bash
npm install stellar-agent-guard-sdk
```

> **Module Format & Environment Note:**
# `stellar-agent-guard-sdk` is published strictly as **pure ESM** (`"type": "module"`) targeting **Node.js >= 24.0.0** (declared in `engines`).
#
# If your project or toolchain runs in CommonJS (e.g. legacy LangChain setups, Jest configs, or `.cjs` scripts), load the SGK using the dynamic `await import()` pattern:
#
# ```javascript
# // CommonJS (.cjs or package without "type": "module")
# async function run() {
#   const { PreFlightInterceptor, CostPreChecker } = await import("stellar-agent-guard-sdk");
#   // use interceptor, cost pre-checker, etc.
# }
# ```

*(Or build locally from source with Node 24+)*

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
npm run deploy:phase2
npm run test:integration
```

`tests/integration/harness.ts` validates the file up front. When it ir
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
`PHASE2_AGENT_SECRET`, `PHASE2_RECIPIENT_SECRET` and
`PHASE2_OUTSIDER_SECRET`, plus optionally `PHASE2_RPC_URL`;
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
  guard: guardAddress, // Type-safe: validated as ContractAddress
  agent: Keypair.fromSecret(process.env.AGENT_SECRET!),
  source: Keypair.fromSecret(process.env.SOURCE_SECRET!),
});

const decision = await interceptor.check({
  contract: contractAddress,
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

- **Input validation throws `InvalidInputError` (synchronous)**: If a `ContractCall` is malformed (invalid StrKey contract ID, missing or non-symbol-shaped function name, invalid arguments array, or non-`i128` amount), `interceptor.check()` throws `InvalidInputError` synchronously without dispatching any network RPC request.
- **Policy refusals return a verdict (`kind: "blocked"`)**: When input is valid but policy disallows the action (spend cap exceeded, recipient not allowlisted, account paused), this represents expected guardrail operation. `check()` returns `{ allowed: false, kind: "blocked", reason, explanation, ... }` instead of throwing.
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
interceptor.invalidate(call);                  // clear one call's entries
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
*exactly* as before — the hook is pure observability and the SDK itself never logs anything (and takes no logger dependency; what you do with the events is up to you):

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

> **Note:** The above documentation is truncated in this file. The complete documentation including the full `onStep` section is available in the published package and on GitHub.

### Injectable transport: custom RPC Server instance

All three surfaces — `PreFlightInterceptor`, `CostPreChecker`, and `invoke()` — accept a shared configuration shape that lets you either pass a pre-built `SorobanRpc.Server` instance or a URL string:

```ts
import { rpc } from "@stellar/stellar-sdk";
import { PreFlightInterceptor, CostPreChecker, invoke } from "stellar-agent-guard-sdk";

// Enterprise/agent deployments route RPC through proxies (auth headers, mTLS, latency shielding).
// Build the Server instance with your proxy configuration before passing it in.
const server = new rpc.Server("https://rpc-proxy.example.com", {
  allowHttp: false,
});

// The injected instance is used verbatim — no fresh Server is constructed from a URL.
const interceptor = new PreFlightInterceptor({
  server,
  networkPassphrase: "Test SDF Network ; September 2015",
  guard: "CAPADGEK457RHKN4RYVUMGJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
  agent: Keypair.fromSecret(process.env.AGENT_SECRET!),
  source: Keypair.fromSecret(process.env.SOURCE_SECRET!),
});

// Or pass a URL string and the SDK will construct the Server for you:
const interceptor2 = new PreFlightInterceptor({
  url: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  guard: "CAPADGEK457RHKN4RYVUMGJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
  agent: Keypair.fromSecret(process.env.AGENT_SECRET!),
  source: Keypair.fromSecret(process.env.SOURCE_SECRET!),
});
```

**Mutual exclusion validation:** You must provide exactly one of `server` or `url`. Providing both throws a typed error. Providing neither throws a typed error.

**Why inject a Server instance?**

- **Proxy routing**: Enterprise deployments route RPC through proxies that add auth headers, mTLS, or latency shielding. Configure the proxy *bufore* constructing the `SorobanRpc.Server` instance, then pass it in.
- **Deterministic testing**: Unit tests can build fake Server objects that assert calls land on them, instead of mocking URL strings scattered throughout the test suite.

**What SDK 17 actually supports**

As of `Stellar/stellar-sdk` v17, the `SorobanRpc.Server` constructor accepts `(serverUrl: string, options?: ServerOptions)` where `ServerOptions` includes `allowHttp`. It does **not** expose a custom `fetch` function injection option. Therefore, the only lever for custom transport behavior is instance injection. To route through a proxy, configure the proxy at the HTTP agent level or via a network layer before constructing the `SorobanRpc.Server`.

A pipeline stage that throws — a dropped RPC connection, say — is reported the same way:
as `kind: "error"` carrying the original error as the typed error's `cause`, never as a
rejection. A guardrail that could not reach a verdict has no business throwing at its
caller, and the original error object stays reachable for diagnostics.

If ledger state changes after enforced simulation and the included transaction is then
refused by the guard, `invoke()` still returns `kind: "blocked"` with the contract reason
and diagnostics. That charged outcome additionally carries `transactionHash` and
`charged: true`; it is not flattened into a technical `BroadcastError`.

`GuardBlockedError` keeps its published name, message, fields, and `instanceof` behavior
and now extends `GuardError`; `PreFlightUndeterminedError` extends `SimulationError`.
The hierarchy, `decodePolicy`, and `verifyAgentSignature` are additive to 0.1.x callers.
The one intentional behavior change is for callers already using `dryRun: true`: the old
success sentinel (`kind: "error"`) is replaced by the structured `kind: "dry_run"` result
documented above. Non-dry-run callers keep their existing outcome shapes.

## API Reference

> **0.x API Policy & Deprecations:** During `0.x`, this package adheres to an **additive-only within minor** policy (`0.1.x` releases are additive and fixes only; breaking changes and deprecation removals occur only at minor boundaries like `0.2.0`). For full policy details, deprecation mechanics, and the tracking table, see [`docs/deprecations.md`](docs/deprecations.md). Release process and versioning checklist: [`docs/releasing.md`](docs/releasing.md).

### Interception & Execution

- `PreFlightInterceptor`
  - `constructor(options: PreFlightInterceptorOptions)` — Pass `cache: { ttlMs }` or `cache: { ttlLedgers }` to opt into the short-lived cache; omit it for fresh simulations.
  - `check(call: ContractCall): Promise<PreFlightDecision>` — Returns `admissible | blocked | undetermined` without throwing or broadcasting.
  - `assertAllowed(call: ContractCall): Promise<AdmissibleDecision>` — Asserts allowed or throws `GuardBlockedError`.
  - `invalidate(call?: ContractCall): void` — Clears all cached decisions or only entries for one call.
- `CostPreChecker`
  - `constructor(options: CostPreCheckerOptions)`
  - `check(call: ContractCall): Promise<CostPreCheckResult>` — Returns `within_budget | over_budget | blocked | undetermined`.
  - `checkWithCost(call: ContractCall): Promise<{ decision, cost }>` — Returns the interceptor verdict and the cost of the **same** single simulation. Prefer this over calling `check()` on both classes.
- `invoke(options: InvokeOptions): Promise<InvokeResult>` — End-to-end pipeline: probe, sign auth, simulate, and broadcast. Accepts an optional `onStep(step: InvokeStepEvent)` hook reporting per-stage `start`/`ok`/`fail` timing events with a 0-based retry `attempt` index; callback exceptions are isolated and omitting the hook changes nothing.

#### Fee units: stroops and XLM

`CostPreChecker` reports fees as exact integer stroops — the raw value is the
source of truth, and it is what a `maxFeeStroops` ceiling is compared against.
`formatFee()` renders the same number in XLM, the unit operators think in, using
**integer math only** (XLM has 7 decimal places; float rounding on
money-adjacent output in a security tool is not acceptable) and with no trailing
zeros:

```ts
import { createLangChainGuardMiddleware } from "stellar-agent-guard-sdk";

const middleware = createLangChainGuardMiddleware({
  interceptor,
  guard,
  agent,
});
```

### Telemetry

```ts
import { GuardTelemetryListener } from "stellar-agent-guard-sdk";

Prefer this over calling `interceptor.check(call)` and `costChecker.check(call)`
in sequence. That two-call pattern still works and its types are unchanged, but
it carries the fee-drift caveat above. `precheckCostWithDecision()` is the
one-shot form.

### Telemetry & Helpers

- [`docs/event-schema.md`](docs/event-schema.md) — every telemetry event and field, each labelled with its stability tier: **Stable** (relied on), **Append-only** (new values may appear, existing ones will not be removed or renamed), **Best-effort** (may change in any release), **Internal** (implementation detail, not a contract).
- `GuardTelemetryListener`
  - `constructor(options: GuardTelemetryListenerOptions)`
  - `watch(params?: GuardTelemetryWatchParams): AsyncIterable<GuardEventPage>` — Tails on-chain and uncommitted events. `params.signal` aborts at loop boundaries: no RPC call before the first pull, no poll after an abort, and the delay between polls is cut short. A request already in flight cannot be cancelled — see [Aborting a watch](#aborting-a-watch-what-cancellation-does-and-does-not-cover).
  - `watchAll(params?: GuardTelemetryUnifiedParams): AsyncIterable<GuardEvent>` — Merges the committed ledger stream with the `diagnostics` batches you feed it into **one ordered, de-duplicated stream**, so a single loop sees blocked decisions too. Each event carries `stream: 'committed' | 'diagnostic'` and, for diagnostics, `observedAt`. Ordering and de-duplication rules: [`docs/event-schema.md`](docs/event-schema.md).
- `validateGuardPolicy(policy: unknown, options?: ValidatePolicyOptions | string): PolicyFailure[]` — Validates policy configuration against SPEC §8 rules prior to broadcast, accumulating all failures for complete form UX.
- `POLICY_RULE_IDS` — Canonical array of SPEC §8 validation rule identifiers.
- `policyToScVal(policy: PolicyConfig): xdr.ScVal` — Encodes a policy as the contract's canonical sorted ScVal struct.
- `decodePolicy(scVal: xdr.ScVal): PolicyConfig` — Strictly decodes `policy()`/set-policy ScVal data, including Option/Vec and numeric normalization.
- `policyFromScVal(scVal)` — Alias for callers using the issue's original function name.
- `invoke(options)` / `invoke({ ...options, dryRun: true })` — Broadcasts an admissible result, or returns the full pre-broadcast dry-run trace.
- `verifyAgentSignature(publicKey, payload, signature): boolean` — Verify-only Ed25519 check against a strkey or raw 32-byte key.
- `GuardError`, `SimulationError`, `SigningError`, `BroadcastError`, `PolicyDecodeError`, and `ContractResponseError` — Typed failure hierarchy.
- `decodeCheckResult(raw): CheckResult` — Decodes `Allowed` or `Blocked(reason)`.
- `decodeAuthDecision(event: SorobanRpc.Api.GetEventsResponse.Event): AuthDecisionEvent | null`
- `guardEventsFromDiagnostics(events: xdr.DiagnosticEvent[]): GuardEvent[]` — Each decoded `GuardEvent` carries a stable `id`: `ledger:<txHash>:<topic>` for committed events, `diag:<sha256>` for blocked ones (which are rolled back and have no hash to anchor on). Same event re-parsed → same id; two different blocks in one simulation → different ids. Format and collision notes: [`docs/event-schema.md`](docs/event-schema.md).
- `explainReason(reason: string | number): string` — Human-readable explanation of contract reason codes.
- `isDeadManFrozen(status: GuardStatus): boolean`
- `deadManRemaining(status: GuardStatus, policy: PolicyConfig | null): bigint | null`

#### Dashboard-style snapshot (issue #68)

A consumer that wants "the last N decisions, right now" — a dashboard panel, an agent status endpoint — can opt into a bounded in-memory window instead of maintaining its own store:

```ts
import { GuardTelemetryListener } from "stellar-agent-guard-sdk";

const listener = new GuardTelemetryListener({
  server,
  guard: GUARD_ID,
  buffer: { max: 200 }, // opt-in; omitted → no buffer is allocated
});

// ...drive it with listener.watch() or listener.watchAll(), then read on demand:
const lastBlocked = listener.recent({ stream: "diagnostic" });
const capRefusals = listener.recent({ reason: "per_tx_cap_exceeded" });
const recentWindow = listener.recent({ fromLedger: 4_700_000 });
```

`recent(filter?)` returns the retained events oldest-first, filtered by any of `stream`, `reason`, `fromLedger`, `toLedger`. The buffer is FIFO and non-durable: it holds only what this listener decoded in this process, and a restart empties it. Persistence across restarts is a cursor store (tracked separately), not something this buffer pretends to provide.

## Architecture

Stellar Agent Guard operates across three dedicated repositories:

listener.on("event", (event) => {
  console.log(event);
});
```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Operator (Browser / Freighter)                     │
│                                     │                                   │
│                                     ▼                                   │
│              stellar-agent-guard-dashboard (Next.js / UI)               │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   AI Agent Runtime (LangChain / ElizaOS)                │
│                                     │                                   │
│                                     ▼                                   │
│                stellar-agent-guard-sdk (TypeScript / RPC)               │
│               • Pre-flight policy check  • Cost pre-checks              │
│               • Agent-auth tx signing    • Event telemetry              │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼ Soroban RPC
┌─────────────────────────────────────────────────────────────────────────┐
│               stellar-agent-guard-contracts (Soroban / Rust)             │
│            • CustomAccount interface (`__check_auth`)                   │
│            • Spend caps, rolling window, allowlists, dead-man switch    │
└─────────────────────────────────────────────────────────────────────────┘
```

| Repository | Role | Documentation |
|---|---|---|
| [**stellar-agent-guard-contracts**](https://github.com/aigbagbobila/stellar-agent-guard-contracts) | Soroban smart contracts implementing Custom Account Abstraction and spending policy firewall | [GitBook Docs](https://soroban-cost-estimator.gitbook.io/stellar-agent-guard-contracts/) |
| [**stellar-agent-guard-sdk**](https://github.com/aigbagbobila/stellar-agent-guard-sdk) (this repo) | TypeScript SDK for pre-flight interception, simulation pricing, and AI agent framework integration | [GitHub](https://github.com/aigbagbobila/stellar-agent-guard-sdk) |
| [**stellar-agent-guard-dashboard**](https://github.com/aigbagbobila/stellar-agent-guard-dashboard) | Client-side operator dashboard for policy deployment, inspection, and emergency panic-button freeze | [GitHub](https://github.com/aigbagbobila/stellar-agent-guard-dashboard) |

## ✅ Verified against live testnet

Proven against a real deployed instance on Stellar testnet (protocol 28, `Test SDF Network ; September 2015`):

- **Guard (custom account)**: `CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44`
- **SAC Token**: `CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB`
- **WASM bytecode hash**: `f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63` (identical to Phase 1 artifact)

Verify a downloaded artifact against the pinned hash before deploying — the same constant the dashboard checks, so there is one source of truth rather than a copy per consumer:

```ts
import { readFileSync } from "node:fs";
import { verifyGuardWasm } from "stellar-agent-guard-sdk";

const result = await verifyGuardWasm(readFileSync("guard.wasm"));
if (!result.ok) {
  throw new Error(`WASM mismatch: got ${result.actual}, expected ${result.expected}`);
}
```

`verifyGuardWasm` hashes with WebCrypto (`crypto.subtle`), so the identical call runs in Node and in the browser and needs no extra dependency. It is async, because `crypto.subtle.digest` is. `GUARD_WASM_HASH` is exported if you need the constant on its own.

### 5/5 Live Enforcement Scenarios

| Scenario | Condition | Result | Evidence |
|---|---|---|---|
| 1. Within caps | Transfer 100 within caps (cap: 1000, window: 150) | **Allowed** | Tx hash `f8f5b3c51b85c8777c956d71330d015fcf72fa57548077d8b32969f8ba9c762e` at ledger `4704849` |
| 2. Per-tx cap | Transfer 1001 > 1000 cap | **Blocked** (`per_tx_cap_exceeded`) | Diagnostic event `event_auth_checked, blocked, per_tx_cap_exceeded`, pre-broadcast, 0 fees |
| 3. Rolling window | Transfer 76 + 76 = 152 > 150 window cap | **Blocked** (`window_cap_exceeded`) | Rolling window accumulation refusal, balances untouched |
| 4. Recipient allowlist | Transfer to unlisted recipient | **Blocked** (`recipient_not_allowed`) | Default-deny address check refusal |
| 5. Account paused | Call while `paused = true` | **Blocked** (`paused`) | Account-state refusal cleanly distinguished from policy caps |

Complete run output and assertion logs are preserved in [`tests/fixtures/integration-evidence.md`](tests/fixtures/integration-evidence.md).

## Honest limitations

- **Enforcement boundary for arbitrary calls**: Full amount/recipient limits are native to SAC token transfers. Arbitrary Soroban contract calls are enforced via protocol/function allowlists, active window, pause, and dead-man switches; per-call amount limits are not available generically from host auth contexts (tracked as v2).
- **Single-key agent signing today, multi-key prepared**: A guard account registers one Ed25519 agent key, and `buildGuardAuthEntry` signs the authorization digest with it. The signing path is now a seam (`AgentSigner`: sign a 32-byte digest, return signature bytes) and every public config accepts either an `AgentSigner` or a plain `Keypair` — so the current single-key behaviour is unchanged, and threshold/multi-key agent signing lands behind the same interface when the contracts repo's v2 decision does. Research, the recommended wire shape, and the revisit trigger: [`docs/concepts/multi-key-agent-signing.md`](docs/concepts/multi-key-agent-signing.md).
- **AutoGPT integration**: AutoGPT lacks an extensible pre-execution interceptor hook at the surveyed revision; findings and future integration paths are documented in [`docs/integration-hooks.md`](docs/integration-hooks.md).
- **Testnet signing credentials**: Running `npm run test:integration` requires `.env.phase2` populated with funded testnet keypairs. The live suite is **not run on every PR**: it is (a) required locally before any PR that touches the enforcement path (`src/tx.ts`, `src/invoke.ts`, `src/policy.ts`, `src/preflight.ts`), with fresh evidence committed to [`tests/fixtures/integration-evidence.md`](tests/fixtures/integration-evidence.md) and CI-verified as present, and (b) run automatically on a weekly schedule ([`.github/workflows/live-suite.yml`](.github/workflows/live-suite.yml)) to catch host/testnet drift. A green `ci` therefore means the required checks ran — not that the live suite ran against this change.
- **Pre-flight is a prediction, not a settlement guarantee**: the four known pre-flight fidelity limits (moving window state, a moving fee market, simulation not executing, approximated batch semantics) are enumerated with their mitigations, residual risks, and code citations in [Fidelity & limits](#fidelity--limits).

## Enforcement scope — read this before relying on the caps

Full recipient/amount enforcement — spend caps, allowlists, per-transaction limits — is native and automatic for SAC token transfers (`transfer`/`transfer_from`), since these are the calls whose arguments the Soroban auth context exposes for inspection. For other Soroban contract calls made by the guarded account (arbitrary DEX/lending/protocol calls), the policy engine still enforces window and pause state, but per-call amount/recipient limits are not yet enforced — extending fine-grained enforcement to arbitrary calls is tracked as a v2 item, not implied as already covered.

This boundary is an inherent property of the platform (the auth context does not expose arbitrary call arguments generically), not a gap this project hides or overclaims. The classification that produces this boundary (`AssetTransfer` vs `Protocol` vs `Unknown` default-deny) is spelled out in SPEC §6.

## Topics

`stellar`, `soroban`, `ai-agents`, `guardrails`, `custom-account`, `pre-flight`,
`spend-limits`, `cost-estimation`, `langchain`, `elizaos`, `telemetry`, `typescript`

## Maintainers

| Name | GitHub | Telegram |
|---|---|---|
| Hybrid | [@aigbagbobila](https://github.com/aigbagbobila) | [@aigbagbobila](https://t.me/+EzSusj-2vVhhNmI0) |

## Socials

- [Telegram](https://t.me/+EzSusj-2vVhhNmI0)
- [Discord](https://discord.gg/Z766vsgjg)

## Contact

- GitHub issues: <https://github.com/aigbagbobila/stellar-agent-guard-sdk/issues>
- Maintainer (GitHub): [@aigbagbobila](https://github.com/aigbagbobila)
- Security disclosures: see [SECURITY.md](https://github.com/aigbagbobila/stellar-agent-guard-contracts/blob/main/SECURITY.md) (Telegram, the Stellar ecosystem norm)

## License

MIT
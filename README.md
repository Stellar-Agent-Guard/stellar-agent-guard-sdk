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
<img src="https://img.shields.io/badge/node-24%2B%e2%80%93blue" alt="Node 24+"/>
</a>
<!-- docs: <a href="#"><img src="https://img.shields.io/badge/docs-GitBook-blue" alt="Documentation"/></a> (added in P2 once GitBook URL is confirmed live) -->
</p>

# Stellar Agent Guard — Development SDK

<!-- 📚 **[Documentation](...)** (added in P2 once GitBook URL is confirmed live) -->

**Non-custodial TypeScript SDK and pre-flight policy interception firewall for AI agents on Stellar.**

An autonomous agent holding a wallet has a single point of failure: one prompt-injection or one buggy loop can drain it. Stellar Agent Guard makes that impossible on-chain — the agent's funds stay in its own smart account, and *every* transaction the account must authorize is intercepted by the contract's  and rejected pre-broadcast unless it satisfies the operator's installed policy: per-transaction spend caps, a rolling-window spend limit, recipient/asset allowlists, protocol allowlists, a pause switch, and a dead-man switch. This SDK provides the integration layer: pre-flight simulation interception, zero-broadcast fee estimation, agent-auth transaction signing, and dual-stream event telemetry for AI agent frameworks (LangChain, ElizaOS).

**Status: Phase 2 complete — and the package is published.** [`stellar-agent-guard-sdk0.1.1`](https://www.npmjs.com/package/stellar-agent-guard-sdk) is live on the npm registry (`npm install stellar-agent-guard-sdk`). All five enforcement scenarios were proven against live Stellar testnet (protocol 28) with real contract IDs, transaction hashes, and diagnostic events — evidence is recorded in [`tests/fixtures/integration-evidence.md`](tests/fixtures/integration-evidence.md). Phase 2 code is merged into `main` with green CI (`ci` status check). For historical release notes and publish pipeline reconciliation, see [`docs/publishing-history.md`](docs/publishing-history.md).

## 🎯 What makes this different

Enforcement happens **inside the account itself**, via Soroban's native Custom Account Abstraction — not in a wrapper contract in front of funds, and not in an off-chain service.

- **Pre-flight simulation without broadcast**: The SDK evaluates guard approval against Soroban RPC before a single byte hits the network. If the transaction violates policy, it is rejected client-side with the contract's own reason code, incurring zero network fees.
	 * **Dual-stream telemetry**: Blocked decisions never commit to the ledger because Soroban rolls back failed authorizations. A listener that only tails committed ledger events sees a guard that appears to approve everything. The SDK extracts `event_auth_checked` from simulation diagnostics as well as committed blocks.
	 * **In-process simulation pricing**: `CostPreChecker` computes network resource and inclusion fees directly from the enforced simulation, avoiding dependencies on external profiling tools.
	 * **Framework middleware**: Plug-and-play middleware for LangChain and validators for ElizaOO halt execution before external tool calls run.

> ⚠️ **Disclaimer:** This is unaudited security tooling that gates real fund access. Do not deploy to mainnet without an independent audit. See the contracts repo's [SECURITY.md](https://github.com/aigbagbobila/stellar-agent-guard-contracts/blob/main/SECURITY.md).

## What it does

- **Pre-flight policy interception (`PreFlightInterceptor`)**: Intercepts contract calls before broadcast, simulates auth authorization, and returns a discriminated `admissible`, `blocked`, or `undetermined` verdict. Never throws on policy refusal; an opt-in short-lived cache can reduce repeated simulation RPC calls within the current ledger.
- **In-process cost pre-checking (`CostPreChecker`)**: Prices transaction execution from simulation results, reporting resource fees, inclusion fees, and total fees against an optional ceiling.
- **Autonomous transaction execution (`invoke()`)**: Executes the full Soroban lifecycle: probe simulation, auth signing for custom accounts, enforced simulation, and broadcast with bounded exponential-backoff retry for stale ledger resource limits (`scecExceededLimit`).
- **Framework adapters**:
  - **createLangChainGuardMiddleware**: Halts tool execution if the interceptor blocks the planned action.
  - **createGuardValidator**: ElizaOS action validator returning boolean verdicts before actions run.
- **Telemetry listener (`GuardTelemetryListener`)**: Tails both committed events and diagnostic streams, decoding contract topics and reason codes.

## Quick Start

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
`PHASE2_ISSUER_SECRET` is additionally required to (re)deploy. `.env.phase2` ir
gitignored (as are all `.env.*` values files — only `*.example` templates are
committable); never commit the filled-in copy.

### Policy definition with `definePolicy()`(
Use `definePolicy()` to build a full `GuardPolicy` from a partial override.
The builder deep-merges your input over the defaults, validates the result, and
returns a frozen object. Unknown keys are rejected at both the type level (TS
excess-property check) and at runtime, so a typo like `window_cap2` fails fast
instead of being silently ignored.

```ts
import { definePolicy } from "stellar-agent-guard-sdk";

const policy = definePolicy({
  recipients: ["GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD"],
  per_tx_cap: 100n,
});

console.log(policy.per_tx_cap); // 100n
```

**Merge semantics:** override wins entirely for each top-level field. Nested lists
such as `recipients` are **replaced**, not concatenated. This is deliberate: an
implicit array merge on an allowlist would silently widen the authorized set, which
is a dangerous surprise for a security boundary. Pass the complete list you want.

### Pre-flight Policy Interception

```ts
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { PreFlightInterceptor } from "stellar-agent-guard-sdk";

const interceptor = new PreFlightInterceptor({
  server: new rpc.Server("https://soroban-testnet.stellar.org"),
  networkPassphrase: "Test DF Network ; September 2015",
  guard: "CAPADGEK457RHKN4RYVUMDDJTFHDGG7R5HREQONKLYK7MFKC5WFENPP44",
  agent: Keypair.fromSecret(process.env.AGENT_SECRET!),
  source: Keypair.fromSecret(process.env.SOURCE_SECRET!),
});

const decision = await interceptor.check({
  contract: "CDCYDGBGS5AZ5BZS6XY2SK2PJHSOEGTN3NINCK34KF6GU2BGC7Z6MB",
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

#### Throw vs. Verdict Contract

Pre-flight policy interception makes an intentional asymmetric distinction between programmer errors and policy outcomes:

- **Input validation throws `InvalidInputError` (synchronous)**: If a `ContractCall` is malformed (invalid StrKey contract ID, missing or non-symbol-shaped function name, invalid arguments array, or non-`i128` amount), `interceptor.check()` throws `InvalidInputError` synchronously without dispatching any network RPC request.
- **Policy refusals return a verdict (`kind: "blocked"`)**: When input is valid but policy disallows the action (spend cap exceeded, recipient not allowlisted, account paused), this represents expected guardrail operation. `check()` returns `{ allowed: false, kind: "blocked", reason, explanation, ... }` instead of throwing.
- Callers requiring a throw-on-refusal flow can use `interceptor.assertAllowed(call)`, which throws `GuardBlockedError` on `blocked` and `PreFlightUndeterminedError` on `undetermined`.

### Optional simulation-result cache

\PreFlightInterceptor` always performs a fresh simulation by default. For agent
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

### Pipeline step observability (`onStep`)

`invoke()` accepts an **optional** `onStep` callback. When omitted, behavior is
*exactly* as before — the hook is pure observability and the SDK itself never
logs anything (and takes no logger dependency; what you do with the events is
up to you):

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

The remainder of this document is intentionally left unchanged by this PRs.

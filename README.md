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

<!-- 📚 **[Documentation](...)** (added in P2 once GitBook URL is confirmed live) -->

**Non-custodial TypeScript SDK and pre-flight policy interception firewall for AI agents on Stellar.**

An autonomous agent holding a wallet has a single point of failure: one prompt-injection or one buggy loop can drain it. Stellar Agent Guard makes that impossible on-chain — the agent's funds stay in its own smart account, and *every* transaction the account must authorize is intercepted by the contract's  and rejected pre-broadcast unless it satisfies the operator's installed policy: per-transaction spend caps, a rolling-window spend limit, recipient/asset allowlists, protocol allowlists, a pause switch, and a dead-man switch. This SDK provides the integration layer: pre-flight simulation interception, zero-broadcast fee estimation, agent-auth transaction signing, and dual-stream event telemetry for AI agent frameworks (LangChain, ElizaOS).

**Status: Phase 2 complete — and the package is published.** [`stellar-agent-guard-sdk@0.1.1`](https://www.npmjs.com/package/stellar-agent-guard-sdk) is live on the npm registry (`npm install stellar-agent-guard-sdk`). All five enforcement scenarios were proven against live Stellar testnet (protocol 28) with real contract IDs, transaction hashes, and diagnostic events — evidence is recorded in [`tests/fixtures/integration-evidence.md`](tests/fixtures/integration-evidence.md). Phase 2 code is merged into `main` with green CI (`ci` status check). For historical release notes and publish pipeline reconciliation, see [`docs/publishing-history.md`](docs/publishing-history.md).

## 🎯 What makes this different

Enforcement happens **inside the account itself**, via Soroban's native Custom Account Abstraction — not in a wrapper contract in front of funds, and not in an off-chain service.

- **Pre-flight simulation without broadcast**: The SDK evaluates guard approval against Soroban RPC before a single byte hits the network. If the transaction violates policy, it is rejected client-side with the contract's own reason code, incurring zero network fees.
- **Dual-stream telemetry**: Blocked decisions never commit to the ledger because Soroban rolls back failed authorizations. A listener that only tails committed ledger events sees a guard that appears to approve everything. The SDK extracts `event_auth_checked` from simulation diagnostics as well as committed blocks.
- **In-process simulation pricing**: `CostPreChecker` computes network resource and inclusion fees directly from the enforced simulation, avoiding dependencies on external profiling tools.
- **Framework middleware**: Plug-and-play middleware for LangChain and validators for ElizaOS halt execution before external tool calls run.

> ⚠️ **Disclaimer:** This is unaudited security tooling that gates real fund access. Do not deploy to mainnet without an independent audit. See the contracts repo's [SECURITY.md](https://github.com/aigbagbobila/stellar-agent-guard-contracts/blob/main/SECURITY.md).

## What it does

- **Pre-flight policy interception (`PreFlightInterceptor`)**: Intercepts contract calls before broadcast, simulates auth authorization, and returns a discriminated `admissible`, `blocked`, or `undetermined` verdict. Never throws on policy refusal.
- **In-process cost pre-checking (`CostPreChecker`)**: Prices transaction execution from simulation results, reporting resource fees, inclusion fees, and total fees against an optional ceiling.
- **Autonomous transaction execution (`invoke()`)**: Executes the full Soroban lifecycle: probe simulation, auth signing for custom accounts, enforced simulation, and broadcast with bounded retry for stale ledger resource limits (`scecExceededLimit`).
- **Framework adapters**:
  - `createLangChainGuardMiddleware`: Halts tool execution if the interceptor blocks the planned action.
  - `createGuardValidator`: ElizaOS action validator returning boolean verdicts before actions run.
- **Telemetry listener (`GuardTelemetryListener`)**: Tails both committed events and diagnostic streams, decoding contract topics and reason codes.

## Quick Start

### Installation

```bash
npm install stellar-agent-guard-sdk
```

*(Or build locally from source with Node 24+)*

```bash
git clone https://github.com/aigbagbobila/stellar-agent-guard-sdk.git
cd stellar-agent-guard-sdk
npm ci
npm run build
```

### Pre-flight Policy Interception

```ts
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { PreFlightInterceptor } from "stellar-agent-guard-sdk";

const interceptor = new PreFlightInterceptor({
  server: new rpc.Server("https://soroban-testnet.stellar.org"),
  networkPassphrase: "Test SDF Network ; September 2015",
  guard: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
  agent: Keypair.fromSecret(process.env.AGENT_SECRET!),
  source: Keypair.fromSecret(process.env.SOURCE_SECRET!),
});

const decision = await interceptor.check({
  contractId: "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB",
  method: "transfer",
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

### Framework Middleware (LangChain & ElizaOS)

```ts
import {
  createLangChainGuardMiddleware,
  createGuardValidator,
} from "stellar-agent-guard-sdk";

// LangChain: intercept agent tool calls
const middleware = createLangChainGuardMiddleware({
  interceptor,
  toContractCall: (request) => ({
    contractId: request.args.token,
    method: "transfer",
    args: [request.args.from, request.args.to, request.args.amount],
  }),
});

// ElizaOS: validate action before execution
const validate = createGuardValidator({
  interceptor,
  toContractCall: (message) => ({
    contractId: message.content.token,
    method: "transfer",
    args: [message.content.from, message.content.to, message.content.amount],
  }),
});
```

### Policy encode/decode round trip

`decodePolicy` is the canonical read-side counterpart to `policyToScVal`. It returns
`bigint` for every integer field, keeps `ProtocolRule.fns: null` distinct from an empty
array, normalizes Stellar addresses, and rejects missing, duplicate, unknown, unsorted, or
wrongly typed fields with a path-bearing `PolicyDecodeError`.

```ts
import {
  decodePolicy,
  policyToScVal,
  type PolicyConfig,
} from "stellar-agent-guard-sdk";

const policy: PolicyConfig = {
  per_tx_cap: 1_000n,
  window_secs: 60n,
  window_cap: 150n,
  assets: ["CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"],
  protocols: [
    {
      contract: "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB",
      fns: ["transfer"],
    },
  ],
  recipients: ["GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH"],
  allow_any_recipient: false,
  active_from: 0n,
  active_until: 0n,
  paused: false,
  dms_grace_secs: 0n,
};

const encoded = policyToScVal(policy);
const decoded = decodePolicy(encoded); // exactly equal to policy
```

The decoder accepts the direct `ScVal::Map` returned by the deployed `policy()` read and
also the one-element `Vec` representation used by some RPC/host surfaces for
`Some(PolicyConfig)`. `ScVal::Void` means no policy is installed and therefore throws
rather than fabricating a default-deny config. Canonical u64/i128 variants are range
checked exactly; base-10 `ScVal::String` integers are accepted as a deliberate
compatibility path for stringly-typed RPC/telemetry payloads and normalized to `bigint`.

### Debug a blocked transfer with `invoke({ dryRun: true })`

Dry run executes the real probe, authorization signing, and enforced-simulation path,
then returns the verdict, diagnostics, network-derived fees, and per-stage timings. It
stops before final transaction assembly and cannot call `sendTransaction`, so its result
has no transaction hash or submission object.

```ts
import { invoke } from "stellar-agent-guard-sdk";

const debug = await invoke({
  server,
  source,
  call: blockedTransferCall,
  networkPassphrase,
  guardAuth: { guard, agent },
  dryRun: true,
});

if (debug.kind === "dry_run") {
  console.log({
    admissible: debug.admissible,
    verdict: debug.verdict,
    reason: debug.reason,
    fees: debug.fees,
  });
  console.table(debug.steps);
}
```

A blocked or undetermined dry run reports an explicit all-zero **charged** fee breakdown;
an admissible dry run reports the simulation's resource fee plus the SDK's 100-stroop
inclusion floor. Missing, negative, malformed, unsafe-number, or out-of-u64-range fee
payloads are `ContractResponseError` failures and remain undetermined—never free.
`steps[].ok` describes whether a stage completed, not whether policy approved the call;
the separate `verdict` field is the policy answer.

### Troubleshooting agent authentication

`verifyAgentSignature` lets an agent runtime check that a signature belongs to the key it
believes is registered before entering an agent loop. The helper is verify-only: it never
accepts, signs with, stores, or derives a private key. Other SDK APIs continue to accept
caller-created `Keypair` objects for transaction/authorization signing as before.

```ts
import { verifyAgentSignature } from "stellar-agent-guard-sdk";

function signerMatches(
  registeredPublicKey: string | Uint8Array,
  hostSignaturePayload: Uint8Array,
  signature: Uint8Array,
): boolean {
  return verifyAgentSignature(
    registeredPublicKey,
    hostSignaturePayload,
    signature,
  );
}
```

`hostSignaturePayload` must be the exact 32-byte host digest covered by the signature;
the helper verifies those bytes without re-hashing and is not SEP-53 message signing. A
successful result proves only the key/payload/signature relationship—it does not validate
network ID, invocation, nonce, expiration ledger, or transaction freshness.

### Typed errors and 0.1.x migration

All SDK-owned errors now share a `GuardError` base. `invoke()` remains result-oriented:
inspect `outcome.error` with `instanceof` when `outcome.kind === "error"`.

```ts
import {
  BroadcastError,
  GuardError,
  SigningError,
  SimulationError,
} from "stellar-agent-guard-sdk";

if (outcome.kind === "error") {
  if (outcome.error instanceof SigningError) {
    console.error("agent signer is wrong or unavailable");
  } else if (outcome.error instanceof SimulationError) {
    console.error("enforcement could not be determined");
  } else if (outcome.error instanceof BroadcastError) {
    console.error("submission failed", outcome.error.transactionHash);
  } else if (outcome.error instanceof GuardError) {
    console.error(outcome.error.message);
  }
}
```

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

### Interception & Execution

- `PreFlightInterceptor`
  - `constructor(options: PreFlightInterceptorOptions)`
  - `check(call: ContractCall): Promise<PreFlightDecision>` — Returns `admissible | blocked | undetermined` without throwing or broadcasting.
  - `assertAllowed(call: ContractCall): Promise<AdmissibleDecision>` — Asserts allowed or throws `GuardBlockedError`.
- `CostPreChecker`
  - `constructor(options: CostPreCheckerOptions)`
  - `check(call: ContractCall): Promise<CostPreCheckResult>` — Returns `within_budget | over_budget | blocked | undetermined`.
- `invoke(options: InvokeOptions): Promise<InvokeResult>` — End-to-end pipeline: probe, sign auth, simulate, and broadcast.

### Telemetry & Helpers

- `GuardTelemetryListener`
  - `constructor(options: GuardTelemetryListenerOptions)`
  - `watch(signal?: AbortSignal): AsyncIterable<GuardEventPage>` — Tails on-chain and uncommitted events.
- `policyToScVal(policy: PolicyConfig): xdr.ScVal` — Encodes a policy as the contract's canonical sorted ScVal struct.
- `decodePolicy(scVal: xdr.ScVal): PolicyConfig` — Strictly decodes `policy()`/set-policy ScVal data, including Option/Vec and numeric normalization.
- `policyFromScVal(scVal)` — Alias for callers using the issue's original function name.
- `invoke(options)` / `invoke({ ...options, dryRun: true })` — Broadcasts an admissible result, or returns the full pre-broadcast dry-run trace.
- `verifyAgentSignature(publicKey, payload, signature): boolean` — Verify-only Ed25519 check against a strkey or raw 32-byte key.
- `GuardError`, `SimulationError`, `SigningError`, `BroadcastError`, `PolicyDecodeError`, and `ContractResponseError` — Typed failure hierarchy.
- `decodeCheckResult(raw): CheckResult` — Decodes `Allowed` or `Blocked(reason)`.
- `decodeAuthDecision(event: SorobanRpc.Api.GetEventsResponse.Event): AuthDecisionEvent | null`
- `guardEventsFromDiagnostics(events: xdr.DiagnosticEvent[]): GuardEvent[]`
- `explainReason(reason: string | number): string` — Human-readable explanation of contract reason codes.
- `isDeadManFrozen(status: AccountStatus | null, policy: GuardPolicy | null, nowSecs?: number): boolean`
- `deadManRemaining(status: AccountStatus | null, policy: GuardPolicy | null, nowSecs?: number): number | null`

## Architecture

Stellar Agent Guard operates across three dedicated repositories:

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
- **AutoGPT integration**: AutoGPT lacks an extensible pre-execution interceptor hook at the surveyed revision; findings and future integration paths are documented in [`docs/integration-hooks.md`](docs/integration-hooks.md).
- **Testnet signing credentials**: Running `npm run test:integration` requires `.env.phase2` populated with funded testnet keypairs. The live suite is **not run on every PR**: it is (a) required locally before any PR that touches the enforcement path (`src/tx.ts`, `src/invoke.ts`, `src/policy.ts`, `src/preflight.ts`), with fresh evidence committed to [`tests/fixtures/integration-evidence.md`](tests/fixtures/integration-evidence.md) and CI-verified as present, and (b) run automatically on a weekly schedule ([`.github/workflows/live-suite.yml`](.github/workflows/live-suite.yml)) to catch host/testnet drift. A green `ci` therefore means the required checks ran — not that the live suite ran against this change.

## Enforcement scope — read this before relying on the caps

Full recipient/amount enforcement — spend caps, allowlists, per-transaction limits — is native and automatic for SAC token transfers (`transfer`/`transfer_from`), since these are the calls whose arguments the Soroban auth context exposes for inspection. For other Soroban contract calls made by the guarded account (arbitrary DEX/lending/protocol calls), the policy engine still enforces window and pause state, but per-call amount/recipient limits are not yet enforced — extending fine-grained enforcement to arbitrary calls is tracked as a v2 item, not implied as already covered.

This boundary is an inherent property of the platform (the auth context does not expose arbitrary call arguments generically), not a gap this project hides or overclaims. The classification that produces this boundary (`AssetTransfer` vs `Protocol` vs `Unknown` default-deny) is spelled out in SPEC §6.

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

Licensed under [MIT](LICENSE). This is unaudited security tooling that gates real fund access — see the contracts repo's [SECURITY.md](https://github.com/aigbagbobila/stellar-agent-guard-contracts/blob/main/SECURITY.md) before considering mainnet use.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for details on coding standards, PR process, and
project structure — including the strict one-commit-per-logical-unit rule.

Looking for something to work on? The
[issue backlog](https://github.com/aigbagbobila/stellar-agent-guard-sdk/issues)
holds scoped issues with Summary / Acceptance Criteria / Tech Stack — good first tasks for
the Drips Stellar Wave contributor sprints.

![Contributors](https://contrib.rocks/image?repo=aigbagbobila/stellar-agent-guard-sdk)

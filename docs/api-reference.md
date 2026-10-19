# API Reference

The Stellar Agent Guard SDK exposes the following public surface. For the narrative pitch and quickstart, see the [repository README](../README.md).

> **0.x API Policy & Deprecations:** During `0.x`, this package adheres to an **additive-only within minor** policy (`0.1.x` releases are additive and fixes only; breaking changes and deprecation removals occur only at minor boundaries like `0.2.0`). For full policy details, deprecation mechanics, and the tracking table, see [`deprecations.md`](deprecations.md). Release process and versioning checklist: [`releasing.md`](releasing.md).

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
- `startHeartbeat(options): Promise<HeartbeatHandle>` — Drift-aware dead-man keep-alive. Fires `heartbeat()` on an interval, reports lateness (`handle.missedBeats`, `onBeat`'s `lateMs`), routes every failure to `onError`, validates `interval <= grace/3` before the first beat when the grace window is readable, and stops cleanly (`await handle.stop()`). See “Keep the dead-man switch alive”.
- `submitHeartbeat(params): Promise<HeartbeatSubmission>` — Signs and submits a single `heartbeat()` with the agent's guard authorization; the default submission `startHeartbeat` uses.

#### Fee units: stroops and XLM

`CostPreChecker` reports fees as exact integer stroops — the raw value is the
source of truth, and it is what a `maxFeeStroops` ceiling is compared against.
`formatFee()` renders the same number in XLM, the unit operators think in, using
**integer math only** (XLM has 7 decimal places; float rounding on
money-adjacent output in a security tool is not acceptable) and with no trailing
zeros:

```ts
import { formatFee } from "stellar-agent-guard-sdk";

cost.totalFeeStroops;            // 12345n           — stroops (exact, source of truth)
formatFee(cost.totalFeeStroops); // "0.0012345"      — same value in XLM

formatFee(1n);             // "0.0000001" — one stroop
formatFee(9_999_999n);     // "0.9999999" — largest sub-XLM value
```

#### `CostPreChecker` resource breakdown

Priced `within_budget` and `over_budget` results may include a `breakdown` parsed from the same Soroban simulation that produced `resourceFeeStroops`:

```ts
if (decision.kind === "within_budget" && decision.breakdown) {
  console.log(decision.breakdown);
  // {
  //   instructions,       // SorobanResources.instructions
  //   diskReadBytes,      // SorobanResources.diskReadBytes
  //   writeBytes,         // SorobanResources.writeBytes
  //   readOnlyEntries,    // footprint.readOnly.length
  //   readWriteEntries,   // footprint.readWrite.length
  //   storageEntries      // readOnlyEntries + readWriteEntries
  // }
}
```

`breakdown` is `undefined` when the simulation is undetermined, malformed, or missing any required resource field; the SDK never fabricates zero values. The stellar-sdk v17 Soroban resource payload has no `memBytes` field, so this API reports the actual `writeBytes`/disk resource fields rather than relabeling them as memory usage.

#### One simulation per check: prefer `checkWithCost`

`PreFlightInterceptor.check()` answers *may this proceed?* and
`CostPreChecker.check()` answers *what will it cost?* — but calling both runs the
enforced simulation **twice**, against two ledger snapshots. The extra RPC is the
lesser problem: the fee reported for a call can then differ from the fee implied
by the verdict that was actually enforced, so the price no longer corresponds to
the approved decision.

`CostPreChecker.checkWithCost()` returns both from a **single** simulation:

```ts
const { decision, cost } = await costChecker.checkWithCost(call);

if (decision.kind === "blocked") {
  console.log("refused:", decision.reason);        // nothing was charged
} else if (cost.kind === "over_budget") {
  console.log("too expensive:", formatFee(cost.totalFeeStroops), "XLM");
} else if (decision.allowed) {
  console.log("approved at", formatFee(cost.totalFeeStroops), "XLM");
}
```

Prefer this over calling `interceptor.check(call)` and `costChecker.check(call)`
in sequence. That two-call pattern still works and its types are unchanged, but
it carries the fee-drift caveat above. `precheckCostWithDecision()` is the
one-shot form.

### Telemetry & Helpers

- [`event-schema.md`](event-schema.md) — every telemetry event and field, each labelled with its stability tier: **Stable** (relied on), **Append-only** (new values may appear, existing ones will not be removed or renamed), **Best-effort** (may change in any release), **Internal** (implementation detail, not a contract).
- `GuardTelemetryListener`
  - `constructor(options: GuardTelemetryListenerOptions)`
  - `watch(params?: GuardTelemetryWatchParams): AsyncIterable<GuardEventPage>` — Tails on-chain and uncommitted events. `params.signal` aborts at loop boundaries: no RPC call before the first pull, no poll after an abort, and the delay between polls is cut short. A request already in flight cannot be cancelled — see [Aborting a watch](../README.md#aborting-a-watch-what-cancellation-does-and-does-not-cover).
  - `watchAll(params?: GuardTelemetryUnifiedParams): AsyncIterable<GuardEvent>` — Merges the committed ledger stream with the `diagnostics` batches you feed it into **one ordered, de-duplicated stream**, so a single loop sees blocked decisions too. Each event carries `stream: 'committed' | 'diagnostic'` and, for diagnostics, `observedAt`. Ordering and de-duplication rules: [`event-schema.md`](event-schema.md).
  - `serializeEvent(event: GuardEvent): string` — Canonical single-line JSON for deterministic JSON-lines log shipping. Fixed key order, drops `undefined`, keeps `null`, renders `bigint` as a decimal string. Contract: [`event-schema.md`](event-schema.md#canonical-json-serialization--serializeevent).
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
- `decodeGuardEventXdr(xdrBase64: string, source?: 'ledger' | 'diagnostic'): GuardAuthDecision | null` — Offline decode of a raw base64 event XDR. Accepts either a `DiagnosticEvent` (what `getEvents()` and a simulation error carry) or a `ContractEvent` (what a block explorer exposes) and returns the same decision the object-path decode produces. Malformed base64, an XDR that is not a contract event, and an event that is not an `event_auth_checked` decision all return `null` — it never throws, so fixture checks and operator copy-paste cannot crash a long-running process.
- `guardEventsFromDiagnostics(events: xdr.DiagnosticEvent[]): GuardEvent[]` — Each decoded `GuardEvent` carries a stable `id`: `ledger:<txHash>:<topic>` for committed events, `diag:<sha256>` for blocked ones (which are rolled back and have no hash to anchor on). Same event re-parsed → same id; two different blocks in one simulation → different ids. Format and collision notes: [`event-schema.md`](event-schema.md).
- `GuardLogger`, `GuardLoggerInput`, `GuardLogMeta`, `GUARD_LOG_LEVELS` — the optional, structurally-typed log sink shared by every config above; `SILENT_LOGGER` is what a config resolves to when none is supplied. See [Optional logging](../README.md#optional-logging-the-sdk-is-silent-unless-you-ask).
- `explainReason(reason: string | number, locale?, overrides?): string` — Human-readable explanation of contract reason codes. The default call is unchanged; the optional `locale` catalog and per-reason `overrides` localise or reword a refusal without an i18n dependency. Reason keys, titles and remediation text: [`reasonMessages` / `reasonMessagesEn`](#reason-messages-issue-96).
- `isDeadManFrozen(status: GuardStatus): boolean`
- `deadManRemaining(status: GuardStatus, policy: PolicyConfig | null): bigint | null`
- `dmsUrgency(status: GuardStatus, policy: PolicyConfig | null, nowSecs?: bigint, warnRatio = DMS_WARN_RATIO_DEFAULT): 'ok' | 'warn' | 'expired' | 'unknown'` — Dead-man countdown urgency for dashboards: `warn` from `warnRatio` (default `DMS_WARN_RATIO_DEFAULT` = 0.8) of the grace period, `expired` once the grace has elapsed. `unknown` exactly where `deadManRemaining` is `null` (no policy, switch disabled, never heartbeated — never ≠ expired).
- `policyDiff(a: PolicyConfig, b: PolicyConfig): PolicyChange[]` — Structured change list between two policies for operator display (e.g. when the policy revision bumps; dashboard change-history feed: stellar-agent-guard-dashboard#17). Lists compare as sets, so a pure reorder is no change; protocols match by contract and report `fns` changes at paths like `protocols[0].fns[1]`.

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

#### Raw events for bug reports (issue #94)

When a decoded verdict looks wrong, attach the **undecoded source event** to the SDK bug report. Decoding discards it by default — the raw payload carries XDR `ScVal`s and host-shaped objects, and retaining one per event is a memory decision — so it is opt-in:

```ts
// Committed feed: opt in on the listener.
const listener = new GuardTelemetryListener({ server, guard: GUARD_ID, includeRaw: true });

// Diagnostic feed: opt in at the decode site.
const events = guardEventsFromDiagnostics(diagnosticEvents, GUARD_ID, { includeRaw: true });

// Every event then carries `raw`: the `rpc.Api.EventResponse` for a committed
// event, or the host-shaped diagnostic object for a blocked one.
const event = (await listener.poll({ startLedger })).events[0];
console.error(JSON.stringify(event.raw, (_key, value) =>
  typeof value === "bigint" ? value.toString() : value));
```

When `includeRaw` is not set, `raw` is **absent** (undefined) — nothing is retained. Leave it off in a long-running fleet; turn it on for the debugging session or the bug-report window. The `id` field stays stable either way, so a raw event can be correlated with the decoded event it produced.

#### Reason messages (issue #96)

`reasonMessages` exposes each reason's numeric code and its stable title/body/remediation keys, and `reasonMessagesEn` holds the built-in English text — so a dashboard can render a table, and a consumer can key its own translations, without the SDK taking an i18n dependency:

```ts
import { reasonMessages, reasonMessagesEn, explainReason } from "stellar-agent-guard-sdk";

for (const [reason, { code, titleKey, remediationKey }] of Object.entries(reasonMessages)) {
  console.log(code, reasonMessagesEn[reason as keyof typeof reasonMessagesEn].title, remediationKey);
}

// Localise one reason; a missing key falls back to English.
explainReason("per_tx_cap_exceeded", {
  [reasonMessages.per_tx_cap_exceeded.bodyKey]: "Le montant dépasse le plafond par transaction.",
});

// Or override individual reasons outright.
explainReason("paused", undefined, { paused: "Agent paused by the operator." });
```

#### Ship events to your logger

`serializeEvent(event)` gives you one canonical JSON line per event, so a log pipeline gets a stable, diffable record with no logger dependency in the SDK:

```ts
import { serializeEvent } from "stellar-agent-guard-sdk";

for await (const event of listener.watchAll({ diagnostics })) {
  logger.info(serializeEvent(event)); // one deterministic JSON line per event
}
```

Key order, the drop-`undefined`/keep-`null` policy, and the `bigint`-to-decimal-string normalization are documented in [`event-schema.md`](event-schema.md#canonical-json-serialization--serializeevent).

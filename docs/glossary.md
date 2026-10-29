# Glossary of guard terms

New to Stellar Agent Guard? This page is the shared vocabulary used across the
[SDK README](../README.md), the [concepts](concepts/) pages and the contracts
repository. Each term is one sentence, followed by the authoritative source to
read next and, where it changes what an integrator must do, a one-line "why it
matters to you".

> **Scope.** Definitions describe behavior this SDK and the deployed contract
> implement. Contract semantics are owned by the
> [contracts SPEC](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SPEC.md);
> SDK behavior is owned by the [SDK README](../README.md). Where the two meet,
> the link points at the owning repository rather than copying its prose.

## Verdicts

### Pre-flight

The read-only simulation the SDK runs **before** a transaction is signed for
broadcast, asking the guard contract what it would decide for a candidate call.
[How pre-flight works](concepts/pre-flight-interception.md#how-pre-flight-works)

*Why it matters:* a refusal is free — no transaction is submitted and no network
fee is paid.

### Simulation

A Soroban RPC dry run that executes the call against current ledger state
without committing anything; the pre-flight verdict is read from that run's
return value and diagnostic events.
[Pre-flight interception](concepts/pre-flight-interception.md)

### Broadcast

Submitting a signed transaction to the network for inclusion in a ledger. The
SDK's `invoke()` performs broadcast; `PreFlightInterceptor.check()` never does.
[Invoke pipeline](api/invoke-pipeline.md)

### Admissible

The verdict meaning the guard approved the call in simulation — it is predicted
to pass `__check_auth` on-chain.
[Decision outcomes](concepts/pre-flight-interception.md#decision-outcomes)

*Why it matters:* "admissible" is a prediction, not a settlement guarantee; the
contract still enforces the policy at broadcast.

### Blocked

The verdict meaning the guard explicitly refused the call, carrying the
contract's own reason code.
[Decision outcomes](concepts/pre-flight-interception.md#decision-outcomes)

*Why it matters:* this is the guardrail working. Nothing was broadcast, so
nothing was spent.

### Undetermined

The verdict meaning the guard did **not** reach a policy decision (simulation
failed, RPC unreachable, malformed response). It is treated as not-allowed.
[Decision outcomes](concepts/pre-flight-interception.md#decision-outcomes)

*Why it matters:* adapters fail closed on `undetermined`; never render it as
"allowed" to an operator.

### Reason code

The stable snake_case symbol in a `blocked` verdict (for example
`per_tx_cap_exceeded`), owned by the contract and explained by the SDK.
[Reason messages](../README.md#reason-messages-issue-96)

*Why it matters:* branch and alert on the code, not on human-readable text.

## The three halts

Three separate mechanisms can stop an account; they are not synonyms.

### Pause

A boolean in the installed policy (`paused`) that turns every spend off without
removing the policy; clearing it is a policy-admin action.
[What it does](../README.md#what-it-does) · reason `paused`

### Admin freeze

A manual, account-level freeze an admin applies independently of the policy;
only an admin can unfreeze it.
[FAQ](faq.md#what-happens-if-the-dead-man-switch-triggers) · reason `admin_frozen`

### Dead-man switch (DMS)

An automatic freeze that fires when the agent has not sent a heartbeat within
the policy's `dms_grace_secs` grace period. In the contract this is the
`heartbeat_expired` condition; a lapsed grace window also surfaces as
`admin_frozen`, because both leave the account frozen.
[FAQ](faq.md#what-happens-if-the-dead-man-switch-triggers) · reason
`heartbeat_expired`

*Why it matters:* a keep-alive process that stops is a fund-access outage, not
just a monitoring gap.

### Heartbeat

The agent-signed transaction that records "still alive" and resets the dead-man
switch countdown.
[Keep the dead-man switch alive](../README.md#keep-the-dead-man-switch-alive-startheartbeat)

## Policy and limits

### Guard policy (`GuardPolicy` / `PolicyConfig`)

The operator-installed rule set enforced inside the smart account: caps,
allowlists, active window, pause and dead-man grace.
[Policy validation](../README.md#policy-validation-before-broadcast-validateguardpolicy) · [SPEC §8](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SPEC.md)

### Per-transaction cap (`per_tx_cap`)

The maximum amount a single transfer may move, in the asset's smallest unit.
[Enforcement scope](enforcement-scope.md)

*Why it matters:* it is the first limit checked and the most common reason a
single oversized transfer is blocked (`per_tx_cap_exceeded`).

### Rolling window (`window_secs`, `window_cap`)

A spend budget of `window_cap` over a trailing `window_secs` period; spending
inside the window accumulates until the budget is exhausted
(`window_cap_exceeded`).
[What it does](../README.md#what-it-does) · [SPEC §8](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SPEC.md)

*Why it matters:* a burst of individually valid transfers can still hit the
window limit, and the window is enforced on-chain at broadcast.

### Allowlist

The policy's explicit permit lists: recipients (`recipients`), assets
(`assets`) and protocol contracts/functions (`protocols`). An entry not on the
relevant list is refused (`recipient_not_allowed`, `asset_not_allowed`,
`protocol_not_allowed`, `function_not_allowed`).
[Enforcement scope](enforcement-scope.md)

*Why it matters:* allowlists are default-deny; an empty list does not mean "no
restriction".

### Active window (`active_from`, `active_until`)

An optional wall-clock interval during which the policy is enforceable; outside
it, calls are refused with `outside_active_window`.
[Policy validation](../README.md#policy-validation-before-broadcast-validateguardpolicy)

*Why it matters:* `0` means "unset", not the Unix epoch — `active_from`/`0` does
not schedule the policy in 1970.

### Ledger

The Stellar chain state at a point in time, identified by a ledger sequence
number. Rolling windows, heartbeats and pre-flight verdicts are all evaluated
against ledger state.
[Architecture](architecture.md)

*Why it matters:* a cached verdict is only valid for the ledger it was computed
against; never treat one as durable.

## Enforcement and signing

### Guard contract / smart account

The Soroban custom account that holds the agent's funds and enforces the policy
inside `__check_auth`; the SDK never custodies funds.
[Architecture](architecture.md) · [SPEC §1](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SPEC.md#1-mechanism-and-non-custodial-guarantee)

### SAC (Stellar Asset Contract)

The standard Soroban contract that wraps a Stellar asset and exposes
`transfer`/`transfer_from`. These are the calls whose arguments the auth context
exposes, so recipient/amount enforcement is native to them.
[Enforcement scope](enforcement-scope.md)

*Why it matters:* the same caps are **not** generically enforceable on arbitrary
contract calls.

### Protocol boundary / arbitrary call

Any non-SAC contract call made by the guarded account (DEX, lending, other
protocols). The policy still enforces allowlists, window and pause state, but
per-call amount/recipient limits are not available for them.
[Enforcement scope](enforcement-scope.md)

*Why it matters:* do not assume a transfer-shaped cap guards an arbitrary
protocol call.

### `__check_auth`

The Soroban custom-account entry point the host calls to authorize a
transaction; it is where the guard evaluates the policy and emits its decision.
[Design principles](design-principles.md#1-fail-closed-an-undetermined-verdict-halts) · [SPEC §1](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SPEC.md#1-mechanism-and-non-custodial-guarantee)

### Agent key

The Ed25519 key registered as the account's agent. It signs auth entries for
ordinary agent actions and heartbeats; it cannot change the policy.
[Custom account signing](concepts/custom-account-signing.md)

### Admin key

The separate key that installs or changes the policy, pauses it, and freezes or
unfreezes the account. It is not the agent key.
[Architecture](architecture.md) · [SPEC](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SPEC.md)

*Why it matters:* a compromised agent key is bounded by the policy; the admin
key is the policy.

### Auth entry / auth payload

The authorization record attached to a Soroban invocation, signed by the agent
key over a digest that binds the entry to the transaction and payload.
[Signature binding](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SPEC.md#101-signature-binding) · [Custom account signing](concepts/custom-account-signing.md)

*Why it matters:* a signature is bound to one payload; it cannot be replayed for
a different call.

## Telemetry

### `event_auth_checked`

The contract event emitted for every guard decision, including blocked decisions
that are rolled back before reaching the ledger.
[Event schema](event-schema.md)

### Dual-stream telemetry

The SDK's combination of committed **ledger** events and uncommitted
**diagnostic** events from simulation, so blocked decisions remain observable.
[Dual-stream telemetry](concepts/dual-stream-telemetry.md)

*Why it matters:* a ledger-only listener sees a guard that appears to approve
everything, because failed authorizations emit nothing on-chain.

---

**See also:** [Introduction](introduction.md) · [Concepts](concepts/) ·
[API reference](api/) · [Troubleshooting](troubleshooting.md) ·
[SDK README](../README.md)

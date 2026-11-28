# Reason codes

`GuardBlockedError.reason` (and a blocked `auth_checked` event) carries one of the
stable snake_case names in `GUARD_REASON_CODES`. Branch on that name or its
numeric `code`; never branch on `explainReason()` prose. The table below lists
every code. The Name column links to the [`explainReason()` API](api-reference.md#reason-messages-issue-96);
the References column also links to the vendored [contract glossary fixture](../tests/fixtures/vendor/reasons.fixture.json)
that pins each code to the contracts repository.

`tests/unit/reason-code-docs.test.ts` derives the expected set from
`GUARD_REASON_CODES`, so adding a code without adding its row here fails
`npm test`.

## Policy refusal or account state?

**Account state** means the guard itself is not ready: initialization is missing,
the account is paused/frozen, the dead-man switch fired, there is no policy, or
the current ledger time is outside the active window. The remedy is an operator
action, a heartbeat, or waiting — not changing the agent's call. These six codes
are the exported `ACCOUNT_STATE_REASONS` set.

**Policy refusal** means the guard was ready and evaluated this call against
policy, but the call or account configuration was not allowed. Changing the
call, or updating the policy through the proper admin path, is the remedy.

| Code | Name | Meaning (`explainReason()`) | Example trigger | Safe next action | Class | References |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `unauthorized` | The presented signature did not verify against the account's registered agent key. | agent signs with an unregistered key while `AgentPubkey` is `G...AGENT`. | Register the agent key on the guard account, or sign with the registered key. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L28) |
| 2 | `already_initialized` | The guard account has already been initialized. | admin calls `initialize()` again while the `Initialized` ledger entry exists. | Read the existing guard state instead of initializing it again. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L36) |
| 3 | `not_initialized` | The guard account has no registered agent key yet. | agent submits `transfer` before the admin has run `initialize()`. | Initialize the guard account and register an agent key. | Account state | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L44) |
| 4 | `invalid_config` | The policy configuration was rejected by validation and was not applied. | admin calls `set_policy()` with `window_cap = 100n` but `window_secs = 0`. | Fix the failing validation rules and re-submit the policy. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L52) |
| 5 | `invalid_amount` | The transfer amount was zero or negative. | SAC `transfer` is submitted with `amount = 0` (or a negative amount). | Send a positive transfer amount. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L60) |
| 6 | `no_pending_admin` | The account has no pending admin rotation to confirm or cancel. | admin calls `confirm_admin_rotation()` when no rotation was started. | Start an admin rotation first, then confirm or cancel it. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L68) |
| 10 | `admin_frozen` | An admin froze the account (freeze), or the dead-man switch grace window lapsed. | admin called `freeze()`, or the dead-man grace elapsed and the account is frozen. | Unfreeze the account with an admin signature, or check the dead-man switch. | Account state | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L76) |
| 11 | `heartbeat_expired` | The dead-man switch fired: no heartbeat within the policy's grace window, so the account is frozen until an admin unfreezes it. | no heartbeat is submitted for longer than a 3600-second grace window. | Have an admin unfreeze the account, then resume agent heartbeats. | Account state | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L84) |
| 12 | `no_policy` | No policy is installed (never set, or revoked) — the account is default-deny. | agent calls `transfer` after the account policy was revoked. | Install a policy for the account before the agent transacts. | Account state | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L92) |
| 13 | `paused` | The policy's admin kill switch is engaged. | agent calls `transfer` while the policy admin has set `paused = true`. | Clear the policy's paused flag as the policy admin. | Account state | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L100) |
| 14 | `outside_active_window` | The current ledger time is outside the policy's active_from/active_until window. | ledger time is before `active_from` (or after `active_until`) for the configured window. | Retry within the policy's active_from/active_until window. | Account state | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L108) |
| 20 | `asset_not_allowed` | The SAC token being called is not in the policy's assets list. | agent transfers a SAC token whose address is absent from `policy.assets`. | Add the SAC token to the policy's assets list. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L116) |
| 21 | `recipient_not_allowed` | The transfer recipient is not in the policy's recipients allowlist. | agent transfers to `G...NOT_ALLOWED`, which is not in `policy.recipients`. | Add the recipient to the policy's allowlist. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L124) |
| 22 | `per_tx_cap_exceeded` | The transfer amount exceeds the policy's per-transaction cap. | policy cap is 1000 stroops and the transfer is 1001 stroops. | Reduce the transfer to the policy's per-transaction cap or below. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L132) |
| 23 | `window_cap_exceeded` | The transfer would push cumulative spend over the rolling-window cap. | window cap is 5000, committed spend is 4900, and the transfer is 200. | Wait for the rolling window to free capacity, or reduce the amount. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L140) |
| 24 | `protocol_not_allowed` | The contract being called is not in the policy's protocols allowlist. | agent calls a DEX contract address absent from `policy.protocols`. | Add the contract to the policy's protocols allowlist. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L148) |
| 25 | `function_not_allowed` | The function being called on an allowlisted contract is not in its function allowlist. | allowlisted protocol permits `swap`, but the agent calls `withdraw`. | Add the function to the allowlisted contract's function list. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L156) |
| 26 | `unknown_contract` | The contract being called is neither the account itself, an allowlisted asset, nor an allowlisted protocol (default deny). | agent calls `C...UNKNOWN`, which is neither an asset nor an allowlisted protocol. | Allowlist the contract as an asset or protocol, or call the account itself. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L172) |
| 27 | `self_function_not_allowed` | The call targets a guard function that the agent key may not invoke. | agent key invokes an admin-only guard function on the account itself. | Invoke the guard function from an admin key, not the agent key. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L180) |
| 28 | `create_contract_not_allowed` | The account may not authorize contract creation. | guarded account authorizes a `create_contract` host function. | Create the contract from an admin account instead of the guarded account. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L188) |
| 29 | `recipient_blocked` | The transfer recipient is explicitly blocked by the account's policy. | agent transfers to an address listed in `policy.blocked_recipients`. | Send to a different recipient, or remove the block if it is no longer wanted. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L196) |
| 30 | `protocol_call_rate_exceeded` | The call would push the rolling protocol-call count past its configured limit. | protocol rate limit is 10 calls per window and the agent submits the 11th. | Wait for the rolling window to free capacity, or make fewer protocol calls. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L204) |
| 31 | `decision_invariant_violation` | The guard's decision engine hit an internal invariant, so the call was refused rather than allowed. | replaying a call leaves the decision engine with contradictory allow/block state; no normal call should trigger it. | Treat this as a guard defect: capture the call and report it to the contract maintainers. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L212) |
| 32 | `asset_fn_not_allowed` | The call invoked a function other than `transfer` on an allowlisted asset. | agent calls `mint` on an allowlisted SAC instead of `transfer`. | Call `transfer`, or allowlist the asset's function explicitly. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L164) |
| 33 | `too_many_auth_contexts` | The call carried more authorization contexts than the guard's decision engine evaluates. | a batch carries more authorization contexts than the decision engine evaluates. | Split the call so each authorization carries fewer contexts. | Policy refusal | [explainReason()](api-reference.md#reason-messages-issue-96) · [contract fixture](../tests/fixtures/vendor/reasons.fixture.json#L220) |

## Worked blocked call

A policy allows `transfer` up to 1000 stroops. The agent submits 1001:

```ts
import {
  GuardBlockedError,
  explainReason,
  unsafeContractAddress,
  type ContractCall,
} from "stellar-agent-guard-sdk";

const call: ContractCall = {
  contract: unsafeContractAddress(
    "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
  ),
  fn: "transfer",
  args: [],
};

try {
  await interceptor.assertAllowed(call);
} catch (error) {
  if (error instanceof GuardBlockedError) {
    console.log(error.code); // 22
    console.log(error.reason); // "per_tx_cap_exceeded" (policy refusal)
    console.log(explainReason(error.reason));
    // "The transfer amount exceeds the policy's per-transaction cap."
    throw error; // fail closed: nothing is executed or broadcast
  }
  throw error;
}
```

The same code appears on the diagnostic `auth_checked` event; the full decoded
event and operator interpretation are in
[Event Schema, Example 2](event-schema.md#example-2--a-blocked-decision-on-the-diagnostic-stream).

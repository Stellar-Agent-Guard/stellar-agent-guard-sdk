# Troubleshooting

Use the symptom text or outcome below as a search term. The SDK fails closed: an
`undetermined` result or adapter mapping failure does not mean the guard approved
the action.

| Symptom to search for | Likely cause | Fix |
|---|---|---|
| `kind: "undetermined"` during an RPC outage, rate limit, or `RPC call during '…' exceeded timeout of …ms` | The simulation could not produce a trustworthy verdict because the RPC is unavailable, throttling, or slower than the request budget. | Confirm the configured RPC endpoint/network and reduce caller-generated RPC pressure with application-level scheduling. There is no SDK `concurrency` option. Set `timeoutMs` on `PreFlightInterceptor.check()` (or adapter `timeoutMs`) to bound each RPC; `invoke()` also accepts `deadlineMs` for a whole-pipeline budget. A timeout bounds SDK waiting, not necessarily the already-sent RPC. |
| `sequence_number_collision` or a submitted transaction rejected for a bad sequence | Another process or code path submitted from the same fee-paying `source` account while this invocation was building, or the RPC returned a stale sequence snapshot. | `invoke()` serializes transactions per source account within one process. Route all same-account submissions through that queue; across processes or other SDKs, add a shared sequence coordinator or use separate fee-paying accounts. Local serialization cannot coordinate external broadcasters. See [invoke pipeline](api/invoke-pipeline.md). |
| `kind: "blocked"` with a `reason` such as `paused`, `heartbeat_expired`, `per_tx_cap_exceeded`, or `recipient_not_allowed` | This is a policy/account refusal, not an RPC failure. For example, `paused` is the admin kill switch; `heartbeat_expired` means the dead-man grace elapsed; `per_tx_cap_exceeded` means the transfer exceeded its per-transaction cap; `window_cap_exceeded` means rolling spend is over budget. | Read the exact reason with `explainReason(reason)` or `reasonMessagesEn[reason]`; the latter includes operator remediation. Check the full [SDK reason glossary](api-reference.md#reason-messages-issue-96) and the [contracts-side operator reason glossary](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/docs/reason-glossary.md). |
| `heartbeat_expired` / `admin_frozen` or `dmsUrgency(...) === "expired"` | The dead-man grace elapsed, or an administrator froze the account. `dmsUrgency()` is display guidance; it does not unfreeze or authorize anything. | Start and monitor `startHeartbeat()` at an interval no greater than one third of the configured grace window. Use `dmsUrgency()` and `DMS_WARN_RATIO_DEFAULT` to surface the countdown. An admin must perform the [contract unfreeze procedure](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/docs/functions/freeze-unfreeze.md); the SDK exposes `submitUnfreeze()`. Resume heartbeats after unfreezing. |
| `call mapping failed before enforcement` or `the langchain adapter's call mapper threw` | The adapter's `toContractCall` mapper threw (often a typo in the mapped contract/function/arguments) before the guard could check the action. For example: `call mapping failed before enforcement: the langchain adapter's call mapper threw: Cannot read properties of undefined`. | Correct the mapper and its inputs. Adapter mapping failures halt execution as `undetermined`; the wrapped tool does not run. Use the exact `toContractCall` option name (or `toContractCalls` for a batch); see [framework adapter options](api/framework-adapters.md). |
| `kind: "over_budget"` | The estimated total fee (resource fee plus inclusion fee) exceeds `maxFeeStroops`. | Raise the `CostPreChecker` ceiling only if the operator's budget permits it. `maxFeeStroops` is a non-negative `bigint`; omission means no fee ceiling, while `0n` is a real zero-stroop ceiling. A per-call ceiling overrides the configured one. This is a pre-flight estimate, not a network fee guarantee; see [cost pre-checking](api/cost-checker.md). |
| `tx_bad_auth` or an auth-entry signature verification failure after changing networks | The transaction/auth signature was prepared for a different network passphrase than the RPC network. | Set `networkPassphrase` to the passphrase for the same network served by `server` (for example, testnet is `Test SDF Network ; September 2015`). Keep guard address, RPC URL, and passphrase from the same deployment. |
| `watch()` yields no events, or `onStreamError` receives a terminal RPC error | The listener may be watching the wrong guard/network, starting after the events of interest, or may have exhausted its bounded retries. A process restart without persisted cursor state can also skip events. | Verify the listener's guard and RPC configuration, and subscribe before the actions to observe. Use `startLedger` for a ledger-range start or `cursor` with its `resumeLedger` for resume/gap detection; persist progress with `cursorStore` (and `failedTxCursorStore` separately when failed-transaction scanning is enabled). Handle `onGap` and `onStreamError`; the terminal error is also available from `getLastError()`. There is no `startFrom` option. See [telemetry listener](api/telemetry-listener.md). |
| `GuardTelemetryListener already has an active watch()/watchAll() stream` | A second stream was started on a listener that already owns an active stream. A listener shares cursor and de-duplication state and supports one active stream. | Finish/abort the existing stream before starting another, or create a separate `GuardTelemetryListener` for the independent stream. |

## What is not an SDK option

The current API does not expose `concurrency` or `startFrom`; do not add either
to an integration config expecting the SDK to act on it. Limit parallel work in
the caller, and use the supported timeout, cursor, and listener options above.
## Authorization entries not signed

Ensure the invoke pipeline receives a valid agent key and that the custom account `__check_auth` policy admits the call. Blocked calls are rejected client-side before broadcast.

## No telemetry events emitted

Confirm the `GuardTelemetryListener` is subscribed before the invoke pipeline runs. Simulation diagnostics are only available during the pre-flight window.

## Agent Key Rotation and Recovery

See the [Agent Key Rotation and Recovery runbook](concepts/custom-account-signing.md#operator-runbook-agent-key-rotation-and-recovery) for procedures to rotate the agent key of a custom account and recover from rotation failures.

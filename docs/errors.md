# Error catalog

Branch on the error class and its stable fields (`code`, `rule`, `kind`, `path`,
`reason`, `stage`), never on message text. Most operational errors extend
`GuardError`; invalid caller input is the deliberate `TypeError` exception.

**Retryable** in this catalog means exactly what
`isRetryableHeartbeatFailure()` returns for that class: `Yes` only for
`BroadcastError`, `RpcTimeoutError`, `SimulationError` and its
`RateLimitedError` subclass. **Fail-closed** says what the SDK does with the
action when the error is produced: `Yes` means no unverified approval is
returned; `N/A` means the error is rejected before any verdict or submission is
possible; `Ambiguous` means a transaction may already be on the network and the
caller must check before retrying.

## Logging an error

`JSON.stringify(error)` normally prints `{}` because `Error.message` is not
enumerable. Every error exported by the SDK (and `HeartbeatIntervalError` /
`InvokeRetryError` outside the `GuardError` root) implements `toJSON()`, so a
structured logger needs no custom replacer:

```ts
JSON.stringify(error);
// {"name":"PolicyValidationError","message":"…","path":"p.json","failures":[…]}
```

The result carries `name`, `message`, every class-specific field and a
summarized `cause` (`{ name, message, code? }` for an `Error`, `{ type }` for a
non-error object — never a full request object or stack). Bigints become decimal
strings so `JSON.stringify` cannot throw. Diagnostic events, XDR envelopes,
signatures and raw payloads are omitted at every depth, including nested fields
such as `BroadcastError.failure.resultXdr`.

For blocked verdicts, see the [reason messages](../README.md#reason-messages-issue-96)
and [troubleshooting](troubleshooting.md#error-classes). For policy rule IDs,
see the [policy rules table](api/policy-schema.md#schema-enforced-vs-code-enforced-rules);
for policy field paths, see [policy JSON error paths](api/policy-json.md#error-paths).

## Which error should I catch?

- **Invalid argument or option?** `InvalidInputError`, `InvalidFeeCeilingError`,
  `PolicyEncodeError`, `AdapterConfigError`, `HeartbeatIntervalError`. Fix the
  caller; do not retry unchanged.
- **Policy file problem?** `PolicyFileReadError` (filesystem), then
  `PolicyValidationError` (SPEC rule failures), then `PolicyDecodeError`
  (wire-shape failures). The `path`/`code`/`failures` fields distinguish them.
- **Guard refused the call?** `GuardBlockedError`. Read `reason` and use
  `explainReason(reason)`; this is a decision, not a transport failure.
- **Guard could not decide?** `GuardUndeterminedError` (aliased as
  `PreFlightUndeterminedError`) or `SimulationError` / `RateLimitedError` /
  `RpcTimeoutError`. Fail closed; retry only the classes marked `Yes` above.
- **Signature, submission or fee problem?** `SigningError`, `BroadcastError`,
  `InvokeRetryError`, `FeeCapExceededError`. Inspect `address`,
  `transactionHash`, `retry` and the fee fields before deciding whether to retry.
- **Heartbeat problem?** `HeartbeatBlockedError`, `HeartbeatDryRunError`,
  `HeartbeatIntervalError`. These are reported through the heartbeat callback.
- **Adapter or telemetry setup problem?** `AdapterMappingError`,
  `AdapterConfigError`, `ConcurrentTelemetryStreamError`.

## Error classes

### `GuardError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `GuardError` | Any | Base class for operational SDK errors; carries `message`, `name` and optional `cause`. Direct throws happen in heartbeat paths, but most failures use a subclass. | No | Depends on subclass | Branch on the concrete subclass; log `name`, `message` and `cause`. |

### `GuardUndeterminedError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `GuardUndeterminedError` | Pre-flight or submission | The guard made no decision. Fields: `stage` (`preflight` / `submission`), `detail`, `cause`. | No | Yes — no approval is returned | Inspect `cause`; check RPC health and guard state. A blocked verdict is a different class. |

### `PreFlightUndeterminedError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `PreFlightUndeterminedError` | Pre-flight | Compatibility alias for `GuardUndeterminedError`, not a distinct class; `error.name` is still `GuardUndeterminedError`. | No | Yes — same as `GuardUndeterminedError` | Catch `GuardUndeterminedError` in new code. |

### `InvalidInputError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `InvalidInputError` | Before RPC | A caller argument had the wrong shape. Fields: `field`, `rule`, optional `detail`; extends `TypeError`. Rules include `required`, `invalid_format`, `symbol_shape`, `array`, `typed_scval`, `missing_argument`. | No | N/A — rejected before work starts | Fix the named `field` according to `rule`. |

### `InvalidFeeCeilingError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `InvalidFeeCeilingError` | Config or per-call override | A fee ceiling was not a non-negative `bigint` in stroops. Fields: `field`, `value`; inherited `rule` is `non_negative_bigint`. | No | N/A — rejected before a policy is used | Pass a non-negative `bigint` such as `500_000n`; `0n` is a valid zero ceiling. |

### `SimulationError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `SimulationError` | `probe`, `simulate` or `preflight` | Simulation failed or produced no contract verdict. Fields: `stage`, `diagnosticEvents`, `cause`. | Yes | Yes — no verdict is trusted | Check RPC health, `stage`, `diagnosticEvents`, guard address and network. |

### `RateLimitedError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `RateLimitedError` | Pre-flight simulation | The RPC returned HTTP 429 after bounded retries. Fields: `kind = "rate_limited"`, `retryAfterMs`, `attempts`, `stage`; extends `SimulationError`. | Yes | Yes — verdict cause is `rate_limited` | Wait `retryAfterMs`, then lower `maxConcurrentSimulations` or raise the RPC limit. |

### `SigningError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `SigningError` | Signing | An authorization signature could not be produced. Fields: `address`, `cause`. | No | Yes — no authorized transaction is submitted | Check signer identity, registered agent key, network passphrase and `address`. |

### `BroadcastError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `BroadcastError` | Submission | `sendTransaction` failed or the fee-bump budget was exhausted. Fields: `kind = "error"`, `transactionHash`, `attempts`, `lastFee`, `failure` (`resultXdr`, `resultCode`, `message`, `diagnosticEvents`), `detail`, `retry`. | Yes | Ambiguous — a submitted transaction may be on the network | If `transactionHash` exists, query `getTransaction` before resubmitting; otherwise inspect `retry.exhausted` and fee-bump bounds. |

### `FeeCapExceededError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `FeeCapExceededError` | Before broadcast | Caller fee ceiling exceeded. Fields: `code = "fee_cap_exceeded"`, `maxFeeCap`, `resourceFeeStroops`, `inclusionFeeStroops`, `totalFeeStroops`, `attempt`. Declared and exported, but no current SDK call site emits it. | No | Yes — nothing is broadcast | Raise the caller's ceiling only if the operator budget permits it; compare the resource and inclusion fee breakdown. |

### `ContractResponseError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `ContractResponseError` | Any contract read | A contract response did not match the expected shape. Fields: `field`, optional `stage`, `cause`. | No | Yes — malformed data is not treated as approval | Verify RPC/network, `networkPassphrase` and WASM compatibility; log `field` and `stage`. |

### `PolicyDecodeError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `PolicyDecodeError` | Policy read | A policy ScVal did not match the deployed wire shape. Field: `path` (dotted field path). | No | Yes — the unreadable policy is not used | Read `path`; compare it with [policy JSON error paths](api/policy-json.md#error-paths). |

### `PolicyEncodeError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `PolicyEncodeError` | Policy draft encode | A draft cannot be represented on-chain. Fields: `path`, `rule`, `failures`; rule IDs are `invalid_type`, `missing_field`, `invalid_address`, `invalid_symbol`, `integer_out_of_range`. Extends `InvalidInputError`. | No | N/A — no partial policy is produced | Fix every item in `failures` and check the [policy rules table](api/policy-schema.md#schema-enforced-vs-code-enforced-rules). |

### `PolicyFileReadError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `PolicyFileReadError` | Filesystem read | A policy file could not be read. Fields: `path`, `code` (`ENOENT`, `EACCES`, `EISDIR`, or `null`), `cause`. | No | N/A — parsing never starts | Check the path and permissions; branch on `code`, not the message. |

### `PolicyValidationError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `PolicyValidationError` | File validation | JSON parsed but SPEC §8 validation failed. Fields: `path`, `failures[]` (`path`, `rule`, `message`). | No | Yes — the invalid policy is not installed | Render every failure and match rule IDs in the [policy rules table](api/policy-schema.md#schema-enforced-vs-code-enforced-rules). |

### `AdapterMappingError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `AdapterMappingError` | Adapter mapping | A framework mapper threw or returned an invalid call. Fields: `field` (`toContractCall` / `toContractCalls`), `cause`. | No | Yes — the wrapped tool does not run | Fix the mapper named by `field`; see [call mapping failures](api/framework-adapters.md#call-mapping-and-mapping-failures). |

### `AdapterConfigError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `AdapterConfigError` | Adapter construction | Adapter options were missing or malformed. Fields: `field`, `expected`, `adapter`, `cause`. | No | N/A — construction fails before any action | Fix the named adapter option to match `expected`. |

### `GuardBlockedError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `GuardBlockedError` | Pre-flight or submission | The guard refused the call. Fields: `reason`, `code`, `explanation`, `stage`, `charged`, `detail`, `call`, `rawEvent`; `toJSON()` is logging-safe. | No | Yes — a refused call is never allowed | Use `explainReason(reason)` and the [reason messages](../README.md#reason-messages-issue-96); account-state blocks need admin/window/heartbeat action, not retries. |

### `RpcTimeoutError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `RpcTimeoutError` | Any RPC | A request exceeded its deadline. Fields: `kind = "timeout"`, `stage`, `aborted`, `deadline`, optional `timeoutMs`, `transactionHash`, `cause = "timeout"`. | Yes | Yes, until network state is checked | If `transactionHash` exists, query the network first; otherwise check RPC health, `signal` and `timeoutMs`. |

### `InvokeRetryError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `InvokeRetryError` | Invoke retry budget exhausted | A result-oriented error returned from `invoke()`, not thrown and not a `GuardError`. Fields: `kind = "error"`, `attempts`, `lastCause`, `retry`, `lastOutcome`, `transactionHash`. | No | Ambiguous — the last attempt may be on the network | Inspect `lastCause`, `retry` and `transactionHash` before any new submission. |

### `HeartbeatBlockedError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `HeartbeatBlockedError` | Heartbeat submission | The guard refused a heartbeat. Fields: `reason`, `detail`. | No | Yes — the failed beat is not counted | Read `reason`; unfreeze/resume heartbeat or fix account state before continuing. |

### `HeartbeatDryRunError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `HeartbeatDryRunError` | Heartbeat dry run | The transport was configured for `dryRun`, so no heartbeat was submitted. Fields: `kind = "dry_run"`, `verdict`, `reason`, `detail`. | No | N/A — no submission was requested | Remove `dryRun: true` when real heartbeats are required. |

### `HeartbeatIntervalError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `HeartbeatIntervalError` | Heartbeat setup | The interval is too long for the configured grace period; extends `Error`, not `GuardError`. Fields: `intervalMs`, `graceSecs`, `maxIntervalMs`. | No | N/A — the heartbeat never starts | Set `intervalMs` to at most `maxIntervalMs` (`graceSecs / 3`). |

### `ConcurrentTelemetryStreamError`

| Class | Typical stage | Meaning | Retryable | Fail-closed | First fix |
| --- | --- | --- | --- | --- | --- |
| `ConcurrentTelemetryStreamError` | Telemetry setup | A listener already owns an active stream. Fields: `code = "telemetry.concurrent_stream"`, `requested` (`watch` / `watchAll`). | No | N/A — the second stream is rejected before RPC or cursor movement | Abort/finish the existing stream or create a separate `GuardTelemetryListener`. |

# Invoke Pipeline API

## `invoke(params: InvokeParams): Promise<InvokeOutcome>`

Executes an end-to-end transaction through the guard:
1. Runs probe simulation to collect required authorization entries.
2. Signs authorization entries with the agent key.
3. Runs enforced simulation through `__check_auth`.
4. Assembles transaction envelope and submits to Soroban RPC.
5. Retries a post-broadcast stale-ledger resource rejection with bounded full-jitter exponential backoff.

Every retry calls the entire pipeline again, so the account sequence, required authorizations, resource declaration, and guard policy decision are refreshed from current ledger state. Non-retryable errors, including invalid input and guard blocks, return immediately without sleeping.

### Retry options

Pass `retry` on `InvokeParams`:

| Option | Default | Meaning |
| --- | ---: | --- |
| `maxAttempts` | `3` | Total attempts, including the first. |
| `baseDelayMs` | `100` | First full-jitter window. |
| `maxDelayMs` | `2_000` | Cap for later full-jitter windows. |
| `random` | `Math.random` | RNG injection point. |
| `sleep` | `setTimeout` | Async sleep injection point. |

The delay for retry `n` is `random() × min(maxDelayMs, baseDelayMs × 2^(n-1))`, which is full jitter rather than a fixed sleep. When the retry budget is exhausted, the result is an `InvokeRetryError` with `attempts`, `lastCause`, `cause`, and `lastOutcome`. `InvokeOptions` is an alias for `InvokeParams` for compatibility with the README.

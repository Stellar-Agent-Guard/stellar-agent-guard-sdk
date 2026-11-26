# Simulation Cost Pre-Checking

The SDK introduces `CostPreChecker` to enforce transaction fee budgets before committing funds to network fees.

## Why In-Process Simulation Pricing?

Other tools profile local compiled WASM files via CLI invocations. In contrast, an AI agent runtime interacts with contracts already deployed on-chain.

`CostPreChecker` extracts `minResourceFee` directly from the enforced simulation:
- **Resource Fee**: Ledger read/write footprint, CPU instructions, memory allocation.
- **Inclusion Fee**: Base transaction inclusion cost.
- **Total Fee**: Total stroops required for execution.

Priced decisions may also expose a `breakdown` containing the simulation's actual
`instructions`, `diskReadBytes`, and `writeBytes` resource limits plus derived
read-only/read-write/total storage-footprint entry counts. The breakdown is
omitted when the simulation does not provide a complete resource block; it is
never replaced with fabricated zeroes.

If an operator specifies `maxFeeStroops`, calls exceeding the limit return `over_budget`. The ceiling accepts a non-negative `bigint` or a base-10 integer string through the Stellar u64 fee limit; malformed strings and out-of-range values are rejected with `InvalidInputError` before any simulation. `0n` and `"0"` are real ceilings rather than the same as omitting the option. Blocked calls are reported as `blocked` with an explicitly zero fee.

Priced decisions also carry `provenance: { ledger } | null`, copied from the same enforced simulation response that produced the fee. It identifies the ledger snapshot a quote describes; it is informational and not a promise of where the transaction will land. When the simulation response has no usable ledger marker, provenance is `null` instead of a fabricated number.

Two additive fields answer the obvious follow-up questions:

- `surplusStroops: bigint | null` — exactly how much room is left under the ceiling (`ceiling - total`, clamped at zero, `null` when no ceiling exists). An `over_budget` decision reports `0n` and its breach through `kind`.
- `headroomWarning` — opt-in with `warnAtRatio` (a ratio in `(0, 1]`). When the quote reaches that fraction of the ceiling, a structured warning is attached without changing `kind` or `allowed`. Off by default; `within_budget` at exactly the ratio warns.

`feeSource: "rpc"` can price the inclusion fee from `getFeeStats` at
`percentile` (`p50`, `p90` or `p99`) instead of the fixed floor. Fee stats are
read once per priced check, the resource fee still comes from the same enforced
simulation, and a failed or malformed response falls back to the fixed fee with
a visible `provenance.fallbackReason`. This is a prediction of the next ledger's
fee market, not a guarantee: the market can move before submission, which is why
`"fixed"` remains the offline default.

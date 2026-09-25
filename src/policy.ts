/**
 * Guards against drift between this SDK and the deployed contract's types.
 *
 * A `#[contracttype]` struct crosses the host boundary as an `ScVal::Map` keyed
 * by field-name symbols, so these types are also the argument shape for
 * `set_policy`. `policyToScVal` builds exactly that, field by field, rather than
 * relying on a type-spec DSL — every cap keeps full i128 precision.
 *
 * Field names are exactly the contract's `PolicyConfig` / `ProtocolRule` /
 * `Status` field names as they appear in the Soroban spec
 * (`stellar-agent-guard-contracts/src/types.rs`), which is also how
 * `scValToNative` decodes them. Numeric fields stay `bigint` — the contract's
 * caps are `i128` and silently narrowing them to `number` would lose precision
 * on exactly the values a spend guard exists to compare.
 */
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export interface ProtocolRule {
  contract: string;
  /** `null` means "any function on this contract". */
  fns: string[] | null;
}

export interface PolicyConfig {
  per_tx_cap: bigint;
  window_secs: bigint;
  window_cap: bigint;
  assets: string[];
  protocols: ProtocolRule[];
  recipients: string[];
  allow_any_recipient: boolean;
  active_from: bigint;
  active_until: bigint;
  paused: boolean;
  dms_grace_secs: bigint;
}

/** Type alias for PolicyConfig matching contract documentation and external vocabulary. */
export type GuardPolicy = PolicyConfig;

export interface GuardStatus {
  has_policy: boolean;
  admin_frozen: boolean;
  heartbeat_expired: boolean;
  last_heartbeat: bigint;
  now: bigint;
}

/**
 * `CheckResult` is a Rust enum over the wire; `scValToNative` decodes the unit
 * variant `Allowed` to the string `"Allowed"` and `Blocked(Symbol)` to an
 * object like `{ Blocked: "recipient_not_allowed" }`.
 */
export type CheckResult =
  | { kind: "allowed" }
  | { kind: "blocked"; reason: string };

/**
 * Encode a `PolicyConfig` as the `ScVal::Map` the contract's `set_policy`
 * expects. Values are emitted as i128/u64/bool/Vec, matching the Rust struct
 * field types exactly.
 *
 * Keys MUST be sorted. The host converts an `ScVal::Map` into a typed struct by
 * walking entries in order, and rejects an unsorted map at conversion time:
 * `HostError: Error(Object, InvalidInput) — ScMap was not sorted by key for
 * conversion to host object`. Sorting by the symbol text is the same order the
 * host's `Symbol` comparison uses.
 */
export function policyToScVal(policy: PolicyConfig): xdr.ScVal {
  const entries: Array<{ key: string; val: xdr.ScVal }> = [
    { key: "per_tx_cap", val: nativeToScVal(policy.per_tx_cap, { type: "i128" }) },
    { key: "window_secs", val: nativeToScVal(policy.window_secs, { type: "u64" }) },
    { key: "window_cap", val: nativeToScVal(policy.window_cap, { type: "i128" }) },
    {
      key: "assets",
      val: xdr.ScVal.scvVec(policy.assets.map((asset) => new Address(asset).toScVal())),
    },
    {
      key: "protocols",
      val: xdr.ScVal.scvVec(
        policy.protocols.map((rule) =>
          sortedScMap([
            { key: "contract", val: new Address(rule.contract).toScVal() },
            {
              key: "fns",
              val:
                rule.fns === null
                  ? xdr.ScVal.scvVoid()
                  : xdr.ScVal.scvVec(rule.fns.map((fn) => xdr.ScVal.scvSymbol(fn))),
            },
          ]),
        ),
      ),
    },
    {
      key: "recipients",
      val: xdr.ScVal.scvVec(policy.recipients.map((address) => new Address(address).toScVal())),
    },
    { key: "allow_any_recipient", val: xdr.ScVal.scvBool(policy.allow_any_recipient) },
    { key: "active_from", val: nativeToScVal(policy.active_from, { type: "u64" }) },
    { key: "active_until", val: nativeToScVal(policy.active_until, { type: "u64" }) },
    { key: "paused", val: xdr.ScVal.scvBool(policy.paused) },
    { key: "dms_grace_secs", val: nativeToScVal(policy.dms_grace_secs, { type: "u64" }) },
  ];
  return sortedScMap(entries);
}

/**
 * Build an `ScVal::Map` with symbol keys in ascending order, as the host
 * requires for struct conversion. Comparison is by code unit, which for the
 * ASCII field names used by the contract is byte order.
 */
function sortedScMap(entries: Array<{ key: string; val: xdr.ScVal }>): xdr.ScVal {
  const sorted = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return xdr.ScVal.scvMap(
    sorted.map(
      (item) =>
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(item.key), val: item.val }),
    ),
  );
}

export function decodeCheckResult(raw: unknown): CheckResult {
  if (raw === "Allowed") return { kind: "allowed" };
  if (raw && typeof raw === "object" && "Blocked" in (raw as Record<string, unknown>)) {
    const reason = (raw as { Blocked: unknown }).Blocked;
    return { kind: "blocked", reason: typeof reason === "string" ? reason : String(reason) };
  }
  throw new Error(`unexpected CheckResult payload from the guard: ${JSON.stringify(raw)}`);
}

/** True when the dead-man switch has fired: frozen by silence, not by an admin. */
export function isDeadManFrozen(status: GuardStatus): boolean {
  return status.heartbeat_expired && !status.admin_frozen;
}

/**
 * Seconds of grace remaining before the dead-man switch fires. `null` when the
 * switch is disabled (`dms_grace_secs == 0`), a positive number while the agent
 * is still within grace, and a negative number once the account is frozen.
 */
export function deadManRemaining(status: GuardStatus, policy: PolicyConfig | null): bigint | null {
  if (!policy || policy.dms_grace_secs === 0n || status.last_heartbeat === 0n) return null;
  return status.last_heartbeat + policy.dms_grace_secs - status.now;
}

/** A compact, log-friendly rendering of the policy in force. */
export function describePolicy(policy: PolicyConfig | null): string {
  if (!policy) return "no policy installed (default-deny: every action is blocked)";
  const parts = [
    `per-tx cap ${policy.per_tx_cap}`,
    `rolling window ${policy.window_cap} / ${policy.window_secs}s`,
    `${policy.assets.length} asset(s)`,
    policy.allow_any_recipient
      ? "any recipient"
      : `${policy.recipients.length} allowlisted recipient(s)`,
    `${policy.protocols.length} allowlisted protocol(s)`,
    policy.paused ? "PAUSED" : "active",
    policy.dms_grace_secs > 0n ? `dead-man grace ${policy.dms_grace_secs}s` : "dead-man switch off",
  ];
  return parts.join(", ");
}

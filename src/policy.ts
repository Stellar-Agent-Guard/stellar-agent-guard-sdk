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
import { Address, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { ContractCall } from "./tx.ts";

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

/**
 * Extract the token transfer amount from a SAC contract call.
 *
 * Full recipient/amount enforcement is native to SAC token transfers (`transfer`
 * and `transfer_from`). For `transfer(from, to, amount)`, the amount is the 3rd
 * argument (index 2). For `transfer_from(spender, from, to, amount)`, the amount
 * is the 4th argument (index 3).
 *
 * Returns null if the call is not a recognized SAC transfer or if the amount
 * argument cannot be decoded into a BigInt.
 */
export function extractTransferAmount(call: ContractCall): bigint | null {
  const arg =
    call.fn === "transfer" ? call.args?.[2] : call.fn === "transfer_from" ? call.args?.[3] : undefined;
  if (arg === undefined) return null;
  if (typeof arg === "bigint") return arg;
  if (typeof arg === "number") return BigInt(arg);
  try {
    const native = scValToNative(arg);
    return typeof native === "bigint" ? native : BigInt(native as number | string);
  } catch {
    return null;
  }
}

/**
 * Read one of a contract's persistent storage entries from ledger state via RPC.
 */
export async function readPersistentEntry(
  server: rpc.Server,
  contractId: string,
  dataKeyName: string,
): Promise<{ value: unknown; lastModifiedLedgerSeq: number | null } | null> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(dataKeyName)]),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
  const response = await server.getLedgerEntries(key);
  const entry = response.entries?.[0] as unknown as {
    val?: { contractData?: () => { val?: () => xdr.ScVal } | { val?: xdr.ScVal } } | { contractData?: { val?: xdr.ScVal } };
    lastModifiedLedgerSeq?: number;
  };
  let scval: xdr.ScVal | undefined;
  if (entry?.val) {
    const contractData =
      typeof (entry.val as { contractData?: unknown }).contractData === "function"
        ? (entry.val as { contractData: () => { val?: unknown } }).contractData()
        : (entry.val as { contractData?: { val?: unknown } }).contractData;
    if (contractData) {
      scval =
        typeof contractData.val === "function"
          ? (contractData.val() as xdr.ScVal)
          : (contractData.val as xdr.ScVal);
    }
  }
  if (!scval) return null;
  return {
    value: scValToNative(scval) as unknown,
    lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq ?? null,
  };
}

/**
 * Read the live policy and committed window spent from ledger state via RPC.
 */
export async function fetchGuardPolicyAndWindow(
  server: rpc.Server,
  guard: string,
): Promise<{ policy: PolicyConfig | null; windowSpent: bigint }> {
  const [policyEntry, windowEntry] = await Promise.all([
    readPersistentEntry(server, guard, "Policy"),
    readPersistentEntry(server, guard, "Window"),
  ]);

  let policy: PolicyConfig | null = null;
  if (policyEntry?.value && typeof policyEntry.value === "object") {
    policy = policyEntry.value as PolicyConfig;
  }

  let windowSpent = 0n;
  if (windowEntry?.value && typeof windowEntry.value === "object") {
    const windowObj = windowEntry.value as { total?: bigint | number };
    windowSpent = BigInt(windowObj.total ?? 0);
  }

  return { policy, windowSpent };
}


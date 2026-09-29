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
import { ContractResponseError, PolicyDecodeError } from "./errors.ts";
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

const POLICY_FIELDS = [
  "active_from",
  "active_until",
  "allow_any_recipient",
  "assets",
  "dms_grace_secs",
  "paused",
  "per_tx_cap",
  "protocols",
  "recipients",
  "window_cap",
  "window_secs",
] as const;
const PROTOCOL_RULE_FIELDS = ["contract", "fns"] as const;
const I128_MIN = -(2n ** 127n);
const I128_MAX = 2n ** 127n - 1n;
const U64_MAX = 2n ** 64n - 1n;

/**
 * Decode a `PolicyConfig` returned by the guard's `policy()` read, or the map
 * accepted by `set_policy`.
 *
 * This is the strict inverse of `policyToScVal`. Normalisation is deliberately
 * explicit because the same ScVal can reach callers through several SDK/RPC
 * surfaces:
 *
 * - a policy map is accepted directly; some RPC surfaces also wrap
 *   `Some(PolicyConfig)` in a one-element `Vec`, so that shape is accepted too;
 * - `fns: None` is `ScVal::Void` and becomes `null`, while
 *   `fns: Some(Vec<Symbol>)` becomes a string array;
 * - u64/i128 values become `bigint` without precision loss. Canonical XDR
 *   integers are decoded as integers; an `ScVal::String` containing a base-10
 *   integer is also accepted for stringly-typed RPC/telemetry payloads, then
 *   range-checked against u64/i128 bounds;
 * - address values must be `ScVal::Address` and are normalised to canonical
 *   Stellar strkeys; function names must be `ScVal::Symbol`.
 *
 * Maps must contain every expected field exactly once, no unknown fields, and
 * symbol keys in canonical ascending order. The decoder checks representation
 * and numeric bounds, but intentionally does not duplicate the contract's
 * cross-field policy validation: a `PolicyConfig` read back from the chain is
 * already valid, and local drafts should be validated before encoding.
 *
 * A missing policy (`Void`) is not a `PolicyConfig`; it throws a typed
 * `PolicyDecodeError` rather than inventing a default-deny policy value.
 */
export function decodePolicy(scVal: xdr.ScVal): PolicyConfig {
  try {
    const fields = symbolMap(policyMap(scVal), "policy", POLICY_FIELDS);
    return {
      per_tx_cap: policyInteger(
        fields.get("per_tx_cap")!,
        "per_tx_cap",
        "i128",
        I128_MIN,
        I128_MAX,
      ),
      window_secs: policyInteger(fields.get("window_secs")!, "window_secs", "u64", 0n, U64_MAX),
      window_cap: policyInteger(
        fields.get("window_cap")!,
        "window_cap",
        "i128",
        I128_MIN,
        I128_MAX,
      ),
      assets: addressVector(fields.get("assets")!, "assets"),
      protocols: protocolRules(fields.get("protocols")!),
      recipients: addressVector(fields.get("recipients")!, "recipients"),
      allow_any_recipient: policyBoolean(
        fields.get("allow_any_recipient")!,
        "allow_any_recipient",
      ),
      active_from: policyInteger(fields.get("active_from")!, "active_from", "u64", 0n, U64_MAX),
      active_until: policyInteger(fields.get("active_until")!, "active_until", "u64", 0n, U64_MAX),
      paused: policyBoolean(fields.get("paused")!, "paused"),
      dms_grace_secs: policyInteger(
        fields.get("dms_grace_secs")!,
        "dms_grace_secs",
        "u64",
        0n,
        U64_MAX,
      ),
    };
  } catch (error) {
    if (error instanceof PolicyDecodeError) throw error;
    throw policyDecodeFailure("policy", "could not decode ScVal", error);
  }
}

/** Alias matching the issue terminology; `decodePolicy` is the canonical name. */
export function policyFromScVal(scVal: xdr.ScVal): PolicyConfig {
  return decodePolicy(scVal);
}

function policyMap(scVal: xdr.ScVal): xdr.ScVal {
  if (scVal.type === "scvMap") return scVal;
  if (scVal.type === "scvVec") {
    const values = (scVal as unknown as { vec?: xdr.ScVal[] }).vec ?? [];
    if (values.length === 1 && values[0]?.type === "scvMap") return values[0];
    throw policyDecodeFailure(
      "policy",
      `expected a policy map or a one-element Some(policy) vector, got ${values.length} vector item(s)`,
    );
  }
  if (scVal.type === "scvVoid") {
    throw policyDecodeFailure("policy", "no policy is installed (Void is None, not a config)");
  }
  throw policyDecodeFailure("policy", `expected a map, got ${scVal.type}`);
}

function symbolMap(
  scVal: xdr.ScVal,
  path: string,
  expectedFields: readonly string[],
): Map<string, xdr.ScVal> {
  if (scVal.type !== "scvMap") throw policyDecodeFailure(path, `expected a map, got ${scVal.type}`);

  const entries = (scVal as unknown as { map?: xdr.ScMapEntry[] }).map ?? [];
  const fields = new Map<string, xdr.ScVal>();
  let previous: string | null = null;

  for (const entry of entries) {
    if (entry.key.type !== "scvSymbol") {
      throw policyDecodeFailure(`${path}.<key>`, `expected a symbol key, got ${entry.key.type}`);
    }
    const name = String(scValToNative(entry.key));
    if (fields.has(name)) throw policyDecodeFailure(path, `duplicate field ${JSON.stringify(name)}`);
    if (previous !== null && name <= previous) {
      throw policyDecodeFailure(path, `symbol keys are not sorted (${previous} precedes ${name})`);
    }
    if (!expectedFields.includes(name)) {
      throw policyDecodeFailure(path, `unknown field ${JSON.stringify(name)}`);
    }
    fields.set(name, entry.val);
    previous = name;
  }

  const missing = expectedFields.filter((name) => !fields.has(name));
  if (missing.length > 0) throw policyDecodeFailure(path, `missing field(s): ${missing.join(", ")}`);
  return fields;
}

function policyInteger(
  scVal: xdr.ScVal,
  path: string,
  wireType: "u64" | "i128",
  min: bigint,
  max: bigint,
): bigint {
  const expectedType = wireType === "u64" ? "scvU64" : "scvI128";
  if (scVal.type !== expectedType && scVal.type !== "scvString") {
    throw policyDecodeFailure(
      path,
      `expected ${wireType} (${expectedType}), or a decimal string, got ${scVal.type}`,
    );
  }

  const native = scValToNative(scVal);
  let value: bigint;
  if (typeof native === "bigint") {
    value = native;
  } else if (typeof native === "number") {
    if (!Number.isSafeInteger(native)) {
      throw policyDecodeFailure(path, `number ${native} cannot be represented safely`);
    }
    value = BigInt(native);
  } else if (typeof native === "string" && /^[+-]?\d+$/.test(native)) {
    value = BigInt(native);
  } else {
    throw policyDecodeFailure(path, "value is not a base-10 integer");
  }

  if (value < min || value > max) {
    throw policyDecodeFailure(path, `${value} is outside the supported [${min}, ${max}] range`);
  }
  return value;
}

function policyBoolean(scVal: xdr.ScVal, path: string): boolean {
  if (scVal.type !== "scvBool") {
    throw policyDecodeFailure(path, `expected bool, got ${scVal.type}`);
  }
  const value = scValToNative(scVal);
  if (typeof value !== "boolean") throw policyDecodeFailure(path, "value did not decode to bool");
  return value;
}

function policyVec(scVal: xdr.ScVal, path: string): xdr.ScVal[] {
  if (scVal.type !== "scvVec") {
    throw policyDecodeFailure(path, `expected Vec, got ${scVal.type}`);
  }
  return (scVal as unknown as { vec?: xdr.ScVal[] }).vec ?? [];
}

function policyAddress(scVal: xdr.ScVal, path: string): string {
  if (scVal.type !== "scvAddress") {
    throw policyDecodeFailure(path, `expected Address, got ${scVal.type}`);
  }
  try {
    const address = new Address(scValToNative(scVal) as string);
    return address.toString();
  } catch (error) {
    throw policyDecodeFailure(path, "value is not a valid Stellar address", error);
  }
}

function addressVector(scVal: xdr.ScVal, path: string): string[] {
  return policyVec(scVal, path).map((item, index) => policyAddress(item, `${path}[${index}]`));
}

function functionSymbols(scVal: xdr.ScVal, path: string): string[] | null {
  if (scVal.type === "scvVoid") return null;
  return policyVec(scVal, path).map((item, index) => {
    if (item.type !== "scvSymbol") {
      throw policyDecodeFailure(`${path}[${index}]`, `expected Symbol, got ${item.type}`);
    }
    return String(scValToNative(item));
  });
}

function protocolRules(scVal: xdr.ScVal): ProtocolRule[] {
  return policyVec(scVal, "protocols").map((rule, index) => {
    const path = `protocols[${index}]`;
    const fields = symbolMap(rule, path, PROTOCOL_RULE_FIELDS);
    return {
      contract: policyAddress(fields.get("contract")!, `${path}.contract`),
      fns: functionSymbols(fields.get("fns")!, `${path}.fns`),
    };
  });
}

function policyDecodeFailure(path: string, detail: string, cause?: unknown): PolicyDecodeError {
  return new PolicyDecodeError(`cannot decode policy field ${path}: ${detail}`, {
    path,
    ...(cause === undefined ? {} : { cause }),
  });
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
  throw new ContractResponseError(
    `unexpected CheckResult payload from the guard: ${JSON.stringify(raw)}`,
    { field: "CheckResult" },
  );
}

/**
 * True when the dead-man switch has fired: frozen by silence, not by an admin.
 *
 * Semantics are pinned to the contract's own truth (SPEC §5, the Dead-Man
 * Switch section of `stellar-agent-guard-contracts/SPEC.md`): the freeze is
 * derived lazily from `LastHeartbeat` and ledger time on every authorization,
 * and rule #2 of that derivation **requires `LastHeartbeat != 0`** — a value
 * of `0` means "never heartbeated" (the storage key's own documented default:
 * "unix seconds of last agent heartbeat (0 = never)"), and a never-heartbeated
 * account is not frozen *by the dead-man switch*. It is spendable if otherwise
 * allowed. "Never" is therefore not "expired": treating `0` as epoch-0 would
 * report a healthy fresh account as frozen since 1970, which is exactly the
 * dashboard false alarm this guard exists to prevent.
 *
 * The check below is defensive rather than trustful: if a decoded `Status`
 * ever carried `heartbeat_expired = true` alongside `last_heartbeat = 0` (a
 * contract build that predates rule #2, or a hand-assembled status), this
 * helper still reports not-dead-man-frozen, matching what the contract could
 * truthfully enforce. An admin freeze is reported separately via
 * `admin_frozen`, exactly as the contract treats the two conditions as
 * separate (see SPEC §5, "Manual freeze" and "Reversal path").
 */
export function isDeadManFrozen(status: GuardStatus): boolean {
  if (status.last_heartbeat === 0n) return false; // never ≠ expired (SPEC §5 rule #2)
  return status.heartbeat_expired && !status.admin_frozen;
}

/**
 * Seconds of grace remaining before the dead-man switch fires. `null` when the
 * switch is disabled (`dms_grace_secs == 0`), a positive number while the agent
 * is still within grace, and a negative number once the account is frozen.
 *
 * `null` also covers the never-heartbeated case: `last_heartbeat == 0` means
 * "no heartbeat has ever been recorded" (the storage key's documented default,
 * SPEC §3 — `0 = never`), so no grace countdown has started and there is no
 * remaining time to report. Per SPEC §5 rule #2 a never-heartbeated account is
 * **not** dead-man-frozen — "never ≠ expired" — it is spendable if otherwise
 * allowed, and `null` here must never be read as "overdue". Callers that want
 * a full-grace rendering for a fresh account can treat `null` (with a non-zero
 * grace and `last_heartbeat == 0`) as "countdown not yet started".
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


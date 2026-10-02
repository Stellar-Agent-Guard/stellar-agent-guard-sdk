/**
 * GuardPolicy JSON-schema validation (issue #133).
 *
 * The rule source for this module is the vendored, hash-pinned
 * `tests/fixtures/vendor/policy.schema.json` — the machine-readable shape of the
 * contract's `PolicyConfig`, written ahead of the contracts repo's own schema
 * issue landing (contracts #61, open at the time of vendoring; see the vendored
 * file's `_provenance` header and `scripts/vendor-fixtures.ts` for the refresh
 * protocol).
 *
 * ## Why a schema-driven validator at all
 *
 * `validateGuardPolicy` (src/policy.ts) is a faithful, hand-maintained mirror of
 * contracts SPEC §8. Hand-maintained is its weakness: nothing structural stops
 * it from drifting from the SPEC row or from the schema the contracts repo will
 * publish. This module is the "rule source moves" half of the answer: it
 * interprets the schema instead of re-stating those rules in TypeScript, so
 * when the upstream schema lands and is refreshed, these checks re-derive from
 * the refreshed bytes — a SPEC change that updates the schema but not this file
 * still changes what this validator enforces.
 *
 * ## Dependency decision (the argument #133 asks for)
 *
 * Ajv was considered and rejected. Full JSON Schema is a large surface; this
 * schema's dialect is a handful of keywords deep (`type`, `required`, `enum`,
 * `pattern`, `minimum`, `contains`, `minLength`, `if`/`then`/`else`). A
 * hand-rolled interpreter for that subset is ~200 lines with zero dependencies;
 * Ajv would be the package's first non-Stellar dependency (the SDK's dependency
 * count staying at 1 is a stated cost boundary — "zero-dep preferred unless
 * justified"). The subset is pinned: `SCHEMA_DIALECT` lists every keyword this
 * interpreter knows, and `tests/unit/policy-schema.test.ts` walks the vendored
 * schema asserting it uses nothing outside that set — an upstream schema that
 * grows a keyword fails CI loudly instead of being validated loosely.
 *
 * ## The honest split: schema-expressible vs code-enforced (per #133)
 *
 * `SCHEMA_VS_CODE_RULES` below is the table the PR must present, expressed in
 * code so the test suite can assert every id on both sides exists in the shared
 * `POLICY_RULE_IDS` vocabulary. Summary:
 *
 * - **Schema-interpreted**: field types, required fields, `minimum: 0`
   * (§8 bullet 1), §8 bullet 2 (`window_cap > 0 ⇒ window_secs > 0`) and bullet 3
 *   (`recipient cap > 0 ⇒ window_secs > 0`) as `if`/`then` blocks.
 * - **Code-enforced**: full StrKey validity (a regex re-implementing the SDK's
 *   decoder would be worse than no check), §8 bullet 4's cross-field comparison
 *   (`active_until > active_from` — not expressible in the dialect), duplicate
 *   detection (`uniqueItems` compares raw values, not normalized addresses),
 *   the §8 bullet 8 entry caps, bullet 9's list intersection, bullet 10's
 *   self-reference rules (need the caller-supplied `guardAddress`), and the
 *   §8 bullet 5 shape-valid advisories the contract no-ops.
 */
import { Address } from "@stellar/stellar-sdk";
import { POLICY_RULE_IDS, type PolicyFailure, type PolicyRuleId } from "./policy.ts";

/** The single source of validation rules for this module. */
export const POLICY_SCHEMA_PATH = "tests/fixtures/vendor/policy.schema.json";

/**
 * Annotation-only vendor extension: an exact `PolicyRuleId` attached to a
 * schema node, used as the failure's rule id when that node rejects a value.
 * Standard JSON Schema validators ignore `x-` keywords; the refresh protocol
 * preserves them (contracts #61 is expected to carry the same annotations or
 * accept them as a suffix on landing — the integrity test allows either).
 */
export const SCHEMA_RULE_ID_ANNOTATION = "x-policy-rule-id";

/**
 * The JSON Schema dialect subset this interpreter implements. The vendored
 * schema may use only these keywords; the policy-schema test walks the vendored
 * schema and asserts every keyword it contains is in this set, so an upstream
 * schema that grows a keyword fails CI loudly instead of being validated
 * loosely.
 */
export const SCHEMA_DIALECT = [
  "$schema",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "items",
  "contains",
  "enum",
  "minimum",
  "minLength",
  "additionalProperties",
  "allOf",
  "if",
  "then",
  "else",
  SCHEMA_RULE_ID_ANNOTATION,
] as const;

export type SchemaKeyword = (typeof SCHEMA_DIALECT)[number];

export interface SchemaValidationOptions {
  /**
   * Guard contract address used to enforce the §8 self-reference rules
   * (`self_as_*`). Omitted → those rules are skipped, exactly as in
   * `validateGuardPolicy`.
   */
  guardAddress?: string;
  /** Maximum allowed recipient entries (default: 256 per SPEC §8). */
  maxRecipientEntries?: number;
}

/** One schema-interpreter failure; extends `PolicyFailure` with provenance. */
export interface SchemaPolicyFailure extends PolicyFailure {
  /** The schema keyword that produced this failure, e.g. `minimum`, `then`. */
  keyword: string;
  /** JSON-pointer-style locator of the subschema that produced this failure. */
  schemaPath: string;
}

/**
 * The rule split table, expressed as data so the vocabulary test can assert
 * both columns against `POLICY_RULE_IDS`. This is the honest accounting #133
 * asks the PR to present: what the schema dialect genuinely enforces, and what
 * stayed in code with the reason it cannot move.
 */
export const SCHEMA_VS_CODE_RULES = {
  schemaEnforced: [
    { rule: "invalid_type", via: "type / additionalProperties / minLength" },
    { rule: "missing_field", via: "required" },
    { rule: "negative_amount", via: "minimum: 0 (§8 bullet 1)" },
    { rule: "window_requires_secs", via: "if window_cap >= 1 then window_secs >= 1 (§8 bullet 2)" },
    {
      rule: "recipient_cap_requires_window",
      via: "if any recipient_window_caps[].cap >= 1 then window_secs >= 1, via contains (§8 bullet 3)",
    },
  ],
  codeEnforced: [
    { rule: "invalid_address", why: "full StrKey checksum decode; a regex would re-implement it badly" },
    {
      rule: "active_window_inverted",
      why: "§8 bullet 4 cross-field comparison (active_until > active_from) is not expressible in the dialect",
    },
    { rule: "empty_vector_noop", why: "§8 bullet 5 advisory: a shape-valid policy the contract no-ops" },
    {
      rule: "duplicate_*",
      why: "§8 bullet 6: uniqueItems compares raw values, not normalized addresses; per-list rule ids differ",
    },
    { rule: "empty_protocol_functions", why: "schema-valid shape ([] ) the contract rejects; null means any" },
    { rule: "max_recipient_entries_exceeded", why: "§8 bullet 8: contract constant kept as a caller option" },
    { rule: "recipient_conflict", why: "§8 bullet 9: set intersection across two lists" },
    { rule: "self_as_*", why: "§8 bullet 10: needs the caller-supplied guardAddress" },
  ],
} as const;

/** ── Value coercion ──────────────────────────────────────────────────────── */

/**
 * JSON has one number type; the PolicyConfig surface has bigint, number, and
 * (for CLI-provided JSON) base-10 strings. This accepts exactly what
 * `validateGuardPolicy` accepts (its `isIntegerLike` semantics), so a policy
 * that passes one layer is not spuriously rejected by the other.
 */
function toIntegerLike(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

/**
 * Instance paths are rooted at "": the failure surface renders the root as
 * `policy`, matching `validateGuardPolicy`'s `path` conventions.
 */
function displayPath(path: string): string {
  return path === "" ? "policy" : path;
}

/** A JSON Schema `type` value, evaluated against the coerced surface. */
function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "integer":
      return toIntegerLike(value) !== null;
    default:
      return false;
  }
}

/** ── The interpreter ─────────────────────────────────────────────────────── */

interface FailureSink {
  push(path: string, keyword: string, schemaPath: string, message: string, ruleOverride?: string): void;
}

interface ResolvedOptions {
  guardAddress: string | null;
  maxRecipientEntries: number;
}

/**
 * Evaluate one schema node against one value, accumulating failures.
 *
 * `schemaPath` is a JSON-pointer-style locator into the vendored schema, kept
 * on every failure so a consumer can see *which rule* fired — that provenance
 * is the point of schema-driven validation.
 */
function evaluateSchema(
  schema: unknown,
  value: unknown,
  path: string,
  schemaPath: string,
  out: FailureSink,
  options: ResolvedOptions,
): void {
  if (typeof schema !== "object" || schema === null || typeof schema === "boolean") return;
  const node = schema as Record<string, unknown>;
  const shown = displayPath(path);
  const ruleOverride = typeof node[SCHEMA_RULE_ID_ANNOTATION] === "string"
    ? (node[SCHEMA_RULE_ID_ANNOTATION] as string)
    : undefined;

  // `type`, in singular or union form (`["array", "null"]` for `fns`).
  if (node.type !== undefined) {
    const expected = Array.isArray(node.type) ? (node.type as string[]) : [node.type as string];
    if (!expected.some((t) => matchesType(value, t))) {
      out.push(shown, "type", schemaPath, `${shown} must be of type ${expected.join(" | ")}`, ruleOverride);
      return; // type failure: deeper structural checks would only cascade
    }
  }

  if (Array.isArray(node.enum) && !(node.enum as unknown[]).some((candidate) => candidate === value)) {
    out.push(shown, "enum", schemaPath, `${shown} must be one of ${JSON.stringify(node.enum)}`, ruleOverride);
  }

  if (typeof node.minLength === "number" && typeof value === "string" && value.length < node.minLength) {
    out.push(shown, "minLength", schemaPath, `${shown} must not be empty`, ruleOverride);
  }

  // `minimum`: the §8 bullet 1 non-negativity family, through integer coercion.
  if (typeof node.minimum === "number") {
    const integer = toIntegerLike(value);
    if (integer !== null && integer < BigInt(node.minimum)) {
      out.push(shown, "minimum", schemaPath, `${shown} must be >= ${node.minimum}`, ruleOverride);
    }
  }

  if (node.required !== undefined && matchesType(value, "object")) {
    const record = value as Record<string, unknown>;
    for (const key of node.required as string[]) {
      if (record[key] === undefined) {
        out.push(key, "required", schemaPath, `${key} is required`, ruleOverride);
      }
    }
  }

  if (matchesType(value, "object")) {
    const record = value as Record<string, unknown>;
    if (node.properties !== undefined && typeof node.properties === "object") {
      for (const [key, subschema] of Object.entries(node.properties as Record<string, unknown>)) {
        if (record[key] !== undefined) {
          evaluateSchema(subschema, record[key], path === "" ? key : `${path}.${key}`, `${schemaPath}/properties/${key}`, out, options);
        }
      }
    }
    if (node.additionalProperties === false && node.properties !== undefined && typeof node.properties === "object") {
      const known = new Set(Object.keys(node.properties as Record<string, unknown>));
      for (const key of Object.keys(record)) {
        if (!known.has(key)) {
          out.push(path === "" ? key : path, "additionalProperties", schemaPath, `unknown field ${JSON.stringify(key)}`, ruleOverride);
        }
      }
    }
  }

  if (node.items !== undefined && Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      evaluateSchema(node.items, item, `${path}[${index}]`, `${schemaPath}/items`, out, options);
    }
  }

  // `contains`: at least one item matches — the any-semantics the §8 bullet 3
  // condition needs ("if any per-recipient cap is set").
  if (node.contains !== undefined && Array.isArray(value)) {
    const anyMatch = value.some((item) => conditionHolds(node.contains, item, options));
    if (!anyMatch) {
      out.push(shown, "contains", schemaPath, `${shown} must contain at least one matching entry`, ruleOverride);
    }
  }

  // `allOf`: independent subschemas, all of which must hold. JSON Schema allows
  // one `if` per schema object, so the two §8 cross-field conditions (bullet 2
  // and bullet 3) live as sibling allOf branches at the root.
  if (Array.isArray(node.allOf)) {
    for (const [branchIndex, branch] of node.allOf.entries()) {
      evaluateSchema(branch, value, path, `${schemaPath}/allOf/${branchIndex}`, out, options);
    }
  }

  // `if`/`then`/`else`: the §8 cross-field rules the dialect can express.
  if (node.if !== undefined) {
    const holds = conditionHolds(node.if, value, options);
    const branch = holds ? node.then : node.else;
    if (branch !== undefined) {
      evaluateSchema(branch, value, path, `${schemaPath}/${holds ? "then" : "else"}`, out, options);
    }
  }
}

/** True when `condition` (a schema) accepts `value`, with failures discarded. */
function conditionHolds(condition: unknown, value: unknown, options: ResolvedOptions): boolean {
  let holds = true;
  evaluateSchema(condition, value, "", "", { push: () => { holds = false; } }, options);
  return holds;
}

/** ── The §8 rules code enforces (the other half of the split table) ──────── */

function normalizeStellarAddress(addr: string): string | null {
  try {
    // The same normalization `validateGuardPolicy` uses: decode + re-encode via
    // the Stellar SDK, so validity and checksum are the SDK's judgment, not a
    // hand-rolled regex (the reason this rule stays in the code column).
    return new Address(addr).toString();
  } catch {
    return null;
  }
}

function arrayAt(record: Record<string, unknown>, key: string): readonly unknown[] | null {
  const value = record[key];
  return Array.isArray(value) ? value : null;
}

function objectAt(entry: unknown, key: string): unknown {
  if (typeof entry !== "object" || entry === null) return undefined;
  return (entry as Record<string, unknown>)[key];
}

function checkAddressList(
  list: readonly unknown[] | null,
  name: string,
  duplicateRule: PolicyRuleId,
  selfRule: PolicyRuleId,
  out: FailureSink,
  options: ResolvedOptions,
  entryPath: (name: string, index: number) => string = (n, i) => `${n}[${i}]`,
): void {
  if (!list) return;
  const seen = new Set<string>();
  for (const [index, entry] of list.entries()) {
    const path = entryPath(name, index);
    if (typeof entry !== "string" || normalizeStellarAddress(entry) === null) {
      out.push(path, "invalid_address", `/code/${name}`, `"${String(entry)}" is not a valid Stellar address`, duplicateRule === "invalid_address" ? undefined : "invalid_address");
      continue;
    }
    const norm = normalizeStellarAddress(entry)!;
    if (seen.has(norm)) {
      out.push(path, "code", `/code/${name}`, `duplicate address "${entry}"`, duplicateRule);
    }
    seen.add(norm);
    if (options.guardAddress !== null && norm === options.guardAddress) {
      out.push(path, "code", `/code/${name}`, "guard contract address cannot appear in this list", selfRule);
    }
  }
}

/**
 * The code-enforced half of §8 — every rule the schema dialect cannot express,
 * emitted with the shared `PolicyRuleId` vocabulary (see `SCHEMA_VS_CODE_RULES`
 * and the module docblock for the reasoned list).
 */
function enforceCodeRules(record: Record<string, unknown>, out: FailureSink, options: ResolvedOptions): void {
  const assets = arrayAt(record, "assets");
  const recipients = arrayAt(record, "recipients");
  const blocked = arrayAt(record, "blocked_recipients");
  const caps = arrayAt(record, "recipient_window_caps");
  const protocols = arrayAt(record, "protocols");

  // §8 bullet 8: entry caps (the bound is a caller option, not schema state).
  for (const [list, name] of [
    [recipients, "recipients"],
    [blocked, "blocked_recipients"],
    [caps, "recipient_window_caps"],
  ] as const) {
    if (list && list.length > options.maxRecipientEntries) {
      out.push(
        name,
        "code",
        `/code/${name}`,
        `${name} list exceeds maximum of ${options.maxRecipientEntries} entries (${list.length})`,
        "max_recipient_entries_exceeded",
      );
    }
  }

  // Per-list address rules: validity, duplicates, self-reference.
  checkAddressList(assets, "assets", "duplicate_asset", "self_as_asset", out, options);
  checkAddressList(recipients, "recipients", "duplicate_recipient", "self_as_recipient", out, options);
  checkAddressList(blocked, "blocked_recipients", "duplicate_blocked_recipient", "self_as_recipient", out, options);
  checkAddressList(
    caps?.map((entry) => objectAt(entry, "recipient")) ?? null,
    "recipient_window_caps",
    "duplicate_recipient_window_cap",
    "self_as_recipient_cap",
    out,
    options,
    (name, index) => `${name}[${index}].recipient`,
  );

  // Protocols: contract-address rules per rule, then fns-shape rules.
  if (protocols) {
    const seenProtocols = new Set<string>();
    for (const [index, rule] of protocols.entries()) {
      const contract = objectAt(rule, "contract");
      if (typeof contract === "string" && normalizeStellarAddress(contract) !== null) {
        const norm = normalizeStellarAddress(contract)!;
        if (seenProtocols.has(norm)) {
          out.push(`protocols[${index}].contract`, "code", "/code/protocols", `duplicate protocol contract "${contract}"`, "duplicate_protocol");
        }
        seenProtocols.add(norm);
        if (options.guardAddress !== null && norm === options.guardAddress) {
          out.push(`protocols[${index}].contract`, "code", "/code/protocols", "guard contract address cannot be listed as a protocol", "self_as_protocol");
        }
      } else {
        out.push(`protocols[${index}].contract`, "invalid_address", "/code/protocols", `"${String(contract)}" is not a valid Stellar address`, "invalid_address");
      }
      const fns = objectAt(rule, "fns");
      if (Array.isArray(fns)) {
        if (fns.length === 0) {
          out.push(`protocols[${index}].fns`, "code", "/code/protocols", "protocol fns list must not be empty (use null to allow any function)", "empty_protocol_functions");
        }
        const seenFns = new Set<string>();
        for (const [fnIndex, fn] of fns.entries()) {
          if (typeof fn !== "string" || fn.length === 0) {
            out.push(`protocols[${index}].fns[${fnIndex}]`, "code", "/code/protocols", "protocol function name must be a non-empty string", "invalid_type");
            continue;
          }
          if (seenFns.has(fn)) {
            out.push(`protocols[${index}].fns[${fnIndex}]`, "code", "/code/protocols", `duplicate function "${fn}" in protocol rule`, "duplicate_protocol_function");
          }
          seenFns.add(fn);
        }
      }
    }
  }

  // §8 bullet 9: recipients and blocked_recipients must not intersect.
  if (recipients && blocked) {
    const recipientSet = new Set(
      recipients
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => normalizeStellarAddress(entry))
        .filter((entry): entry is string => entry !== null),
    );
    for (const [index, entry] of blocked.entries()) {
      if (typeof entry !== "string") continue;
      const norm = normalizeStellarAddress(entry);
      if (norm !== null && recipientSet.has(norm)) {
        out.push(`blocked_recipients[${index}]`, "code", "/code/blocked", `recipient "${entry}" appears in both recipients and blocked_recipients`, "recipient_conflict");
      }
    }
  }

  // §8 bullet 4: active_until = 0 (never) or strictly greater than active_from.
  // A cross-field comparison, which the dialect cannot express — code column.
  const activeFrom = toIntegerLike(record.active_from);
  const activeUntil = toIntegerLike(record.active_until);
  if (activeFrom !== null && activeUntil !== null && activeUntil !== 0n && activeUntil <= activeFrom) {
    out.push("active_until", "code", "/code/active_until", "active_until must be 0 (no expiration) or strictly greater than active_from", "active_window_inverted");
  }

  // §8 bullet 5 advisories: shape-valid policies the contract no-ops.
  if (assets && assets.length === 0) {
    out.push("assets", "code", "/code/assets", "assets list is empty; SAC token transfers will never be allowed", "empty_vector_noop");
  }
  if (recipients && recipients.length === 0 && record.allow_any_recipient === false) {
    out.push("recipients", "code", "/code/recipients", "recipients list is empty while allow_any_recipient is false; no recipient will be allowed", "empty_vector_noop");
  }
}

/** ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Validate a candidate policy against the vendored schema (the schema-driven
 * half) plus the code-enforced §8 rules the dialect cannot express (see
 * `SCHEMA_VS_CODE_RULES`).
 *
 * Same contract as `validateGuardPolicy`: returns **all** failures at once
 * (form-UX completeness), `[]` for a valid policy, and `SchemaPolicyFailure`
 * items that additionally name the schema `keyword` and `schemaPath` that
 * fired. The schema is a parameter so the caller controls which pinned copy is
 * authoritative; the tests pass the vendored file's `schema` value.
 */
export function validateGuardPolicyAgainstSchema(
  policy: unknown,
  schema: unknown,
  optionsOrGuardAddress?: SchemaValidationOptions | string,
): SchemaPolicyFailure[] {
  const options: SchemaValidationOptions =
    typeof optionsOrGuardAddress === "string"
      ? { guardAddress: optionsOrGuardAddress }
      : optionsOrGuardAddress ?? {};

  const resolved: ResolvedOptions = {
    guardAddress: options.guardAddress ? normalizeStellarAddress(options.guardAddress) : null,
    maxRecipientEntries: options.maxRecipientEntries ?? 256,
  };

  const failures: SchemaPolicyFailure[] = [];
  const out: FailureSink = {
    push(path, keyword, schemaPath, message, ruleOverride) {
      failures.push({
        path,
        rule: ruleOverride ? ruleFromAnnotation(ruleOverride) : ruleForKeyword(keyword),
        keyword,
        schemaPath,
        message,
      });
    },
  };

  evaluateSchema(schema, policy, "", "", out, resolved);
  if (typeof policy === "object" && policy !== null && !Array.isArray(policy)) {
    enforceCodeRules(policy as Record<string, unknown>, out, resolved);
  }
  return failures;
}

/**
 * Map a schema keyword to the shared `PolicyRuleId` vocabulary, so both
 * validation layers speak the same rule language (`POLICY_RULE_IDS` /
 * `policy-rule-ids.json`). Schema nodes that carry the
 * `x-policy-rule-id` annotation bypass this mapping (see `ruleFromAnnotation`).
 */
export function ruleForKeyword(keyword: string): PolicyRuleId {
  switch (keyword) {
    case "required":
      return "missing_field";
    case "minimum":
      return "negative_amount";
    case "type":
    case "enum":
    case "minLength":
    case "pattern":
    case "additionalProperties":
      return "invalid_type";
    case "contains":
      return "invalid_type";
    default:
      return "invalid_type";
  }
}

/** Resolve an `x-policy-rule-id` annotation to the shared vocabulary. */
export function ruleFromAnnotation(annotation: string): PolicyRuleId {
  return POLICY_RULE_IDS.includes(annotation as PolicyRuleId) ? (annotation as PolicyRuleId) : "invalid_type";
}

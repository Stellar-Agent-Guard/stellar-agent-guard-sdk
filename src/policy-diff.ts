/**
 * Structured diff between two guard policies (issue #131).
 *
 * When a policy revision bumps, operators ask "what changed?". Diffing two
 * `PolicyConfig` objects looks trivial but is easy to get wrong for the list
 * fields: the contract treats every policy list as a **set** (an allowlist
 * matches regardless of position), so reordering recipients is not a change,
 * while removing one and adding another is two changes. This module encodes
 * those semantics once. It is a display helper only — nothing on the
 * authorization path reads it.
 */
import type { PolicyConfig, ReadonlyPolicyConfig } from "./policy.ts";

/** A value appearing in a {@link PolicyChange}. */
export type PolicyValue = bigint | boolean | string | readonly string[] | null;

/**
 * One difference between two policies.
 *
 * - `"changed"`: a scalar field, a `recipient_window_caps` cap, or a protocol's
 *   `fns` switching between `null` ("any function") and a list. Carries
 *   `before` and `after`.
 * - `"removed"`: a set member present in `a` only. Carries `before`; `path`
 *   indexes into `a`.
 * - `"added"`: a set member present in `b` only. Carries `after`; `path`
 *   indexes into `b`.
 *
 * There is no "reordered" kind: every list in a policy has set semantics in
 * the contract, so a pure permutation produces no change at all.
 */
export interface PolicyChange {
  /** Top-level policy field the change belongs to. */
  field: keyof PolicyConfig;
  /** Dotted/indexed location, e.g. `per_tx_cap`, `recipients[2]`, `protocols[0].fns[1]`. */
  path: string;
  kind: "added" | "removed" | "changed";
  before?: PolicyValue;
  after?: PolicyValue;
}

type ScalarField =
  | "per_tx_cap"
  | "window_secs"
  | "window_cap"
  | "allow_any_recipient"
  | "active_from"
  | "active_until"
  | "paused"
  | "dms_grace_secs";

type AddressSetField = "assets" | "recipients" | "blocked_recipients";

/**
 * Every difference between `a` and `b`, in a deterministic order: fields in
 * `PolicyConfig` declaration order; within a set field, removals in `a`'s
 * order, then additions in `b`'s order.
 *
 * Semantics:
 * - scalars (caps, windows, flags) compare by value;
 * - `assets`, `recipients`, `blocked_recipients` and each protocol's `fns`
 *   compare as unordered sets;
 * - `protocols` are matched by `contract`; `recipient_window_caps` by
 *   `recipient` — a matched entry reports only its inner changes;
 * - an absent optional list (`recipient_window_caps`, `blocked_recipients`)
 *   is the same as an empty one.
 *
 * `policyDiff(a, b)` is empty exactly when `a` and `b` are equal under these
 * semantics.
 */
export function policyDiff(a: ReadonlyPolicyConfig, b: ReadonlyPolicyConfig): PolicyChange[] {
  const changes: PolicyChange[] = [];

  scalar(changes, "per_tx_cap", a.per_tx_cap, b.per_tx_cap);
  scalar(changes, "window_secs", a.window_secs, b.window_secs);
  scalar(changes, "window_cap", a.window_cap, b.window_cap);
  addressSet(changes, "assets", a.assets, b.assets);
  protocols(changes, a, b);
  addressSet(changes, "recipients", a.recipients, b.recipients);
  scalar(changes, "allow_any_recipient", a.allow_any_recipient, b.allow_any_recipient);
  scalar(changes, "active_from", a.active_from, b.active_from);
  scalar(changes, "active_until", a.active_until, b.active_until);
  scalar(changes, "paused", a.paused, b.paused);
  scalar(changes, "dms_grace_secs", a.dms_grace_secs, b.dms_grace_secs);
  windowCaps(changes, a, b);
  addressSet(changes, "blocked_recipients", a.blocked_recipients ?? [], b.blocked_recipients ?? []);

  return changes;
}

function scalar(
  changes: PolicyChange[],
  field: ScalarField,
  before: bigint | boolean,
  after: bigint | boolean,
): void {
  if (before !== after) changes.push({ field, path: field, kind: "changed", before, after });
}

/** Set difference of two string lists, reported with indices into each side. */
function setDiff(
  changes: PolicyChange[],
  field: keyof PolicyConfig,
  path: string,
  before: readonly string[],
  after: readonly string[],
): void {
  const inAfter = new Set(after);
  const inBefore = new Set(before);
  before.forEach((value, index) => {
    if (!inAfter.has(value)) {
      changes.push({ field, path: `${path}[${index}]`, kind: "removed", before: value });
    }
  });
  after.forEach((value, index) => {
    if (!inBefore.has(value)) {
      changes.push({ field, path: `${path}[${index}]`, kind: "added", after: value });
    }
  });
}

function addressSet(
  changes: PolicyChange[],
  field: AddressSetField,
  before: readonly string[],
  after: readonly string[],
): void {
  setDiff(changes, field, field, before, after);
}

function protocols(changes: PolicyChange[], a: ReadonlyPolicyConfig, b: ReadonlyPolicyConfig): void {
  const afterIndex = new Map(b.protocols.map((rule, index) => [rule.contract as string, index]));
  const beforeContracts = new Set(a.protocols.map((rule) => rule.contract as string));

  a.protocols.forEach((rule, index) => {
    const matched = afterIndex.get(rule.contract);
    if (matched === undefined) {
      changes.push({
        field: "protocols",
        path: `protocols[${index}]`,
        kind: "removed",
        before: rule.contract,
      });
      return;
    }
    const next = b.protocols[matched];
    if (next === undefined) return; // unreachable: `matched` indexes `b.protocols`
    const path = `protocols[${matched}].fns`;
    if (rule.fns === null || next.fns === null) {
      if (rule.fns !== next.fns) {
        changes.push({ field: "protocols", path, kind: "changed", before: rule.fns, after: next.fns });
      }
      return;
    }
    setDiff(changes, "protocols", path, rule.fns, next.fns);
  });

  b.protocols.forEach((rule, index) => {
    if (!beforeContracts.has(rule.contract)) {
      changes.push({ field: "protocols", path: `protocols[${index}]`, kind: "added", after: rule.contract });
    }
  });
}

function windowCaps(changes: PolicyChange[], a: ReadonlyPolicyConfig, b: ReadonlyPolicyConfig): void {
  const before = a.recipient_window_caps ?? [];
  const after = b.recipient_window_caps ?? [];
  const afterIndex = new Map(after.map((entry, index) => [entry.recipient as string, index]));
  const beforeRecipients = new Set(before.map((entry) => entry.recipient as string));

  before.forEach((entry, index) => {
    const matched = afterIndex.get(entry.recipient);
    if (matched === undefined) {
      changes.push({
        field: "recipient_window_caps",
        path: `recipient_window_caps[${index}]`,
        kind: "removed",
        before: entry.recipient,
      });
      return;
    }
    const next = after[matched];
    if (next !== undefined && next.cap !== entry.cap) {
      changes.push({
        field: "recipient_window_caps",
        path: `recipient_window_caps[${matched}].cap`,
        kind: "changed",
        before: entry.cap,
        after: next.cap,
      });
    }
  });

  after.forEach((entry, index) => {
    if (!beforeRecipients.has(entry.recipient)) {
      changes.push({
        field: "recipient_window_caps",
        path: `recipient_window_caps[${index}]`,
        kind: "added",
        after: entry.recipient,
      });
    }
  });
}

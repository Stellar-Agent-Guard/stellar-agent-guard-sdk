/**
 * Deterministic SHA-256 fingerprint of a guard policy (issue #437).
 *
 * Kept in its own module so callers that only need hashing do not pull in the
 * full policy codec, and so this file is not part of the enforcement-path gate
 * (`src/policy.ts`, `src/tx.ts`, `src/invoke.ts`, `src/preflight.ts`).
 */
import { sha256Hex } from "./hash.ts";
import type { ReadonlyPolicyConfig } from "./policy.ts";

/**
 * Deterministic SHA-256 fingerprint of a policy, suitable for change-detection
 * and audit logging.
 *
 * The canonical encoding sorts every list field (assets, recipients,
 * blocked_recipients, protocol rules by contract address, each rule's fns by
 * name, recipient_window_caps by recipient) so that permutations of equivalent
 * lists produce the same hash. All `bigint` values are encoded as decimal
 * strings without the trailing `n`.
 *
 * When `guardAddress` is supplied it is included in the canonical form, so the
 * same policy installed on two different guard accounts produces different
 * hashes.
 *
 * Returns a lower-case 64-character hex string.
 */
export function policyHash(policy: ReadonlyPolicyConfig, guardAddress?: string): string {
  const sortedStrings = (arr: readonly string[]): string[] => [...arr].sort();
  const bigStr = (n: bigint): string => n.toString();

  const canonical: Record<string, unknown> = {
    per_tx_cap: bigStr(policy.per_tx_cap),
    window_secs: bigStr(policy.window_secs),
    window_cap: bigStr(policy.window_cap),
    assets: sortedStrings(policy.assets),
    protocols: [...policy.protocols]
      .sort((a, b) => (a.contract < b.contract ? -1 : a.contract > b.contract ? 1 : 0))
      .map((rule) => ({
        contract: rule.contract,
        fns: rule.fns === null ? null : sortedStrings(rule.fns),
      })),
    recipients: sortedStrings(policy.recipients),
    allow_any_recipient: policy.allow_any_recipient,
    active_from: bigStr(policy.active_from),
    active_until: bigStr(policy.active_until),
    paused: policy.paused,
    dms_grace_secs: bigStr(policy.dms_grace_secs),
    recipient_window_caps: [...(policy.recipient_window_caps ?? [])]
      .sort((a, b) => (a.recipient < b.recipient ? -1 : 1))
      .map((cap) => ({ recipient: cap.recipient, cap: bigStr(cap.cap) })),
    blocked_recipients: sortedStrings(policy.blocked_recipients ?? []),
  };
  if (guardAddress !== undefined) {
    canonical.guard = guardAddress;
  }
  return sha256Hex(JSON.stringify(canonical));
}

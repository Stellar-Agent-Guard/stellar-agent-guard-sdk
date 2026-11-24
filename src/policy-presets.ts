/**
 * Named policy presets (issue #436).
 *
 * These are starting points for common agent archetypes. Every preset is a
 * frozen {@link ReadonlyPolicyConfig} that the operator must customise before
 * deployment: the asset and recipient addresses here are from the contracts
 * repo's README examples and are **not** safe to use on mainnet as-is.
 *
 * Values are pinned to `tests/fixtures/vendor/policy-presets.json`, which is
 * in turn vendored from the upstream contracts docs. The test suite asserts
 * round-trip equality between this module and that fixture so drift is caught
 * in CI.
 */
import {
  freezePolicy,
  unsafeAccountAddress,
  unsafeContractAddress,
  type ReadonlyPolicyConfig,
} from "./policy.ts";

/** The four preset archetypes. */
export type PolicyPresetName = "day-trader" | "payments-bot" | "watch-only" | "max-security";

/**
 * All four named policy presets, keyed by {@link PolicyPresetName}.
 *
 * - `"day-trader"`: high-frequency DEX trading with a short rolling window
 *   and narrow protocol/function allowlist.
 * - `"payments-bot"`: capped automated payments to a fixed recipient set.
 * - `"watch-only"`: paused and zero-capped — no spending allowed; useful for
 *   monitoring agents that need a registered guard but must never move funds.
 * - `"max-security"`: tightly capped transfers to a single recipient.
 */
export const POLICY_PRESETS: Readonly<Record<PolicyPresetName, ReadonlyPolicyConfig>> =
  Object.freeze({
    "day-trader": freezePolicy({
      active_from: 0n,
      active_until: 0n,
      allow_any_recipient: false,
      assets: [unsafeContractAddress("CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7")],
      dms_grace_secs: 300n,
      paused: false,
      per_tx_cap: 50000n,
      protocols: [
        {
          contract: unsafeContractAddress(
            "CCYIRHS5OIVHEBKM27BDOPS6N3XKJSBQW2JAAV2F47GJH4C7ESLYGKVM",
          ),
          fns: ["swap", "add_liquidity"],
        },
      ],
      recipients: [
        unsafeAccountAddress("GDUYLFVFLVISVOM5FK5KTBA446VQQ7NBRRFMLNLKLISKL26LJGKUVRRX"),
      ],
      window_cap: 250000n,
      window_secs: 300n,
    }),

    "payments-bot": freezePolicy({
      active_from: 0n,
      active_until: 0n,
      allow_any_recipient: false,
      assets: [unsafeContractAddress("CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7")],
      dms_grace_secs: 86400n,
      paused: false,
      per_tx_cap: 1000n,
      protocols: [],
      recipients: [
        unsafeAccountAddress("GBQ6OQUM5FTH7M5AU4PXFGB5GZXDF742E6ORZUP6UUJ6IHA653Z6LPQL"),
        unsafeAccountAddress("GCR2RCC7QOFAHRNGHTAMQ4VZFXSG2ICZGL6DGW7X2OMKOJHY2MAWJANI"),
      ],
      window_cap: 10000n,
      window_secs: 3600n,
    }),

    "watch-only": freezePolicy({
      active_from: 0n,
      active_until: 0n,
      allow_any_recipient: false,
      assets: [],
      dms_grace_secs: 604800n,
      paused: true,
      per_tx_cap: 0n,
      protocols: [],
      recipients: [],
      window_cap: 0n,
      window_secs: 86400n,
    }),

    "max-security": freezePolicy({
      active_from: 0n,
      active_until: 0n,
      allow_any_recipient: false,
      assets: [unsafeContractAddress("CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7")],
      dms_grace_secs: 3600n,
      paused: false,
      per_tx_cap: 100n,
      protocols: [],
      recipients: [
        unsafeAccountAddress("GCDCESJSIFS2K2MI5OIUWJUJZVEM2WM2PBEAZMFRC5QU7HVJETCXYC3G"),
      ],
      window_cap: 500n,
      window_secs: 3600n,
    }),
  });

/**
 * Retrieve a named policy preset.
 *
 * Returns the same frozen {@link ReadonlyPolicyConfig} as `POLICY_PRESETS[name]`.
 * Use `freezePolicy({ ...getPolicyPreset(name), <overrides> })` to derive a
 * customised variant without mutating the preset.
 */
export function getPolicyPreset(name: PolicyPresetName): ReadonlyPolicyConfig {
  return POLICY_PRESETS[name];
}

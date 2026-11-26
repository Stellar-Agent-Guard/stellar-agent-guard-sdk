/**
 * Policy cookbook (issue #444): five complete, reviewed `ReadonlyPolicyConfig`
 * recipes.
 *
 * Every recipe here is a full policy, not a field fragment: copy one, change the
 * addresses and numbers, and install it. They are typechecked with the rest of
 * the repository and validated by `tests/unit/policy-cookbook-example.test.ts`,
 * so an example cannot silently rot into an invalid policy.
 *
 * The matching prose — why each recipe is shaped this way, what it deliberately
 * does **not** protect against, and its `describePolicy()` output — lives in
 * `docs/policy-cookbook.md`.
 *
 * ## What these recipes are not
 *
 * A policy constrains what the **guard** authorizes; it is not a substitute for
 * the guard's own on-chain enforcement, a treasury's signing ceremony, or an
 * operator's monitoring. Each recipe states its own gaps in the cookbook. In
 * particular, `per_tx_cap`/`window_cap` are enforced natively for SAC
 * `transfer`/`transfer_from`; arbitrary protocol calls are gated by allowlist,
 * window and pause state only (see `docs/enforcement-scope.md`).
 *
 * ## Addresses
 *
 * The addresses are real Stellar StrKey values from this repository's Phase 2
 * testnet fixtures. They are placeholders for your deployment: replace them
 * with your own guard, asset, recipient and protocol addresses.
 */
import {
  freezePolicy,
  unsafeAccountAddress,
  unsafeContractAddress,
  type ReadonlyPolicyConfig,
} from "../src/policy.ts";

/** Phase 2 testnet guard instance (placeholders, not a production guard). */
export const GUARD_ADDRESS = unsafeContractAddress(
  "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
);
/** SAC token used by the recipes, e.g. a stablecoin on your deployment. */
export const ASSET_ADDRESS = unsafeContractAddress(
  "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB",
);
/** An allowlisted payout recipient (account address). */
export const VENDOR_ADDRESS = unsafeAccountAddress(
  "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH",
);
/** The operator's treasury account. */
export const TREASURY_ADDRESS = unsafeAccountAddress(
  "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
);
/** An allowlisted DEX contract. */
export const DEX_ADDRESS = unsafeContractAddress(
  "CAJJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4LNU",
);

/**
 * 1. Single-recipient payer: one asset, one recipient, a daily cap.
 *
 * The narrowest useful production policy: a payer agent that can only send one
 * asset to one allowlisted recipient. Everything else is denied because no
 * other asset or recipient is named and `allow_any_recipient` is `false`.
 */
export const singleRecipientPayer: ReadonlyPolicyConfig = freezePolicy({
  per_tx_cap: 250n,
  window_secs: 86_400n,
  window_cap: 1_000n,
  assets: [ASSET_ADDRESS],
  protocols: [],
  recipients: [VENDOR_ADDRESS],
  allow_any_recipient: false,
  active_from: 0n,
  active_until: 0n,
  paused: false,
  dms_grace_secs: 604_800n,
});

/**
 * 2. Hourly-capped trading agent: a protocol allowlist plus a rolling hourly cap.
 *
 * The agent may call `swap` on the allowlisted DEX and transfer the asset, but
 * never more than `per_tx_cap` at once or `window_cap` in any rolling hour. The
 * treasury recipient entry keeps a sweep path for realised proceeds.
 */
export const hourlyCappedTradingAgent: ReadonlyPolicyConfig = freezePolicy({
  per_tx_cap: 5_000n,
  window_secs: 3_600n,
  window_cap: 12_000n,
  assets: [ASSET_ADDRESS],
  protocols: [{ contract: DEX_ADDRESS, fns: ["swap"] }],
  recipients: [TREASURY_ADDRESS],
  allow_any_recipient: false,
  active_from: 0n,
  active_until: 0n,
  paused: false,
  dms_grace_secs: 604_800n,
  protocol_calls_per_window: 60,
});

/**
 * 3. Staged rollout: an explicit `active_from` / `active_until` window.
 *
 * The policy is installed and verifiable before it can authorize anything, and
 * stops authorizing on its own at the deadline even if nobody pauses it. The
 * values are illustrative future timestamps (`1_800_000_000n` is
 * 2027-01-15T08:00:00Z); set them against your own schedule.
 */
export const stagedRollout: ReadonlyPolicyConfig = freezePolicy({
  per_tx_cap: 100n,
  window_secs: 3_600n,
  window_cap: 500n,
  assets: [ASSET_ADDRESS],
  protocols: [],
  recipients: [VENDOR_ADDRESS],
  allow_any_recipient: false,
  active_from: 1_800_000_000n,
  active_until: 1_802_592_000n,
  paused: false,
  dms_grace_secs: 86_400n,
});

/**
 * 4. Treasury with pause: a deliberately paused policy kept warm.
 *
 * `paused: true` makes the guard refuse every action while the policy, window
 * accounting and allowlists stay installed, so an operator can resume by
 * clearing the pause instead of reinstalling (and re-reviewing) a policy.
 */
export const treasuryWithPause: ReadonlyPolicyConfig = freezePolicy({
  per_tx_cap: 10_000n,
  window_secs: 86_400n,
  window_cap: 50_000n,
  assets: [ASSET_ADDRESS],
  protocols: [],
  recipients: [TREASURY_ADDRESS],
  allow_any_recipient: false,
  active_from: 0n,
  active_until: 0n,
  paused: true,
  dms_grace_secs: 604_800n,
});

/**
 * 5. Deny-all observer: an inert policy for a watch-only account.
 *
 * Both caps are zero and only the treasury is allowlisted, so the account can
 * be monitored (events, heartbeats, telemetry) while authorizing at most a
 * zero-value transfer. The asset and recipient entries exist purely so the
 * policy validates clean rather than tripping the `empty_vector_noop` rule.
 */
export const denyAllObserver: ReadonlyPolicyConfig = freezePolicy({
  per_tx_cap: 0n,
  window_secs: 3_600n,
  window_cap: 0n,
  assets: [ASSET_ADDRESS],
  protocols: [],
  recipients: [TREASURY_ADDRESS],
  allow_any_recipient: false,
  active_from: 0n,
  active_until: 0n,
  paused: false,
  dms_grace_secs: 0n,
});

/** Every recipe, with a stable id matching its cookbook section. */
export const policies = [
  { id: "single-recipient-payer", title: "Single-recipient payer", policy: singleRecipientPayer },
  {
    id: "hourly-capped-trading-agent",
    title: "Hourly-capped trading agent",
    policy: hourlyCappedTradingAgent,
  },
  { id: "staged-rollout", title: "Staged rollout", policy: stagedRollout },
  { id: "treasury-with-pause", title: "Treasury with pause", policy: treasuryWithPause },
  { id: "deny-all-observer", title: "Deny-all observer", policy: denyAllObserver },
] as const;

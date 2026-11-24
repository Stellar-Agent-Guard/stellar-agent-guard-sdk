/**
 * Representative policies for the canonical Policy JSON golden tests (#440).
 *
 * Each case pins one shape the format must render byte-for-byte: empty
 * allowlists, full-width bigint caps, an active window plus per-rule pause
 * flags, and per-recipient window caps. The policies are `PolicyConfig` values
 * (bigint integers, `readonly`-friendly arrays), so a case also proves that the
 * encoder narrows nothing.
 *
 * The matching `*.golden.json` files are committed output, not regenerated on
 * the fly: a change to key order, integer formatting or whitespace is meant to
 * show up as a reviewable golden diff.
 */
import {
  unsafeAccountAddress,
  unsafeContractAddress,
  type PolicyConfig,
} from "../../../src/policy.ts";

const TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
const PROTOCOL = unsafeContractAddress("CAJJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4LNU");
const RECIPIENT = unsafeAccountAddress("GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH");
const RECIPIENT_TWO = unsafeAccountAddress("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ");
const BLOCKED_RECIPIENT = unsafeAccountAddress(
  "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
);

export interface PolicyJsonGoldenCase {
  /** Golden filename inside `tests/fixtures/policy-json/`. */
  readonly file: string;
  /** What this case pins, quoted in the test and fixture header. */
  readonly purpose: string;
  readonly policy: PolicyConfig;
}

export const POLICY_JSON_GOLDEN_CASES: readonly PolicyJsonGoldenCase[] = [
  {
    file: "empty-allowlists.golden.json",
    purpose: "empty assets/recipients/protocols encode as empty arrays, not omitted or null",
    policy: {
      per_tx_cap: 0n,
      window_secs: 0n,
      window_cap: 0n,
      assets: [],
      protocols: [],
      recipients: [],
      allow_any_recipient: false,
      active_from: 0n,
      active_until: 0n,
      paused: false,
      dms_grace_secs: 0n,
    },
  },
  {
    file: "bigint-caps.golden.json",
    purpose: "i128 and u64 maximums keep full precision as plain decimal strings",
    policy: {
      per_tx_cap: 2n ** 127n - 1n,
      window_secs: 2n ** 64n - 1n,
      window_cap: 2n ** 127n - 1n,
      assets: [TOKEN],
      protocols: [],
      recipients: [RECIPIENT],
      allow_any_recipient: false,
      active_from: 0n,
      active_until: 0n,
      paused: false,
      dms_grace_secs: 2n ** 64n - 1n,
    },
  },
  {
    file: "active-window.golden.json",
    purpose: "a bounded active window, a paused policy and per-rule pause flags",
    policy: {
      per_tx_cap: 5_000_000_000n,
      window_secs: 86_400n,
      window_cap: 20_000_000_000n,
      assets: [TOKEN],
      protocols: [
        { contract: PROTOCOL, fns: ["transfer", "approve"], paused: true },
        { contract: TOKEN, fns: null },
      ],
      recipients: [RECIPIENT],
      allow_any_recipient: false,
      active_from: 1_700_000_000n,
      active_until: 1_700_086_400n,
      paused: true,
      dms_grace_secs: 604_800n,
    },
  },
  {
    file: "recipient-window-caps.golden.json",
    purpose: "optional recipient caps, blocked recipients and protocol call caps stay in canonical order",
    policy: {
      per_tx_cap: 1_000n,
      window_secs: 3_600n,
      window_cap: 5_000n,
      assets: [TOKEN],
      protocols: [{ contract: PROTOCOL, fns: ["swap"], paused: false }],
      recipients: [RECIPIENT, RECIPIENT_TWO],
      allow_any_recipient: false,
      active_from: 0n,
      active_until: 0n,
      paused: false,
      dms_grace_secs: 0n,
      recipient_window_caps: [
        { recipient: RECIPIENT, cap: 1_000n },
        { recipient: RECIPIENT_TWO, cap: 2n ** 127n - 1n },
      ],
      blocked_recipients: [BLOCKED_RECIPIENT],
      protocol_calls_per_window: 12,
    },
  },
];

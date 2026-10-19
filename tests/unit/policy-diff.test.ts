/**
 * `policyDiff` (issue #131): structured, set-aware change list between policies.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { policyDiff, type PolicyChange } from "../../src/policy-diff.ts";
import {
  unsafeAccountAddress,
  unsafeContractAddress,
  type PolicyConfig,
} from "../../src/policy.ts";
import * as sdk from "../../src/index.ts";

const TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
const DEX = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
const R1 = unsafeAccountAddress("GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH");
const R2 = unsafeAccountAddress("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H");
const R3 = unsafeAccountAddress("GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ");

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    per_tx_cap: 1000n,
    window_secs: 60n,
    window_cap: 150n,
    assets: [TOKEN],
    protocols: [{ contract: DEX, fns: ["swap", "deposit"] }],
    recipients: [R1, R2, R3],
    allow_any_recipient: false,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: 0n,
    ...overrides,
  };
}

/** Canonical form under set semantics, for the "empty diff ⇔ equal" property. */
function canonical(p: PolicyConfig): string {
  const sorted = (xs: readonly string[] | undefined) => [...(xs ?? [])].sort();
  return JSON.stringify(
    {
      per_tx_cap: p.per_tx_cap,
      window_secs: p.window_secs,
      window_cap: p.window_cap,
      assets: sorted(p.assets),
      protocols: [...p.protocols]
        .map((r) => ({ contract: r.contract, fns: r.fns === null ? null : sorted(r.fns) }))
        .sort((x, y) => x.contract.localeCompare(y.contract)),
      recipients: sorted(p.recipients),
      allow_any_recipient: p.allow_any_recipient,
      active_from: p.active_from,
      active_until: p.active_until,
      paused: p.paused,
      dms_grace_secs: p.dms_grace_secs,
      recipient_window_caps: [...(p.recipient_window_caps ?? [])]
        .map((c) => ({ recipient: c.recipient, cap: c.cap }))
        .sort((x, y) => x.recipient.localeCompare(y.recipient)),
      blocked_recipients: sorted(p.blocked_recipients),
    },
    (_key, value: unknown) => (typeof value === "bigint" ? `${value}n` : value),
  );
}

describe("policyDiff", () => {
  it("is exported from the package root", () => {
    assert.equal(sdk.policyDiff, policyDiff);
  });

  it("reports a scalar change", () => {
    assert.deepEqual(policyDiff(policy(), policy({ per_tx_cap: 2000n })), [
      { field: "per_tx_cap", path: "per_tx_cap", kind: "changed", before: 1000n, after: 2000n },
    ] satisfies PolicyChange[]);
    assert.deepEqual(policyDiff(policy(), policy({ paused: true })), [
      { field: "paused", path: "paused", kind: "changed", before: false, after: true },
    ]);
  });

  it("reports list removal (index into a) and addition (index into b)", () => {
    assert.deepEqual(policyDiff(policy(), policy({ recipients: [R1, R3] })), [
      { field: "recipients", path: "recipients[1]", kind: "removed", before: R2 },
    ]);
    assert.deepEqual(policyDiff(policy({ recipients: [R1] }), policy({ recipients: [R1, R2] })), [
      { field: "recipients", path: "recipients[1]", kind: "added", after: R2 },
    ]);
  });

  it("treats a pure reorder as no change (set semantics)", () => {
    assert.deepEqual(policyDiff(policy(), policy({ recipients: [R3, R1, R2] })), []);
    assert.deepEqual(
      policyDiff(policy(), policy({ protocols: [{ contract: DEX, fns: ["deposit", "swap"] }] })),
      [],
    );
  });

  it("distinguishes a swap from a reorder", () => {
    assert.deepEqual(policyDiff(policy({ recipients: [R1, R2] }), policy({ recipients: [R3, R1] })), [
      { field: "recipients", path: "recipients[1]", kind: "removed", before: R2 },
      { field: "recipients", path: "recipients[0]", kind: "added", after: R3 },
    ]);
  });

  it("reports nested protocol fn-list changes with indexed paths", () => {
    const b = policy({ protocols: [{ contract: DEX, fns: ["swap", "withdraw"] }] });
    assert.deepEqual(policyDiff(policy(), b), [
      { field: "protocols", path: "protocols[0].fns[1]", kind: "removed", before: "deposit" },
      { field: "protocols", path: "protocols[0].fns[1]", kind: "added", after: "withdraw" },
    ]);
  });

  it("reports fns switching between any-function (null) and a list", () => {
    const anyFn = policy({ protocols: [{ contract: DEX, fns: null }] });
    assert.deepEqual(policyDiff(policy(), anyFn), [
      {
        field: "protocols",
        path: "protocols[0].fns",
        kind: "changed",
        before: ["swap", "deposit"],
        after: null,
      },
    ]);
  });

  it("matches protocols by contract and reports whole-rule add/remove", () => {
    const b = policy({ protocols: [{ contract: TOKEN, fns: null }] });
    assert.deepEqual(policyDiff(policy(), b), [
      { field: "protocols", path: "protocols[0]", kind: "removed", before: DEX },
      { field: "protocols", path: "protocols[0]", kind: "added", after: TOKEN },
    ]);
  });

  it("matches recipient window caps by recipient", () => {
    const a = policy({ recipient_window_caps: [{ recipient: R1, cap: 10n }, { recipient: R2, cap: 20n }] });
    const b = policy({ recipient_window_caps: [{ recipient: R2, cap: 25n }, { recipient: R3, cap: 5n }] });
    assert.deepEqual(policyDiff(a, b), [
      { field: "recipient_window_caps", path: "recipient_window_caps[0]", kind: "removed", before: R1 },
      {
        field: "recipient_window_caps",
        path: "recipient_window_caps[0].cap",
        kind: "changed",
        before: 20n,
        after: 25n,
      },
      { field: "recipient_window_caps", path: "recipient_window_caps[1]", kind: "added", after: R3 },
    ]);
  });

  it("treats an absent optional list as empty", () => {
    assert.deepEqual(policyDiff(policy(), policy({ blocked_recipients: [] })), []);
    assert.deepEqual(policyDiff(policy(), policy({ blocked_recipients: [R2] })), [
      { field: "blocked_recipients", path: "blocked_recipients[0]", kind: "added", after: R2 },
    ]);
  });

  it("orders changes by field declaration order", () => {
    const b = policy({ dms_grace_secs: 30n, per_tx_cap: 1n, assets: [] });
    assert.deepEqual(
      policyDiff(policy(), b).map((c) => c.field),
      ["per_tx_cap", "assets", "dms_grace_secs"],
    );
  });

  describe("empty diff ⇔ equal under set semantics", () => {
    const pairs: Array<[string, PolicyConfig, PolicyConfig]> = [
      ["identical", policy(), policy()],
      ["permuted recipients", policy(), policy({ recipients: [R2, R3, R1] })],
      ["permuted fns", policy(), policy({ protocols: [{ contract: DEX, fns: ["deposit", "swap"] }] })],
      ["absent vs empty caps", policy(), policy({ recipient_window_caps: [] })],
      ["scalar change", policy(), policy({ window_cap: 151n })],
      ["recipient removed", policy(), policy({ recipients: [R1, R2] })],
      ["fns any vs list", policy(), policy({ protocols: [{ contract: DEX, fns: null }] })],
      ["cap changed", policy({ recipient_window_caps: [{ recipient: R1, cap: 1n }] }),
        policy({ recipient_window_caps: [{ recipient: R1, cap: 2n }] })],
      ["blocked added", policy(), policy({ blocked_recipients: [R3] })],
    ];
    for (const [label, a, b] of pairs) {
      it(label, () => {
        assert.deepEqual(policyDiff(a, a), [], "diff(a, a) is empty");
        assert.equal(
          policyDiff(a, b).length === 0,
          canonical(a) === canonical(b),
          "empty diff exactly when set-equal",
        );
        assert.equal(policyDiff(a, b).length === 0, policyDiff(b, a).length === 0, "symmetric emptiness");
      });
    }
  });
});

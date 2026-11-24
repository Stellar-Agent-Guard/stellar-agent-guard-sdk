/**
 * `policyDiff` (issue #131): structured, set-aware change list between policies.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPolicyDiff, policyDiff, type PolicyChange } from "../../src/policy-diff.ts";
import {
  policyAddressComparisonKey,
  unsafeAccountAddress,
  unsafeContractAddress,
  type AccountAddress,
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

  it("exports canonical Stellar address comparison keys and rejects invalid values", () => {
    assert.equal(sdk.policyAddressComparisonKey, policyAddressComparisonKey);
    assert.equal(policyAddressComparisonKey(R1), R1);
    assert.equal(policyAddressComparisonKey(DEX), DEX);
    assert.notEqual(policyAddressComparisonKey(R1), policyAddressComparisonKey(DEX));
    assert.equal(policyAddressComparisonKey(R1.toLowerCase()), null);
    assert.equal(policyAddressComparisonKey("not-an-address"), null);
    assert.equal(policyAddressComparisonKey(1), null);
  });

  it("reports a scalar change", () => {
    assert.deepEqual(policyDiff(policy(), policy({ per_tx_cap: 2000n })), [
      {
        field: "per_tx_cap",
        path: "per_tx_cap",
        kind: "changed",
        direction: "widening",
        before: 1000n,
        after: 2000n,
      },
    ] satisfies PolicyChange[]);
    assert.deepEqual(policyDiff(policy(), policy({ paused: true })), [
      {
        field: "paused",
        path: "paused",
        kind: "changed",
        direction: "narrowing",
        before: false,
        after: true,
      },
    ] satisfies PolicyChange[]);
  });

  it("reports list removal (index into a) and addition (index into b)", () => {
    assert.deepEqual(policyDiff(policy(), policy({ recipients: [R1, R3] })), [
      {
        field: "recipients",
        path: "recipients[1]",
        kind: "removed",
        direction: "narrowing",
        before: R2,
      },
    ] satisfies PolicyChange[]);
    assert.deepEqual(policyDiff(policy({ recipients: [R1] }), policy({ recipients: [R1, R2] })), [
      {
        field: "recipients",
        path: "recipients[1]",
        kind: "added",
        direction: "widening",
        after: R2,
      },
    ] satisfies PolicyChange[]);
  });

  it("treats a pure reorder as no change (set semantics)", () => {
    assert.deepEqual(policyDiff(policy(), policy({ recipients: [R3, R1, R2] })), []);
    assert.deepEqual(
      policyDiff(policy(), policy({ protocols: [{ contract: DEX, fns: ["deposit", "swap"] }] })),
      [],
    );
  });

  it("distinguishes a swap from a reorder", () => {
    assert.deepEqual(
      policyDiff(policy({ recipients: [R1, R2] }), policy({ recipients: [R3, R1] })),
      [
        {
          field: "recipients",
          path: "recipients[1]",
          kind: "removed",
          direction: "narrowing",
          before: R2,
        },
        {
          field: "recipients",
          path: "recipients[0]",
          kind: "added",
          direction: "widening",
          after: R3,
        },
      ] satisfies PolicyChange[],
    );
  });

  it("reports nested protocol fn-list changes with indexed paths", () => {
    const b = policy({ protocols: [{ contract: DEX, fns: ["swap", "withdraw"] }] });
    assert.deepEqual(policyDiff(policy(), b), [
      {
        field: "protocols",
        path: "protocols[0].fns[1]",
        kind: "removed",
        direction: "narrowing",
        before: "deposit",
      },
      {
        field: "protocols",
        path: "protocols[0].fns[1]",
        kind: "added",
        direction: "widening",
        after: "withdraw",
      },
    ] satisfies PolicyChange[]);
  });

  it("reports fns switching between any-function (null) and a list", () => {
    const anyFn = policy({ protocols: [{ contract: DEX, fns: null }] });
    assert.deepEqual(policyDiff(policy(), anyFn), [
      {
        field: "protocols",
        path: "protocols[0].fns",
        kind: "changed",
        direction: "widening",
        before: ["swap", "deposit"],
        after: null,
      },
    ] satisfies PolicyChange[]);
  });

  it("matches protocols by contract and reports whole-rule add/remove", () => {
    const b = policy({ protocols: [{ contract: TOKEN, fns: null }] });
    assert.deepEqual(policyDiff(policy(), b), [
      {
        field: "protocols",
        path: "protocols[0]",
        kind: "removed",
        direction: "narrowing",
        before: DEX,
      },
      {
        field: "protocols",
        path: "protocols[0]",
        kind: "added",
        direction: "widening",
        after: TOKEN,
      },
    ] satisfies PolicyChange[]);
  });

  it("matches recipient window caps by recipient", () => {
    const a = policy({
      recipient_window_caps: [
        { recipient: R1, cap: 10n },
        { recipient: R2, cap: 20n },
      ],
    });
    const b = policy({
      recipient_window_caps: [
        { recipient: R2, cap: 25n },
        { recipient: R3, cap: 5n },
      ],
    });
    assert.deepEqual(policyDiff(a, b), [
      {
        field: "recipient_window_caps",
        path: "recipient_window_caps[0]",
        kind: "removed",
        direction: "widening",
        before: R1,
      },
      {
        field: "recipient_window_caps",
        path: "recipient_window_caps[0].cap",
        kind: "changed",
        direction: "widening",
        before: 20n,
        after: 25n,
      },
      {
        field: "recipient_window_caps",
        path: "recipient_window_caps[1]",
        kind: "added",
        direction: "narrowing",
        after: R3,
      },
    ] satisfies PolicyChange[]);
  });

  it("treats an absent optional list as empty", () => {
    assert.deepEqual(policyDiff(policy(), policy({ blocked_recipients: [] })), []);
    assert.deepEqual(policyDiff(policy(), policy({ blocked_recipients: [R2] })), [
      {
        field: "blocked_recipients",
        path: "blocked_recipients[0]",
        kind: "added",
        direction: "narrowing",
        after: R2,
      },
    ] satisfies PolicyChange[]);
  });

  it("collapses duplicate members in malformed drafts without implying a change", () => {
    const duplicated = policy({
      assets: [TOKEN, TOKEN],
      recipients: [R1, R1],
      protocols: [
        { contract: DEX, fns: ["swap", "swap"] },
        { contract: DEX, fns: ["withdraw"] },
      ],
      recipient_window_caps: [
        { recipient: R1, cap: 5n },
        { recipient: R1, cap: 6n },
      ],
    });
    const unique = policy({
      assets: [TOKEN],
      recipients: [R1],
      protocols: [{ contract: DEX, fns: ["swap"] }],
      recipient_window_caps: [{ recipient: R1, cap: 5n }],
    });

    assert.deepEqual(policyDiff(duplicated, unique), []);
    assert.deepEqual(policyDiff(unique, duplicated), []);
    assert.deepEqual(
      policyDiff(
        duplicated,
        policy({ assets: [], recipients: [], protocols: [], recipient_window_caps: [] }),
      ),
      [
        {
          field: "assets",
          path: "assets[0]",
          kind: "removed",
          direction: "narrowing",
          before: TOKEN,
        },
        {
          field: "protocols",
          path: "protocols[0]",
          kind: "removed",
          direction: "narrowing",
          before: DEX,
        },
        {
          field: "recipients",
          path: "recipients[0]",
          kind: "removed",
          direction: "narrowing",
          before: R1,
        },
        {
          field: "recipient_window_caps",
          path: "recipient_window_caps[0]",
          kind: "removed",
          direction: "widening",
          before: R1,
        },
      ] satisfies PolicyChange[],
    );
  });

  it("does not normalize invalid addresses into a match", () => {
    assert.deepEqual(
      policyDiff(
        policy({ recipients: ["not-an-address" as AccountAddress] }),
        policy({ recipients: ["NOT-AN-ADDRESS" as AccountAddress] }),
      ),
      [
        {
          field: "recipients",
          path: "recipients[0]",
          kind: "removed",
          direction: "narrowing",
          before: "not-an-address",
        },
        {
          field: "recipients",
          path: "recipients[0]",
          kind: "added",
          direction: "widening",
          after: "NOT-AN-ADDRESS",
        },
      ] satisfies PolicyChange[],
    );
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
      [
        "permuted fns",
        policy(),
        policy({ protocols: [{ contract: DEX, fns: ["deposit", "swap"] }] }),
      ],
      ["absent vs empty caps", policy(), policy({ recipient_window_caps: [] })],
      ["scalar change", policy(), policy({ window_cap: 151n })],
      ["recipient removed", policy(), policy({ recipients: [R1, R2] })],
      ["fns any vs list", policy(), policy({ protocols: [{ contract: DEX, fns: null }] })],
      [
        "cap changed",
        policy({ recipient_window_caps: [{ recipient: R1, cap: 1n }] }),
        policy({ recipient_window_caps: [{ recipient: R1, cap: 2n }] }),
      ],
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
        assert.equal(
          policyDiff(a, b).length === 0,
          policyDiff(b, a).length === 0,
          "symmetric emptiness",
        );
      });
    }
  });

  describe("direction field", () => {
    it("every PolicyChange produced by policyDiff has a valid direction", () => {
      const a = policy();
      const b = policy({
        per_tx_cap: 500n,
        window_secs: 120n,
        window_cap: 200n,
        assets: [],
        protocols: [{ contract: TOKEN, fns: null }],
        recipients: [R1],
        allow_any_recipient: true,
        active_from: 10n,
        active_until: 9999n,
        paused: true,
        dms_grace_secs: 600n,
        blocked_recipients: [R3],
        recipient_window_caps: [{ recipient: R2, cap: 50n }],
      });
      const changes = policyDiff(a, b);
      assert.ok(changes.length > 0, "expected at least one change");
      for (const change of changes) {
        assert.ok(
          change.direction === "widening" ||
            change.direction === "narrowing" ||
            change.direction === "neutral",
          `change at ${change.path} has invalid direction: ${change.direction as string}`,
        );
      }
    });

    it("per_tx_cap increase is widening, decrease is narrowing", () => {
      const up = policyDiff(policy({ per_tx_cap: 500n }), policy({ per_tx_cap: 1000n }));
      assert.equal(up[0]?.direction, "widening");
      const down = policyDiff(policy({ per_tx_cap: 1000n }), policy({ per_tx_cap: 500n }));
      assert.equal(down[0]?.direction, "narrowing");
    });

    it("window_secs increase is narrowing (throughput drops), decrease is widening", () => {
      const up = policyDiff(policy({ window_secs: 60n }), policy({ window_secs: 120n }));
      assert.equal(up[0]?.direction, "narrowing");
      const down = policyDiff(policy({ window_secs: 120n }), policy({ window_secs: 60n }));
      assert.equal(down[0]?.direction, "widening");
    });

    it("paused false→true is narrowing; true→false is widening", () => {
      const pause = policyDiff(policy({ paused: false }), policy({ paused: true }));
      assert.equal(pause[0]?.direction, "narrowing");
      const unpause = policyDiff(policy({ paused: true }), policy({ paused: false }));
      assert.equal(unpause[0]?.direction, "widening");
    });

    it("adding active_until expiry is narrowing; removing is widening", () => {
      const addExpiry = policyDiff(policy({ active_until: 0n }), policy({ active_until: 9999n }));
      assert.equal(addExpiry[0]?.direction, "narrowing");
      const removeExpiry = policyDiff(
        policy({ active_until: 9999n }),
        policy({ active_until: 0n }),
      );
      assert.equal(removeExpiry[0]?.direction, "widening");
    });

    it("dms_grace_secs 0→positive is narrowing; positive→0 is widening", () => {
      const enable = policyDiff(policy({ dms_grace_secs: 0n }), policy({ dms_grace_secs: 300n }));
      assert.equal(enable[0]?.direction, "narrowing");
      const disable = policyDiff(policy({ dms_grace_secs: 300n }), policy({ dms_grace_secs: 0n }));
      assert.equal(disable[0]?.direction, "widening");
    });

    it("blocked_recipients: added is narrowing, removed is widening", () => {
      const add = policyDiff(policy(), policy({ blocked_recipients: [R1] }));
      assert.equal(add[0]?.direction, "narrowing");
      const remove = policyDiff(policy({ blocked_recipients: [R1] }), policy());
      assert.equal(remove[0]?.direction, "widening");
    });

    it("recipient_window_caps: entry added is narrowing, removed is widening", () => {
      const add = policyDiff(
        policy(),
        policy({ recipient_window_caps: [{ recipient: R1, cap: 10n }] }),
      );
      assert.equal(add[0]?.direction, "narrowing");
      const remove = policyDiff(
        policy({ recipient_window_caps: [{ recipient: R1, cap: 10n }] }),
        policy(),
      );
      assert.equal(remove[0]?.direction, "widening");
    });
  });

  describe("formatPolicyDiff (issue #438)", () => {
    it("is exported from the package root", () => {
      assert.equal(sdk.formatPolicyDiff, formatPolicyDiff);
    });

    it("returns 'No changes.' for an empty list", () => {
      assert.equal(formatPolicyDiff([]), "No changes.");
    });

    it("renders a scalar change", () => {
      const changes = policyDiff(policy(), policy({ per_tx_cap: 2000n }));
      const out = formatPolicyDiff(changes);
      assert.ok(out.includes("per_tx_cap:"), `expected field header, got:\n${out}`);
      assert.ok(out.includes("~ 1000 → 2000"), `expected ~ line, got:\n${out}`);
    });

    it("renders additions with + and removals with -", () => {
      const changes = policyDiff(
        policy({ recipients: [R1, R2] }),
        policy({ recipients: [R3, R1] }),
      );
      const out = formatPolicyDiff(changes);
      assert.ok(out.includes("  - "), `expected removal line, got:\n${out}`);
      assert.ok(out.includes("  + "), `expected addition line, got:\n${out}`);
    });

    it("groups multiple changes under a single field header", () => {
      const a = policy({ recipients: [R1, R2, R3] });
      const b = policy({ recipients: [] });
      const out = formatPolicyDiff(policyDiff(a, b));
      const lines = out.split("\n");
      const headers = lines.filter((l) => !l.startsWith("  "));
      assert.equal(headers.length, 1, `expected one field header, got:\n${out}`);
    });

    it("renders boolean values as 'true' and 'false'", () => {
      const out = formatPolicyDiff(policyDiff(policy(), policy({ paused: true })));
      assert.ok(out.includes("~ false → true"), `got:\n${out}`);
    });

    it("renders null fns as '<any function>'", () => {
      const out = formatPolicyDiff(
        policyDiff(policy(), policy({ protocols: [{ contract: DEX, fns: null }] })),
      );
      assert.ok(out.includes("<any function>"), `got:\n${out}`);
    });

    it("renders full addresses by default", () => {
      const out = formatPolicyDiff(
        policyDiff(policy({ recipients: [R1, R2] }), policy({ recipients: [R3, R1] })),
      );
      assert.ok(out.includes(R2), `expected full R2 address, got:\n${out}`);
      assert.ok(out.includes(R3), `expected full R3 address, got:\n${out}`);
    });

    it("truncates addresses when truncateAddresses: true", () => {
      const out = formatPolicyDiff(
        policyDiff(policy({ recipients: [R1, R2] }), policy({ recipients: [R3, R1] })),
        { truncateAddresses: true },
      );
      assert.ok(!out.includes(R2), `expected truncated address, got:\n${out}`);
      assert.ok(!out.includes(R3), `expected truncated address, got:\n${out}`);
    });

    it("produces stable output for the same input", () => {
      const changes = policyDiff(policy(), policy({ per_tx_cap: 2000n, assets: [] }));
      assert.equal(formatPolicyDiff(changes), formatPolicyDiff(changes));
    });
  });
});

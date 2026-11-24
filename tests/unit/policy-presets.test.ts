/**
 * Policy presets (issue #436): POLICY_PRESETS and getPolicyPreset.
 *
 * Tests pin every preset against `tests/fixtures/vendor/policy-presets.json`
 * so that drift between the vendored fixture and the TypeScript constants is
 * caught in CI.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  POLICY_PRESETS,
  getPolicyPreset,
  type PolicyPresetName,
} from "../../src/policy-presets.ts";
import { validateGuardPolicy } from "../../src/policy.ts";
import * as sdk from "../../src/index.ts";

// --- fixture loading ---

interface FixturePreset {
  name: string;
  policy: {
    active_from: number;
    active_until: number;
    allow_any_recipient: boolean;
    assets: string[];
    dms_grace_secs: number;
    paused: boolean;
    per_tx_cap: string;
    protocols: Array<{ contract: string; fns: string[] | null }>;
    recipients: string[];
    window_cap: string;
    window_secs: number;
  };
}

function loadFixture(): Map<string, FixturePreset> {
  const raw = JSON.parse(
    readFileSync(
      new URL("../../tests/fixtures/vendor/policy-presets.json", import.meta.url),
      "utf-8",
    ),
  ) as { presets: FixturePreset[] };
  return new Map(raw.presets.map((p) => [p.name, p]));
}

const PRESET_NAMES: PolicyPresetName[] = [
  "day-trader",
  "payments-bot",
  "watch-only",
  "max-security",
];

describe("POLICY_PRESETS", () => {
  it("is exported from the package root", () => {
    assert.equal(sdk.POLICY_PRESETS, POLICY_PRESETS);
    assert.equal(sdk.getPolicyPreset, getPolicyPreset);
  });

  it("contains exactly the four named presets", () => {
    assert.deepEqual(Object.keys(POLICY_PRESETS).sort(), [...PRESET_NAMES].sort());
  });

  it("every preset is frozen (ReadonlyPolicyConfig)", () => {
    for (const name of PRESET_NAMES) {
      const preset = POLICY_PRESETS[name];
      assert.ok(Object.isFrozen(preset), `${name} top-level not frozen`);
      assert.ok(Object.isFrozen(preset.assets), `${name}.assets not frozen`);
      assert.ok(Object.isFrozen(preset.recipients), `${name}.recipients not frozen`);
      assert.ok(Object.isFrozen(preset.protocols), `${name}.protocols not frozen`);
    }
  });

  it("getPolicyPreset returns the same reference as POLICY_PRESETS[name]", () => {
    for (const name of PRESET_NAMES) {
      assert.equal(getPolicyPreset(name), POLICY_PRESETS[name]);
    }
  });

  describe("pin against fixture", () => {
    const fixture = loadFixture();

    for (const name of PRESET_NAMES) {
      it(name, () => {
        const fp = fixture.get(name);
        assert.ok(fp, `fixture missing preset "${name}"`);
        const preset = POLICY_PRESETS[name];

        assert.equal(preset.per_tx_cap, BigInt(fp.policy.per_tx_cap), "per_tx_cap");
        assert.equal(preset.window_cap, BigInt(fp.policy.window_cap), "window_cap");
        assert.equal(preset.window_secs, BigInt(fp.policy.window_secs), "window_secs");
        assert.equal(preset.active_from, BigInt(fp.policy.active_from), "active_from");
        assert.equal(preset.active_until, BigInt(fp.policy.active_until), "active_until");
        assert.equal(preset.dms_grace_secs, BigInt(fp.policy.dms_grace_secs), "dms_grace_secs");
        assert.equal(preset.paused, fp.policy.paused, "paused");
        assert.equal(
          preset.allow_any_recipient,
          fp.policy.allow_any_recipient,
          "allow_any_recipient",
        );
        assert.deepEqual([...preset.assets].sort(), [...fp.policy.assets].sort(), "assets");
        assert.deepEqual(
          [...preset.recipients].sort(),
          [...fp.policy.recipients].sort(),
          "recipients",
        );

        // protocols: match by contract, fns as sets
        assert.equal(
          preset.protocols.length,
          fp.policy.protocols.length,
          `${name} protocols.length`,
        );
        const fixtureByContract = new Map(fp.policy.protocols.map((r) => [r.contract, r]));
        for (const rule of preset.protocols) {
          const fr = fixtureByContract.get(rule.contract);
          assert.ok(fr, `contract ${rule.contract} not in fixture`);
          if (rule.fns === null) {
            assert.equal(fr.fns, null, "fns null");
          } else {
            assert.ok(fr.fns !== null, "fixture fns should not be null");
            assert.deepEqual([...rule.fns].sort(), [...(fr.fns as string[])].sort(), "fns");
          }
        }
      });
    }
  });

  describe("validateGuardPolicy", () => {
    it("day-trader, payments-bot, max-security produce 0 failures", () => {
      for (const name of ["day-trader", "payments-bot", "max-security"] as const) {
        const failures = validateGuardPolicy(POLICY_PRESETS[name]);
        assert.deepEqual(
          failures,
          [],
          `${name} expected 0 failures but got: ${JSON.stringify(failures)}`,
        );
      }
    });

    it("watch-only has empty assets/recipients by design — produces exactly 2 empty_vector_noop failures", () => {
      const failures = validateGuardPolicy(POLICY_PRESETS["watch-only"]);
      const rules = failures.map((f) => f.rule);
      assert.equal(
        failures.length,
        2,
        `expected 2 failures (empty assets + empty recipients), got: ${JSON.stringify(failures)}`,
      );
      assert.ok(rules.includes("empty_vector_noop"), "expected empty_vector_noop rule");
    });
  });
});

/**
 * Unit tests for `DEFAULT_GUARD_POLICY`, the frozen safe-start baseline (issue #59).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  DEFAULT_GUARD_POLICY,
  decodePolicy,
  policyToScVal,
  unsafeAccountAddress,
  unsafeContractAddress,
  validateGuardPolicy,
  validatePolicyForEncoding,
  type PolicyConfig,
  type ReadonlyPolicyConfig,
} from "../../src/policy.ts";
import * as sdk from "../../src/index.ts";

const TOKEN = unsafeContractAddress(StrKey.encodeContract(Buffer.alloc(32, 7)));
const RECIPIENT = unsafeAccountAddress(Keypair.random().publicKey());

interface PresetFixture {
  presets: Array<{ name: string; policy: Record<string, unknown> }>;
}

function template(name: string): Record<string, unknown> {
  const path = resolve(process.cwd(), "tests/fixtures/vendor/policy-presets.json");
  const doc = JSON.parse(readFileSync(path, "utf8")) as PresetFixture;
  const found = doc.presets.find((preset) => preset.name === name);
  assert.ok(found, `template ${name} missing from the vendored presets`);
  return found.policy;
}

describe("DEFAULT_GUARD_POLICY", () => {
  it("is exported from the package entry point", () => {
    assert.equal(sdk.DEFAULT_GUARD_POLICY, DEFAULT_GUARD_POLICY);
  });

  it("is deny-all with the dead-man switch on", () => {
    assert.deepEqual([...DEFAULT_GUARD_POLICY.assets], []);
    assert.deepEqual([...DEFAULT_GUARD_POLICY.recipients], []);
    assert.deepEqual([...DEFAULT_GUARD_POLICY.protocols], []);
    assert.equal(DEFAULT_GUARD_POLICY.allow_any_recipient, false);
    assert.equal(DEFAULT_GUARD_POLICY.paused, false);
    assert.ok(DEFAULT_GUARD_POLICY.dms_grace_secs > 0n, "dead-man switch must be enabled");
  });

  it("is conservative, and the grace meets SPEC §5 production guidance (>= several days)", () => {
    assert.equal(DEFAULT_GUARD_POLICY.per_tx_cap, 100n);
    assert.equal(DEFAULT_GUARD_POLICY.window_secs, 3600n);
    assert.equal(DEFAULT_GUARD_POLICY.window_cap, 500n);
    assert.ok(DEFAULT_GUARD_POLICY.window_cap >= DEFAULT_GUARD_POLICY.per_tx_cap);
    assert.equal(DEFAULT_GUARD_POLICY.dms_grace_secs, 604800n);
    assert.ok(DEFAULT_GUARD_POLICY.dms_grace_secs >= 3n * 86_400n);
  });

  it("matches the contracts templates it is drawn from", () => {
    const maxSecurity = template("max-security");
    assert.equal(String(DEFAULT_GUARD_POLICY.per_tx_cap), maxSecurity["per_tx_cap"]);
    assert.equal(String(DEFAULT_GUARD_POLICY.window_cap), maxSecurity["window_cap"]);
    assert.equal(Number(DEFAULT_GUARD_POLICY.window_secs), maxSecurity["window_secs"]);
    const watchOnly = template("watch-only");
    assert.equal(Number(DEFAULT_GUARD_POLICY.dms_grace_secs), watchOnly["dms_grace_secs"]);
  });

  it("is deeply frozen: mutation throws in strict mode", () => {
    const policy = DEFAULT_GUARD_POLICY as unknown as PolicyConfig;
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.assets));
    assert.ok(Object.isFrozen(policy.recipients));
    assert.ok(Object.isFrozen(policy.protocols));
    assert.throws(() => {
      policy.per_tx_cap = 1_000_000n;
    }, TypeError);
    assert.throws(() => {
      policy.assets.push(TOKEN);
    }, TypeError);
    assert.throws(() => {
      policy.recipients.push(RECIPIENT);
    }, TypeError);
    assert.equal(DEFAULT_GUARD_POLICY.per_tx_cap, 100n);
  });

  it("reports only the deliberate deny-all findings, and validates clean once extended", () => {
    const failures = validateGuardPolicy(DEFAULT_GUARD_POLICY);
    assert.deepEqual(failures.map((failure) => `${failure.path}:${failure.rule}`).sort(), [
      "assets:empty_vector_noop",
      "recipients:empty_vector_noop",
    ]);

    const extended: ReadonlyPolicyConfig = {
      ...DEFAULT_GUARD_POLICY,
      assets: [TOKEN],
      protocols: [],
      recipients: [RECIPIENT],
    };
    assert.deepEqual(validateGuardPolicy(extended), []);
    assert.deepEqual(validatePolicyForEncoding(extended), []);
  });

  it("round-trips through the encoder and decoder", () => {
    assert.deepEqual(validatePolicyForEncoding(DEFAULT_GUARD_POLICY), []);
    const decoded = decodePolicy(policyToScVal(DEFAULT_GUARD_POLICY));
    assert.equal(decoded.per_tx_cap, DEFAULT_GUARD_POLICY.per_tx_cap);
    assert.equal(decoded.window_secs, DEFAULT_GUARD_POLICY.window_secs);
    assert.equal(decoded.window_cap, DEFAULT_GUARD_POLICY.window_cap);
    assert.equal(decoded.dms_grace_secs, DEFAULT_GUARD_POLICY.dms_grace_secs);
    assert.equal(decoded.allow_any_recipient, false);
    assert.equal(decoded.paused, false);
    assert.deepEqual(decoded.assets, []);
    assert.deepEqual(decoded.recipients, []);
  });

  it("can be extended without touching the baseline", () => {
    const mine: ReadonlyPolicyConfig = {
      ...DEFAULT_GUARD_POLICY,
      assets: [TOKEN],
      protocols: [],
      recipients: [RECIPIENT],
    };
    assert.deepEqual([...mine.assets], [TOKEN]);
    assert.deepEqual([...DEFAULT_GUARD_POLICY.assets], []);
  });
});

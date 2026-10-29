/**
 * Encode parity for `policyToScVal` against the **contracts repo's** canonical
 * ScVal XDR vectors (SDK issue #260; contracts issue #31, PR #277).
 *
 * The vector file lives in `stellar-agent-guard-contracts` and is consumed
 * here through the SDK's vendoring mechanism — provenance-pinned, digest-
 * checked, no second copy and no network at test time (issue #133's rule: no
 * test that decides pass/fail may fetch). Each vector pins the exact ScVal XDR
 * bytes the contract's own encoder produces for one policy; this suite
 * converts the JSON policy to a `PolicyConfig`, runs the SDK's encoder, and
 * compares the bytes.
 *
 * The vectors cover defaults, all lists populated, zero caps, boundary
 * timestamps, and `allow_any_recipient: true`. The captured on-chain
 * Phase-1 fixture (`tests/fixtures/phase1-policy-scval.json`) is a *read* of a
 * deployed contract and stays distinct from this encode-side parity fixture.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { xdr } from "@stellar/stellar-sdk";
import {
  decodePolicy,
  policyToScVal,
  unsafeAccountAddress,
  unsafeContractAddress,
  type AccountAddress,
  type ContractAddress,
  type PolicyConfig,
  type ProtocolRule,
  type RecipientWindowCap,
} from "../../src/policy.ts";

/** One policy as the contracts repo publishes it; integers are decimal strings. */
interface VectorPolicyJson {
  per_tx_cap: string;
  window_secs: string;
  window_cap: string;
  assets: string[];
  protocols: Array<{ contract: string; fns: string[] | null; paused: boolean }>;
  recipients: string[];
  recipient_window_caps: Array<{ recipient: string; cap: string }>;
  blocked_recipients: string[];
  allow_any_recipient: boolean;
  active_from: string;
  active_until: string;
  paused: boolean;
  dms_grace_secs: string;
  protocol_calls_per_window: string;
}

interface PolicyVector {
  name: string;
  policy: VectorPolicyJson;
  expected_scval_xdr_hex: string;
}

interface VendoredVectors {
  _provenance: {
    sourceRepo: string;
    sourceCommit: string;
    sourcePath: string;
    digest: string;
    refreshCommand: string;
    upstreamLanded: boolean;
  };
  policyVectors: {
    format: string;
    description: string;
    vectors: PolicyVector[];
  };
}

function loadVendoredVectors(): VendoredVectors {
  const path = resolve(process.cwd(), "tests/fixtures/vendor/policy-vectors.json");
  return JSON.parse(readFileSync(path, "utf8")) as VendoredVectors;
}

/** Convert one vector's JSON policy into the SDK's `PolicyConfig`, losslessly. */
function vectorToPolicyConfig(policy: VectorPolicyJson): PolicyConfig {
  const protocols: ProtocolRule[] = policy.protocols.map((rule) => ({
    contract: unsafeContractAddress(rule.contract),
    fns: rule.fns === null ? null : [...rule.fns],
    ...(rule.paused ? { paused: true } : {}),
  }));
  const recipientWindowCaps: RecipientWindowCap[] | undefined =
    policy.recipient_window_caps.length > 0
      ? policy.recipient_window_caps.map((cap) => ({
          recipient: unsafeAccountAddress(cap.recipient),
          cap: BigInt(cap.cap),
        }))
      : undefined;
  const blockedRecipients: AccountAddress[] | undefined =
    policy.blocked_recipients.length > 0
      ? policy.blocked_recipients.map((address) => unsafeAccountAddress(address))
      : undefined;
  return {
    per_tx_cap: BigInt(policy.per_tx_cap),
    window_secs: BigInt(policy.window_secs),
    window_cap: BigInt(policy.window_cap),
    assets: policy.assets.map((address) => unsafeContractAddress(address) as ContractAddress),
    protocols,
    recipients: policy.recipients.map((address) => unsafeAccountAddress(address)),
    allow_any_recipient: policy.allow_any_recipient,
    active_from: BigInt(policy.active_from),
    active_until: BigInt(policy.active_until),
    paused: policy.paused,
    dms_grace_secs: BigInt(policy.dms_grace_secs),
    protocol_calls_per_window: Number(policy.protocol_calls_per_window),
    ...(recipientWindowCaps ? { recipient_window_caps: recipientWindowCaps } : {}),
    ...(blockedRecipients ? { blocked_recipients: blockedRecipients } : {}),
  };
}

describe("policyToScVal encode parity (contracts vectors, issue #260)", () => {
  it("vendors the contracts vector file with its provenance and an intact digest", () => {
    const doc = loadVendoredVectors();
    const provenance = doc._provenance;

    assert.equal(provenance.sourceRepo, "Stellar-Agent-Guard/stellar-agent-guard-contracts");
    assert.match(provenance.sourceCommit, /^[0-9a-f]{40}$/, "source commit must be a pinned SHA");
    assert.equal(provenance.sourcePath, "tests/fixtures/policy-vectors.json");
    assert.equal(provenance.refreshCommand, "npm run vendor:refresh");
    assert.equal(provenance.upstreamLanded, true);

    // The digest is recomputed from the vendored file alone, so a hand-edit or
    // a truncated download fails here instead of silently becoming the truth.
    const canonical = `${JSON.stringify(doc.policyVectors, null, 2)}\n`;
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    assert.equal(
      provenance.digest,
      `sha256:${digest}`,
      "the vendored vectors were modified without refreshing their digest — run npm run vendor:refresh and commit both together",
    );
  });

  it("covers the five vector classes the contracts issue pins", () => {
    const { policyVectors } = loadVendoredVectors();
    assert.equal(policyVectors.format, "soroban-policy-scval-xdr-v1");
    const names = policyVectors.vectors.map((vector) => vector.name);
    for (const required of [
      "defaults",
      "all-lists-populated",
      "zero-caps",
      "boundary-timestamps",
      "allow-any-recipient",
    ]) {
      assert.ok(names.includes(required), `missing required vector: ${required}`);
    }
  });

  it("encodes every vector to the exact contract-produced XDR bytes", () => {
    const { policyVectors } = loadVendoredVectors();
    assert.ok(policyVectors.vectors.length >= 5, "the fixture must carry the full vector set");

    for (const vector of policyVectors.vectors) {
      const policy = vectorToPolicyConfig(vector.policy);
      const encoded = policyToScVal(policy).toXDR("hex");
      assert.equal(
        encoded,
        vector.expected_scval_xdr_hex,
        `vector '${vector.name}' diverges from the contract's canonical encoding`,
      );
    }
  });

  it("re-encodes each decoded vector to the same bytes (decode side agrees too)", () => {
    const { policyVectors } = loadVendoredVectors();
    for (const vector of policyVectors.vectors) {
      const scVal = xdr.ScVal.fromXDR(vector.expected_scval_xdr_hex, "hex");
      const decoded = decodePolicy(scVal);
      assert.equal(
        policyToScVal(decoded).toXDR("hex"),
        vector.expected_scval_xdr_hex,
        `vector '${vector.name}' does not survive the decode/encode round trip`,
      );
    }
  });

  it("decodes the boundary vector's u32 and i128 extremes without loss", () => {
    const { policyVectors } = loadVendoredVectors();
    const boundary = policyVectors.vectors.find((vector) => vector.name === "boundary-timestamps");
    assert.ok(boundary, "the boundary-timestamps vector must exist");
    const decoded = decodePolicy(xdr.ScVal.fromXDR(boundary.expected_scval_xdr_hex, "hex"));

    assert.equal(decoded.protocol_calls_per_window, 4_294_967_295, "u32::MAX");
    assert.equal(decoded.window_secs, 2n ** 64n - 1n, "u64::MAX");
    assert.equal(decoded.active_until, 2n ** 64n - 1n);
    assert.equal(decoded.dms_grace_secs, 2n ** 64n - 1n);
    assert.equal(decoded.paused, true);
    assert.equal(decoded.per_tx_cap, 1n);
    assert.equal(decoded.window_cap, 1n);
  });

  it("keeps the captured Phase-1 read fixture distinct from the parity vectors", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../fixtures/phase1-policy-scval.json", import.meta.url), "utf8"),
    ) as { scvalBase64: string };
    const phase1Hex = Buffer.from(fixture.scvalBase64, "base64").toString("hex");
    const { policyVectors } = loadVendoredVectors();
    for (const vector of policyVectors.vectors) {
      assert.notEqual(
        vector.expected_scval_xdr_hex,
        phase1Hex,
        "the shared parity fixture must not be replaced by the on-chain Phase-1 capture",
      );
    }
  });
});

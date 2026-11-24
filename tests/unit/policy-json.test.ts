/**
 * Canonical byte stability of `encodePolicyJson()` (issue #440).
 *
 * Policy JSON is an interchange format: ops scripts diff it and dashboards hash
 * it to detect revisions. That only works if re-encoding the same policy
 * produces the same bytes, so this suite pins the exact output for
 * representative policies as committed golden files. It is deliberately
 * byte-for-byte, not deep-equal: key order, integer formatting and whitespace
 * are part of the promise.
 *
 * A failure prints the first differing line with `-`/`+` context, so a
 * formatting change is reviewable rather than a wall of JSON.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { decodePolicyJson, encodePolicyJson, type PolicyJson } from "../../src/policy-json.ts";
import type { PolicyConfig } from "../../src/policy.ts";
import { POLICY_JSON_GOLDEN_CASES } from "../fixtures/policy-json/cases.ts";

const GOLDEN_DIR = new URL("../fixtures/policy-json/", import.meta.url);

/** Serialize exactly the way the golden files are committed. */
function canonicalText(policy: PolicyConfig): string {
  return `${JSON.stringify(encodePolicyJson(policy), null, 2)}\n`;
}

/**
 * Assert two canonical documents are byte-identical, reporting the first
 * differing line with a small context window instead of two whole documents.
 */
function assertGolden(actual: string, expected: string, file: string): void {
  if (actual === expected) return;
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  const firstDifference = actualLines.findIndex((line, index) => line !== expectedLines[index]);
  const index =
    firstDifference === -1 ? Math.min(actualLines.length, expectedLines.length) : firstDifference;
  const from = Math.max(0, index - 3);
  const to = Math.max(index + 4, from);
  const window = (lines: string[], marker: string) =>
    lines
      .slice(from, to)
      .map((line, offset) => `${marker} ${String(from + offset + 1).padStart(4)} | ${line}`)
      .join("\n");

  assert.fail(
    `${file} is no longer byte-identical to the committed golden output.\n` +
      `This is a Policy JSON compatibility change: review the diff, then either fix the encoder ` +
      `or update the golden and document the change under "Canonical ordering" in ` +
      `docs/api/policy-json.md.\n` +
      `first difference at line ${index + 1}\n` +
      `--- committed golden\n${window(expectedLines, "-")}\n` +
      `+++ encodePolicyJson() output\n${window(actualLines, "+")}`,
  );
}

/**
 * Semantic form for round-trip comparison: a protocol rule's `paused: false` and
 * an absent `paused` mean the same thing (the format omits the default), so
 * compare against the normalized policy rather than the one that happened to
 * spell the default out.
 */
function normalize(policy: PolicyConfig): unknown {
  return {
    ...policy,
    protocols: policy.protocols.map((rule) => ({
      contract: rule.contract,
      fns: rule.fns,
      ...(rule.paused === true ? { paused: true } : {}),
    })),
  };
}

/** Reverse the key order of every object, recursively, without changing values. */
function reverseKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .reverse()
      .map((key) => [key, reverseKeyOrder(record[key])]),
  );
}

describe("Policy JSON canonical bytes (issue #440)", () => {
  for (const { file, purpose, policy } of POLICY_JSON_GOLDEN_CASES) {
    describe(file, () => {
      it(`pins canonical output: ${purpose}`, async () => {
        const expected = await readFile(new URL(file, GOLDEN_DIR), "utf8");
        assertGolden(canonicalText(policy), expected, file);
      });

      it("decodePolicyJson(encodePolicyJson(p)) preserves semantics", () => {
        const decoded = decodePolicyJson(encodePolicyJson(policy));
        assert.deepEqual(normalize(decoded), normalize(policy));
        assert.deepEqual(
          decodePolicyJson(JSON.stringify(encodePolicyJson(policy))),
          decoded,
          "decoding the serialized document must equal decoding the in-memory object",
        );
      });

      it("reordering the input object's keys does not change the output", async () => {
        const expected = await readFile(new URL(file, GOLDEN_DIR), "utf8");
        const reordered = reverseKeyOrder(encodePolicyJson(policy)) as PolicyJson;
        // Decoding canonicalizes again, so a key-order-insensitive input path
        // (a JSON file authored by hand, a dashboard form) still hashes the same.
        const decoded = decodePolicyJson(reordered);
        assertGolden(canonicalText(decoded), expected, file);
      });
    });
  }

  it("writes the fixed top-level key order the compatibility promise names", () => {
    const policy = POLICY_JSON_GOLDEN_CASES[3]!.policy;
    assert.deepEqual(Object.keys(encodePolicyJson(policy)), [
      "version",
      "per_tx_cap",
      "window_secs",
      "window_cap",
      "assets",
      "protocols",
      "recipients",
      "allow_any_recipient",
      "active_from",
      "active_until",
      "paused",
      "dms_grace_secs",
      "recipient_window_caps",
      "blocked_recipients",
      "protocol_calls_per_window",
    ]);
  });

  it("is idempotent: encoding a decoded document reproduces the same bytes", () => {
    for (const { policy } of POLICY_JSON_GOLDEN_CASES) {
      const once = canonicalText(policy);
      const twice = canonicalText(decodePolicyJson(once));
      assert.equal(twice, once);
    }
  });
});

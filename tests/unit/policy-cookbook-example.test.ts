/**
 * Policy cookbook (issue #444): every recipe compiles, validates, and its
 * documented `describePolicy()` output is still the one in the cookbook.
 *
 * Importing the examples is the point: a recipe that stops typechecking, stops
 * validating, or whose summary drifts from the prose fails here rather than in a
 * reader's deployment.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { policies } from "../../examples/policy-cookbook.ts";
import { describePolicy, validateGuardPolicy } from "../../src/policy.ts";

const DOC = readFileSync(new URL("../../docs/policy-cookbook.md", import.meta.url), "utf8");
// Pinned "now" for the staged-rollout summary. The other recipes have no active
// window, so their summary is independent of the clock.
const NOW = 1_700_000_000n;

describe("policy cookbook (issue #444)", () => {
  it("ships exactly the five reviewed recipes", () => {
    assert.deepEqual(
      policies.map((entry) => entry.id),
      [
        "single-recipient-payer",
        "hourly-capped-trading-agent",
        "staged-rollout",
        "treasury-with-pause",
        "deny-all-observer",
      ],
    );
  });

  for (const { id, policy } of policies) {
    it(`${id} is a complete policy that validates with no failures`, () => {
      assert.deepEqual(validateGuardPolicy(policy), []);
    });

    it(`${id} documents the exact describePolicy() output`, () => {
      const summary = describePolicy(policy, { nowSecs: NOW });
      assert.ok(
        DOC.includes(summary),
        `docs/policy-cookbook.md no longer contains the describePolicy() output for ${id}:\n${summary}`,
      );
    });
  }
});

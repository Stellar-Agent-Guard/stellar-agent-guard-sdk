/**
 * The agent-runtime example (docs/agent-runtime.md, issue #74): the failure-mode
 * table in the guide is pinned here so it cannot drift from the code.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actionFor, alertFor, guardedTransfer } from "../../examples/agent-runtime.ts";
import type { GuardEvent, PreFlightDecision, PreFlightInterceptor } from "../../src/index.ts";
import { unsafeContractAddress } from "../../src/policy.ts";

const call = {
  contract: unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"),
  fn: "transfer",
  args: [],
};

const admissible: PreFlightDecision = {
  allowed: true,
  kind: "admissible",
  estimatedResourceFee: 1n,
  footprintKeys: 1,
};
const blocked: PreFlightDecision = {
  allowed: false,
  kind: "blocked",
  reason: "per_tx_cap_exceeded",
  explanation: "over the cap",
  detail: "d",
  diagnosticEvents: [],
};
const undetermined: PreFlightDecision = {
  allowed: false,
  kind: "undetermined",
  detail: "rpc down",
};
const rateLimited: PreFlightDecision = { ...undetermined, cause: "rate_limited" };

const stub = (decision: PreFlightDecision) =>
  ({ check: async () => decision }) as unknown as PreFlightInterceptor;

describe("agent runtime failure modes", () => {
  it("executes only an admissible verdict; blocked and undetermined both refuse", () => {
    assert.equal(actionFor(admissible), "execute");
    assert.equal(actionFor(blocked), "refuse");
    assert.equal(actionFor(undetermined), "refuse");
    assert.equal(actionFor(rateLimited), "refuse");
  });

  it("alerts on a block and on an undetermined verdict, and stays quiet on admissible", async () => {
    for (const [decision, expected] of [
      [admissible, 0],
      [blocked, 1],
      [undetermined, 1],
      [rateLimited, 1],
    ] as const) {
      const alerts: string[] = [];
      const action = await guardedTransfer(stub(decision), call, (m) => alerts.push(m));
      assert.equal(action, actionFor(decision));
      assert.equal(alerts.length, expected);
    }
  });

  it("raises telemetry alerts for freezes, policy changes and blocked decisions only", () => {
    const event = (partial: Partial<GuardEvent>) => partial as GuardEvent;
    assert.match(alertFor(event({ kind: "frozen" }))!, /frozen/);
    assert.match(alertFor(event({ kind: "policy_set" }))!, /policy/);
    assert.match(
      alertFor(
        event({ kind: "auth_checked", decision: { result: "blocked", reason: "paused" } as never }),
      )!,
      /paused/,
    );
    assert.equal(alertFor(event({ kind: "heartbeat" })), null);
    assert.equal(
      alertFor(
        event({ kind: "auth_checked", decision: { result: "allowed", reason: null } as never }),
      ),
      null,
    );
  });
});

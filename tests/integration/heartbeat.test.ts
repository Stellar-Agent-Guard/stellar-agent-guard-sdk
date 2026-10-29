/**
 * `heartbeat()` against the live guard (issue #75).
 *
 * A real heartbeat is signed through the custom-account auth path, submitted,
 * and its effect is checked by re-reading `status()`: `LastHeartbeat` must be
 * non-zero and the dead-man switch not expired. The transaction hash is printed
 * so it can be appended to the evidence file.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { rpc } from "@stellar/stellar-sdk";
import { heartbeat, readGuardStatus } from "../../src/heartbeat.ts";
import {
  TESTNET_PASSPHRASE,
  installPolicy,
  loadPhase2Config,
  type Phase2Config,
} from "./harness.ts";

let config: Phase2Config;
let server: rpc.Server;

before(async () => {
  config = await loadPhase2Config();
  server = new rpc.Server(config.rpcUrl);
});

describe("heartbeat() against the live guard", () => {
  it("submits a real heartbeat and verifies LastHeartbeat via a status re-read", async () => {
    await installPolicy(server, config);

    const result = await heartbeat({
      server,
      guard: config.guard,
      signer: config.keys.agent,
      networkPassphrase: TESTNET_PASSPHRASE,
    });

    assert.match(result.transactionHash, /^[0-9a-f]{64}$/);
    assert.equal(result.verified, true, "status() should show the heartbeat took effect");
    assert.ok(result.lastHeartbeat !== null && result.lastHeartbeat > 0n);

    const reread = await readGuardStatus({
      server,
      guard: config.guard,
      source: config.keys.agent.publicKey(),
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    assert.equal(BigInt(reread.last_heartbeat), result.lastHeartbeat);
    assert.equal(reread.heartbeat_expired, false);
    console.log(`[heartbeat] tx ${result.transactionHash} ledger ${result.ledger}`);
  });
});

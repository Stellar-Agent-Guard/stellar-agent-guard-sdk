/**
 * Read-only preview against the live guard (issue #465).
 *
 * The preview must observe the installed policy without touching chain state:
 * no transaction is built for submission, signed or broadcast. The policy is
 * re-read afterwards to prove the guard did not change.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { rpc } from "@stellar/stellar-sdk";
import { policyHash, previewSetPolicy, unsafeContractAddress } from "../../src/index.ts";
import { installPolicy, loadPhase2Config, readPolicy, type Phase2Config } from "./harness.ts";

let config: Phase2Config;
let server: rpc.Server;

before(async () => {
  config = await loadPhase2Config();
  server = new rpc.Server(config.rpcUrl);
});

describe("previewSetPolicy against the live guard", () => {
  it("previews the installed policy with an empty diff and no state change", async () => {
    await installPolicy(server, config);
    const before = await readPolicy(server, config);
    assert.ok(before, "the harness must install a policy before previewing");

    const preview = await previewSetPolicy({
      server,
      guard: unsafeContractAddress(config.guard),
      policy: before,
    });

    assert.equal(
      preview.valid,
      true,
      preview.failures.map((failure) => failure.message).join("; "),
    );
    assert.deepEqual(preview.diff, []);
    assert.equal(preview.policyHash, policyHash(before));
    assert.deepEqual(preview.current, before);

    assert.deepEqual(await readPolicy(server, config), before, "preview changed no chain state");
  });
});

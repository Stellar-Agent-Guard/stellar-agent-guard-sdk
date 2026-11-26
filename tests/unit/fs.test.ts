/**
 * Policy file loader tests (issue #105).
 *
 * The three failure modes are asserted by class (and, for the filesystem case,
 * by errno code) rather than by message text, because a script integrator is
 * expected to branch on the class.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import {
  PolicyDecodeError,
  PolicyFileReadError,
  PolicyValidationError,
  parseEventRecord,
  policyToJson,
  serializeEventRecord,
  unsafeAccountAddress,
  unsafeContractAddress,
  type CursorStoreScope,
  type GuardEvent,
  type PolicyConfig,
} from "../../src/index.ts";
import {
  JsonFileCursorStore,
  createJsonLinesWriter,
  diffPolicyFiles,
  formatPolicyDiff,
  loadPolicyFromFile,
} from "../../src/fs.ts";

const TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
const RECIPIENT = unsafeAccountAddress("GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH");

const scratch = mkdtempSync(join(tmpdir(), "stellar-agent-guard-fs-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function samplePolicy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    per_tx_cap: 1000n,
    window_secs: 60n,
    window_cap: 150n,
    assets: [TOKEN],
    protocols: [],
    recipients: [RECIPIENT],
    allow_any_recipient: false,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: 0n,
    ...overrides,
  };
}

function writeTemp(name: string, contents: string): string {
  const file = join(scratch, name);
  writeFileSync(file, contents, "utf8");
  return file;
}

describe("loadPolicyFromFile (issue #105)", () => {
  it("returns a validated policy from a JSON file", async () => {
    const expected = samplePolicy();
    const file = writeTemp("valid.json", JSON.stringify(policyToJson(expected)));

    const loaded = await loadPolicyFromFile(file);

    assert.deepEqual(loaded, expected);
  });

  it("accepts the guard address and applies its self-reference rule", async () => {
    const guard = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
    const file = writeTemp(
      "self-asset.json",
      JSON.stringify(policyToJson(samplePolicy({ assets: [unsafeContractAddress(guard)] }))),
    );

    await assert.rejects(loadPolicyFromFile(file, { guardAddress: guard }), (error: unknown) => {
      assert(error instanceof PolicyValidationError);
      assert.ok(error.failures.some((failure) => failure.rule === "self_as_asset"));
      return true;
    });
  });

  it("rejects a missing file with PolicyFileReadError and errno ENOENT", async () => {
    const missing = join(scratch, "does-not-exist.json");

    await assert.rejects(loadPolicyFromFile(missing), (error: unknown) => {
      assert(error instanceof PolicyFileReadError);
      assert.equal(error.path, missing);
      assert.equal(error.code, "ENOENT");
      return true;
    });
  });

  it("rejects invalid JSON with PolicyDecodeError", async () => {
    const file = writeTemp("invalid.json", "{ not json");

    await assert.rejects(loadPolicyFromFile(file), (error: unknown) => {
      assert(error instanceof PolicyDecodeError);
      assert.equal(error.path, "policy");
      assert.match(error.message, /not valid JSON/);
      return true;
    });
  });

  it("rejects a structurally valid policy that violates SPEC §8 with every failure", async () => {
    // Duplicate recipients and an inverted active window: both parse as JSON
    // policy, both fail validation, and both must be reported together.
    const file = writeTemp(
      "invalid-policy.json",
      JSON.stringify(
        policyToJson(
          samplePolicy({
            recipients: [RECIPIENT, RECIPIENT],
            active_from: 100n,
            active_until: 50n,
          }),
        ),
      ),
    );

    await assert.rejects(loadPolicyFromFile(file), (error: unknown) => {
      assert(error instanceof PolicyValidationError);
      assert.equal(error.path, file);
      const rules = error.failures.map((failure) => failure.rule);
      assert.ok(rules.includes("duplicate_recipient"));
      assert.ok(rules.includes("active_window_inverted"));
      assert.match(error.message, /2 failure\(s\)/);
      return true;
    });
  });

  it("keeps node:fs out of the root entry's import graph", () => {
    const rootEntry = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");

    assert.ok(!rootEntry.includes("node:fs"), "root entry must not import node:fs");
    assert.ok(!rootEntry.includes('"./fs.ts"'), "root entry must not re-export the ./fs subpath");
  });
});

describe("diffPolicyFiles (issue #499)", () => {
  it("returns structured diff and formatted summary for two distinct valid policy files", async () => {
    const fileA = writeTemp(
      "diff-left.json",
      JSON.stringify(policyToJson(samplePolicy({ per_tx_cap: 1000n }))),
    );
    const fileB = writeTemp(
      "diff-right.json",
      JSON.stringify(policyToJson(samplePolicy({ per_tx_cap: 2000n }))),
    );

    const result = await diffPolicyFiles(fileA, fileB);

    assert.equal(result.diff.length, 1);
    assert.equal(result.changes.length, 1);
    assert.equal(result.diff[0]!.field, "per_tx_cap");
    assert.equal(result.diff[0]!.kind, "changed");
    assert.equal(result.diff[0]!.before, 1000n);
    assert.equal(result.diff[0]!.after, 2000n);
    assert.match(result.summary, /~ per_tx_cap: 1000 -> 2000/);
  });

  it("returns empty diff and empty summary for identical policy files", async () => {
    const fileA = writeTemp("diff-identical-1.json", JSON.stringify(policyToJson(samplePolicy())));
    const fileB = writeTemp("diff-identical-2.json", JSON.stringify(policyToJson(samplePolicy())));

    const result = await diffPolicyFiles(fileA, fileB);

    assert.deepEqual(result.diff, []);
    assert.deepEqual(result.changes, []);
    assert.equal(result.summary, "");
  });

  it("rejects when left file is missing with PolicyFileReadError naming left", async () => {
    const missing = join(scratch, "missing-left.json");
    const valid = writeTemp("diff-valid-right.json", JSON.stringify(policyToJson(samplePolicy())));

    await assert.rejects(diffPolicyFiles(missing, valid), (error: unknown) => {
      assert(error instanceof PolicyFileReadError);
      assert.equal(error.path, missing);
      assert.match(error.message, /^left policy file/);
      return true;
    });
  });

  it("rejects when right file is missing with PolicyFileReadError naming right", async () => {
    const valid = writeTemp("diff-valid-left.json", JSON.stringify(policyToJson(samplePolicy())));
    const missing = join(scratch, "missing-right.json");

    await assert.rejects(diffPolicyFiles(valid, missing), (error: unknown) => {
      assert(error instanceof PolicyFileReadError);
      assert.equal(error.path, missing);
      assert.match(error.message, /^right policy file/);
      return true;
    });
  });

  it("rejects when left file has invalid JSON with PolicyDecodeError naming left", async () => {
    const invalid = writeTemp("diff-invalid-left.json", "{ broken");
    const valid = writeTemp(
      "diff-valid-right-2.json",
      JSON.stringify(policyToJson(samplePolicy())),
    );

    await assert.rejects(diffPolicyFiles(invalid, valid), (error: unknown) => {
      assert(error instanceof PolicyDecodeError);
      assert.match(error.message, /^left policy file/);
      return true;
    });
  });

  it("rejects when right file has invalid JSON with PolicyDecodeError naming right", async () => {
    const valid = writeTemp("diff-valid-left-2.json", JSON.stringify(policyToJson(samplePolicy())));
    const invalid = writeTemp("diff-invalid-right.json", "{ broken");

    await assert.rejects(diffPolicyFiles(valid, invalid), (error: unknown) => {
      assert(error instanceof PolicyDecodeError);
      assert.match(error.message, /^right policy file/);
      return true;
    });
  });

  it("rejects when left file fails validation with PolicyValidationError naming left", async () => {
    const invalidPolicy = writeTemp(
      "diff-invalid-policy-left.json",
      JSON.stringify(
        policyToJson(
          samplePolicy({
            recipients: [RECIPIENT, RECIPIENT],
          }),
        ),
      ),
    );
    const valid = writeTemp(
      "diff-valid-right-3.json",
      JSON.stringify(policyToJson(samplePolicy())),
    );

    await assert.rejects(diffPolicyFiles(invalidPolicy, valid), (error: unknown) => {
      assert(error instanceof PolicyValidationError);
      assert.match(error.message, /^left policy file/);
      return true;
    });
  });

  it("rejects when right file fails validation with PolicyValidationError naming right", async () => {
    const valid = writeTemp("diff-valid-left-3.json", JSON.stringify(policyToJson(samplePolicy())));
    const invalidPolicy = writeTemp(
      "diff-invalid-policy-right.json",
      JSON.stringify(
        policyToJson(
          samplePolicy({
            recipients: [RECIPIENT, RECIPIENT],
          }),
        ),
      ),
    );

    await assert.rejects(diffPolicyFiles(valid, invalidPolicy), (error: unknown) => {
      assert(error instanceof PolicyValidationError);
      assert.match(error.message, /^right policy file/);
      return true;
    });
  });

  it("validates guardAddress self-reference rules on both sides before diffing", async () => {
    const guard = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
    const selfAsset = writeTemp(
      "diff-self-asset.json",
      JSON.stringify(policyToJson(samplePolicy({ assets: [unsafeContractAddress(guard)] }))),
    );
    const valid = writeTemp("diff-valid-both.json", JSON.stringify(policyToJson(samplePolicy())));

    await assert.rejects(
      diffPolicyFiles(selfAsset, valid, { guardAddress: guard }),
      (error: unknown) => {
        assert(error instanceof PolicyValidationError);
        assert.match(error.message, /^left policy file/);
        return true;
      },
    );

    await assert.rejects(
      diffPolicyFiles(valid, selfAsset, { guardAddress: guard }),
      (error: unknown) => {
        assert(error instanceof PolicyValidationError);
        assert.match(error.message, /^right policy file/);
        return true;
      },
    );
  });

  it("formatPolicyDiff renders additions, removals, and changes accurately", () => {
    const formatted = formatPolicyDiff([
      { field: "per_tx_cap", path: "per_tx_cap", kind: "changed", before: 100n, after: 200n },
      { field: "recipients", path: "recipients[0]", kind: "added", after: "GAOBC" },
      { field: "recipients", path: "recipients[1]", kind: "removed", before: "GBRPY" },
    ]);

    assert.equal(
      formatted,
      "~ per_tx_cap: 100 -> 200\n+ recipients[0]: GAOBC\n- recipients[1]: GBRPY",
    );
    assert.equal(formatPolicyDiff([]), "");
  });
});

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

/** One complete committed guard event, enough for a parseable record. */
function guardEvent(id: string): GuardEvent {
  return {
    id,
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "ledger",
    stream: "committed",
    contractId: GUARD,
    ledger: 42,
    ledgerClosedAt: "2026-11-25T00:00:00Z",
    observedAt: null,
    transactionHash: "ab".repeat(32),
    decision: { result: "allowed", reason: null, source: "ledger" },
    data: {},
  };
}

describe("JsonFileCursorStore (issue #426)", () => {
  const scope = (
    stream: CursorStoreScope["stream"],
    network = "rpc.testnet",
  ): CursorStoreScope => ({
    network,
    guard: GUARD,
    stream,
  });

  it("keeps scoped committed and failed-tx cursors across a simulated restart", async () => {
    const file = join(scratch, "cursor-store.json");
    const first = new JsonFileCursorStore({ path: file });
    await first.save("committed-1", scope("events"));
    await first.save("failed-tx-1", scope("failed_tx"));

    // A new instance is a new process: it must read the file, not shared state.
    const restarted = new JsonFileCursorStore({ path: file });
    assert.equal(await restarted.load(scope("events")), "committed-1");
    assert.equal(await restarted.load(scope("failed_tx")), "failed-tx-1");
  });

  it("scopes cursors by network and guard, and keeps unscoped use separate", async () => {
    const file = join(scratch, "cursor-scopes.json");
    const store = new JsonFileCursorStore({ path: file });
    await store.save("mainnet", scope("events", "rpc.mainnet"));
    await store.save("testnet", scope("events"));
    await store.save("unscoped");

    const restarted = new JsonFileCursorStore({ path: file });
    assert.equal(await restarted.load(scope("events", "rpc.mainnet")), "mainnet");
    assert.equal(await restarted.load(scope("events")), "testnet");
    assert.equal(await restarted.load(), "unscoped");
    assert.equal(await restarted.load({ ...scope("events"), guard: "COTHER" }), null);
  });

  it("treats a missing file as an empty store and touches no file until a save", async () => {
    const file = join(scratch, "cursor-missing.json");
    const store = new JsonFileCursorStore({ path: file });

    assert.equal(await store.load(scope("events")), null);
    assert.equal(existsSync(file), false, "loading must not create the store file");
  });

  it("does not rewrite the file when the cursor is unchanged", async () => {
    const file = join(scratch, "cursor-unchanged.json");
    const store = new JsonFileCursorStore({ path: file });
    await store.save("cursor-1", scope("events"));

    rmSync(file);
    await store.save("cursor-1", scope("events"));

    assert.equal(existsSync(file), false, "an unchanged cursor must not be written again");
    assert.equal(await store.load(scope("events")), "cursor-1");
  });

  it("rejects corrupt JSON with PolicyFileReadError naming the path", async () => {
    const file = writeTemp("cursor-corrupt.json", "{ not json");

    await assert.rejects(
      new JsonFileCursorStore({ path: file }).load(scope("events")),
      (error: unknown) => {
        assert(error instanceof PolicyFileReadError);
        assert.equal(error.path, file);
        assert.equal(error.code, "EJSONPARSE");
        assert.match(error.message, /recoverCorrupt/);
        return true;
      },
    );
  });

  it("recovers from a corrupt file only when recoverCorrupt is explicit", async () => {
    const file = writeTemp("cursor-recover.json", "[]");
    const store = new JsonFileCursorStore({ path: file, recoverCorrupt: true });

    assert.equal(await store.load(scope("events")), null);
    await store.save("cursor-2", scope("events"));

    const restarted = new JsonFileCursorStore({ path: file });
    assert.equal(await restarted.load(scope("events")), "cursor-2");
  });

  it("rejects a JSON value that is not a cursor string", async () => {
    const file = writeTemp("cursor-bad-value.json", JSON.stringify({ key: 42 }));

    await assert.rejects(
      new JsonFileCursorStore({ path: file }).load(),
      (error: unknown) => error instanceof PolicyFileReadError,
    );
  });

  it("serializes concurrent saves and leaves no temporary files behind", async () => {
    const file = join(scratch, "cursor-concurrent.json");
    const store = new JsonFileCursorStore({ path: file });

    await Promise.all([
      store.save("a", scope("events", "net-a")),
      store.save("b", scope("events", "net-b")),
      store.save("c", scope("failed_tx", "net-a")),
    ]);

    const restarted = new JsonFileCursorStore({ path: file });
    assert.equal(await restarted.load(scope("events", "net-a")), "a");
    assert.equal(await restarted.load(scope("events", "net-b")), "b");
    assert.equal(await restarted.load(scope("failed_tx", "net-a")), "c");

    const leftovers = readdirSync(scratch).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "atomic writes must not leave temp files");
  });
});

describe("createJsonLinesWriter (issue #427)", () => {
  it("writes one parseable serializeEventRecord() line per event", async () => {
    const file = join(scratch, "events.jsonl");
    const writer = createJsonLinesWriter({ path: file });

    await writer.write(guardEvent("ledger:1:event_auth_checked"));
    await writer.write(guardEvent("ledger:2:event_auth_checked"));
    await writer.close();

    assert.equal(writer.count, 2);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(
      lines[0],
      serializeEventRecord(guardEvent("ledger:1:event_auth_checked")),
      "the file must contain the same record format as recentJsonLines()",
    );
    for (const line of lines) {
      const parsed = parseEventRecord(line);
      assert.equal(parsed.version, 1);
      assert.equal(parsed.event.kind, "auth_checked");
    }
  });

  it("rotates by size and retains at most maxFiles rotated files", async () => {
    const file = join(scratch, "events-rotated.jsonl");
    const sample = guardEvent("ledger:0:event_auth_checked");
    const lineBytes = Buffer.byteLength(`${serializeEventRecord(sample)}\n`);
    const writer = createJsonLinesWriter({ path: file, maxBytes: lineBytes * 2, maxFiles: 2 });

    for (let index = 1; index <= 5; index += 1) {
      await writer.write(guardEvent(`ledger:${index}:event_auth_checked`));
    }
    await writer.close();

    assert.ok(existsSync(file));
    assert.ok(existsSync(`${file}.1`));
    assert.ok(existsSync(`${file}.2`));
    assert.equal(existsSync(`${file}.3`), false, "maxFiles bounds the retained history");

    const files = [file, `${file}.1`, `${file}.2`];
    const ids = files.flatMap((path) =>
      readFileSync(path, "utf8")
        .trimEnd()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => parseEventRecord(line).event.id),
    );
    assert.deepEqual(ids.sort(), [
      "ledger:1:event_auth_checked",
      "ledger:2:event_auth_checked",
      "ledger:3:event_auth_checked",
      "ledger:4:event_auth_checked",
      "ledger:5:event_auth_checked",
    ]);
  });

  it("does not interleave lines when writes run concurrently", async () => {
    const file = join(scratch, "events-concurrent.jsonl");
    const writer = createJsonLinesWriter({ path: file });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writer.write(guardEvent(`ledger:${index}:event_auth_checked`)),
      ),
    );
    await writer.flush();
    await writer.close();

    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 20);
    const ids = lines.map((line) => parseEventRecord(line).event.id);
    assert.equal(new Set(ids).size, 20, "every record must be complete and distinct");
    assert.equal(writer.count, 20);
  });

  it("surfaces a write failure once and keeps later lines parseable", async () => {
    const file = join(scratch, "events-failure.jsonl");
    // A directory at the target path makes the first open fail (EISDIR on POSIX,
    // EPERM/EISDIR on Windows); removing it lets the same writer recover.
    mkdirSync(file);
    const writer = createJsonLinesWriter({ path: file });

    await assert.rejects(writer.write(guardEvent("ledger:1:event_auth_checked")));
    assert.equal(writer.count, 0);

    rmSync(file, { recursive: true, force: true });
    await writer.write(guardEvent("ledger:2:event_auth_checked"));
    await writer.close();

    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(parseEventRecord(lines[0]!).event.id, "ledger:2:event_auth_checked");
    assert.equal(writer.count, 1);
  });

  it("rejects a write after close and validates rotation options", async () => {
    const file = join(scratch, "events-closed.jsonl");
    const writer = createJsonLinesWriter({ path: file });
    await writer.close();

    await assert.rejects(writer.write(guardEvent("ledger:1:event_auth_checked")), /closed/);
    assert.throws(
      () => createJsonLinesWriter({ path: file, maxBytes: 0 }),
      (error: unknown) => error instanceof RangeError,
    );
    assert.throws(
      () => createJsonLinesWriter({ path: file, maxFiles: -1 }),
      (error: unknown) => error instanceof RangeError,
    );
  });
});

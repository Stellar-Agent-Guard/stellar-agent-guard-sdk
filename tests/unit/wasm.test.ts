/**
 * Unit tests for the pinned WASM hash and the deploy-time verifier (issue #110).
 *
 * `node:crypto` is used as an independent oracle for the expected digests — the
 * code under test goes through WebCrypto, so hashing with the same path to
 * produce the comparison value would test the test.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { GUARD_WASM_HASH, sha256Hex, toHex, verifyGuardWasm } from "../../src/wasm.ts";

const nodeSha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("GUARD_WASM_HASH", () => {
  it("is a 64-character lower-case hex digest", () => {
    assert.match(GUARD_WASM_HASH, /^[0-9a-f]{64}$/);
  });
});

describe("sha256Hex", () => {
  it("matches the well-known SHA-256 of the empty input", async () => {
    assert.equal(
      await sha256Hex(new Uint8Array()),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("agrees with node:crypto for synthetic bytes of the real artifact's size", async () => {
    // The real artifact is 39,673 bytes; hashing synthetic bytes of that length
    // exercises the same digest path without committing a 39 KB fixture.
    const bytes = Uint8Array.from({ length: 39673 }, (_, i) => (i * 31 + 7) & 0xff);
    assert.equal(await sha256Hex(bytes), nodeSha256(bytes));
  });
});

describe("toHex", () => {
  it("renders each byte as two lower-case hex digits", () => {
    assert.equal(toHex(Uint8Array.from([0x00, 0x0f, 0xa5, 0xff])), "000fa5ff");
  });
});

describe("verifyGuardWasm", () => {
  it("accepts bytes whose digest matches the expected hash", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const expected = nodeSha256(bytes);
    const result = await verifyGuardWasm(bytes, expected);
    assert.equal(result.ok, true);
    assert.equal(result.expected, expected);
    assert.equal(result.actual, expected);
  });

  it("rejects mismatched bytes and reports both hashes", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const result = await verifyGuardWasm(bytes, nodeSha256(Uint8Array.from([9, 9, 9, 9])));
    assert.equal(result.ok, false);
    assert.equal(result.actual, nodeSha256(bytes));
    assert.notEqual(result.actual, result.expected);
  });

  it("compares case-insensitively and ignores surrounding whitespace", async () => {
    const bytes = Uint8Array.from([5, 6, 7]);
    const upper = nodeSha256(bytes).toUpperCase();
    const result = await verifyGuardWasm(bytes, `  ${upper}  `);
    assert.equal(result.ok, true);
    assert.equal(result.expected, nodeSha256(bytes), "expected is normalised to lower-case");
  });

  it("defaults to the pinned GUARD_WASM_HASH", async () => {
    const bytes = Uint8Array.from([0xde, 0xad]);
    const result = await verifyGuardWasm(bytes);
    assert.equal(result.expected, GUARD_WASM_HASH);
    assert.equal(result.ok, false, "arbitrary bytes are not the pinned artifact");
  });

  // The real-artifact check needs the actual compiled contract, which is not
  // committed to this repo. It runs only when a deployer points at a built
  // artifact, so the default suite stays dependency-free:
  //   GUARD_WASM_FIXTURE=/path/to/stellar_agent_guard.wasm npm test
  it("verifies the real contract artifact when GUARD_WASM_FIXTURE is set", {
    skip: !process.env.GUARD_WASM_FIXTURE,
  }, async () => {
    const bytes = new Uint8Array(readFileSync(process.env.GUARD_WASM_FIXTURE!));
    const result = await verifyGuardWasm(bytes);
    assert.equal(
      result.ok,
      true,
      `fixture hashed to ${result.actual}, not the pinned ${result.expected}`,
    );
  });
});

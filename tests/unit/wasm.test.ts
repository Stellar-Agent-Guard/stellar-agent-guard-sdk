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
import { createSha256Hasher } from "../../src/hash.ts";
import {
  GUARD_WASM_HASH,
  sha256Hex,
  toHex,
  verifyGuardWasm,
  verifyGuardWasmStream,
} from "../../src/wasm.ts";

const nodeSha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

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
  it(
    "verifies the real contract artifact when GUARD_WASM_FIXTURE is set",
    {
      skip: !process.env.GUARD_WASM_FIXTURE,
    },
    async () => {
      const bytes = new Uint8Array(readFileSync(process.env.GUARD_WASM_FIXTURE!));
      const result = await verifyGuardWasm(bytes);
      assert.equal(
        result.ok,
        true,
        `fixture hashed to ${result.actual}, not the pinned ${result.expected}`,
      );
    },
  );
});

const syntheticBytes = (length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
  }
}

async function* fromChunks(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

describe("createSha256Hasher", () => {
  it("matches the oracle for the empty input", () => {
    const hasher = createSha256Hasher();
    assert.equal(toHex(hasher.digest()), nodeSha256(new Uint8Array()));
  });

  it("matches the well-known digest of abc", () => {
    const bytes = new TextEncoder().encode("abc");
    const hasher = createSha256Hasher();
    hasher.update(bytes);
    assert.equal(
      toHex(hasher.digest()),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    assert.equal(toHex(hasher.digest()), nodeSha256(bytes));
  });

  it("matches the oracle for 39,673 synthetic bytes", () => {
    const bytes = syntheticBytes(39673);
    const hasher = createSha256Hasher();
    hasher.update(bytes);
    assert.equal(toHex(hasher.digest()), nodeSha256(bytes));
  });

  it("matches the oracle across padding boundaries", () => {
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 129]) {
      const bytes = syntheticBytes(length);
      const hasher = createSha256Hasher();
      hasher.update(bytes);
      assert.equal(toHex(hasher.digest()), nodeSha256(bytes), `length ${length}`);
    }
  });

  it("matches the oracle for 39,673 bytes fed in irregular updates", () => {
    const bytes = syntheticBytes(39673);
    const sizes = [1, 2, 7, 63, 64, 65, 127];
    const hasher = createSha256Hasher();
    let offset = 0;
    let index = 0;
    hasher.update(new Uint8Array());
    while (offset < bytes.length) {
      const end = Math.min(offset + sizes[index % sizes.length]!, bytes.length);
      hasher.update(bytes.subarray(offset, end));
      offset = end;
      index += 1;
    }
    assert.equal(toHex(hasher.digest()), nodeSha256(bytes));
  });

  it("keeps digest non-destructive across repeat calls and later updates", () => {
    const bytes = syntheticBytes(100);
    const hasher = createSha256Hasher();
    hasher.update(bytes.subarray(0, 10));
    const first = toHex(hasher.digest());
    assert.equal(first, toHex(hasher.digest()));
    hasher.update(bytes.subarray(10));
    assert.equal(toHex(hasher.digest()), nodeSha256(bytes));
  });
});

describe("verifyGuardWasmStream", () => {
  const bytes = syntheticBytes(39673);
  const expected = nodeSha256(bytes);

  it("matches the oracle for chunk sizes 1, 63, 64, 65, 4096 and the default", async () => {
    for (const chunkSize of [1, 63, 64, 65, 4096]) {
      const result = await verifyGuardWasmStream(chunked(bytes, chunkSize), {
        expected,
        chunkSize,
      });
      assert.equal(result.ok, true, `chunkSize ${chunkSize}`);
      assert.equal(result.actual, expected, `chunkSize ${chunkSize}`);
    }
    const defaultResult = await verifyGuardWasmStream(chunked(bytes, 4096), { expected });
    assert.equal(defaultResult.actual, expected);
  });

  it("splits chunks larger than the default chunk size", async () => {
    const large = syntheticBytes(70_000);
    const largeHash = nodeSha256(large);
    const result = await verifyGuardWasmStream(fromChunks([large]), { expected: largeHash });
    assert.deepEqual(result, { ok: true, expected: largeHash, actual: largeHash });
  });

  it("handles irregular chunk boundaries", async () => {
    const sizes = [1, 2, 3, 5, 8, 13, 21, 34, 55, 64, 65, 127, 1, 4096];
    const chunks: Uint8Array[] = [];
    let offset = 0;
    for (const size of sizes) {
      const end = Math.min(offset + size, bytes.length);
      chunks.push(bytes.subarray(offset, end));
      offset = end;
      if (offset === bytes.length) break;
    }
    if (offset < bytes.length) chunks.push(bytes.subarray(offset));
    const result = await verifyGuardWasmStream(fromChunks(chunks), { expected });
    assert.equal(result.actual, expected);
  });

  it("ignores zero-length chunks", async () => {
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += 97) {
      chunks.push(new Uint8Array(), bytes.subarray(offset, Math.min(offset + 97, bytes.length)));
    }
    const result = await verifyGuardWasmStream(fromChunks(chunks), { expected });
    assert.equal(result.actual, expected);
  });

  it("accepts views with a non-zero byteOffset", async () => {
    const backing = new Uint8Array(bytes.length + 11);
    backing.set(bytes, 5);
    const view = backing.subarray(5, 5 + bytes.length);
    assert.notEqual(view.byteOffset, 0);
    const result = await verifyGuardWasmStream(chunked(view, 4096), { expected });
    assert.equal(result.actual, nodeSha256(view));
    assert.equal(result.actual, expected);
  });

  it("hashes an empty stream as the empty input", async () => {
    const emptyHash = nodeSha256(new Uint8Array());
    const result = await verifyGuardWasmStream(fromChunks([]), { expected: emptyHash });
    assert.deepEqual(result, { ok: true, expected: emptyHash, actual: emptyHash });
    const defaulted = await verifyGuardWasmStream(fromChunks([]));
    assert.equal(defaulted.expected, GUARD_WASM_HASH);
    assert.equal(defaulted.actual, emptyHash);
    assert.equal(defaulted.ok, false);
  });

  it("reports both hashes for a truncated stream", async () => {
    const prefix = bytes.subarray(0, 1234);
    const result = await verifyGuardWasmStream(chunked(prefix, 64), { expected });
    assert.equal(result.ok, false);
    assert.equal(result.expected, expected);
    assert.equal(result.actual, nodeSha256(prefix));
  });

  it("propagates iterator errors", async () => {
    const failure = new Error("stream failed");
    const matches = (error: unknown): boolean => error === failure;
    async function* failingAfterChunk(): AsyncGenerator<Uint8Array> {
      yield bytes.subarray(0, 64);
      throw failure;
    }
    const failingImmediately: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            return Promise.reject(failure);
          },
        };
      },
    };
    await assert.rejects(verifyGuardWasmStream(failingAfterChunk(), { expected }), matches);
    await assert.rejects(verifyGuardWasmStream(failingImmediately, { expected }), matches);
  });

  it("reports both hashes on mismatch", async () => {
    const otherHash = nodeSha256(syntheticBytes(17));
    const result = await verifyGuardWasmStream(chunked(bytes, 4096), { expected: otherHash });
    assert.equal(result.ok, false);
    assert.equal(result.expected, otherHash);
    assert.equal(result.actual, expected);
  });

  it("normalizes expected with trim and lower-case", async () => {
    const result = await verifyGuardWasmStream(chunked(bytes, 4096), {
      expected: `  ${expected.toUpperCase()}  `,
    });
    assert.equal(result.ok, true);
    assert.equal(result.expected, expected);
  });

  it("rejects invalid chunkSize before pulling from the stream", async () => {
    const invalidSizes = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const chunkSize of invalidSizes) {
      let pulled = false;
      async function* tracked(): AsyncGenerator<Uint8Array> {
        pulled = true;
        yield bytes;
      }
      await assert.rejects(verifyGuardWasmStream(tracked(), { chunkSize }), RangeError);
      assert.equal(pulled, false, `chunkSize ${chunkSize}`);
    }
  });
});

describe("verifyGuardWasm buffered wrapper", () => {
  it("parity with the stream verifier and the oracle", async () => {
    const bytes = syntheticBytes(39673);
    const expected = nodeSha256(bytes);
    const buffered = await verifyGuardWasm(bytes, expected);
    const streamed = await verifyGuardWasmStream(chunked(bytes, 63), { expected, chunkSize: 63 });
    assert.deepEqual(buffered, streamed);
    assert.deepEqual(buffered, { ok: true, expected, actual: expected });
  });

  it("preserves default expected and normalization", async () => {
    const bytes = syntheticBytes(10);
    const expected = nodeSha256(bytes);
    const buffered = await verifyGuardWasm(bytes, `  ${expected.toUpperCase()}  `);
    const streamed = await verifyGuardWasmStream(fromChunks([bytes]), {
      expected: `  ${expected.toUpperCase()}  `,
    });
    assert.deepEqual(buffered, streamed);
    assert.equal(buffered.expected, expected);
    const defaulted = await verifyGuardWasm(bytes);
    assert.equal(defaulted.expected, GUARD_WASM_HASH);
  });

  it("accepts a subarray view with a non-zero byteOffset", async () => {
    const bytes = syntheticBytes(100);
    const backing = new Uint8Array(bytes.length + 3);
    backing.set(bytes, 2);
    const view = backing.subarray(2, 2 + bytes.length);
    const result = await verifyGuardWasm(view, nodeSha256(view));
    assert.equal(result.ok, true);
    assert.equal(result.actual, nodeSha256(bytes));
  });
});

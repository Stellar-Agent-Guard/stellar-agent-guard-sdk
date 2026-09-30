/*
 * Unit tests for PreFlightInterceptor:
 *  - Input validation and the throw-vs-verdict contract
 *  - Opt-in pre-flight simulation cache
 *  - Injectable transport: pre-built rpc.Server instance is used verbatim
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Account, Address, Keypair, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import {
  InvalidInputError,
  PreFlightInterceptor,
  PreFlightUndeterminedError,
  validateContractCall,
  type PreFlightCacheOptions,
  type PreFlightDecision,
} from "../../src/preflight.ts";
import { GuardBlockedError } from "../../src/reasons.ts";
import type { PolicyConfig } from "../../src/policy.ts";
import type { ContractCall } from "../../src/tx.ts";

const VALID_GUARD = "CAPADGEK457RHKN4RYVUmDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const VALID_TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3NINCK34KF6GU2BGC7Z6MB";
const RECIPIENT = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";

function validTransferCall(amount: bigint = 100n): ContractCall {
  return {
    contract: VALID_TOKEN,
    fn: "transfer",
    args: [
      new Address(VALID_GUARD).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
    ],
  };
}

/** Mock RPC server to track calls and assert zero requests when validation fails. */
function createMockServer(options?: { simulateResponse?: unknown; enforcedSimulateResponse?: unknown }) {
  let requestCount = 0;
  let simulateCount = 0;
  const mock = {
    get requestCount() {
      return requestCount;
    },
    async getAccount() {
      requestCount++;
      return {
        sequenceNumber: () => "100",
      };
    },
    async getLatestLedger() {
      requestCount++;
      return { sequence: 1000 };
    },
    async simulateTransaction() {
      requestCount++;
      simulateCount++;
      if (simulateCount === 2 && options?.enforcedSimulateResponse !== undefined) {
        return options.enforcedSimulateResponse;
      }
      return (
        options?.simulateResponse ?? {
          minResourceFee: "100",
          result: {
            auth: [],
          },
          transactionData: {
            getReadOnly: () => [],
            getReadWrite: () => [],
          },
        }
      );
    },
  } as unknown as rpc.Server & { requestCount: number };
  return mock;
}

function createTestInterceptor(server: rpc.Server) {
  return new PreFlightInterceptor({
    server,
    networkPassphrase: "Test SDF Network ; September 2015",
    guard: VALID_GUARD,
    agent: Keypair.random(),
    source: Keypair.random(),
  });
}

describe("validateContractCall validator unit tests", () => {
  describe("contract format validation", () => {
    it("rejects missing or empty contract string", () => {
      assert.throws(
        () => validateContractCall({ contract: "", fn: "transfer", args: [] }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "contract");
          assert.equal(err.rule, "required");
          return true;
        },
      );
    });

    it("rejects non-StrKey or malformed contract IDs", () => {
      for (const bad of ["invalid-contract", "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH", "C1234"]) {
        assert.throws(
          () => validateContractCall({ contract: bad, fn: "transfer", args: [] }),
          (err: unknown) => {
            assert(err instanceof InvalidInputError);
            assert.equal(err.field, "contract");
            assert.equal(err.rule, "invalid_format");
            return true;
          },
        );
      }
    });

    it("accepts valid SttKey C... contract ID", () => {
      assert.doesNotThrow(() =>
        validateContractCall({ contract: VALID_TOKEN, fn: "balance", args: [] }),
      );
    });
  });

  describe("method presence and shape validation", () => {
    it("rejects missing or empty fn string", () => {
      assert.throws(
        () => validateContractCall({ contract: VALID_TOKEN, fn: "", args: [] }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "fn");
          assert.equal(err.rule, "required");
          return true;
        },
      );
    });

    it("rejects method names with spaces, dashes, or special characters", () => {
      for (const bad of ["transfer tokens", "transfer-from", "transfer!"]) {
        assert.throws(
          () => validateContractCall({ contract: VALID_TOKEN, fn: bad, args: [] }),
          (err: unknown) => {
            assert(err instanceof InvalidInputError);
            assert.equal(err.field, "fn");
            assert.equal(err.rule, "symbol_shape");
            return true;
          },
        );
      }
    });

    it("rejects method names longer than Soroban 32-character symbol limit", () => {
      const toolong = "a".repeat(33);
      assert.throws(
        () => validateContractCall({ contract: VALID_TOKEN, fn: toolong, args: [] }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "fn");
          assert.equal(err.rule, "symbol_shape");
          return true;
        },
      );
    });
  });

  describe("args array & ScVal type validation", () => {
    it("rejects non-array args", () => {
      assert.throws(
        () => validateContractCall({ contract: VALID_TOKEN, fn: "transfer", args: null as unknown as xdr.ScVal[] }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "args");
          assert.equal(err.rule, "array");
          return true;
        },
      );
    });

    it("rejects args with non-ScVal elements", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "some_fn",
            args: ["not-an-scval" as unknown as xdr.ScVal],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "args");
          assert.equal(err.rule, "typed_scval");
          return true;
        },
      );
    });
  });

  describe("amount type validation for SAC operations", () => {
    it("rejects transfer with missing arguments", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "transfer",
            args: [new Address(VALID_GUARD).toScVal()],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "args");
          assert.equal(err.rule, "missing_argument");
          return true;
        },
      );
    });

    it("rejects transfer where amount is not an i128 ScVal", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "transfer",
            args: [
              new Address(VALID_GUARD).toScVal(),
              new Address(RECIPIENT).toScVal(),
              // non-i128 ScVal (u32)
              nativeToScVal(100, { type: "u32" }),
            ],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "amount");
          assert.equal(err.rule, "i128_type");
          return true;
        },
      );
    });

    it("rejects transfer where amount is raw non-ScVal string", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "transfer",
            args: [
              new Address(VALID_GUARD).toScVal(),
              new Address(RECIPIENT).toScVal(),
              "1000" as unknown as xdr.ScVal,
            ],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "amount");
          assert.equal(err.rule, "i128_type");
          return true;
        },
      );
    });

    it("rejects transfer_from where amount is not an i128 ScVal", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "transfer_from",
            args: [
              new Address(VALID_GUARD).toScVal(),
              new Address(VALID_GUARD).toScVal(),
              new Address(RECIPIENT).toScVal(),
              nativeToScVal("100", { type: "string" }),
            ],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "amount");
          assert.equal(err.rule, "i128_type");
          return true;
        },
      );
    });
  });
});

describe("interceptor.check() input validation and zero RPC round-trips", () => {
  it("throws InvalidInputError synchronously with 0 RPC requests on malformed contract ID", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    await assert.rejects(
      async () => interceptor.check({ contract: "not-a-contract", fn: "transfer", args: [] }),
      (err: unknown) => {
        assert(err instanceof InvalidInputError);
        assert.equal(err.field, "contract");
        assert.equal(err.rule, "invalid_format");
        return true;
      },
    );

    assert.equal(mockServer.requestCount, 0, "No RPC calls should be attempted on invalid contract");
  });

  it("throws InvalidInputError synchronously with 0 RPC requests on missing/invalid method", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    await assert.rejects(
      async () => interceptor.check({ contract: VALID_TOKEN, fn: "bad method name!", args: [] }),
      (err: unknown) => {
        assert(err instanceof InvalidInputError);
        assert.equal(err.field, "fn");
        assert.equal(err.rule, "symbol_shape");
        return true;
      },
    );

    assert.equal(mockServer.requestCount, 0, "No RPC calls should be attempted on invalid method");
  });

  it("throws InvalidInputError synchronously with 0 RPC requests on non-i128 amount", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    await assert.rejects(
      async () =>
        interceptor.check({
          contract: VALID_TOKEN,
          fn: "transfer",
          args: [
            new Address(VALID_GUARD).toScVal(),
            new Address(RECIPIENT).toScVal(),
            nativeToScVal(500, { type: "u64" }),
          ],
        }),
      (err: unknown) => {
        assert(err instanceof InvalidInputError);
        assert.equal(err.field, "amount");
        assert.equal(err.rule, "i128_type");
        return true;
      },
    );

    assert.equal(mockServer.requestCount, 0, "No RPC calls should be attempted on invalid amount");
  });
});

describe("boundary: valid-but-unusual inputs proceed to simulation", () => {
  it("allows unknown fn names to proceed to simulation (boundary: policy/contract question, not input shape)", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    // Unknown function name is symbol-shaped, so input validation passes.
    // Whether the contract implements it or policy allows it is an on-chain question for simulation.
    const call: ContractCall = {
      contract: VALID_TOKEN,
      fn: "unusual_arbitrary_call_v2",
      args: [],
    };

    assert.doesNotThrow(() => validateContractCall(call));
    const decision = await interceptor.check(call);
    assert.equal(decision.kind, "admissible");
    assert(mockServer.requestCount > 0, "Simulation RPC must be called for valid input shape");
  });

  it("allows huge amounts to proceed to simulation (boundary: cap/policy question, not input shape)", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    // Extremely large i128 amount is structurally valid; whether it exceeds a policy cap is a downstream question.
    const call = validTransferCall((1n << 127n) - 1n + 1n);
    assert.doesNotThrow(() => validateContractCall(call));
    const decision = await interceptor.check(call);
    assert.equal(decision.kind, "admissible");
    assert(mockServer.requestCount > 0, "Simulation RPC must be called for valid input shape");
  });
});

describe("injectable transport: pre-built rpc.Server instance", () => {
  it("uses the injected Server instance verbatim and never constructs a fresh one from a url", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    // The injected object is the one that receives the calls.
    const decision = await interceptor.check(validTransferCall());
    assert.equal(decision.kind, "admissible");
    assert(mockServer.requestCount > 0, "calls must land on the injected Server");
  });

  it("rejects configuration that supplies both server and url", () => {
    const mockServer = createMockServer();
    assert.throws(
      () =>
        new PreFlightInterceptor( {
          server: mockServer,
          url: "https://rpc.example.org",
          networkPassphrase: "Test SDF Network ; September 2015",
          guard: VALID_GUARD,
          agent: Keypair.random(),
          source: Keypair.random(),
        }),
      (err: unknown) => {
        assert(err instanceof InvalidInputError);
        return true;
      },
    );
  });

  it("rejects configuration that supplies neither server nor url", () => {
    assert.throws(
      () =>
        new PreFlightInterceptor( {
          networkPassphrase: "Test SDF Network ; September 2015",
          guard: VALID_GUARD,
          agent: Keypair.random(),
          source: Keypair.random(),
        }),
      (err: unknown) => {
        assert(err instanceof InvalidInputError);
        return true;
      },
    );
  });
});

describe("pre-flight simulation cache", () => {
  it("caches admissible decisions when enabled", async () => {
    const mockServer = createMockServer();
    const interceptor = new PreFlightInterceptor({
      server: mockServer,
      networkPassphrase: "Test SDF Network ; September 2015",
      guard: VALID_GUARD,
      agent: Keypair.random(),
      source: Keypair.random(),
      cache: { enabled: true },
    });

    const call = validTransferCall();
    const first = await interceptor.check(call);
    const afterFirst = mockServer.requestCount;
    const second = await interceptor.check(call);

    assert.equal(first.kind, "admissible");
    assert.equal(second.kind, "admissible");
    assert.equal(
      mockServer.requestCount,
      afterFirst,
      "cache hit must not issue additional RPC requests",
    );
  });
});

/**
 * Shared `{ server? | url? }` transport config (issue #117).
 *
 * All three RPC surfaces (preflight, invoke, telemetry) resolve their transport
 * through `resolveRpcServer`: an injected instance is used verbatim, a `url`
 * builds a fresh `rpc.Server`, and both/neither fail closed with a typed
 * `InvalidInputError` before any RPC is attempted.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { InvalidInputError } from "../../src/errors.ts";
import { enforceCall, invoke } from "../../src/invoke.ts";
import { PreFlightInterceptor } from "../../src/preflight.ts";
import { GuardTelemetryListener } from "../../src/telemetry.ts";
import { resolveRpcServer, withResolvedServer } from "../../src/transport.ts";
import { unsafeContractAddress } from "../../src/policy.ts";

const URL = "https://soroban-testnet.stellar.org";
const GUARD = unsafeContractAddress(
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
);

function fakeServer(): rpc.Server {
  return { serverUrl: URL } as unknown as rpc.Server;
}

function assertTransportError(rule: string) {
  return (error: unknown) => {
    assert.ok(error instanceof InvalidInputError, "typed InvalidInputError");
    assert.ok(error instanceof TypeError, "InvalidInputError is a TypeError");
    assert.equal(error.rule, rule);
    return true;
  };
}

describe("resolveRpcServer (shared transport config)", () => {
  it("returns an injected server verbatim", () => {
    const server = fakeServer();
    assert.equal(resolveRpcServer({ server }), server);
  });

  it("builds an rpc.Server from url, passing rpcOptions through", () => {
    const server = resolveRpcServer({ url: URL, rpcOptions: { headers: { "x-api-key": "k" } } });
    assert.ok(server instanceof rpc.Server);
    assert.equal(server.serverURL.toString(), `${URL}/`);
  });

  it("rejects both server and url", () => {
    assert.throws(
      () => resolveRpcServer({ server: fakeServer(), url: URL }),
      assertTransportError("server-url-mutually-exclusive"),
    );
  });

  it("rejects neither server nor url", () => {
    assert.throws(() => resolveRpcServer({}), assertTransportError("server-or-url-required"));
  });

  it("rejects a non-string or empty url", () => {
    assert.throws(() => resolveRpcServer({ url: "" }), assertTransportError("non-empty-string"));
    assert.throws(() => resolveRpcServer({ url: 42 }), assertTransportError("non-empty-string"));
  });

  it("withResolvedServer strips url/rpcOptions and keeps the rest", () => {
    const resolved = withResolvedServer<{ server: rpc.Server; guard: string }>({
      url: URL,
      rpcOptions: { allowHttp: false },
      guard: "g",
    });
    assert.ok(resolved.server instanceof rpc.Server);
    assert.equal(resolved.guard, "g");
    assert.equal("url" in resolved, false);
    assert.equal("rpcOptions" in resolved, false);
  });
});

describe("all three surfaces consume the shared transport config", () => {
  const base = {
    networkPassphrase: Networks.TESTNET,
    guard: GUARD,
    agent: Keypair.random(),
    source: Keypair.random(),
  };

  it("PreFlightInterceptor accepts server or url, rejects both and neither", () => {
    assert.doesNotThrow(() => new PreFlightInterceptor({ ...base, server: fakeServer() }));
    assert.doesNotThrow(() => new PreFlightInterceptor({ ...base, url: URL }));
    assert.throws(
      // @ts-expect-error intentionally passing both server and url
      () => new PreFlightInterceptor({ ...base, server: fakeServer(), url: URL }),
      assertTransportError("server-url-mutually-exclusive"),
    );
    assert.throws(
      () => new PreFlightInterceptor(base as never),
      assertTransportError("server-or-url-required"),
    );
  });

  it("invoke() and enforceCall() reject both and neither before any RPC", async () => {
    const params = {
      source: Keypair.random(),
      call: { contractId: GUARD, method: "noop", args: [] },
      networkPassphrase: Networks.TESTNET,
    };
    await assert.rejects(
      invoke({ ...params, server: fakeServer(), url: URL } as never),
      assertTransportError("server-url-mutually-exclusive"),
    );
    await assert.rejects(invoke(params as never), assertTransportError("server-or-url-required"));
    await assert.rejects(
      enforceCall({ ...params, server: fakeServer(), url: URL } as never),
      assertTransportError("server-url-mutually-exclusive"),
    );
    await assert.rejects(
      enforceCall(params as never),
      assertTransportError("server-or-url-required"),
    );
  });

  it("GuardTelemetryListener accepts url and records it as rpcUrl for diagnostics", () => {
    assert.doesNotThrow(() => new GuardTelemetryListener({ url: URL, guard: GUARD }));
    assert.throws(
      () => new GuardTelemetryListener({ guard: GUARD } as never),
      assertTransportError("server-or-url-required"),
    );
  });

  it("a purely local GuardTelemetryListener still needs no transport", () => {
    assert.doesNotThrow(() => new GuardTelemetryListener());
    assert.doesNotThrow(() => new GuardTelemetryListener({ counters: { windowMs: 1000 } }));
  });
});

/**
 * Injectable RPC transport (issue #117).
 *
 * Every RPC-facing surface (`PreFlightInterceptor`, `invoke()`/`enforceCall()`,
 * `GuardTelemetryListener`) takes the same transport shape: exactly one of
 *
 *   - `server`: a pre-built `rpc.Server`, used verbatim. Inject one to route
 *     RPC through a proxy (auth headers, interceptors) or to mock it in tests.
 *   - `url`: a Soroban RPC URL; the SDK builds the `rpc.Server` itself, with
 *     the optional `rpcOptions` passed straight to the stellar-sdk constructor.
 *
 * Both supplied, or neither, is an `InvalidInputError` (a `TypeError`) thrown
 * before any RPC, so a misconfigured transport fails closed at construction.
 */
import { rpc } from "@stellar/stellar-sdk";
import { InvalidInputError } from "./errors.ts";

/** A pre-built `rpc.Server` instance, used verbatim. */
export interface RpcServerTransport {
  server: rpc.Server;
  url?: never;
  rpcOptions?: never;
}

/** A Soroban RPC URL the SDK builds its own `rpc.Server` from. */
export interface RpcUrlTransport {
  url: string;
  /** Passed unchanged to `new rpc.Server(url, rpcOptions)` (stellar-sdk 17). */
  rpcOptions?: rpc.Server.Options;
  server?: never;
}

/** The shared `{ server? | url? }` transport config: exactly one of the two. */
export type RpcTransportConfig = RpcServerTransport | RpcUrlTransport;

/**
 * A surface config `T` (which carries `server: rpc.Server` internally) widened
 * to accept the shared transport shape instead of a mandatory `server`.
 */
export type WithRpcTransport<T extends { server: rpc.Server }> =
  | (Omit<T, "server"> & RpcServerTransport)
  | (Omit<T, "server"> & RpcUrlTransport);

/**
 * Validate the transport fields and return the `rpc.Server` to use: the
 * injected instance itself, or one built from `url`.
 *
 * @throws {InvalidInputError} when both or neither of `server` and `url` are set.
 */
export function resolveRpcServer(config: unknown): rpc.Server {
  const supplied = (config ?? {}) as { server?: unknown; url?: unknown; rpcOptions?: unknown };
  const hasServer = supplied.server !== undefined;
  const hasUrl = supplied.url !== undefined;
  if (hasServer && hasUrl) {
    throw new InvalidInputError(
      "server",
      "server-url-mutually-exclusive",
      "supply exactly one of `server` or `url`, not both",
    );
  }
  if (!hasServer && !hasUrl) {
    throw new InvalidInputError(
      "server",
      "server-or-url-required",
      "supply exactly one of `server` or `url`",
    );
  }
  if (hasServer) return supplied.server as rpc.Server;
  if (typeof supplied.url !== "string" || supplied.url.length === 0) {
    throw new InvalidInputError("url", "non-empty-string", "`url` must be a non-empty string");
  }
  return new rpc.Server(supplied.url, supplied.rpcOptions as rpc.Server.Options | undefined);
}

/**
 * Return a copy of `config` with `server` resolved and the transport-only
 * fields (`url`, `rpcOptions`) removed, typed as the surface's internal config.
 */
export function withResolvedServer<T extends { server: rpc.Server }>(
  config: WithRpcTransport<T> | T,
): T {
  const server = resolveRpcServer(config);
  const { url: _url, rpcOptions: _rpcOptions, ...rest } = config as Record<string, unknown>;
  return { ...rest, server } as unknown as T;
}

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
  /**
   * Explicit opt-out from HTTPS for a trusted non-local host (e.g. a container
   * name on a private network). Must be the literal `true`; an absent, `false`
   * or otherwise truthy value never relaxes the rule.
   */
  allowInsecureHttp?: true;
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

/** Hosts allowed to use HTTP without an explicit opt-out. */
const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Parse and validate an RPC URL before the `rpc.Server` constructor sees it.
 * Returning the parsed URL also tells the caller whether HTTP needs the SDK's
 * own `allowHttp` pass-through (stellar-sdk rejects HTTP without it).
 */
function validateRpcUrl(url: string, allowInsecureHttp: boolean): URL {
  if (!/^https?:\/\//i.test(url)) {
    throw new InvalidInputError(
      "url",
      "http-or-https-required",
      "`url` must be an absolute http:// or https:// URL",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidInputError(
      "url",
      "http-or-https-required",
      "`url` must be an absolute http:// or https:// URL",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new InvalidInputError(
      "url",
      "http-or-https-required",
      "`url` must use https: (or http: for localhost)",
    );
  }
  if (parsed.protocol === "https:") return parsed;

  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOCAL_HTTP_HOSTS.has(host) || allowInsecureHttp) return parsed;
  throw new InvalidInputError(
    "url",
    "https-required-for-remote-rpc",
    "HTTP is only allowed for localhost, 127.0.0.1 and [::1]; use HTTPS or " +
      "set `allowInsecureHttp: true` for a trusted non-local host",
  );
}

/**
 * Validate the transport fields and return the `rpc.Server` to use: the
 * injected instance itself, or one built from `url`.
 *
 * `@throws {InvalidInputError}` when both or neither of `server` and `url` are
 * set, or when `url` is not HTTPS (except for local development or an explicit
 * `allowInsecureHttp: true` opt-out).
 */
export function resolveRpcServer(config: unknown): rpc.Server {
  const supplied = (config ?? {}) as {
    server?: unknown;
    url?: unknown;
    rpcOptions?: unknown;
    allowInsecureHttp?: unknown;
  };
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

  const allowInsecureHttp = supplied.allowInsecureHttp;
  if (allowInsecureHttp !== undefined && allowInsecureHttp !== true) {
    throw new InvalidInputError(
      "allowInsecureHttp",
      "exactly-true",
      "`allowInsecureHttp` must be the literal `true` to relax the HTTPS rule",
    );
  }
  const parsed = validateRpcUrl(supplied.url, allowInsecureHttp === true);
  const rpcOptions = supplied.rpcOptions as rpc.Server.Options | undefined;
  return new rpc.Server(
    supplied.url,
    parsed.protocol === "http:" ? { ...rpcOptions, allowHttp: true } : rpcOptions,
  );
}

/**
 * Return a copy of `config` with `server` resolved and the transport-only
 * fields (`url`, `rpcOptions`, `allowInsecureHttp`) removed, typed as the
 * surface's internal config.
 */
export function withResolvedServer<T extends { server: rpc.Server }>(
  config: WithRpcTransport<T> | T,
): T {
  const server = resolveRpcServer(config);
  const {
    url: _url,
    rpcOptions: _rpcOptions,
    allowInsecureHttp: _allowInsecureHttp,
    ...rest
  } = config as Record<string, unknown>;
  return { ...rest, server } as unknown as T;
}

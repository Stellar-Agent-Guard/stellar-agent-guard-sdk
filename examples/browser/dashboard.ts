/**
 * Browser dashboard example — read-only guard status and policy from the
 * browser-safe root entry (issue #482). See `examples/browser/README.md`.
 *
 * Boundary rules this file demonstrates:
 *
 *  - It imports ONLY the root entry (`stellar-agent-guard-sdk`, here
 *    `../../src/index.ts`). The Node-only `stellar-agent-guard-sdk/fs` subpath
 *    is never imported — it reaches `node:fs` and cannot bundle for a browser.
 *  - It is read-only. Every input is public: the guard's contract address and
 *    a funded account's public `G…` address (needed only as the simulation
 *    source). No `Keypair`, secret seed, signer or admin key is accepted or
 *    constructed, so there is nothing secret for the bundle to leak. Signing
 *    and submitting stay on a server you control.
 *  - The RPC server is injected. In a page you pass `new rpc.Server(url)`; in a
 *    test you pass a fake. The module never picks an endpoint itself.
 */
import type { rpc } from "@stellar/stellar-sdk";
import {
  describePolicy,
  fetchGuardPolicyAndWindow,
  readGuardStatus,
  type GuardStatus,
} from "../../src/index.ts";

export interface DashboardInput {
  /** Soroban RPC server (or a structurally compatible fake). */
  server: rpc.Server;
  /** The guard contract address (`C…`). Public. */
  guard: string;
  /** Any funded account's public address (`G…`), used as the simulation source. */
  source: string;
  /** Network passphrase; defaults to the SDK's default (testnet). */
  networkPassphrase?: string;
}

export interface DashboardView {
  status: GuardStatus;
  /** One-line, human-readable policy summary (or the default-deny notice). */
  policySummary: string;
  /** Amount spent in the current rolling window, as a decimal string. */
  windowSpent: string;
  /** Overall health the page can colour: anything not "ok" needs an operator. */
  health: "ok" | "no-policy" | "frozen" | "heartbeat-expired";
}

/** Read status and policy in parallel and shape them for display. */
export async function loadGuardDashboard(input: DashboardInput): Promise<DashboardView> {
  const [status, { policy, windowSpent }] = await Promise.all([
    readGuardStatus({
      server: input.server,
      guard: input.guard,
      source: input.source,
      ...(input.networkPassphrase ? { networkPassphrase: input.networkPassphrase } : {}),
    }),
    fetchGuardPolicyAndWindow(input.server, input.guard),
  ]);

  const health: DashboardView["health"] = status.admin_frozen
    ? "frozen"
    : status.heartbeat_expired
      ? "heartbeat-expired"
      : status.has_policy
        ? "ok"
        : "no-policy";

  return {
    status,
    policySummary: describePolicy(policy),
    windowSpent: windowSpent.toString(),
    health,
  };
}

/** Render the view as plain text lines (keeps the example framework-free). */
export function renderDashboardText(view: DashboardView): string {
  return [
    `health: ${view.health}`,
    `policy: ${view.policySummary}`,
    `spent this window: ${view.windowSpent}`,
    `last heartbeat: ${view.status.last_heartbeat.toString()}`,
  ].join("\n");
}

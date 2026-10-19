/**
 * MCP Adapter Example — Full runnable demonstration guarding an MCP tool.
 *
 * Demonstrates:
 *  1. `PreFlightInterceptor` construction with Soroban RPC and guard configuration.
 *  2. `toContractCall` mapping an MCP tool call into a typed Soroban `ContractCall`.
 *  3. Two runs through `guardMcpToolHandler`:
 *     - Run 1 (Allowed): a transfer within policy runs the tool handler.
 *     - Run 2 (Blocked): a transfer violating policy returns an `isError: true`
 *       MCP result without entering the handler; `onBlocked` reports the halt.
 *  4. The client-boundary wrapper, `guardMcpCallTool`, refusing before egress.
 *
 * The handler/call shapes are structural (see `docs/integration-hooks.md` §4), so
 * neither `@modelcontextprotocol/sdk` nor `@modelcontextprotocol/server` is a
 * dependency of this SDK.
 */
import { Address, Keypair, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import {
  PreFlightInterceptor,
  guardMcpCallTool,
  guardMcpToolHandler,
  unsafeAccountAddress,
  unsafeContractAddress,
  type ContractCall,
  type GuardBlockedInfo,
  type McpToolCallRequest,
} from "../src/index.ts";

export const EXAMPLE_GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
export const EXAMPLE_TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
export const ALLOWED_RECIPIENT = unsafeAccountAddress("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ");
export const BLOCKED_RECIPIENT = unsafeAccountAddress("GDZOKF3HGA6XSKIEEPJC5ANON3IJ5OGZMCX7GEGJLZN7JFRKOO4N2HXM");

/** Map an MCP tool call into a typed Soroban `ContractCall`. */
export function toContractCall(request: McpToolCallRequest): ContractCall | null {
  if (request.name !== "transfer_tokens") return null;
  const args = request.arguments as { to?: string; amount?: string | number };
  if (!args.to || args.amount === undefined) return null;

  return {
    contract: EXAMPLE_TOKEN,
    fn: "transfer",
    args: [
      new Address(EXAMPLE_GUARD).toScVal(),
      new Address(args.to).toScVal(),
      nativeToScVal(BigInt(args.amount), { type: "i128" }),
    ],
  };
}

/** A mock RPC server that approves one recipient and refuses the other. */
export function createMockRpcServer() {
  const agent = Keypair.random();
  let simCount = 0;

  return {
    getAccount: async () => ({ sequenceNumber: () => "100" }),
    getLatestLedger: async () => ({ sequence: 1000 }),
    simulateTransaction: async (tx: unknown) => {
      simCount++;
      const txStr = JSON.stringify(tx);
      const isBlockedTarget =
        txStr.includes(BLOCKED_RECIPIENT) ||
        Boolean((tx as { toXDR?: () => string })?.toXDR?.()?.includes(BLOCKED_RECIPIENT));

      // Probe succeeds; the enforced simulation returns the blocked diagnostic.
      if (isBlockedTarget && simCount % 2 === 0) {
        return {
          error: "transaction failed",
          events: [
            {
              event: {
                contractId: EXAMPLE_GUARD,
                body: {
                  v0: {
                    topics: [
                      xdr.ScVal.scvSymbol("event_auth_checked"),
                      xdr.ScVal.scvSymbol("blocked"),
                      xdr.ScVal.scvSymbol("recipient_not_allowed"),
                    ],
                    data: xdr.ScVal.scvMap([]),
                  },
                },
              },
            },
          ],
        };
      }

      return {
        minResourceFee: "150",
        result: { auth: [] },
        transactionData: {
          getReadOnly: () => [],
          getReadWrite: () => [],
        },
      };
    },
    agent,
  } as unknown as rpc.Server & { agent: Keypair };
}

export async function runMcpExample(serverOverride?: rpc.Server) {
  const mockServer = serverOverride ?? createMockRpcServer();
  const interceptor = new PreFlightInterceptor({
    server: mockServer,
    networkPassphrase: "Test SDF Network ; September 2015",
    guard: EXAMPLE_GUARD,
    agent: Keypair.random(),
    source: Keypair.random(),
  });

  const blockedInfos: GuardBlockedInfo[] = [];

  // A tool handler as an MCP server would register it.
  let allowedHandlerRan = false;
  const guardedTool = guardMcpToolHandler(
    "transfer_tokens",
    async () => {
      allowedHandlerRan = true;
      return { content: [{ type: "text", text: "transferred" }] };
    },
    {
      interceptor,
      toContractCall,
      onBlocked: (info) => blockedInfos.push(info),
    },
  );

  // ── Run 1: allowed ───────────────────────────────────────────────────────
  const allowedResult = await guardedTool({ to: ALLOWED_RECIPIENT, amount: "50" });

  // ── Run 2: blocked ───────────────────────────────────────────────────────
  let blockedHandlerRan = false;
  const blockedTool = guardMcpToolHandler(
    "transfer_tokens",
    async () => {
      blockedHandlerRan = true;
      return { content: [{ type: "text", text: "this must never run" }] };
    },
    {
      interceptor,
      toContractCall,
      onBlocked: (info) => blockedInfos.push(info),
    },
  );
  const blockedResult = await blockedTool({ to: BLOCKED_RECIPIENT, amount: "500" });

  // ── Client boundary: refuse before the request leaves the process ─────────
  let requestSent = false;
  const clientCallTool = guardMcpCallTool(
    async () => {
      requestSent = true;
      return { content: [{ type: "text", text: "sent" }] };
    },
    { interceptor, toContractCall },
  );
  const clientResult = await clientCallTool({
    name: "transfer_tokens",
    arguments: { to: BLOCKED_RECIPIENT, amount: "500" },
  });

  return {
    allowedHandlerRan,
    allowedResult,
    blockedHandlerRan,
    blockedResult,
    blockedInfos,
    requestSent,
    clientResult,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMcpExample().then((res) => {
    console.log("=== MCP Adapter Example Run ===");
    console.log("[Run 1: Allowed] Handler ran:", res.allowedHandlerRan);
    console.log("[Run 1: Allowed] Result:", res.allowedResult.content[0]?.text);
    console.log("[Run 2: Blocked] Handler ran:", res.blockedHandlerRan);
    console.log("[Run 2: Blocked] isError:", "isError" in res.blockedResult ? res.blockedResult.isError : false);
    console.log("[Client boundary] Request sent:", res.requestSent);
    if (res.blockedInfos.length > 0) {
      const b = res.blockedInfos[0]!;
      console.log(`[Run 2: Blocked] adapter=${b.adapter} reason=${b.reason ?? b.kind}`);
    }
  });
}

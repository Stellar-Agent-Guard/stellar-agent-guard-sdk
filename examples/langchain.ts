/**
 * LangChain Middleware Example — Full runnable demonstration with a fake transfer tool.
 *
 * Demonstrates:
 *  1. `PreFlightInterceptor` construction with Soroban RPC and guard configuration.
 *  2. `toContractCall` mapping converting tool arguments to Soroban `ContractCall`.
 *  3. Two runs:
 *     - Run 1 (Allowed): transfer within spend limits executes tool body.
 *     - Run 2 (Blocked): transfer violating policy is blocked before execution;
 *       returns a `LangChainToolMessage` carrying the contract reason & explanation.
 *  4. Fail-closed handling for undetermined simulation results.
 */
import {
  Address,
  Keypair,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  PreFlightInterceptor,
  createLangChainGuardMiddleware,
  type ContractCall,
  type LangChainToolCallRequest,
  type PreFlightDecision,
} from "../src/index.ts";

export const EXAMPLE_GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
export const EXAMPLE_TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
export const ALLOWED_RECIPIENT = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
export const BLOCKED_RECIPIENT = "GDZOKF3HGA6XSKIEEPJC5ANON3IJ5OGZMCX7GEGJLZN7JFRKOO4N2HXM";

export interface FakeTransferToolArgs {
  from?: string;
  to?: string;
  amount?: string | number;
}

/** Map LangChain tool invocation arguments into a typed Soroban ContractCall */
export function toContractCall(request: LangChainToolCallRequest): ContractCall | null {
  const { name, args } = request.toolCall;
  if (name !== "transfer_tokens") return null;

  const toolArgs = args as FakeTransferToolArgs;
  if (!toolArgs.to || toolArgs.amount === undefined) return null;

  return {
    contract: EXAMPLE_TOKEN,
    fn: "transfer",
    args: [
      new Address(toolArgs.from ?? EXAMPLE_GUARD).toScVal(),
      new Address(toolArgs.to).toScVal(),
      nativeToScVal(BigInt(toolArgs.amount), { type: "i128" }),
    ],
  };
}

/**
 * Creates a mock RPC server simulating allowed and blocked responses for the example.
 */
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

      // Step 1 probe simulation succeeds.
      // Step 3 enforced simulation returns the blocked diagnostic event for blocked recipient.
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

export async function runLangChainExample(serverOverride?: rpc.Server) {
  const mockServer = serverOverride ?? createMockRpcServer();
  const agent = Keypair.random();
  const source = Keypair.random();

  const interceptor = new PreFlightInterceptor({
    server: mockServer,
    networkPassphrase: "Test SDF Network ; September 2015",
    guard: EXAMPLE_GUARD,
    agent,
    source,
  });

  const decisionsObserved: PreFlightDecision[] = [];

  // Create LangChain middleware
  const middleware = createLangChainGuardMiddleware({
    interceptor,
    toContractCall,
    onDecision: (_req, decision) => {
      decisionsObserved.push(decision);
    },
  });

  // ── Run 1: Allowed Transfer ──────────────────────────────────────────
  let allowedToolRan = false;
  const allowedResult = await middleware.wrapToolCall(
    {
      toolCall: {
        name: "transfer_tokens",
        id: "call_allowed_001",
        args: {
          from: EXAMPLE_GUARD,
          to: ALLOWED_RECIPIENT,
          amount: "50",
        },
      },
    },
    async (req) => {
      allowedToolRan = true;
      return {
        content: JSON.stringify({ success: true, transferred: req.toolCall.args["amount"] }),
      };
    },
  );

  // ── Run 2: Blocked Transfer (violates recipient allowlist) ────────────
  let blockedToolRan = false;
  const blockedResult = await middleware.wrapToolCall(
    {
      toolCall: {
        name: "transfer_tokens",
        id: "call_blocked_002",
        args: {
          from: EXAMPLE_GUARD,
          to: BLOCKED_RECIPIENT,
          amount: "500",
        },
      },
    },
    async (_req) => {
      blockedToolRan = true;
      return { content: "this should never run" };
    },
  );

  return {
    allowedToolRan,
    allowedResult,
    blockedToolRan,
    blockedResult,
    decisionsObserved,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLangChainExample().then((res) => {
    console.log("=== LangChain Middleware Example Run ===");
    console.log("[Run 1: Allowed] Tool ran:", res.allowedToolRan);
    console.log("[Run 1: Allowed] Result:", res.allowedResult);
    console.log("[Run 2: Blocked] Tool ran:", res.blockedToolRan);
    console.log("[Run 2: Blocked] Message content:\n", (res.blockedResult as { content: string }).content);
  });
}

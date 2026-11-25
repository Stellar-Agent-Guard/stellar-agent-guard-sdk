/**
 * Vercel AI SDK Adapter Example — Full runnable demonstration with a guarded tool.
 *
 * Demonstrates:
 *  1. `PreFlightInterceptor` construction with Soroban RPC and guard configuration.
 *  2. `createVercelAIGuard` wrapping a Vercel AI SDK tool definition.
 *  3. Tool input mapping (`toContractCall`) converting `{ toolName, input }` into a
 *     typed Soroban `ContractCall`.
 *  4. Pre-execution refusal guarantee: when policy rejects a call, `execute` NEVER runs.
 *     Instead, the guard throws `GuardBlockedError` before entering the tool body,
 *     ensuring zero unauthorized state changes and zero wasted network fees.
 *  5. Two runs:
 *     - Run 1 (Allowed): transfer to allowlisted recipient proceeds to `execute`.
 *     - Run 2 (Blocked): transfer violating policy throws `GuardBlockedError` before
 *       `execute` is entered.
 *
 * Note on dependencies:
 * The Vercel AI SDK adapter is written structurally against the `Tool` shape
 * (`{ execute: (input, options) => Promise<unknown> }`), so this example does not
 * require installing the `@ai-sdk/*` or `ai` packages as direct dependencies.
 */
import { Address, Keypair, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import {
  GuardBlockedError,
  PreFlightInterceptor,
  createVercelAIGuard,
  unsafeAccountAddress,
  unsafeContractAddress,
  type ContractCall,
  type PreFlightDecision,
  type VercelAIToolCallInput,
} from "../src/index.ts";

export const EXAMPLE_GUARD = unsafeContractAddress(
  "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
);
export const EXAMPLE_TOKEN = unsafeContractAddress(
  "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB",
);
export const ALLOWED_RECIPIENT = unsafeAccountAddress(
  "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
);
export const BLOCKED_RECIPIENT = unsafeAccountAddress(
  "GDZOKF3HGA6XSKIEEPJC5ANON3IJ5OGZMCX7GEGJLZN7JFRKOO4N2HXM",
);

export interface TransferToolInput {
  to?: string;
  amount?: string | number;
}

/**
 * Maps a Vercel AI tool call input into a typed Soroban ContractCall.
 */
export function toContractCall(call: VercelAIToolCallInput): ContractCall | null {
  if (call.toolName !== "transfer_tokens") return null;

  const input = call.input as TransferToolInput;
  if (!input || !input.to || input.amount === undefined) return null;

  return {
    contract: EXAMPLE_TOKEN,
    fn: "transfer",
    args: [
      new Address(EXAMPLE_GUARD).toScVal(),
      new Address(input.to).toScVal(),
      nativeToScVal(BigInt(input.amount), { type: "i128" }),
    ],
  };
}

/**
 * Creates a mock Soroban RPC server simulating allowed and blocked responses for the example.
 * No network credentials or live cluster needed.
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

export async function runVercelAiExample(serverOverride?: rpc.Server) {
  const mockServer = serverOverride ?? createMockRpcServer();
  const interceptor = new PreFlightInterceptor({
    server: mockServer,
    networkPassphrase: "Test SDF Network ; September 2015",
    guard: EXAMPLE_GUARD,
    agent: Keypair.random(),
    source: Keypair.random(),
  });

  const decisionsObserved: PreFlightDecision[] = [];

  // Create Vercel AI SDK guard wrapper
  const guard = createVercelAIGuard({
    interceptor,
    toContractCall,
    onDecision: (_call, decision) => {
      decisionsObserved.push(decision);
    },
  });

  // Track whether the underlying tool execute function was ever called
  let allowedToolRan = false;
  let blockedToolRan = false;

  // Define a tool using the structural Vercel AI SDK Tool shape
  const transferTool = guard("transfer_tokens", {
    description: "Transfer tokens from guarded account to a recipient",
    execute: async (input: TransferToolInput) => {
      allowedToolRan = true;
      return { success: true, recipient: input.to, amount: input.amount };
    },
  });

  // ── Run 1: Allowed Transfer ──────────────────────────────────────────
  // Recipient is allowed; pre-flight verdict is admissible.
  // The wrapped `execute` function runs and returns its result.
  const allowedResult = (await transferTool.execute?.({
    to: ALLOWED_RECIPIENT,
    amount: "50",
  })) as { success: boolean; recipient: string; amount: string | number };

  // ── Run 2: Blocked Transfer (violates recipient allowlist) ────────────
  // Recipient is NOT allowed; pre-flight simulation produces a `blocked` verdict.
  // The guard throws GuardBlockedError BEFORE execute is entered.
  // Crucial invariant: execute NEVER runs on a refusal.
  const blockedTransferTool = guard("transfer_tokens", {
    description: "Transfer tokens from guarded account to a recipient",
    execute: async (input: TransferToolInput) => {
      blockedToolRan = true;
      return { success: true, recipient: input.to, amount: input.amount };
    },
  });

  let blockedError: GuardBlockedError | null = null;
  try {
    await blockedTransferTool.execute?.({
      to: BLOCKED_RECIPIENT,
      amount: "500",
    });
  } catch (error) {
    if (error instanceof GuardBlockedError) {
      blockedError = error;
    } else {
      throw error;
    }
  }

  return {
    allowedToolRan,
    allowedResult,
    blockedToolRan,
    blockedError,
    decisionsObserved,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runVercelAiExample().then((res) => {
    console.log("=== Vercel AI SDK Guard Example Run ===");
    console.log("[Run 1: Allowed] Tool execute ran:", res.allowedToolRan);
    console.log("[Run 1: Allowed] Result:", res.allowedResult);
    console.log("[Run 2: Blocked] Tool execute ran:", res.blockedToolRan);
    console.log("[Run 2: Blocked] Caught error:", res.blockedError?.message);
    console.log("[Run 2: Blocked] Reason:", res.blockedError?.reason);
  });
}

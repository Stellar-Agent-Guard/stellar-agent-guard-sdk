/**
 * ElizaOS Action Validator Example — Full runnable demonstration with action wiring.
 *
 * Demonstrates:
 *  1. Version-pinned integration against `@elizaos/core` `Action.validate` hook
 *     (pinned in `docs/integration-hooks.md` §2, blob `5f604e593854` / `eb3f3fc98cef`).
 *  2. `PreFlightInterceptor` construction with Soroban RPC and guard configuration.
 *  3. `createGuardValidator` and `guardAction` composing pre-flight simulation before
 *     action candidate selection.
 *  4. Two runs:
 *     - Run 1 (Allowed): valid & permitted transfer -> `validate` returns `true`.
 *     - Run 2 (Blocked): transfer violating policy -> `validate` returns `false`,
 *       `onBlocked` records the refusal reason code and human-readable explanation;
 *       action handler is never scheduled or executed.
 *  5. Undetermined handling note (fails closed by returning `false`).
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
  createGuardValidator,
  guardAction,
  type ContractCall,
  type ElizaActionLike,
  type PreFlightDecision,
} from "../src/index.ts";

export const EXAMPLE_GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
export const EXAMPLE_TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
export const ALLOWED_RECIPIENT = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
export const BLOCKED_RECIPIENT = "GDZOKF3HGA6XSKIEEPJC5ANON3IJ5OGZMCX7GEGJLZN7JFRKOO4N2HXM";

export interface ElizaTransferState {
  token?: string;
  from?: string;
  to?: string;
  amount?: string | number;
}

/** Map ElizaOS message / state parameters into a typed Soroban ContractCall */
export function toContractCall(_message: unknown, state: unknown): ContractCall | null {
  const s = (state ?? {}) as ElizaTransferState;
  if (!s.to || s.amount === undefined) return null;

  return {
    contract: s.token ?? EXAMPLE_TOKEN,
    fn: "transfer",
    args: [
      new Address(s.from ?? EXAMPLE_GUARD).toScVal(),
      new Address(s.to).toScVal(),
      nativeToScVal(BigInt(s.amount), { type: "i128" }),
    ],
  };
}

/**
 * Creates a mock RPC server simulating allowed and blocked responses for the ElizaOS example.
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
                      xdr.ScVal.scvSymbol("per_tx_cap_exceeded"),
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

export async function runElizaOSExample(serverOverride?: rpc.Server) {
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

  const blockedDecisions: Array<PreFlightDecision & { allowed: false }> = [];

  // Define base ElizaOS action
  let baseValidateRan = 0;
  const rawTransferAction: ElizaActionLike = {
    name: "TRANSFER_FUNDS",
    validate: async (_runtime, _message, state) => {
      baseValidateRan++;
      const s = (state ?? {}) as ElizaTransferState;
      // Basic sanity check: requires recipient and positive amount
      return Boolean(s.to && Number(s.amount) > 0);
    },
  };

  // Demonstrating createGuardValidator directly:
  const directValidator = createGuardValidator({
    interceptor,
    toContractCall,
  });

  // Guard the action with stellar-agent-guard validator (wraps createGuardValidator)
  const action = guardAction(rawTransferAction, {
    interceptor,
    toContractCall,
    onBlocked: (decision) => {
      blockedDecisions.push(decision);
    },
  });

  // ── Run 1: Allowed Action ────────────────────────────────────────────
  const allowedDirectVerdict = await directValidator(
    {},
    {},
    {
      from: EXAMPLE_GUARD,
      to: ALLOWED_RECIPIENT,
      amount: "25",
    },
  );

  const allowedVerdict = await action.validate(
    {},
    {},
    {
      from: EXAMPLE_GUARD,
      to: ALLOWED_RECIPIENT,
      amount: "25",
    },
  );

  // ── Run 2: Blocked Action (exceeds spend cap or policy violation) ─────
  const blockedVerdict = await action.validate(
    {},
    {},
    {
      from: EXAMPLE_GUARD,
      to: BLOCKED_RECIPIENT,
      amount: "1500",
    },
  );

  return {
    baseValidateRan,
    allowedDirectVerdict,
    allowedVerdict,
    blockedVerdict,
    blockedDecisions,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runElizaOSExample().then((res) => {
    console.log("=== ElizaOS Validator Example Run ===");
    console.log("[Run 1: Allowed] Validation verdict (true => eligible):", res.allowedVerdict);
    console.log("[Run 2: Blocked] Validation verdict (false => dropped):", res.blockedVerdict);
    if (res.blockedDecisions.length > 0) {
      const b = res.blockedDecisions[0]!;
      console.log("[Run 2: Blocked] Reason:", b.kind === "blocked" ? b.reason : b.kind);
      console.log("[Run 2: Blocked] Explanation:", b.kind === "blocked" ? b.explanation : b.detail);
    }
  });
}

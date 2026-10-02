/**
 * ContractCall helpers for common SAC operations.
 *
 * Every integration hand-builds `{contractId, method: 'transfer', args: [from, to, amount]}` — arg-order
 * mistakes are a consumer-side bug class the SDK can eliminate. These builders produce typed `ContractCall` values
 * with args in contract-verified positions. Wrong-order becomes impossible for the two functions
 * the guard actually parses.
 *
 * Spec reference: SPEC §6.2 (SAC transfer / transfer_from argument layouts).
 *  - `transfer`      : [from, to, amount]
 *  - `transfer_from` : [from, spender, to, amount]
 *
 * The arg order is asserted element-by-element in `tests/unit/calls.test.ts`. If the spec
 * changes, update both the builders and the citation-aware test.
 */

import type { ContractCall } from "./tx.ts";

/**
 * Amount type accepted by the builders.
 *
 * The amount-type audit issue narrows SAC transfer amounts to `string | bigint`. The
 * builders are the natural enforcement point: accepting the audit's types here means an
 * integration that goes through a builder cannot accidentally pass a float or a
 * number that loses precision. If the audit issue has not landed yet, these types
 * are the follow-up contract: the builders already accept them and the rest of the
 * SDK will converge on them.
 */
export type SacAmount = string | bigint;

/**
 * The SAC transfer method name.
 */
export const SAC_TRANSFER_METHOD = "transfer" as const;

/**
 * The SAC transfer_from method name.
 */
export const SAC_TRANSFER_FROM_METHOD = "transfer_from" as const;

/**
 * Build a `ContractCall` for a SAC `transfer`.
 *
 * SPEC §6.2 positions: `[from, to, amount]`.
 *
 * @param token     Contract id of the SAC token.
 * @param from      Source account address.
 * @param to        Destination account address.
 * @param amount    Amount in the token's base units (`string`|`bigint`).
 */
export function sacTransfer(token: string, from: string, to: string, amount: SacAmount): ContractCall {
  return {
    contractId: token,
    method: SAC_TRANSFER_METHOD,
    args: [from, to, amount],
  };
}

/**
 * Build a `ContractCall` for a SAC `transfer_from`.
 *
 * SPEC §6.2 positions: `[from, spender, to, amount]`.
 *
 * Note the layout differs from `transfer`: the spender is the second argument, not
 * the destination. This is exactly the class of arg-order bug the builder eliminates.
 *
 * @param token     Contract id of the SAC token.
 * @param from      Source account address.
 * @param spender   Account authorized to spend `from`'s balance.
 * @param to        Destination account address.
 * @param amount    Amount in the token's base units (`string`|`bigint`).
 */
export function sacTransferFrom(
  token: string,
  from: string,
  spender: string,
  to: string,
  amount: SacAmount,
): ContractCall {
  return {
    contractId: token,
    method: SAC_TRANSFER_FROM_METHOD,
    args: [from, spender, to, amount],
  };
}

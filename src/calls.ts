import type { ContractCall } from './policy';

/**
 * Amount accepted by SAC amount-bearing builders.
 *
 * Strings allow for unsigned integer literals that exceed `Number.MAX_SAFE_INTEGER`
 * (i.e. 7-decimal SAC balances are routinely >> 2^53). Bigint is the preferred
 * representation for computed amounts. Number is intentionally excluded.
 */
export type SacAmount = string | bigint;

export type SacAddress = string;

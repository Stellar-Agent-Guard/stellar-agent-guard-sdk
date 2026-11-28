/**
 * Builders and pre-flight helpers for the two SAC calls integrations guard
 * most often: `transfer(from, to, amount)` and
 * `transfer_from(spender, from, to, amount)`.
 *
 * Building the `ContractCall` by hand is repetitive and easy to get wrong —
 * the argument order differs between the two functions, and the amount must be
 * an `i128`, not a plain number. These helpers own both details: the call they
 * produce is byte-for-byte the call the manual examples build, and the amount
 * is encoded once, in one place, from a value that provably fits.
 *
 * Every input is validated synchronously, before any RPC: an invalid address
 * or a lossy amount is an `InvalidInputError`, never a simulation round trip
 * that fails for an avoidable reason. The helpers then delegate to the normal
 * `check()` path, so the returned verdict is the same `PreFlightDecision` the
 * interceptor always produces — including its fail-closed `undetermined` arm.
 */
import { Address, nativeToScVal, type xdr } from "@stellar/stellar-sdk";
import { InvalidInputError } from "./errors.ts";
import {
  isContractAddress,
  isStrKeyAddress,
  type ContractAddress,
  type StrKeyAddress,
} from "./policy.ts";
import {
  PreFlightInterceptor,
  type PreFlightCheckOptions,
  type PreFlightConfigInput,
  type PreFlightDecision,
} from "./preflight.ts";
import type { ContractCall } from "./tx.ts";

/** Largest value an `i128` can carry (`2^127 - 1`). */
const I128_MAX = 2n ** 127n - 1n;

/** The arguments a SAC `transfer` needs. */
export interface TransferRequest {
  /** SAC token contract (`C…`). */
  token: ContractAddress;
  /** Token holder the amount is debited from (`G…` or `C…`). */
  from: StrKeyAddress;
  /** Recipient credited with the amount (`G…` or `C…`). */
  to: StrKeyAddress;
  /**
   * Amount in the token's smallest unit. `bigint` is the expected form; a
   * `number` is accepted only when it is a safe integer, so a value that
   * cannot round-trip exactly is rejected instead of silently rounded.
   */
  amount: bigint | number;
}

/** The arguments a SAC `transfer_from` needs. */
export interface TransferFromRequest extends TransferRequest {
  /** Address the allowance is spent from, i.e. `transfer_from`'s first argument. */
  spender: StrKeyAddress;
}

function describeValue(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function requireContractAddress(field: string, value: unknown): ContractAddress {
  if (!isContractAddress(value)) {
    throw new InvalidInputError(
      field,
      "contract_address",
      `expected a valid C... contract address, got ${describeValue(value)}`,
    );
  }
  return value;
}

function requireStrKeyAddress(field: string, value: unknown): StrKeyAddress {
  if (!isStrKeyAddress(value)) {
    throw new InvalidInputError(
      field,
      "strkey_address",
      `expected a valid G... account or C... contract address, got ${describeValue(value)}`,
    );
  }
  return value;
}

/**
 * Validate an amount and encode it as the `i128` ScVal the SAC expects.
 *
 * The rejection rules mirror the policy encoder's: a `bigint` is exact, a
 * `number` is accepted only when it is a safe integer (anything else is a
 * lossy value the SDK refuses to guess at), and the result must be a
 * non-negative `i128`. String amounts are not coerced — a caller holding one
 * should convert it explicitly.
 */
function encodeAmount(amount: bigint | number): xdr.ScVal {
  let value: bigint;
  if (typeof amount === "bigint") {
    value = amount;
  } else if (typeof amount === "number") {
    if (!Number.isSafeInteger(amount)) {
      throw new InvalidInputError(
        "amount",
        "safe_integer",
        `a number amount must be a safe integer to avoid precision loss, got ${describeValue(amount)}`,
      );
    }
    value = BigInt(amount);
  } else {
    throw new InvalidInputError(
      "amount",
      "bigint_integer",
      `expected a bigint amount in the token's smallest unit, got ${describeValue(amount)}`,
    );
  }
  if (value < 0n) {
    throw new InvalidInputError(
      "amount",
      "non_negative",
      `expected a non-negative amount, got ${describeValue(value)}`,
    );
  }
  if (value > I128_MAX) {
    throw new InvalidInputError(
      "amount",
      "i128_range",
      `amount ${describeValue(value)} exceeds the maximum i128 value ${I128_MAX}`,
    );
  }
  return nativeToScVal(value, { type: "i128" });
}

/**
 * Build the `ContractCall` for a SAC `transfer` without checking it.
 *
 * Useful when the call is queued, batched (`checkBatch()`), or executed later:
 * validation still happens here, so an invalid argument fails before the call
 * is handed anywhere.
 *
 * @throws {InvalidInputError} for a malformed token, holder, recipient or amount.
 */
export function buildTransferCall(params: TransferRequest): ContractCall {
  const token = requireContractAddress("token", params?.token);
  const from = requireStrKeyAddress("from", params.from);
  const to = requireStrKeyAddress("to", params.to);
  const amount = encodeAmount(params.amount);
  return {
    contract: token,
    fn: "transfer",
    args: [new Address(from).toScVal(), new Address(to).toScVal(), amount],
  };
}

/**
 * Build the `ContractCall` for a SAC `transfer_from` without checking it.
 *
 * The argument order is `[spender, from, to, amount]` — the detail this helper
 * exists to stop callers from getting wrong.
 *
 * @throws {InvalidInputError} for a malformed token, spender, holder, recipient or amount.
 */
export function buildTransferFromCall(params: TransferFromRequest): ContractCall {
  const token = requireContractAddress("token", params?.token);
  const spender = requireStrKeyAddress("spender", params.spender);
  const from = requireStrKeyAddress("from", params.from);
  const to = requireStrKeyAddress("to", params.to);
  const amount = encodeAmount(params.amount);
  return {
    contract: token,
    fn: "transfer_from",
    args: [
      new Address(spender).toScVal(),
      new Address(from).toScVal(),
      new Address(to).toScVal(),
      amount,
    ],
  };
}

/**
 * Run a pre-flight check for a SAC `transfer`.
 *
 * Equivalent to `preflight(config, buildTransferCall(params))`: the verdict is
 * the interceptor's ordinary `PreFlightDecision`, and invalid input throws
 * synchronously instead of returning `undetermined`. For repeated checks,
 * construct a `PreFlightInterceptor` once and pass it `buildTransferCall()`.
 *
 * @example
 * const decision = await checkTransfer(
 *   { server, networkPassphrase, guard, agent, source },
 *   { token: usdc, from: guard, to: recipient, amount: 1_001n },
 * );
 */
export function checkTransfer(
  config: PreFlightConfigInput,
  params: TransferRequest,
  options?: PreFlightCheckOptions,
): Promise<PreFlightDecision> {
  return new PreFlightInterceptor(config).check(buildTransferCall(params), options);
}

/**
 * Run a pre-flight check for a SAC `transfer_from`.
 *
 * Equivalent to `preflight(config, buildTransferFromCall(params))`, with the
 * same synchronous validation and the same fail-closed verdict shape.
 */
export function checkTransferFrom(
  config: PreFlightConfigInput,
  params: TransferFromRequest,
  options?: PreFlightCheckOptions,
): Promise<PreFlightDecision> {
  return new PreFlightInterceptor(config).check(buildTransferFromCall(params), options);
}

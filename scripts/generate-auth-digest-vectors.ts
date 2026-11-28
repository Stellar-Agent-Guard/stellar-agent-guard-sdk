#!/usr/bin/env node
/**
 * Regenerate the committed known-answer vectors for the guard auth digest
 * (issue #473).
 *
 * The expected bytes come from the Stellar XDR definition of
 * `HashIdPreimage::SorobanAuthorization{WithAddress}` and `node:crypto`'s
 * SHA-256 — never from `src/tx.ts`, which is what the vectors are meant to
 * check. Edit only a vector's `input`, run `npm run vectors:auth-digest`, and
 * review the resulting `expected` diff before committing it.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Address, xdr } from "@stellar/stellar-sdk";

export type AuthCredentialType = "sorobanCredentialsAddress" | "sorobanCredentialsAddressV2";

export interface AuthVectorInput {
  guard: string;
  networkPassphrase: string;
  nonce: string;
  signatureExpirationLedger: number;
  credentialType: AuthCredentialType;
  call: {
    contract: string;
    fn: string;
    args: Array<{ description: string; scValHex: string }>;
  };
}

export interface AuthVectorExpected {
  networkIdHex: string;
  preimageHex: string;
  digestHex: string;
}

interface AuthVector {
  name: string;
  description: string;
  input: AuthVectorInput;
  expected: AuthVectorExpected;
}

export interface AuthVectorFixture {
  _provenance: { source: string; regenerate: string; note: string };
  vectors: AuthVector[];
}

/** Rebuild the XDR preimage and its SHA-256 digest from vector inputs alone. */
export function computeAuthVectorExpected(input: AuthVectorInput): AuthVectorExpected {
  const networkId = createHash("sha256").update(input.networkPassphrase, "utf8").digest();
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(input.call.contract).toScAddress(),
        functionName: input.call.fn,
        args: input.call.args.map((arg) => xdr.ScVal.fromXDR(arg.scValHex, "hex")),
      }),
    ),
    subInvocations: [],
  });
  const guardAddress = new Address(input.guard).toScAddress();
  const nonce = BigInt(input.nonce);
  const preimage =
    input.credentialType === "sorobanCredentialsAddressV2"
      ? xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
          new xdr.HashIdPreimageSorobanAuthorizationWithAddress({
            networkId,
            nonce,
            invocation,
            address: guardAddress,
            signatureExpirationLedger: input.signatureExpirationLedger,
          }),
        )
      : xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
          new xdr.HashIdPreimageSorobanAuthorization({
            networkId,
            nonce,
            invocation,
            signatureExpirationLedger: input.signatureExpirationLedger,
          }),
        );
  const preimageBytes = Buffer.from(preimage.toXDR());
  return {
    networkIdHex: networkId.toString("hex"),
    preimageHex: preimageBytes.toString("hex"),
    digestHex: createHash("sha256").update(preimageBytes).digest("hex"),
  };
}

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../tests/fixtures/auth-digest-vectors.json",
);

function main(): void {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as AuthVectorFixture;
  for (const vector of fixture.vectors) {
    vector.expected = computeAuthVectorExpected(vector.input);
  }
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`refreshed ${fixture.vectors.length} auth-digest vectors in ${FIXTURE_PATH}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

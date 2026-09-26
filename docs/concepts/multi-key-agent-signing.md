# Multi-key agent signing — research spike (issue #29)

**Status: spike + interface prep, not implementation.** The SDK side is landed
(the `AgentSigner` seam). The multi-key *encoding* is deliberately absent until
the contracts repo decides its v2 `Signature` type.

## The problem this anticipates

`stellar-agent-guard-contracts` issue #2 (v2 multi-sig) will change
`__check_auth`'s `Signature` type from a single `BytesN<64>` to something
multi-key — a threshold over N registered agent keys. The SDK's signing path
(`src/tx.ts` → `buildGuardAuthEntry`, surfaced through
`PreFlightInterceptor.check` and `invoke`) was written against the single-key
assumption: it took a `Keypair` and called `keypair.sign(digest)`, and every
public config object typed the agent as `Keypair`.

If multi-key support is bolted on later as a *new* parameter, every integration
(including the LangChain/ElizaOS adapters and anything downstream that builds a
config object) has to change again. This note records how the host actually
presents custom-account signatures so the interface can be shaped now, and what
exactly lands when contracts #2 merges.

## How soroban-sdk 27 presents a custom account's signature

From the custom-account interface, as quoted in the contracts SPEC §1.1
(verified there against `soroban-sdk 27.0.6`, `src/auth.rs` /
`src/custom_account.rs`):

```rust
pub trait CustomAccountInterface {
    type Signature;
    type Error: Into<Error>;
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,            // the digest the signature must verify against
        signatures: Self::Signature,             // the contract's OWN associated type
        auth_contexts: Vec<Context>,
    ) -> Result<(), Self::Error>;
}
```

Two properties follow, and they are the whole design constraint:

1. **`Signature` is contract-defined.** The host does not impose a signature
   shape. It carries the `ScVal` that appears in
   `SorobanAddressCredentials.signature` and converts it to the contract's
   associated `Signature` type (`TryFromVal`). Whatever Rust type v2 chooses, the
   wire payload is still one `ScVal` in that one field.
2. **The signed payload does not change with the number of signers.** All N
   signers verify against the same 32-byte digest — the SHA-256 of the
   authorization preimage the host computed. A multi-signer is not N different
   payloads; it is N signatures over one payload.

So the host offers these presentations for a non-trivial `Signature` type:

| Option | Wire shape (`ScVal`) | Contract-side type | Assessment |
|---|---|---|---|
| **A. single key (v1)** | `Bytes` (64 bytes) | `BytesN<64>` | Current. Cannot express N keys or a threshold. |
| **B. vector of signatures** | `Vec<Bytes>` (N × 64 bytes) | `Vec<BytesN<64>>` | Works, but the key↔signature pairing is positional and implicit; duplicate/unknown keys are only detectable by rejection. |
| **C. key + signature records (recommended)** | `Vec<Map{public_key, signature}>` (sorted inner maps) | `#[contracttype] struct AgentSignature { public_key, signature }`, `Vec<AgentSignature>` | Self-describing, order-independent, and the threshold check is natural inside `__check_auth` (count distinct valid registered keys ≥ threshold). |
| **D. opaque blob** | `Bytes` (serialized structure) | `Vec<u8>` + a bespoke decoder | Least type-safe; couples the SDK's encoder to a contract-internal encoding that can change without an XDR change. Avoid. |

**Recommendation: option C** — a `Vec` of `{ public_key, signature }` records,
with the threshold evaluated in `__check_auth` against the registered key set.
It keeps type-safety, makes the signer set explicit, and (as above) does not
change what is signed.

An SDK-relevant detail that the repo has already been bitten by: the host
rejects an **unsorted** `ScMap` at struct-conversion time
(`ScMap was not sorted by key for conversion to host object` — see
`policyToScVal`). Option C means every inner map the SDK emits must be
key-sorted, and `"public_key" < "signature"` holds, so a sorted encoder
produces a valid payload. Option B sidesteps maps entirely, which is its one
practical advantage.

## What this PR landed (interface prep, single-key behaviour unchanged)

- **`AgentSigner` (new, `src/tx.ts`)** — the seam: "something that signs the
  32-byte authorization digest". The SDK depends on this, not on `Keypair`.
  `signDigest` may be sync (a local key) or async (a remote/HSM signer).
- **`keypairAgentSigner(kp)`** — wraps a `Keypair`; the v1 behaviour, unchanged.
- **`toAgentSigner(signer)`** — accepts either, so every existing caller that
  passes a `Keypair` keeps working with no call-site change.
- **`buildGuardAuthEntry({ signer })`** — now takes `AgentSigner | Keypair` and
  is `async` (a threshold/remote signer resolves signatures as a promise). The
  preimage, nonce and credential-type logic are untouched; only the signing step
  moved behind the interface.
- **`GuardAuthorization.agent` and `PreFlightConfig.agent`** (public config
  objects) widened to `AgentSigner | Keypair` — the surface integrations touch,
  so they will not need a second breaking change.

## What is deliberately NOT here

- No `Vec`/threshold encoding in the SDK, and no option selection at runtime.
- No per-key nonce or replay scheme. The nonce belongs to the credential (one
  per authorization entry), not to a signer, so multi-key does not change the
  nonce story — but if v2 introduces per-key nonces, that is a v2 change to
  `buildGuardAuthEntry`, not a caller-facing one.
- No contract-side change (out of scope: `stellar-agent-guard-contracts`).
- No key-rotation or key-set management in the SDK; the guard remains the
  authority on which keys are registered.

## Revisit trigger

**Implement the multi-key path when contracts #2 lands:**
<https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/issues/2>

At that point the SDK work is small and contained, because the seam already
exists:

1. pick the contract's chosen presentation (expect option C);
2. add a `MultiAgentSigner` (N signers + the set of public keys) beside
   `AgentSigner`, with its own `signDigest` that signs the same digest N times
   and encodes the result into the single `ScVal` the credential carries;
3. extend the credentials builder to write that `ScVal` — the envelope, nonce
   and preimage code is unchanged;
4. add unit tests for the encoding (sorted inner maps; N = 1, N = threshold,
   N > threshold) and extend the live suite with a multi-key guard instance.

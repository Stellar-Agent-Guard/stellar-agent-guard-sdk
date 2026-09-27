# Recorded RPC fixtures

Real Soroban RPC responses, captured from Stellar testnet and committed so the
unit suite decodes **the network's actual payload shapes** instead of objects the
tests invented.

## Why these exist

A hand-written mock encodes what the test author *believes* the RPC returns. When
`@stellar/stellar-sdk` renames a field or reshapes a nested object, those mocks
keep passing while production breaks — the exact drift a green suite is supposed
to catch. These fixtures pin the real wire form: the tests load them with the
SDK's own parsers (`parseRawEvents`, `parseRawSimulation`) and feed the result
through the SDK's production decode paths, so a shape change fails here.

They are not test-only inventions. Each file carries a provenance header, and
each was produced by `scripts/capture-rpc-fixtures.ts` against the live Phase 2
instance.

## Fixtures

| File | RPC method | What it pins |
| --- | --- | --- |
| `get-events-guard-page.json` | `getEvents` | The raw page envelope — `events`, `cursor`, and the retention window (`oldestLedger` / `latestLedger`, `latestLedgerCloseTime` / `oldestLedgerCloseTime`). The guard has no events in the retained window on a quiet network, so `events` may be empty; the retention fields and cursor are real. |
| `simulate-success-status.json` | `simulateTransaction` (success) | A real successful read-only simulation of `guard.status()`: transaction footprint (`transactionData`), `minResourceFee`, `result` and `stateChanges`. |
| `simulate-error-wrong-agent.json` | `simulateTransaction` (failure) | A real enforced-simulation failure. The guard's auth entry is signed with a throwaway key, so the on-chain `__check_auth` rejects the credential before the contract can publish a block event — the diagnostics are host noise. Used to prove the decoder never fabricates a guard event from a host failure. |

### Provenance

Every fixture's header records: `source`, `method`, `contractId`, `network`,
`rpcUrl`, `capturedAt`, `stellarSdkVersion` and a `note`. The unit test
`tests/unit/rpc-fixtures.test.ts` asserts the header is present, so a fixture
cannot be quietly replaced with a hand-written object.

The guard contract is
`CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44`, the Phase 2 testnet
instance recorded in `../phase2-instance.json`.

### A real blocked-decision payload

A genuine `event_auth_checked / blocked / <reason>` payload cannot be captured
without the registered agent secret: the guard's `unauthorized` path verifies the
agent signature *before* it publishes its event, so a wrong key produces a
cryptographic trap instead. That decode path is covered instead by the committed
golden vocabulary in [`../contract-fixtures.json`](../contract-fixtures.json)
(real base64 `ScVal` XDR for every reason symbol) plus the live capture recorded
in [`../../docs/event-schema.md`](../../../docs/event-schema.md).

## Capturing / refreshing

```bash
npm run capture:rpc-fixtures
```

No secrets are needed. The script reads the public guard and token addresses
(overridable with `PHASE2_GUARD`, `PHASE2_TOKEN`, `PHASE2_RPC_URL`) and funds its
own throwaway source account through Friendbot. It rewrites the files above in
place with a fresh `capturedAt`, then the unit suite re-runs against them.

Refresh when you touch `src/telemetry.ts`, `src/invoke.ts`, or upgrade
`@stellar/stellar-sdk`; otherwise the scheduled `live-suite` workflow is the
canary. Provenance (`stellarSdkVersion`) tells you which SDK a fixture was
recorded against.

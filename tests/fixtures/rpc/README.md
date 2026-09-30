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

### Replay fixtures (offline enforcement verdict replay)

| File | Verdict | What it replays |
| --- | --- | --- |
| `replay-admissible.json` | admissible | Transfer within both per-tx and window caps, to allowlisted recipient |
| `replay-blocked-per-tx-cap.json` | blocked (per_tx_cap_exceeded) | Transfer amount exceeds per-transaction cap |
| `replay-blocked-recipient-not-allowed.json` | blocked (recipient_not_allowed) | Transfer to recipient not in allowlist |
| `replay-blocked-window-cap.json` | blocked (window_cap_exceeded) | Transfer pushes cumulative spend over rolling window cap |
| `replay-blocked-paused.json` | blocked (paused) | Account-state refusal: policy paused |
| `replay-undetermined-malformed.json` | undetermined | Simulation error before guard verdict (host trap) |

Replay fixtures carry recorded simulation request+response pairs and the expected verdict/reason.
They prove the SDK decode pipeline still extracts correct verdicts from historical evidence without
touching the network. Complements live-suite enforcement proofs and the evidence-checker.

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

### Basic RPC fixtures

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

### Replay fixtures

Replay fixtures (`replay-*.json`) should be captured from actual live enforcement
runs when the integration suite runs. Each fixture carries:

- Header provenance (source, method, network, capturedAt, SDK version, note)
- Guard contract ID
- Simulation request context (note field)
- Raw simulation response (base64 XDR diagnostics)
- Expected verdict (admissible/blocked/undetermined) and reason

To capture a new replay fixture from a live run:

1. Run the integration suite and observe the enforcement scenario
2. Extract the simulation response from the diagnostic output
3. Create a new `replay-<scenario>.json` file with the structure above
4. Verify the fixture passes `npm run test:unit` (replay.test.ts)

Replay fixtures are hermetic: they assert semantic decoding of captured payloads
without issuing any RPC calls. The transport mock absence proves network isolation.

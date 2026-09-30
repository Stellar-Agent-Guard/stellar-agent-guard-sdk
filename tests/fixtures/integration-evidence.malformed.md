<!--
  DELIBERATELY MALFORMED — test fixture only. Not evidence.

  This is a structural-drift copy of `integration-evidence.md`: its headings were
  renamed ("## Deployment details", "## Execution log", "## Scenarios"), its
  instance table was rewritten as prose, its run output lost the `✔` markers, and
  its scenarios became a plain numbered list. It is loaded by
  `tests/unit/check-enforcement-evidence.test.ts` to prove that
  `scripts/check-enforcement-evidence.ts` fails loudly (non-zero exit) instead of
  passing vacuously when the document no longer parses.

  It is never treated as the real evidence file: the script only reads it when
  the test points `--evidence` at it.
-->

# Live integration evidence — Phase 2 (malformed copy)

Record of the enforcement suite running against the real Phase 2 testnet
instance. Reproduce with `npm run test:integration` (requires `.env.phase2`).

## Deployment details

The headings above were renamed, so the structural checker cannot find
"Instance under test". The table was replaced by prose:

The guard under test is `CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44`
and the SAC token is `CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB`.

## Execution log

The run output was narrated instead of recorded, so there are no `✔` rows:

Five scenarios passed: an allowed transfer, a per-transaction-cap violation, a
rolling-window-cap violation, a recipient-allowlist violation, and an
account-state refusal. No transaction hashes are quoted.

## Scenarios

The `### N.` headings became a plain numbered list, so the section minimums are
not met:

1) Allowed transfer
2) Per-transaction-cap violation
3) Rolling-window-cap violation
4) Recipient-allowlist violation
5) Account-state refusal is distinguishable

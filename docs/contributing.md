# Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for coding standards, PR workflow, and the one-commit-per-file convention.

## Architecture on-ramp: where a change lands

New contributors often ask "is this an interceptor, an adapter, telemetry, or policy encoding?" — and "even if it is, is this the right repo?" This section maps the SDK's five layers to actual source files and gives you a routing table for common bug reports. The repo-level diagram in the [README](../README.md) shows how the repositories fit together; this section shows where changes land inside this one.

The SDK is organized into five layers. Each layer owns a distinct question:

| Layer | Files | Responsibility (one line) |
| --- | --- | --- |
| **Verdict** | `src/preflight.`, `src/cost.` | Runs preflight checks and cost estimation before a transaction is submitted. |
| **Execution** | `src/transaction.`, `src/invoke.` | Builds, signs, and submits transactions and contract invocations. |
| **Observation** | `src/telemetry.`, `src/events.` | Emits telemetry and surfaces chain events to consumers. |
| **Integration** | `src/adapters/` | Adapts the SDK to external signers, wallets, and runtimes. |
| **Authority** | `src/policy/` | Encodes policy decisions into the form the chain enforces. |

> Verify the cited paths before opening a PR: `rg --files src/preflight.src/policy/`

### Change-routing table

Use this table to find the starting point for a change. The last two rows are deliberate redirects: the SGK cannot fix these, and opening a PR here will not land the fix.

| Symptom / request | Start in | Notes |
| --- | --- | --- |
| Preflight blocks a transaction that should pass | `src/preflight.` | Check the check pipeline and input normalization. |
| Cost estimate is incorrect or missing a fee | `src/cost.` | Check fee tables and decimal handling. |
| Transaction fails to build, sign, or submit | `src/transaction.`, `src/invoke.` | Chech sequencing, signer plumbing, and result parsing. |
| Telemetry missing or events undelivered | `src/telemetry.`, `src/events.` | Check emitter wiring and event decoding. |
| Signer/wallet integration broke | `src/adapters/` | Check the adapter implementation and its contract. |
| Policy encoding is wrong or a policy decision is unexpected | [`stellar-agent-guard-contracts`](https://github.com/aigbagbobila/stellar-agent-guard-contracts) | **Wrong repo:** verdict logic lives on-chain. The SDK only encodes inputs. |
| A transaction is blocked wrongly by policy semantics | [`stellar-agent-guard-contracts`](https://github.com/aigbagbobila/stellar-agent-guard-contracts) | **Wrong repo:** policy semantics are enforced on-chain. Do not open an SGK PR to change policy behavior. |

## Links

- GitHub Issues: <https://github.com/aigbagbobila/stellar-agent-guard-sdk/Issues>
- Backlog Labels: `tier:blocker`, `tier:maintainer-decision`, `tier:enhancement`, `scope:sdk`

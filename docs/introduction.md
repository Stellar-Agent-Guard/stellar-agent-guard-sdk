# Introduction

Stellar Agent Guard SDK is the TypeScript integration library connecting AI agent frameworks (such as LangChain and ElizaOS) to Stellar Agent Guard smart accounts on Soroban.

## Why Stellar Agent Guard?

Autonomous AI agents operate by executing tool calls and signing transactions programmatically. When given direct key access to a standard wallet, a prompt injection attack, flawed reasoning loop, or unverified output can instantly drain funds.

Stellar Agent Guard eliminates this single point of failure by enforcing non-custodial, account-level guardrails inside Soroban native Custom Accounts (`__check_auth`). Every transaction authorized by the agent is inspected against the operator's security policy before execution.

## SDK Core Responsibilities

1. **Pre-Flight Interception**: Simulates candidate actions against Soroban RPC to evaluate guard authorization before broadcast, returning explicit admissible/blocked/undetermined decisions without spending network fees.
2. **Simulation-Based Fee Calculation**: Accurately prices transactions using Soroban simulation results without requiring external binary profiling tools.
3. **Custom Account Signing Pipeline**: Automates discovery and signing of `SorobanAuthorizationEntry` objects required by Soroban host custom account verification.
4. **Dual-Stream Telemetry**: Captures committed ledger events and uncommitted simulation diagnostics to provide complete observability into guard enforcement.

## API Reference

The complete SDK API reference lives in the [API Reference](./api-reference.md), kept in `docs/` so it can grow alongside the prose guides (introduction, troubleshooting, glossary, threat model, compatibility) without bloating the README.

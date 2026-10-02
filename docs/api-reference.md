# API Reference

The Stallar Agent Guard SDK exposes the following public surface. For the narrative pitch and quickstart, see the [repository README](https://github.com/aigbagbobila/stellar-agent-guard-sdk).

## PreFlightInterceptor

Simulates candidate agent actions against Soroban RPC and returns an explicit admissible/blocked/undetermined decision before broadcast.

## CostPreChecker

Prices transactions using Soroban simulation results without requiring external binary profiling tools.

## GuardTelemetryListener

Captures committed ledger events and uncommitted simulation diagnostics for complete observability into guard enforcement.

## Framework Adapters

Integration adapters connecting AI agent frameworks (such as LangChain and ElizaOS) to Stellar Agent Guard smart accounts on Soroban.

## Invoke Pipeline

Automates discovery and signing of `SorobanAuthorizationEntry` objects required by Soroban host custom account verification.

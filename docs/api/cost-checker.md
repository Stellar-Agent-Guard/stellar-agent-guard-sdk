# CostPreChecker API

`CostPreChecker` evaluates expected transaction fees against an optional ceiling before broadcast.

## Constructor

```ts
constructor(options: CostPreCheckerOptions)
```

### Options

- `interceptor: PreFlightInterceptor` — Configured interceptor instance
- `maxFeeStroops?: bigint` — Maximum allowable total fee in stroops

## Methods

### `check(call: ContractCall): Promise<CostPreCheckResult>`

Returns a discriminated result: `{ kind: "within_budget" | "over_budget" | "blocked" | "undetermined", ... }`.

Priced `within_budget` and `over_budget` results may include a `breakdown` parsed from the same simulation:

```ts
{
  instructions: number;       // SorobanResources.instructions
  diskReadBytes: number;      // SorobanResources.diskReadBytes
  writeBytes: number;         // SorobanResources.writeBytes
  readOnlyEntries: number;    // footprint.readOnly.length
  readWriteEntries: number;   // footprint.readWrite.length
  storageEntries: number;     // readOnlyEntries + readWriteEntries
}
```

The breakdown is `undefined` when the simulation is undetermined or does not contain a complete resource block; no zero-filled fallback is fabricated. The stellar-sdk v17 payload does not expose a `memBytes` field, so the API preserves the real `writeBytes` and disk-read fields instead of inventing a memory metric.

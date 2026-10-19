# Installation

## Requirements

- `Node.js`: `v24.0.0` or higher
- `@stellar/stellar-sdk`: `^17.0.1` (runtime dependency)

## Installing from NPM

```bash
npm install stellar-agent-guard-sdk
```

## Installing from Source

```bash
git clone https://github.com/aigbagbobila/stellar-agent-guard-sdk.git
cd stellar-agent-guard-sdk
npm ci
npm run build
npm test
```

The SDK uses Node 24 native TypeScript test execution (`node --test`) and compiles to modern ESM (`dist/index.js`).

## Next Steps

- See the [API reference](./api-reference.md) for the full surface area.
- See the [quickstart](../README.md#quick-start) for a minimal end-to-end example.
- See [troubleshooting](./troubleshooting.md) if installation fails.

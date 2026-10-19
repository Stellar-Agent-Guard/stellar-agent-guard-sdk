# Troubleshooting

Common failure modes and resolutions when integrating the Stellar Agent Guard SDK.

## Simulation returns `undetermined`

The pre-flight interceptor could not conclusively evaluate the candidate action. Verify the Soroban RPC endpoint is reachable and that the target contract exists on the configured network.

## Authorization entries not signed

Ensure the invoke pipeline receives a valid agent key and that the custom account `__check_auth` policy admits the call. Blocked calls are rejected client-side before broadcast.

## No telemetry events emitted

Confirm the `GuardTelemetryListener` is subscribed before the invoke pipeline runs. Simulation diagnostics are only available during the pre-flight window.

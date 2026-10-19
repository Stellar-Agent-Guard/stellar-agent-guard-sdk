/**
 * Browser-consumer bundle entry for the size check (issue #145).
 *
 * Deliberately the dashboard-shaped import: the named client-side surface an
 * operator console actually pulls in. One-off bundlings of other named exports
 * can be measured by editing this file — the point of the canary is a *stable*
 * import whose size is comparable across commits.
 *
 * Keep the list aligned with what the dashboard imports (see
 * `tests/unit/bundle-size.test.ts` for the exact canary contract).
 */
export {
  CostPreChecker,
  GuardEventRingBuffer,
  GuardTelemetryListener,
  PreFlightInterceptor,
  computePollDelay,
  decodeAuthDecision,
  decodePolicy,
  describeCostDecision,
  describeGuardEvent,
  describePolicy,
  policyToScVal,
  preflight,
  validateGuardPolicy,
} from "../src/index.ts";

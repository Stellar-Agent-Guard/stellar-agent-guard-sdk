/**
 * Shared step vocabulary for pipeline traces.
 *
 * One source of truth for the names a trace uses when it walks the guarded
 * pipeline — the discovery probe, the signing pass, the enforced simulation
 * and the broadcast — so that `invoke()`'s `onStep` observability and a
 * dry-run trace describe the same stages with the same words. Defining the
 * names once here is what keeps the two from drifting apart: a stage added to
 * the pipeline must be added to this list, and a trace emitting a name that is
 * not on it is a type error, not a silent second vocabulary.
 */

/** The pipeline stages a trace can report, in the order the pipeline runs them. */
export const TRACE_STEP_NAMES = ["probe", "sign", "simulate", "broadcast"] as const;

/** One of the shared trace step names. */
export type TraceStepName = (typeof TRACE_STEP_NAMES)[number];

/** Lifecycle of one stage attempt: it begins, then it succeeds or it does not. */
export type TraceStepStatus = "start" | "ok" | "fail";

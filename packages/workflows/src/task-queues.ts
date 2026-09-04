/**
 * Task queue lanes shared by the worker (which runs one Worker per lane) and
 * the database (which routes each step type to a lane). Kept free of any
 * Temporal SDK import so non-worker packages can route without the dependency.
 *
 * The lanes separate work by latency tolerance, not by tenant: `control` serves
 * Workflow Tasks and short account operations, `live` serves work a person is
 * waiting on, and `bulk` serves backfills.
 */
export const taskQueueLanes = ["control", "live", "bulk"] as const;

export type TaskQueueLane = (typeof taskQueueLanes)[number];

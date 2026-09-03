/**
 * Task queue lanes shared by the worker (which creates one Worker per lane) and
 * the database (which routes each step type to a lane). Kept free of any
 * Temporal SDK import so non-worker packages can route without the dependency.
 */
export const tenantTaskQueueLanes = ["control", "live", "bulk"] as const;

export type TenantTaskQueueLane = (typeof tenantTaskQueueLanes)[number];

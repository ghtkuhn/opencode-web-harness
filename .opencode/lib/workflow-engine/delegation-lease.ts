import type { DelegationLease, WorkerHelpRequest } from "../worker-help.ts"

export type SessionObservation = {
  state: "busy" | "idle" | "terminal" | "missing"
  handoff?: string | null
}

export type DelegationResolution =
  | { kind: "none" }
  | { kind: "wait"; lease: DelegationLease }
  | { kind: "resume"; lease: DelegationLease; workerSessionID: string }
  | { kind: "deliver"; lease: DelegationLease; workerSessionID: string; handoff: string }
  | { kind: "fresh"; lease: DelegationLease }

export function delegationLeaseFromHelp(request: WorkerHelpRequest | null | undefined): DelegationLease | null {
  if (!request || request.status !== "delegated") return null
  if (request.delegation) return request.delegation
  const priorStatus = request.delegationPriorStatus
  if (priorStatus !== "retry_approved" && priorStatus !== "task_changed") return null
  return {
    version: 1,
    phase: request.delegatedWorkerSessionID ? "running" : "launching",
    taskPath: request.taskPath,
    taskHash: request.taskHash,
    helpID: request.id,
    priorStatus,
    parentSessionID: request.delegationParentSessionID,
    workerSessionID: request.delegatedWorkerSessionID,
    callID: request.delegationCallID,
    source: request.delegationSource,
    revision: 1,
    updatedAt: request.delegatedAt ?? request.createdAt,
  }
}

export function reconcileDelegationLease(
  lease: DelegationLease | null,
  observation: SessionObservation | null,
): DelegationResolution {
  if (!lease) return { kind: "none" }
  if (lease.phase === "launching" || !lease.workerSessionID) return { kind: "wait", lease }
  if (!observation || observation.state === "busy") return { kind: "wait", lease }
  if (observation.state === "idle") {
    return { kind: "resume", lease, workerSessionID: lease.workerSessionID }
  }
  const handoff = observation.handoff?.trim()
  if (handoff) {
    return { kind: "deliver", lease, workerSessionID: lease.workerSessionID, handoff }
  }
  return { kind: "fresh", lease }
}

export function normalizeBoundWorkerTaskArgs<T extends Record<string, unknown>>(
  args: T,
  resolution: DelegationResolution,
): T {
  if (resolution.kind !== "resume") return args
  const normalized = args as Record<string, unknown>
  for (const field of ["session_id", "sessionID", "taskID"] as const) delete normalized[field]
  normalized.task_id = resolution.workerSessionID
  normalized.subagent_type = "worker"
  delete normalized.model
  return args
}

export function advanceDelegationLease(
  lease: DelegationLease,
  phase: DelegationLease["phase"],
  now: string,
  workerSessionID = lease.workerSessionID,
): DelegationLease {
  return {
    ...lease,
    phase,
    workerSessionID,
    revision: lease.revision + 1,
    updatedAt: now,
  }
}

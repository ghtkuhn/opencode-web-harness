import type { AuthoritativeWorkflowSnapshot, WorkflowHelpSnapshot } from "./types.ts"
import { delegationLeaseFromHelp } from "./delegation-lease.ts"

export type AuthoritativeWorkflowPorts = {
  role?(): AuthoritativeWorkflowSnapshot["role"]
  doctorState(): any
  checkpoint(): any
  lastDoctorFailure(): any
  openTasks(): string[]
  currentHelp(taskPath: string | null, taskHash?: string | null): any
  memoryRecovery(): { size: number; maxSize: number } | null
  harnessRecovery(): { taskPath: string; paths: Array<{ path: string }> } | null
  plannerOwner(taskPath: string): { plannerSessionID?: string | null } | null
  plannerRecovery(): any
  requestedOperation?(): string | null
  sessionObservation?(): AuthoritativeWorkflowSnapshot["sessionObservation"]
}

export function readAuthoritativeWorkflowSnapshot(ports: AuthoritativeWorkflowPorts): AuthoritativeWorkflowSnapshot {
  const state = ports.doctorState()
  const checkpoint = ports.checkpoint()
  const savedFailure = ports.lastDoctorFailure()
  const doctorStatus = typeof state?.status === "string" ? state.status : "none"
  const doctorTask = typeof state?.taskPath === "string" ? state.taskPath : null
  const doctorDestination = typeof state?.destination === "string" ? state.destination : null
  const help = ports.currentHelp(doctorTask, state?.taskHash)
  const plannerOwner = doctorTask ? ports.plannerOwner(doctorTask) : null
  const plannerRecovery = ports.plannerRecovery()
  const activePlannerRecovery = plannerRecovery?.version === 1
    && plannerRecovery.taskPath === doctorTask
    && plannerRecovery.taskHash === state?.taskHash
    && ["unavailable", "incomplete"].includes(plannerRecovery.status)
      ? plannerRecovery
      : null
  const normalizedHelp: WorkflowHelpSnapshot = help && !["resolved", "obsolete"].includes(help.status)
    ? {
        id: help.id,
        status: help.status,
        taskPath: help.taskPath,
        problem: help.problem,
        delegation: delegationLeaseFromHelp(help),
      }
    : null

  return {
    role: ports.role?.() ?? "unknown",
    doctor: {
      status: doctorStatus,
      taskPath: doctorTask,
      destination: doctorDestination,
      taskHash: typeof state?.taskHash === "string" ? state.taskHash : null,
    },
    completedTask: doctorDestination
      ?? (typeof checkpoint?.completedTask === "string" ? checkpoint.completedTask : null),
    openTasks: ports.openTasks(),
    help: normalizedHelp,
    plannerOwnerSessionID: plannerOwner?.plannerSessionID ?? null,
    recovery: {
      memory: ports.memoryRecovery(),
      harness: normalizeHarnessRecovery(ports.harnessRecovery()),
      planner: activePlannerRecovery
        ? {
            status: activePlannerRecovery.status,
            plannerSessionID: activePlannerRecovery.plannerSessionID,
            reason: activePlannerRecovery.reason,
          }
        : null,
    },
    requestedOperation: ports.requestedOperation?.() ?? null,
    sessionObservation: ports.sessionObservation?.() ?? null,
    lastDoctorFailure: savedFailure?.taskPath === doctorTask
      ? { gate: String(savedFailure.gate ?? "unknown"), output: String(savedFailure.output ?? "") }
      : null,
  }
}

function normalizeHarnessRecovery(value: ReturnType<AuthoritativeWorkflowPorts["harnessRecovery"]>) {
  return value
    ? { taskPath: value.taskPath, paths: value.paths.map(({ path }) => path) }
    : null
}

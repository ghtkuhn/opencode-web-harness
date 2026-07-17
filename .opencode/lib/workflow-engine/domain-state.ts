import type { WorkflowRole } from "./types.ts"

export const DOCTOR_STATES = ["none", "registered", "ready", "started", "passed", "completed", "failed"] as const
export const WORKER_TRANSACTION_STATES = ["idle", "preflighted", "previewed", "applied", "verifying", "reviewable", "blocked"] as const
export const HELP_STATES = ["none", "pending", "retry_approved", "rejected", "resolved"] as const
export const PLANNER_RECOVERY_STATES = ["none", "requested", "active", "blocked", "complete"] as const
export const RECOVERY_STATES = ["none", "memory", "harness"] as const
export const FAILURE_WINDOW_STATES = ["clear", "retryable", "terminal"] as const
export const BOOST_STATES = ["disabled", "eligible", "active", "exhausted"] as const
export const GUARD_LEARNING_STATES = ["clear", "pending", "recording"] as const
export const SESSION_STATES = ["active", "compacted", "deleted"] as const
export const WORKFLOW_DOMAIN_EVENT_TYPES = [
  "planner.task_planned", "planner.task_registered", "executor.task_scheduled", "worker.task_started",
  "worker.preflight_passed", "worker.change_previewed", "worker.change_applied", "worker.verification_started",
  "worker.verification_passed", "executor.review_completed", "worker.help_requested", "executor.retry_approved",
  "planner.recovery_requested", "planner.recovery_started", "planner.recovery_completed", "recovery.memory_required",
  "recovery.harness_required", "recovery.completed", "failure.recorded", "failure.cleared", "boost.activated",
  "boost.exhausted", "learning.pending", "learning.recorded", "session.compacted", "session.deleted",
] as const

export type WorkflowDomainState = {
  doctor: { state: typeof DOCTOR_STATES[number]; taskPath: string | null }
  role: WorkflowRole
  workerTransaction: { state: typeof WORKER_TRANSACTION_STATES[number]; taskPath: string | null }
  help: { state: typeof HELP_STATES[number]; id: string | null; taskPath: string | null }
  plannerRecovery: { state: typeof PLANNER_RECOVERY_STATES[number]; taskPath: string | null }
  recovery: { state: typeof RECOVERY_STATES[number]; taskPath: string | null }
  failureWindow: { state: typeof FAILURE_WINDOW_STATES[number] }
  boost: { state: typeof BOOST_STATES[number] }
  guardLearning: { state: typeof GUARD_LEARNING_STATES[number] }
  session: { state: typeof SESSION_STATES[number] }
}

export type WorkflowDomainEvent =
  | { type: "planner.task_planned" }
  | { type: "planner.task_registered"; taskPath: string }
  | { type: "executor.task_scheduled"; taskPath: string }
  | { type: "worker.task_started"; taskPath: string }
  | { type: "worker.preflight_passed" }
  | { type: "worker.change_previewed" }
  | { type: "worker.change_applied" }
  | { type: "worker.verification_started" }
  | { type: "worker.verification_passed" }
  | { type: "executor.review_completed" }
  | { type: "worker.help_requested"; id: string }
  | { type: "executor.retry_approved" }
  | { type: "planner.recovery_requested" }
  | { type: "planner.recovery_started" }
  | { type: "planner.recovery_completed" }
  | { type: "recovery.memory_required" }
  | { type: "recovery.harness_required"; taskPath: string }
  | { type: "recovery.completed" }
  | { type: "failure.recorded"; terminal: boolean }
  | { type: "failure.cleared" }
  | { type: "boost.activated" }
  | { type: "boost.exhausted" }
  | { type: "learning.pending" }
  | { type: "learning.recorded" }
  | { type: "session.compacted" }
  | { type: "session.deleted" }

export type WorkflowDomainTransition = {
  state: WorkflowDomainState
  diagnostics: string[]
}

export function transitionWorkflowDomainState(current: WorkflowDomainState, event: WorkflowDomainEvent): WorkflowDomainTransition {
  const next = structuredClone(current)
  const taskPath = next.doctor.taskPath
  if (event.type === "planner.task_registered") next.doctor = { state: "registered", taskPath: event.taskPath }
  if (event.type === "executor.task_scheduled") next.doctor = { state: "ready", taskPath: event.taskPath }
  if (event.type === "worker.task_started") {
    next.role = "worker"
    next.doctor = { state: "started", taskPath: event.taskPath }
    next.workerTransaction = { state: "idle", taskPath: null }
  }
  if (event.type === "worker.preflight_passed") next.workerTransaction = { state: "preflighted", taskPath }
  if (event.type === "worker.change_previewed") next.workerTransaction = { state: "previewed", taskPath }
  if (event.type === "worker.change_applied") next.workerTransaction = { state: "applied", taskPath }
  if (event.type === "worker.verification_started") next.workerTransaction = { state: "verifying", taskPath }
  if (event.type === "worker.verification_passed") {
    next.doctor = { state: "passed", taskPath }
    next.workerTransaction = { state: "reviewable", taskPath }
  }
  if (event.type === "executor.review_completed") {
    next.role = "executor"
    next.doctor = { state: "completed", taskPath: null }
    next.workerTransaction = { state: "idle", taskPath: null }
    next.help = { state: "none", id: null, taskPath: null }
  }
  if (event.type === "worker.help_requested") {
    next.help = { state: "pending", id: event.id, taskPath }
    next.workerTransaction = { state: "blocked", taskPath }
  }
  if (event.type === "executor.retry_approved") next.help.state = "retry_approved"
  if (event.type === "planner.recovery_requested") next.plannerRecovery = { state: "requested", taskPath }
  if (event.type === "planner.recovery_started") next.plannerRecovery.state = "active"
  if (event.type === "planner.recovery_completed") next.plannerRecovery = { state: "complete", taskPath: null }
  if (event.type === "recovery.memory_required") next.recovery = { state: "memory", taskPath: null }
  if (event.type === "recovery.harness_required") next.recovery = { state: "harness", taskPath: event.taskPath }
  if (event.type === "recovery.completed") next.recovery = { state: "none", taskPath: null }
  if (event.type === "failure.recorded") next.failureWindow.state = event.terminal ? "terminal" : "retryable"
  if (event.type === "failure.cleared") next.failureWindow.state = "clear"
  if (event.type === "boost.activated") next.boost.state = "active"
  if (event.type === "boost.exhausted") next.boost.state = "exhausted"
  if (event.type === "learning.pending") next.guardLearning.state = "pending"
  if (event.type === "learning.recorded") next.guardLearning.state = "clear"
  if (event.type === "session.compacted") next.session.state = "compacted"
  if (event.type === "session.deleted") {
    next.session.state = "deleted"
    next.workerTransaction = { state: "idle", taskPath: null }
    next.guardLearning.state = "clear"
    next.boost.state = "disabled"
  }
  const transitionDiagnostics = transitionPrerequisiteDiagnostics(current, event)
  return { state: next, diagnostics: [...transitionDiagnostics, ...validateWorkflowDomainState(next)] }
}

export function validateWorkflowDomainState(value: WorkflowDomainState): string[] {
  const diagnostics: string[] = []
  const taskRequired = !["none", "completed"].includes(value.doctor.state)
  if (taskRequired !== Boolean(value.doctor.taskPath)) diagnostics.push("Doctor task path does not match Doctor state")
  if (value.workerTransaction.state !== "idle" && !value.workerTransaction.taskPath) diagnostics.push("Worker transaction has no task path")
  if (value.workerTransaction.taskPath && value.doctor.taskPath && value.workerTransaction.taskPath !== value.doctor.taskPath) {
    diagnostics.push("Worker transaction task differs from Doctor task")
  }
  if (["preflighted", "previewed", "applied", "verifying"].includes(value.workerTransaction.state) && value.doctor.state !== "started") {
    diagnostics.push("Worker transaction requires a started Doctor task")
  }
  if (value.workerTransaction.state === "reviewable" && value.doctor.state !== "passed") {
    diagnostics.push("Reviewable Worker transaction requires a passed Doctor task")
  }
  if (value.help.state === "none" && (value.help.id || value.help.taskPath)) diagnostics.push("Absent Help contains identifiers")
  if (value.help.state !== "none" && (!value.help.id || !value.help.taskPath)) diagnostics.push("Active Help lacks identifiers")
  if (value.plannerRecovery.state !== "none" && value.plannerRecovery.state !== "complete" && !value.plannerRecovery.taskPath) {
    diagnostics.push("Planner recovery lacks a task path")
  }
  if (value.recovery.state === "harness" && !value.recovery.taskPath) diagnostics.push("Harness recovery lacks a task path")
  if (value.recovery.state !== "harness" && value.recovery.taskPath) diagnostics.push("Non-harness recovery contains a task path")
  if (value.session.state === "deleted" && value.workerTransaction.state !== "idle") diagnostics.push("Deleted session contains Worker transaction state")
  if (value.session.state === "deleted" && value.guardLearning.state !== "clear") diagnostics.push("Deleted session contains Guard learning state")
  if (value.boost.state === "active" && (value.role !== "worker" || value.session.state !== "active")) {
    diagnostics.push("Active boost requires an active Worker session")
  }
  return diagnostics
}

function transitionPrerequisiteDiagnostics(current: WorkflowDomainState, event: WorkflowDomainEvent): string[] {
  const workerStarted = current.doctor.state === "started" && current.role === "worker"
  if (["worker.preflight_passed", "worker.help_requested"].includes(event.type) && !workerStarted) return [`${event.type} requires a started Worker task`]
  if (event.type === "worker.change_previewed" && current.workerTransaction.state !== "preflighted") return ["Preview requires passed preflight"]
  if (event.type === "worker.change_applied" && current.workerTransaction.state !== "previewed") return ["Apply requires a preview"]
  if (event.type === "worker.verification_started" && current.workerTransaction.state !== "applied") return ["Verification requires Apply"]
  if (event.type === "worker.verification_passed" && current.workerTransaction.state !== "verifying") return ["Verification pass requires active verification"]
  if (event.type === "executor.review_completed" && (current.doctor.state !== "passed" || current.workerTransaction.state !== "reviewable")) return ["Review completion requires REVIEWABLE PASS"]
  if (event.type === "executor.retry_approved" && current.help.state !== "pending") return ["Retry approval requires pending Help"]
  if (event.type === "planner.recovery_started" && current.plannerRecovery.state !== "requested") return ["Planner recovery start requires a request"]
  if (event.type === "planner.recovery_completed" && current.plannerRecovery.state !== "active") return ["Planner recovery completion requires active recovery"]
  if (event.type === "boost.activated" && (current.role !== "worker" || current.session.state !== "active")) return ["Boost requires an active Worker session"]
  return []
}

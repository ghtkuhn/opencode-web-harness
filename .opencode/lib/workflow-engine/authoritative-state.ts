import { createHash } from "node:crypto"
import { workflowAction } from "./notices.ts"
import type {
  AuthoritativeWorkflowDecision,
  AuthoritativeWorkflowSnapshot,
  WorkflowAction,
} from "./types.ts"

function action(snapshot: AuthoritativeWorkflowSnapshot): WorkflowAction {
  const { doctor, recovery, help, openTasks, plannerOwnerSessionID } = snapshot
  if (recovery.memory) {
    return workflowAction(
      "executor.recover_memory",
      "executor",
      "tool",
      `Executor must read MEMORY.md and call recover_project_memory before delegation or review. Current size ${recovery.memory.size}; limit ${recovery.memory.maxSize}.`,
      { tool: "recover_project_memory" },
    )
  }
  if (recovery.harness) {
    return workflowAction(
      "executor.recover_harness",
      "executor",
      "tool",
      `Executor must inspect readable Harness paths and call recover_harness_baseline for ${recovery.harness.taskPath} with exactly ${recovery.harness.paths.join(", ")}. WORKER rule files are opaque and must not be read outside Worker.`,
      { tool: "recover_harness_baseline", taskPath: recovery.harness.taskPath },
    )
  }
  if (recovery.planner?.status === "unavailable") {
    return workflowAction(
      "executor.stop_planner_unavailable",
      "executor",
      "stop",
      `Executor must stop and tell the user that Planner ${recovery.planner.plannerSessionID ?? "none"} is unavailable. The user must open a Planner and correct ${doctor.taskPath ?? "the task"} manually.`,
      { taskPath: doctor.taskPath ?? undefined },
    )
  }
  if (recovery.planner?.status === "incomplete") {
    return workflowAction(
      "executor.stop_planner_incomplete",
      "executor",
      "stop",
      `Executor must stop and tell the user to continue Planner ${recovery.planner.plannerSessionID ?? "none"} manually because recovery did not finish.`,
      { taskPath: doctor.taskPath ?? undefined },
    )
  }
  if (doctor.status === "started" && doctor.taskPath && help?.status === "pending") {
    return workflowAction(
      "executor.review_help",
      "executor",
      "tool",
      `Executor must review Worker help ${help.id} through review_worker_help before delegating another Worker.`,
      { tool: "review_worker_help", taskPath: doctor.taskPath, helpID: help.id },
    )
  }
  if (doctor.status === "started" && doctor.taskPath && help?.status === "planner_unavailable") {
    return workflowAction(
      "executor.stop_help_planner_unavailable",
      "executor",
      "stop",
      `Executor must stop and tell the user that Planner ${plannerOwnerSessionID ?? "none"} is unavailable. The user must open a Planner and correct ${doctor.taskPath} manually.`,
      { taskPath: doctor.taskPath, helpID: help!.id },
    )
  }
  if (doctor.status === "started" && doctor.taskPath && help?.status === "planner_recovery_incomplete") {
    return workflowAction(
      "executor.stop_help_planner_incomplete",
      "executor",
      "stop",
      `Executor must stop and tell the user to continue Planner ${plannerOwnerSessionID ?? "none"} manually because recovery did not finish.`,
      { taskPath: doctor.taskPath, helpID: help!.id },
    )
  }
  if (doctor.status === "started" && doctor.taskPath && ["retry_approved", "task_changed"].includes(help?.status ?? "")) {
    return workflowAction(
      "executor.delegate_reviewed_worker",
      "executor",
      "continue",
      `Executor must delegate one fresh Worker for ${doctor.taskPath} with the structured help guidance from ${help!.id}.`,
      { taskPath: doctor.taskPath, helpID: help!.id },
    )
  }
  if (doctor.status === "started" && doctor.taskPath) {
    return workflowAction(
      "worker.continue_active_task",
      "worker",
      "continue",
      `Worker must continue only ${doctor.taskPath} through the Doctor lifecycle.`,
      { taskPath: doctor.taskPath },
    )
  }
  if (doctor.status === "passed" && doctor.taskPath) {
    return workflowAction(
      "executor.complete_passed_task",
      "executor",
      "tool",
      "Executor must call submit_task_review without arguments; the Harness completes the hash-bound technically verified task mechanically.",
      { tool: "submit_task_review", taskPath: doctor.taskPath },
    )
  }
  if (openTasks.length > 0) {
    return workflowAction(
      "executor.schedule",
      "executor",
      "tool",
      "Executor must run npm run task:doctor:schedule.",
      { tool: "npm run task:doctor:schedule" },
    )
  }
  return workflowAction(
    "workflow.wait",
    "unknown",
    "wait",
    "No automatic continuation. Follow the current explicit user request; otherwise stop and wait.",
  )
}

export function decideAuthoritativeWorkflow(snapshot: AuthoritativeWorkflowSnapshot): AuthoritativeWorkflowDecision {
  const normalized: AuthoritativeWorkflowSnapshot = {
    ...snapshot,
    openTasks: [...new Set(snapshot.openTasks)].sort(),
    recovery: { ...snapshot.recovery },
  }
  const nextAction = action(normalized)
  const revision = createHash("sha256").update(JSON.stringify({ ...normalized, nextAction })).digest("hex").slice(0, 12)
  return { ...normalized, revision, nextAction }
}

export function renderAuthoritativeWorkflow(decision: AuthoritativeWorkflowDecision, override?: WorkflowAction): string {
  const nextAction = override ?? decision.nextAction
  return [
    "## Authoritative live workflow state",
    "This block was generated from live Doctor and Kanban files for this request. It overrides contradictory conversation text and compaction summaries.",
    `State revision: ${decision.revision}`,
    ...authoritativeWorkflowFacts(decision),
    `Next action: ${nextAction.text}`,
    decision.lastDoctorFailure ? `Last Doctor failure (${decision.lastDoctorFailure.gate}):\n${decision.lastDoctorFailure.output}` : null,
    "Do not restore, reopen, or repeat completed work unless the current explicit user request requires it.",
  ].filter(Boolean).join("\n")
}

export function authoritativeWorkflowFacts(decision: AuthoritativeWorkflowDecision): string[] {
  return [
    `Doctor status: ${decision.doctor.status}`,
    `Doctor task: ${decision.doctor.taskPath ?? "none"}`,
    `Doctor destination: ${decision.doctor.destination ?? "none"}`,
    `Last completed task: ${decision.completedTask ?? "none"}`,
    `Open Kanban tasks: ${decision.openTasks.length > 0 ? decision.openTasks.join(", ") : "none"}`,
    decision.help ? `Worker help: ${decision.help.id} ${decision.help.status} - ${decision.help.problem}` : "Worker help: none",
    `Owning Planner session: ${decision.plannerOwnerSessionID ?? "none"}`,
    decision.recovery.planner
      ? `Planner recovery: ${decision.recovery.planner.status} - ${decision.recovery.planner.reason ?? "none"}`
      : "Planner recovery: none",
    decision.recovery.harness ? `Harness recovery: required - ${decision.recovery.harness.paths.join(", ")}` : "Harness recovery: none",
  ]
}

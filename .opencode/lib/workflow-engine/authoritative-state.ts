import { createHash } from "node:crypto"
import { workflowAction } from "./notices.ts"
import type {
  AuthoritativeWorkflowDecision,
  AuthoritativeWorkflowSnapshot,
  WorkflowAction,
} from "./types.ts"

function action(snapshot: AuthoritativeWorkflowSnapshot): WorkflowAction {
  const { role, doctor, recovery, help, openTasks, plannerOwnerSessionID } = snapshot
  const wait = (code = "workflow.wait", text = role === "unknown"
    ? "No automatic continuation. Follow the current explicit user request; otherwise stop and wait."
    : `${role.slice(0, 1).toUpperCase()}${role.slice(1)} must follow the explicit user request or wait.`) => workflowAction(
      code,
      role,
      "wait",
      text,
      { taskPath: doctor.taskPath ?? undefined, helpID: help?.id },
    )
  const executorOnly = (executorAction: WorkflowAction, code: string, text: string) => {
    if (role === "executor" || role === "unknown") return executorAction
    if (role === "worker") {
      return workflowAction(code, "worker", "return", "Worker must return BLOCKED with Required owner: Executor and stop.", {
        taskPath: doctor.taskPath ?? undefined,
        helpID: help?.id,
      })
    }
    return wait(code, text)
  }
  if (recovery.memory) {
    return executorOnly(workflowAction(
      "executor.recover_memory",
      "executor",
      "tool",
      `Executor must read MEMORY.md and call recover_project_memory before delegation or review. Current size ${recovery.memory.size}; limit ${recovery.memory.maxSize}.`,
      { tool: "recover_project_memory" },
    ), "planner.wait_memory_recovery", "Planner must leave project-memory recovery to Executor and wait.")
  }
  if (recovery.harness) {
    return executorOnly(workflowAction(
      "executor.recover_harness",
      "executor",
      "tool",
      `Executor must call recover_harness_baseline for ${recovery.harness.taskPath}. The Harness supplies these exact paths: ${recovery.harness.paths.join(", ")}.`,
      { tool: "recover_harness_baseline", taskPath: recovery.harness.taskPath },
    ), "planner.wait_harness_recovery", "Planner must leave Harness recovery to Executor and wait.")
  }
  if (recovery.planner?.status === "unavailable") {
    return executorOnly(workflowAction(
      "executor.stop_planner_unavailable",
      "executor",
      "stop",
      `Executor must stop and tell the user that Planner ${recovery.planner.plannerSessionID ?? "none"} is unavailable. The user must open a Planner and correct ${doctor.taskPath ?? "the task"} manually.`,
      { taskPath: doctor.taskPath ?? undefined },
    ), "planner.wait_unavailable_recovery", "Planner must follow the explicit user request or wait.")
  }
  if (recovery.planner?.status === "incomplete") {
    return executorOnly(workflowAction(
      "executor.stop_planner_incomplete",
      "executor",
      "stop",
      `Executor must stop and tell the user to continue Planner ${recovery.planner.plannerSessionID ?? "none"} manually because recovery did not finish.`,
      { taskPath: doctor.taskPath ?? undefined },
    ), "planner.wait_incomplete_recovery", "Planner must follow the explicit user request or wait.")
  }
  if (snapshot.requestedOperation && (role === "planner" || role === "executor")) {
    const label = `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`
    return workflowAction(
      "project.run_requested_operation",
      role,
      "tool",
      `${label} must run ${snapshot.requestedOperation}.`,
      { tool: snapshot.requestedOperation },
    )
  }
  if (doctor.status === "started" && doctor.taskPath && help?.status === "pending") {
    return executorOnly(workflowAction(
      "executor.review_help",
      "executor",
      "tool",
      `Executor must review Worker help ${help.id} through review_worker_help before delegating another Worker.`,
      { tool: "review_worker_help", taskPath: doctor.taskPath, helpID: help.id },
    ), "planner.wait_pending_help", "Planner must not intercept pending Worker help unless the user requests task revision.")
  }
  if (doctor.status === "started" && doctor.taskPath && help?.status === "planner_unavailable") {
    return executorOnly(workflowAction(
      "executor.stop_help_planner_unavailable",
      "executor",
      "stop",
      `Executor must stop and tell the user that Planner ${plannerOwnerSessionID ?? "none"} is unavailable. The user must open a Planner and correct ${doctor.taskPath} manually.`,
      { taskPath: doctor.taskPath, helpID: help!.id },
    ), "planner.wait_help_owner", "Planner must follow the explicit user request or wait.")
  }
  if (doctor.status === "started" && doctor.taskPath && help?.status === "planner_recovery_incomplete") {
    return executorOnly(workflowAction(
      "executor.stop_help_planner_incomplete",
      "executor",
      "stop",
      `Executor must stop and tell the user to continue Planner ${plannerOwnerSessionID ?? "none"} manually because recovery did not finish.`,
      { taskPath: doctor.taskPath, helpID: help!.id },
    ), "planner.wait_help_recovery", "Planner must follow the explicit user request or wait.")
  }
  if (doctor.status === "started" && doctor.taskPath && ["retry_approved", "task_changed"].includes(help?.status ?? "")) {
    return executorOnly(workflowAction(
      "executor.delegate_reviewed_worker",
      "executor",
      "tool",
      `Executor must delegate one fresh Worker for ${doctor.taskPath} with the structured help guidance from ${help!.id}.`,
      { tool: "task", taskPath: doctor.taskPath, helpID: help!.id },
    ), "planner.wait_reviewed_help", "Planner must not delegate the reviewed Worker retry.")
  }
  if (doctor.status === "started" && doctor.taskPath && help?.status === "delegated" && help.delegation) {
    if (role === "executor" || role === "unknown") {
      if (help.delegation.phase === "reviewable") {
        return workflowAction(
          "executor.consume_recovered_handoff",
          "executor",
          "continue",
          `Executor must consume the recovered Worker handoff for ${doctor.taskPath} without starting another Worker.`,
          { taskPath: doctor.taskPath, helpID: help.id },
        )
      }
      if (help.delegation.phase === "launching") {
        return workflowAction(
          "executor.wait_delegation_binding",
          "executor",
          "wait",
          `Executor must wait for the in-flight Worker delegation for ${doctor.taskPath} to bind.`,
          { taskPath: doctor.taskPath, helpID: help.id },
        )
      }
      return workflowAction(
        "executor.resume_delegated_worker",
        "executor",
        "tool",
        `Executor must resume the Worker bound to ${doctor.taskPath}; the Harness supplies its session selector.`,
        { tool: "task", taskPath: doctor.taskPath, helpID: help.id },
      )
    }
    if (role === "planner") return wait("planner.wait_delegated_worker", "Planner must follow the explicit user request or wait while Executor owns the Worker delegation.")
  }
  if (doctor.status === "started" && doctor.taskPath) {
    if (role === "worker" || role === "unknown") return workflowAction(
        "worker.continue_active_task",
        "worker",
        "continue",
        `Worker must continue only ${doctor.taskPath} through the Doctor lifecycle.`,
        { taskPath: doctor.taskPath },
      )
    if (role === "executor") return workflowAction(
      "executor.delegate_active_worker",
      "executor",
      "tool",
      `Executor must delegate one Worker for active task ${doctor.taskPath}.`,
      { tool: "task", taskPath: doctor.taskPath },
    )
    return wait("planner.wait_active_task", "Planner must follow the explicit user request; Executor owns the active task lifecycle.")
  }
  if (doctor.status === "passed" && doctor.taskPath) {
    if (role === "worker") return workflowAction(
      "worker.return_reviewable",
      "worker",
      "return",
      `Worker must return the canonical REVIEWABLE handoff for ${doctor.taskPath}.`,
      { taskPath: doctor.taskPath },
    )
    if (role === "planner") return wait("planner.wait_passed_task", "Planner must leave the technically passed task to Executor review.")
    return workflowAction(
      "executor.complete_passed_task",
      "executor",
      "tool",
      "Executor must call submit_task_review without arguments; the Harness completes the hash-bound technically verified task mechanically.",
      { tool: "submit_task_review", taskPath: doctor.taskPath },
    )
  }
  if (openTasks.length > 0 && (role === "executor" || role === "unknown")) {
    return workflowAction(
      "executor.schedule",
      "executor",
      "tool",
      "Executor must run npm run task:doctor:schedule.",
      { tool: "npm run task:doctor:schedule" },
    )
  }
  return wait()
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

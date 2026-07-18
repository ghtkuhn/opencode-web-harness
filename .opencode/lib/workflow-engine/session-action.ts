import { workflowAction } from "./notices.ts"
import type { WorkflowAction, WorkflowRole } from "./types.ts"

export type SessionActionInput = {
  role: WorkflowRole
  doctorStatus: string
  deterministicRecoveryPending: boolean
  terminalExecutorReason?: string | null
  activePlannerRecovery?: {
    lifecycle: "active" | "prestart"
    taskPath: string
    exactContract: boolean
    supersedeTasks: string[]
    supersededTasks: string[]
  } | null
  pendingHelpReviewID?: string | null
  requestedHelpReReviewID?: string | null
  plannerRecoveryRequest?: { taskPath: string; frozen: boolean } | null
  scheduledReadyTask?: string | null
  executorScheduleRequired: boolean
}

export function decideSessionAction(input: SessionActionInput): WorkflowAction | null {
  if (input.deterministicRecoveryPending) return null
  const recoveryAction = plannerRecoveryAction(input.activePlannerRecovery)
  if (recoveryAction) return recoveryAction
  if (input.terminalExecutorReason) {
    return workflowAction(
      "executor.terminal_stop",
      "executor",
      "stop",
      `Executor must stop. ${input.terminalExecutorReason}`,
    )
  }
  if (input.pendingHelpReviewID) {
    return workflowAction(
      "executor.rereview_help",
      "executor",
      "tool",
      `Executor must call review_worker_help for ${input.pendingHelpReviewID} again now because newer full-file evidence is loaded. Do not delegate Worker.`,
      { tool: "review_worker_help", helpID: input.pendingHelpReviewID },
    )
  }
  if (input.requestedHelpReReviewID) {
    return workflowAction(
      "executor.requested_help_review",
      "executor",
      "tool",
      `Executor must re-review Worker help ${input.requestedHelpReReviewID} through review_worker_help now. Do not delegate Worker.`,
      { tool: "review_worker_help", helpID: input.requestedHelpReReviewID },
    )
  }
  if (input.plannerRecoveryRequest) {
    const suffix = input.plannerRecoveryRequest.frozen
      ? "with only task_path; the pending receipt restores all other fields mechanically"
      : "with file-backed evidence and the exact recovery contract"
    return workflowAction(
      "executor.escalate_planner",
      "executor",
      "tool",
      `Executor must call escalate_to_planner for ${input.plannerRecoveryRequest.taskPath} ${suffix}. Do not schedule or delegate until it completes.`,
      { tool: "escalate_to_planner", taskPath: input.plannerRecoveryRequest.taskPath },
    )
  }
  if (input.role === "executor" && input.scheduledReadyTask) {
    return workflowAction(
      "executor.delegate_ready",
      "executor",
      "continue",
      `Executor must delegate ${input.scheduledReadyTask} now. Do not inspect or schedule.`,
      { taskPath: input.scheduledReadyTask },
    )
  }
  if (input.role === "executor" && input.executorScheduleRequired) {
    return workflowAction(
      "executor.schedule_once",
      "executor",
      "tool",
      "Executor must run npm run task:doctor:schedule.",
      { tool: "npm run task:doctor:schedule" },
    )
  }
  if (input.role === "worker" && !["started", "passed"].includes(input.doctorStatus)) {
    return workflowAction(
      "worker.follow_prompt",
      "worker",
      "continue",
      "Worker must follow its exact task prompt; never schedule.",
    )
  }
  return null
}

function plannerRecoveryAction(input: SessionActionInput["activePlannerRecovery"]): WorkflowAction | null {
  if (!input) return null
  if (input.lifecycle === "prestart") {
    return workflowAction(
      "planner.finish_prestart_recovery",
      "planner",
      "continue",
      `Planner must correct the task definition for ${input.taskPath} without implementing or delegating.`,
      { taskPath: input.taskPath },
    )
  }
  const outstanding = input.supersedeTasks.find((path) => !input.supersededTasks.includes(path))
  if (outstanding) {
    return workflowAction(
      "planner.supersede_recovery_task",
      "planner",
      "tool",
      `Planner must call supersede_registered_task now for ${outstanding}. Do not inspect, implement, or delegate.`,
      { tool: "supersede_registered_task", taskPath: outstanding },
    )
  }
  return workflowAction(
    "planner.revise_recovery_task",
    "planner",
    "tool",
    input.exactContract
      ? `Planner must call revise_active_task now for ${input.taskPath} with only task_path and one concise reason. The trusted tool holds the exact contract.`
      : `Planner must call revise_active_task now for ${input.taskPath} with the structured additions from the active recovery request.`,
    { tool: "revise_active_task", taskPath: input.taskPath },
  )
}

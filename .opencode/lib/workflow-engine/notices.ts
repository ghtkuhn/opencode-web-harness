import type { GuardNotice, WorkflowAction, WorkflowRole } from "./types.ts"

const roleVerbs: Record<Exclude<WorkflowRole, "unknown">, RegExp> = {
  planner: /\b(?:Planner|plan|register|revise|supersede|schedule|stop|wait)\b/i,
  executor: /\b(?:Executor|schedule|delegate|review|complete|recover|stop|wait)\b/i,
  worker: /\b(?:Worker|continue|read|preview|apply|discard|verify|return|implement|stop|wait)\b/i,
}

export function workflowAction(
  code: string,
  role: WorkflowRole,
  kind: WorkflowAction["kind"],
  text: string,
  options: Pick<WorkflowAction, "tool" | "taskPath"> = {},
): WorkflowAction {
  const action = { code, role, kind, text: text.trim(), ...options }
  const errors = validateWorkflowAction(action)
  if (errors.length > 0) throw new Error(`Invalid workflow action ${code}: ${errors.join("; ")}`)
  return action
}

export function validateWorkflowAction(action: WorkflowAction): string[] {
  const errors: string[] = []
  if (!action.code.trim()) errors.push("code is empty")
  if (!action.text.trim()) errors.push("text is empty")
  if (action.kind === "tool" && !action.tool) errors.push("tool action has no tool")
  if (action.kind !== "tool" && action.tool) errors.push("non-tool action declares a tool")
  if (action.role !== "unknown" && !roleVerbs[action.role].test(action.text)) {
    errors.push(`text does not identify a ${action.role} action`)
  }
  return errors
}

export function guardNotice(
  code: string,
  problem: string,
  action: WorkflowAction,
  options: Pick<GuardNotice, "success" | "learning"> = {},
): GuardNotice {
  const notice = { code, problem: problem.trim(), action, ...options }
  const errors = validateGuardNotice(notice)
  if (errors.length > 0) throw new Error(`Invalid guard notice ${code}: ${errors.join("; ")}`)
  return notice
}

export function validateGuardNotice(notice: GuardNotice): string[] {
  const errors = validateWorkflowAction(notice.action)
  if (!notice.problem.trim()) errors.push("problem is empty")
  if (notice.success !== undefined && !notice.success.trim()) errors.push("success is empty")
  return errors
}

export function renderGuardNotice(notice: GuardNotice): string {
  const learning = notice.learning
  const learningStatus = learning?.status === "already" ? "ALREADY_LEARNED" : learning?.status.toUpperCase()
  return [
    "WORKFLOW GUARD BLOCKED",
    learning ? `Guard learning ID: ${learning.id}` : null,
    learning ? `LEARNING_STATUS: ${learningStatus}` : null,
    `Problem: ${notice.problem}`,
    learning?.rule ? `Learned rule: ${learning.rule}` : null,
    learning?.status === "already" ? "Do not record this learning again." : null,
    `Do next: ${notice.action.text}`,
    notice.success ? `Continue only after: ${notice.success}` : null,
  ].filter(Boolean).join("\n")
}

export type WorkflowGuardMessageInput = {
  feedback?: string | null
  learningActions?: Array<{ id: string; action: string }>
  liveState?: string | null
  checkpoint?: unknown
}

export function renderWorkflowGuardMessage(input: WorkflowGuardMessageInput): string | null {
  const learningActions = input.learningActions ?? []
  if (!input.feedback && !input.liveState && input.checkpoint == null && learningActions.length === 0) return null
  return [
    "## Workflow guard state",
    "This synthetic message contains live workflow state, not a new user request.",
    input.feedback ? `Latest blocking feedback:\n${input.feedback}` : null,
    learningActions.length > 0
      ? `Record these Guard learnings before other work:\n${learningActions.map(({ id, action }) => `${id}: ${action}`).join("\n")}`
      : null,
    input.liveState ?? (input.checkpoint == null ? null : `Latest checkpoint:\n${JSON.stringify(input.checkpoint)}`),
  ].filter(Boolean).join("\n\n")
}

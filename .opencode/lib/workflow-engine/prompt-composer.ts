import { validateWorkflowAction, workflowAction } from "./notices.ts"
import type {
  ComposedWorkflowPrompt,
  DirectivePriority,
  PromptFrame,
  WorkflowAction,
  WorkflowDirective,
  WorkflowRole,
} from "./types.ts"

const roleToolRules: Record<Exclude<WorkflowRole, "unknown">, {
  allowed: RegExp
  forbidden: RegExp
}> = {
  planner: {
    allowed: /^(?:register_planner_task|revise_active_task|supersede_registered_task|npm run task:doctor:next)$/,
    forbidden: /^(?:task|submit_task_review|review_worker_help|escalate_to_planner|recover_|preview_worker_changes|apply_worker_changes|verify_worker_task)/,
  },
  executor: {
    allowed: /^(?:task|submit_task_review|review_worker_help|escalate_to_planner|recover_project_memory|recover_harness_baseline|npm run task:doctor:schedule)$/,
    forbidden: /^(?:register_planner_task|revise_active_task|supersede_registered_task|preview_worker_changes|apply_worker_changes|verify_worker_task|npm run task:doctor:(?:lint|register|start|verify|complete))$/,
  },
  worker: {
    allowed: /^(?:append_task_memory|preview_worker_changes|apply_worker_changes|discard_worker_changes|verify_worker_task|request_executor_help|request_task_change_permission|request_command_permission|request_dependency_install_permission|npm run task:doctor:(?:lint|register|start|verify|whitelist|test-file))$/,
    forbidden: /^(?:task|submit_task_review|review_worker_help|escalate_to_planner|recover_|register_planner_task|revise_active_task|supersede_registered_task|npm run task:doctor:(?:next|schedule|complete))$/,
  },
}

const priorityOrder: Record<DirectivePriority, number> = {
  recovery: 7,
  terminal: 6,
  help: 5,
  review: 4,
  active: 3,
  schedule: 2,
  idle: 1,
}

export function workflowDirective(
  action: WorkflowAction,
  options: {
    priority: DirectivePriority
    precedence?: number
    terminal?: boolean
    requires?: string[]
    forbids?: string[]
    after?: WorkflowAction
  },
): WorkflowDirective {
  const directive: WorkflowDirective = {
    ...action,
    priority: options.priority,
    precedence: options.precedence,
    terminal: options.terminal ?? (action.kind === "stop" || action.kind === "return"),
    requires: options.requires,
    forbids: options.forbids,
    after: options.after,
  }
  const diagnostics = validateWorkflowDirective(directive)
  if (diagnostics.length > 0) throw new Error(`Invalid workflow directive ${action.code}: ${diagnostics.join("; ")}`)
  return directive
}

export function directiveFromAction(action: WorkflowAction): WorkflowDirective {
  return workflowDirective(action, {
    priority: inferredPriority(action),
    terminal: action.kind === "stop" || action.kind === "return",
    after: scheduleFollowUp(action),
  })
}

export function selectWorkflowDirective(...directives: Array<WorkflowDirective | null | undefined>): WorkflowDirective | null {
  return directives.filter((value): value is WorkflowDirective => Boolean(value)).reduce<WorkflowDirective | null>((selected, candidate) => {
    if (!selected) return candidate
    const priority = priorityOrder[candidate.priority] - priorityOrder[selected.priority]
    if (priority > 0) return candidate
    if (priority < 0) return selected
    return (candidate.precedence ?? 0) >= (selected.precedence ?? 0) ? candidate : selected
  }, null)
}

export function validateWorkflowDirective(directive: WorkflowDirective): string[] {
  const diagnostics = validateWorkflowAction(directive)
  if (directive.terminal && !["stop", "return"].includes(directive.kind)) {
    diagnostics.push("terminal directive must stop or return")
  }
  if (!directive.terminal && ["stop", "return"].includes(directive.kind)) {
    diagnostics.push("stop or return directive must be terminal")
  }
  if (directive.tool && directive.forbids?.includes(directive.tool)) {
    diagnostics.push(`tool ${directive.tool} is both required and forbidden`)
  }
  if (directive.terminal && directive.after) diagnostics.push("terminal directive cannot have a follow-up action")
  if (directive.after) {
    diagnostics.push(...validateWorkflowAction(directive.after).map((value) => `follow-up: ${value}`))
    diagnostics.push(...roleCapabilityDiagnostics(directive.after).map((value) => `follow-up: ${value}`))
  }
  diagnostics.push(...roleCapabilityDiagnostics(directive))
  return diagnostics
}

export function roleCapabilityDiagnostics(action: WorkflowAction): string[] {
  if (!action.tool || action.role === "unknown") return []
  if (action.role === "planner" && /^planner\.prestart_recovery\./.test(action.code)
    && /^npm run task:doctor:(?:lint|register)$/.test(action.tool)) return []
  const rules = roleToolRules[action.role]
  if (rules.forbidden.test(action.tool)) return [`${action.role} cannot use ${action.tool}`]
  if (knownWorkflowTool(action.tool) && !rules.allowed.test(action.tool)) {
    return [`${action.role} has no capability for ${action.tool}`]
  }
  return []
}

export function composeWorkflowPrompt(frame: PromptFrame): ComposedWorkflowPrompt {
  const diagnostics: string[] = []
  const primary = frame.directive.role === "unknown" && frame.role !== "unknown"
    ? { ...frame.directive, role: frame.role }
    : frame.directive
  diagnostics.push(...validateWorkflowDirective(primary).map((value) => `${primary.code}: ${value}`))
  if (frame.role !== "unknown" && primary.role !== frame.role) {
    diagnostics.push(`primary role ${primary.role} differs from frame role ${frame.role}`)
  }
  const after = primary.terminal ? undefined : primary.after
  if (frame.taskPath && primary.taskPath && frame.taskPath !== primary.taskPath) diagnostics.push("primary task path differs from frame task path")
  if (frame.helpID && primary.helpID && frame.helpID !== primary.helpID) diagnostics.push("primary Help ID differs from frame Help ID")
  if (frame.helpID && primary.priority === "help" && !primary.helpID) diagnostics.push("Help action omits the frame Help ID")
  const actor = `Acting role: ${capitalize(primary.role === "unknown" ? frame.role : primary.role)}`
  const facts = normalizedLines(frame.facts)
  const requirements = normalizedLines(primary.requires ?? []).map((value) => `Prerequisite: ${value}`)
  const constraints = normalizedLines(primary.forbids ?? []).map((value) => `Do not: ${value}`)
  const text = [
    "## Workflow guard state",
    "This is deterministic technical workflow state, not a new user request.",
    frame.revision ? `State revision: ${frame.revision}` : null,
    ...facts,
    frame.evidence ? `Technical evidence (not an additional action):\n${frame.evidence.trim()}` : null,
    actor,
    ...requirements,
    `Next action: ${primary.text}`,
    after ? `After success: ${after.text}` : null,
    ...constraints,
  ].filter(Boolean).join("\n")
  diagnostics.push(...promptTextDiagnostics(text, primary, after))
  return { primary, after, diagnostics: [...new Set(diagnostics)], text }
}

export function promptTextDiagnostics(text: string, primary: WorkflowDirective, after?: WorkflowAction): string[] {
  const diagnostics: string[] = []
  if ((text.match(/^Next action:/gm) ?? []).length !== 1) diagnostics.push("prompt must contain exactly one Next action")
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((value) => value.trim()).filter(Boolean)
  if (new Set(sentences).size !== sentences.length) diagnostics.push("prompt contains duplicate sentences")
  if (primary.terminal && /^After success:/m.test(text)) {
    diagnostics.push("terminal prompt contains a continuation action")
  }
  if (primary.terminal && /^Next action:\s*(?:\w+\s+must\s+)?(?:continue|implement|delegate|schedule|preview|apply)\b/im.test(text)) {
    diagnostics.push("terminal prompt contains a non-terminal primary action")
  }
  if (primary.tool && primary.forbids?.some((value) => value.includes(primary.tool!))) {
    diagnostics.push(`prompt requires and forbids ${primary.tool}`)
  }
  if (after && !/^After success:/m.test(text)) diagnostics.push("follow-up action is not sequenced")
  if (!/[.!?]$/.test(primary.text)) diagnostics.push("primary action is not a complete sentence")
  if (after && !/[.!?]$/.test(after.text)) diagnostics.push("follow-up action is not a complete sentence")
  if (/(?:\band|\bor|\bthen|\bbecause|\bbefore|\bafter)\s*[.:;!?]*$/i.test(primary.text)) diagnostics.push("primary action ends with an incomplete connector")
  return diagnostics
}

function inferredPriority(action: WorkflowAction): DirectivePriority {
  if (/^executor\.recover_(?:memory|harness)$/.test(action.code)) return "recovery"
  if (["stop", "return"].includes(action.kind) || /terminal/.test(action.code)) return "terminal"
  if (/help|escalate|planner\..*recovery/.test(action.code)) return "help"
  if (/review|complete_passed/.test(action.code)) return "review"
  if (/schedule/.test(action.code)) return "schedule"
  if (action.kind === "wait") return "idle"
  return "active"
}

function knownWorkflowTool(tool: string): boolean {
  return /^(?:task|register_planner_task|revise_active_task|supersede_registered_task|submit_task_review|review_worker_help|escalate_to_planner|recover_|append_task_memory|preview_worker_changes|apply_worker_changes|discard_worker_changes|verify_worker_task|request_|npm run task:doctor:)/.test(tool)
}

function scheduleFollowUp(action: WorkflowAction): WorkflowAction | undefined {
  if (action.code === "executor.schedule" || action.code === "executor.schedule_once") {
    return workflowAction(
      `${action.code}.delegate_ready`,
      "executor",
      "continue",
      "Executor must delegate the READY task to Worker.",
    )
  }
  return undefined
}

function normalizedLines(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}

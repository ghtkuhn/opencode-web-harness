import { validateWorkflowAction, workflowAction } from "./notices.ts"
import type {
  ComposedWorkflowPrompt,
  DirectivePriority,
  PromptFrame,
  WorkflowAction,
  WorkflowDirective,
  WorkflowRole,
} from "./types.ts"

const priorityRank: Record<DirectivePriority, number> = {
  recovery: 700,
  terminal: 600,
  help: 500,
  review: 400,
  active: 300,
  schedule: 200,
  idle: 100,
}

const roleToolRules: Record<Exclude<WorkflowRole, "unknown">, {
  allowed: RegExp
  forbidden: RegExp
}> = {
  planner: {
    allowed: /^(?:register_planner_task|revise_active_task|supersede_registered_task|npm run task:doctor:(?:next|schedule))$/,
    forbidden: /^(?:submit_task_review|review_worker_help|escalate_to_planner|recover_|preview_worker_changes|apply_worker_changes|verify_worker_task)/,
  },
  executor: {
    allowed: /^(?:submit_task_review|review_worker_help|escalate_to_planner|recover_project_memory|recover_harness_baseline|npm run task:doctor:schedule)$/,
    forbidden: /^(?:register_planner_task|revise_active_task|supersede_registered_task|preview_worker_changes|apply_worker_changes|verify_worker_task|npm run task:doctor:(?:lint|register|start|verify|complete))$/,
  },
  worker: {
    allowed: /^(?:append_task_memory|preview_worker_changes|apply_worker_changes|discard_worker_changes|verify_worker_task|request_executor_help|request_task_change_permission|request_command_permission|request_dependency_install_permission|npm run task:doctor:(?:lint|register|start|verify|whitelist|test-file))$/,
    forbidden: /^(?:submit_task_review|review_worker_help|escalate_to_planner|recover_|register_planner_task|revise_active_task|supersede_registered_task|npm run task:doctor:(?:next|schedule|complete))$/,
  },
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
  const directives = deduplicateDirectives(frame.directives)
  for (const directive of directives) diagnostics.push(...validateWorkflowDirective(directive).map((value) => `${directive.code}: ${value}`))
  const ordered = [...directives].sort((left, right) => (
    priorityRank[right.priority] - priorityRank[left.priority]
      || (right.precedence ?? 0) - (left.precedence ?? 0)
      || left.code.localeCompare(right.code)
  ))
  const primary = ordered[0] ?? workflowDirective(
    workflowAction("workflow.wait", "unknown", "wait", "Wait for an explicit user request."),
    { priority: "idle" },
  )
  const samePriority = ordered.filter((directive) => directive.priority === primary.priority
    && (directive.precedence ?? 0) === (primary.precedence ?? 0))
  if (samePriority.some((directive) => !equivalentDirective(primary, directive))) {
    diagnostics.push(`multiple primary directives at ${primary.priority}: ${samePriority.map((value) => value.code).join(", ")}`)
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
  return /^(?:register_planner_task|revise_active_task|supersede_registered_task|submit_task_review|review_worker_help|escalate_to_planner|recover_|append_task_memory|preview_worker_changes|apply_worker_changes|discard_worker_changes|verify_worker_task|request_|npm run task:doctor:)/.test(tool)
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
  if (action.code === "planner.schedule_once") {
    return workflowAction(
      "planner.schedule_once.stop",
      "planner",
      "stop",
      "Planner must stop and return the READY result to Executor.",
    )
  }
  return undefined
}

function deduplicateDirectives(values: WorkflowDirective[]): WorkflowDirective[] {
  const unique = new Map<string, WorkflowDirective>()
  for (const value of values) unique.set(JSON.stringify([value.code, value.role, value.kind, value.tool, value.taskPath, value.helpID, value.text]), value)
  return [...unique.values()]
}

function equivalentDirective(left: WorkflowDirective, right: WorkflowDirective): boolean {
  return left.role === right.role && left.kind === right.kind && left.tool === right.tool
    && left.taskPath === right.taskPath && left.helpID === right.helpID && left.text === right.text
}

function normalizedLines(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}

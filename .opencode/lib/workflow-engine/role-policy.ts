export type RolePolicyBlock = {
  code: string
  problem: string
  action: string
  success?: string
}

export type RolePolicyInput = {
  role: "planner" | "executor" | "worker" | "unknown"
  tool: string
  command: string
  writes: boolean
  invocation?: { gate: string; taskPath: string } | null
  plannerDoctor: boolean
  plannerInspection: boolean
  projectOperation: boolean
  plannerWrite: boolean
  plannerExecutionQuestion: boolean
  planningEnforcer: boolean
  planningTaskPath?: string
  activeTask?: { status: string; taskPath: string } | null
  taskChangePermission: boolean
  plannerRecovery?: { lifecycle: "active" | "prestart"; taskPath: string } | null
}

const plannerManifestNames = /^(?:package\.json|project\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?)$/
const implementationExtension = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|vue|svelte|html|css)$/i

export function hasCompletedPlannerDiscoveryPlan(messages: any[], plannerAgents: Set<string>, projectHasImplementation = true) {
  let inventory = false
  let manifest = false
  const implementationFiles = new Set<string>()

  for (const message of messages) {
    const info = message?.info
    const agent = String(info?.agent ?? info?.mode ?? "").toLowerCase()
    if (info?.role !== "assistant" || !plannerAgents.has(agent)) continue
    for (const part of message?.parts ?? []) {
      if (part?.type === "text" && /(?:^|\n)\s*(?:#{1,6}\s*|\*\*)?PLAN\b/i.test(String(part.text ?? ""))) {
        if (info?.time?.completed && info?.finish === "stop"
          && inventory && manifest && (!projectHasImplementation || implementationFiles.size >= 2)) return true
        continue
      }
      if (part?.type !== "tool" || part?.state?.status !== "completed") continue
      const tool = String(part.tool ?? "")
      const input = part.state?.input ?? {}
      if (tool === "glob") inventory = true
      if (tool === "bash" && /^(?:ls|rg\s+--files)(?:\s|$)/.test(String(input.command ?? "").trim())) inventory = true
      if (tool !== "read") continue
      const path = String(input.filePath ?? input.path ?? "").replace(/\\/g, "/")
      const name = path.split("/").pop() ?? ""
      if (plannerManifestNames.test(name)) manifest = true
      if (implementationExtension.test(path)
        && !/(?:^|\/)(?:\.opencode|kanban)(?:\/|$)/.test(path)
        && !/(?:^|\/)(?:AGENTS|CUSTOM|MEMORY|CODEX-INBOX|WORKER[^/]*)\.md$/i.test(path)) {
        implementationFiles.add(path)
      }
    }
  }
  return false
}

export function decideRoleToolPolicy(input: RolePolicyInput): RolePolicyBlock | null {
  if (input.role === "planner") return plannerPolicy(input)
  if (input.role === "executor") return executorPolicy(input)
  if (input.role === "worker" && input.writes && input.planningTaskPath) {
    return {
      code: "worker.task_write",
      problem: "Worker attempted to create or rewrite a Kanban task.",
      action: input.taskChangePermission
        ? "Do not retry the edit. If Doctor lint requires this correction before start, call request_task_change_permission with the exact task path, reason, old text, and new text. The user must approve it. Otherwise stop and report the blocker."
        : "Switch to Planner for task authoring. Worker may only execute an already registered task through Doctor.",
    }
  }
  return null
}

function plannerPolicy(input: RolePolicyInput): RolePolicyBlock | null {
  if (input.plannerExecutionQuestion) {
    return {
      code: "planner.execution_question",
      problem: "Planner attempted to ask whether tasks should be delegated or executed.",
      action: "Do not ask this decision. Report that the registered tasks are ready for Executor, then stop. Only Executor may delegate Worker.",
    }
  }
  if (input.invocation && ["lint", "register"].includes(input.invocation.gate)) {
    if (input.plannerRecovery?.lifecycle === "prestart" && input.invocation.taskPath === input.plannerRecovery.taskPath) return null
    return {
      code: "planner.direct_registration",
      problem: `Planner attempted Doctor ${input.invocation.gate} directly for ${input.invocation.taskPath}.`,
      action: "Call register_planner_task with only title, exact files, concrete done facts, and depends_on only when needed. The trusted tool derives and registers the canonical task atomically.",
      success: `PLANNER TASK REGISTERED ${input.invocation.taskPath}`,
    }
  }
  if (input.invocation && !input.plannerDoctor) {
    return {
      code: "planner.doctor_lifecycle",
      problem: `Planner cannot run Doctor ${input.invocation.gate}.`,
      action: "Use register_planner_task for new tasks and only Doctor next directly. Executor owns schedule. Switch to Worker before start, verify, complete, whitelist, or test-file.",
    }
  }
  if (input.writes) {
    if (input.plannerRecovery?.lifecycle === "prestart" && input.planningTaskPath === input.plannerRecovery.taskPath) return null
    if (input.activeTask?.status === "started" && input.planningTaskPath === input.activeTask.taskPath) {
      return {
        code: "planner.active_task_write",
        problem: `Planner attempted to edit active task ${input.activeTask.taskPath} directly.`,
        action: `Call revise_active_task with ${input.activeTask.taskPath}, the reason, and only the needed structured additions. Omit replacement unless the whole task definition must change.`,
      }
    }
    if (input.planningEnforcer && input.planningTaskPath) {
      return {
        code: "planner.task_file_write",
        problem: `Planner attempted to write task file ${input.planningTaskPath} directly.`,
        action: "Call register_planner_task with only title, exact files, concrete done facts, and depends_on only when needed. It derives canonical task metadata and registers atomically.",
        success: `PLANNER TASK REGISTERED ${input.planningTaskPath}`,
      }
    }
    if (!input.plannerWrite) {
      return {
        code: "planner.outside_write",
        problem: "Planner attempted to change a path outside kanban/todo or MEMORY.md.",
        action: "Stay in Planner mode and write only approved Kanban tasks or durable memory. Switch to Worker before implementation.",
      }
    }
  } else if (input.tool === "bash" && !input.plannerDoctor && !input.plannerInspection && !input.projectOperation) {
    return {
      code: "planner.shell_allowlist",
      problem: "Planner attempted a shell command outside the read-only and fixed app-operation allowlist.",
      action: "Use one read-only command or one allowed project operation without pipes, redirects, chaining, or substitution. Allowed project operations are app lifecycle controls and build. Switch to Worker before implementation.",
    }
  }
  return null
}

function executorPolicy(input: RolePolicyInput): RolePolicyBlock | null {
  if (input.writes) {
    return {
      code: "executor.file_write",
      problem: "Executor attempted to change a file.",
      action: "Delegate implementation to Worker through the task tool. Executor may only inspect results with read-only commands.",
    }
  }
  if (input.invocation) {
    if (input.invocation.gate === "schedule") return null
    return {
      code: "executor.doctor_lifecycle",
      problem: `Executor cannot run Doctor ${input.invocation.gate}.`,
      action: "Executor must delegate the exact registered task to Worker. Worker owns every Doctor lifecycle command except schedule.",
    }
  }
  if (input.tool === "bash" && /^npm\s+run\s+task:doctor:schedule\s*$/.test(input.command)) return null
  if (input.tool === "bash" && !input.plannerDoctor && !input.plannerInspection && !input.projectOperation) {
    return {
      code: "executor.shell_allowlist",
      problem: "Executor attempted a shell command outside the read-only and project-operation allowlist.",
      action: "Executor must use one read-only command, one allowed app lifecycle or build operation, or task:doctor:schedule. Worker owns every other lifecycle command and mutation.",
    }
  }
  return null
}

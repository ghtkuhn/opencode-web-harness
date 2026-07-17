import type { RolePolicyBlock } from "./role-policy.ts"

export type OperationTodo = { content?: unknown; status?: unknown }

export type OperationPolicyInput = {
  role: "planner" | "executor" | "worker" | "unknown"
  tool: string
  internalFileGuard: boolean
  protectedTarget?: string | null
  readOnlyTarget?: string | null
  activeTask?: { status: string; taskPath: string } | null
  firstTodoTask?: string | null
  todoDiscipline: boolean
  todos: OperationTodo[]
  doctorEvidence: string[]
  planningEnforcer: boolean
  newTask?: string | null
  unfinishedTask?: string | null
  taskStartGuard: boolean
  mutation: boolean
  taskGuardExempt: boolean
  firstTaskRegistered: boolean
  outsideScopePath?: string | null
  opaqueInlineWithoutPaths: boolean
  pathlessShellMutation: boolean
  userPermissionEscalation: boolean
  transactionalWorkerChanges: boolean
}

export function decideOperationPolicy(input: OperationPolicyInput): RolePolicyBlock | null {
  const active = input.activeTask ?? null
  const task = input.firstTodoTask ?? "kanban/todo/<task>.md"

  if (input.internalFileGuard && input.protectedTarget) {
    return {
      code: "operation.protected_path",
      problem: `${input.protectedTarget} is an internal workflow path and cannot be inspected or changed by the coding agent.`,
      action: input.role === "worker" && active?.status === "started"
        ? `Worker must continue ${active.taskPath} through its current transactional step without inspecting workflow internals.`
        : input.role === "worker" && active?.status === "passed"
          ? "Worker must return the existing REVIEWABLE handoff without inspecting workflow internals."
          : input.role === "executor"
            ? "Executor must stop inspecting workflow internals and follow the current review or scheduling action."
            : input.role === "planner"
              ? "Planner must stop inspecting workflow internals and continue only task authoring."
              : "Stop inspecting workflow internals and wait for an explicit role-owned workflow action.",
    }
  }

  if (input.internalFileGuard && input.mutation && input.readOnlyTarget) {
    return {
      code: "operation.read_only_path",
      problem: `${input.readOnlyTarget} is read-only for the coding agent.`,
      action: "Read the file and follow it. Use the dedicated workflow tool for authorized changes; never edit, delete, restore, or move it directly.",
    }
  }

  if (input.todoDiscipline && input.tool === "todowrite") {
    if (input.todos.length > 5) return {
      code: "operation.todo_limit",
      problem: "The internal todo list has more than five entries.",
      action: "Rewrite it with at most five steps for only the current Kanban task.",
    }
    if (input.todos.filter((todo) => todo.status === "in_progress").length > 1) return {
      code: "operation.todo_parallel",
      problem: "More than one internal todo is in progress.",
      action: "Keep exactly one current step in_progress and set the others to pending or completed.",
    }
    const taskNames = new Set(input.todos.flatMap((todo) => String(todo.content ?? "").match(/\b\d{2,3}-[\w-]+\.md\b/g) ?? []))
    if (taskNames.size > 1) return {
      code: "operation.todo_multiple_tasks",
      problem: "The internal todo list mixes multiple Kanban tasks.",
      action: "Keep only the current lexicographic Kanban task in the internal list.",
    }
    const evidence = new Set(input.doctorEvidence)
    for (const todo of input.todos) {
      const gate = String(todo.content ?? "").match(/doctor\s*:?(lint|register|start|verify|complete)/i)?.[1]?.toLowerCase()
      if (todo.status === "completed" && gate && !evidence.has(gate)) return {
        code: "operation.todo_unproven_doctor",
        problem: `Doctor ${gate} was marked complete without matching successful tool output.`,
        action: `${roleLabel(input.role)} must set the unproven todo back to pending and follow the current workflow action.`,
        success: `A TASK DOCTOR success line for ${gate}.`,
      }
    }
  }

  if (input.planningEnforcer && input.newTask && input.unfinishedTask) return {
    code: "operation.unregistered_predecessor",
    problem: `${input.unfinishedTask} is not registered, so ${input.newTask} cannot be created yet.`,
    action: `Run npm run task:doctor:lint -- ${input.unfinishedTask}, fix findings, then run npm run task:doctor:register -- ${input.unfinishedTask}.`,
    success: `TASK DOCTOR: REGISTERED ${input.unfinishedTask}`,
  }

  if (!input.taskStartGuard || !input.mutation || input.taskGuardExempt) return null

  if (active?.status !== "started") return {
    code: "operation.task_not_started",
    problem: "Implementation was attempted before the current task was started.",
    action: input.firstTaskRegistered
      ? `Run npm run task:doctor:start -- ${task}.`
      : `Run npm run task:doctor:lint -- ${task}, then npm run task:doctor:register -- ${task}, then npm run task:doctor:start -- ${task}.`,
    success: `TASK DOCTOR: STARTED ${task}`,
  }

  if (input.outsideScopePath) return {
    code: "operation.outside_scope",
    problem: `${input.outsideScopePath} is outside the active task Scope.`,
    action: "Do not edit it. Stop and report that the task Scope is insufficient; task Scope cannot change after start.",
  }

  if (input.opaqueInlineWithoutPaths) return {
    code: "operation.opaque_inline",
    problem: "An inline interpreter command is opaque and may read or mutate paths outside the active task Scope.",
    action: input.userPermissionEscalation && !input.transactionalWorkerChanges
      ? "Use request_command_permission. Explain what the command will do and why, provide the complete command, and declare every affected project-relative path. The user must approve it before execution."
      : input.transactionalWorkerChanges
        ? "Use read or grep for inspection. Use preview_worker_changes and apply_worker_changes for exact scoped file changes. Arbitrary scripts and interpreters are not supported."
        : "Use read or grep for inspection. Use write or edit for an exact scoped file. For executable project logic, add a regular script file to the task Scope and run that file instead of inline code.",
  }

  if (input.pathlessShellMutation) return {
    code: "operation.pathless_shell_mutation",
    problem: "The mutating shell command has no target path the guard can verify.",
    action: input.userPermissionEscalation && !input.transactionalWorkerChanges
      ? "Use write for ordinary files; OpenCode write creates missing parent directories. If the shell command is necessary, use request_command_permission with a clear purpose, the complete command, and every affected project-relative path."
      : input.transactionalWorkerChanges
        ? "Use preview_worker_changes and apply_worker_changes for exact scoped file changes. Arbitrary mutating shell commands are not supported."
        : "Create the exact scoped file with the write tool. OpenCode write creates missing parent directories automatically; do not run mkdir first.",
  }

  return null
}

function roleLabel(role: OperationPolicyInput["role"]): string {
  return role === "unknown" ? "The current role" : `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`
}

import type { RolePolicyBlock } from "./role-policy.ts"

export type DoctorInvocation = {
  gate: string
  taskPath: string
}

export type LifecyclePolicyInput = {
  role: "planner" | "executor" | "worker" | "unknown"
  command: string
  invocation?: DoctorInvocation | null
  activeTask?: { status: string; taskPath: string; memoryAction?: string } | null
  todoTaskPaths: string[]
  mutation: boolean
  targetPaths: string[]
  taskMemoryAppend: boolean
  modeGuard: boolean
  contextCheckpoint: boolean
  checkpointPending: boolean
  executorReview: boolean
  doctorCommandMentioned: boolean
  exactDoctorCommand: boolean
}

export function decideLifecyclePolicy(input: LifecyclePolicyInput): RolePolicyBlock | null {
  const active = input.activeTask ?? null
  const invocation = input.invocation ?? null

  if (input.taskMemoryAppend
    && input.role === "worker"
    && input.mutation
    && input.targetPaths.includes("MEMORY.md")
    && active?.status === "started"
    && active.memoryAction === "append") {
    return {
      code: "lifecycle.worker_memory_append",
      problem: "Worker attempted to edit append-only MEMORY.md directly.",
      action: `Call append_task_memory with task_path ${active.taskPath} and one concise durable fact without a timestamp. The tool restores the Doctor baseline, adds the timestamp, and appends exactly once.`,
      success: `TASK MEMORY APPENDED ${active.taskPath}`,
    }
  }

  if (input.modeGuard && input.role === "worker" && /^npm\s+run\s+task:doctor:schedule(?:\s|$)/.test(input.command.trim())) {
    return {
      code: "lifecycle.worker_schedule",
      problem: "Worker attempted to run the Executor scheduling command.",
      action: active?.status === "started"
        ? `Do not schedule or start again. Continue active task ${active.taskPath} from the current finding; Apply verifies mechanically. Use verify_worker_task only when a tool result explicitly requires the fallback, then return a REVIEWABLE handoff after PASS.`
        : "Stop and report that the delegated task was not READY. Only Executor may schedule and delegate tasks.",
    }
  }

  if (input.contextCheckpoint && input.checkpointPending && input.role !== "executor") {
    return {
      code: "lifecycle.context_checkpoint",
      problem: "A Kanban task just completed and the mandatory context-threshold check is pending.",
      action: "Stop the current turn without another tool call. At session idle the guard will compact when the configured percentage is reached, then continue the requested batch.",
    }
  }

  if (input.doctorCommandMentioned && /\||&&|;|[<>]/.test(input.command)) {
    return {
      code: "lifecycle.combined_doctor",
      problem: "A Doctor command was combined, piped, redirected, or filtered, so its lifecycle and authoritative output could be altered.",
      action: `Run the Doctor command alone without other commands, 2>&1, pipes, filters, redirects, semicolons, or &&. Use the current task path ${input.todoTaskPaths[0] ?? "kanban/todo/<task>.md"}.`,
    }
  }

  if (input.executorReview && input.role === "worker" && invocation?.gate === "complete") {
    return {
      code: "lifecycle.worker_complete",
      problem: "Worker attempted Doctor complete, which belongs to the trusted Executor review transition.",
      action: `Do not run Doctor complete. Return REVIEWABLE with the exact Task path ${invocation.taskPath}, then stop. Executor calls zero-argument submit_task_review to complete it.`,
    }
  }

  if (input.role === "worker"
    && invocation?.gate === "start"
    && (active?.status === "started" || active?.status === "passed")
    && invocation.taskPath === active.taskPath) {
    return {
      code: "lifecycle.worker_restart",
      problem: `${active.taskPath} is already ${active.status}.`,
      action: active.status === "passed"
        ? "Do not start it again or change implementation. Return the existing REVIEWABLE state to Executor for review."
        : `Do not lint, register, start, or schedule again. Continue ${active.taskPath} from the current finding; Apply verifies mechanically. Use verify_worker_task only for an explicitly requested fallback, then return REVIEWABLE after PASS.`,
    }
  }

  if (input.doctorCommandMentioned && !input.exactDoctorCommand) {
    const task = active?.taskPath ?? input.todoTaskPaths[0] ?? "kanban/todo/<task>.md"
    return {
      code: "lifecycle.unsupported_doctor",
      problem: "The Doctor command is unsupported or missing its exact task path.",
      action: input.role === "executor"
        ? "Executor must run only npm run task:doctor:schedule; Worker owns every other Doctor lifecycle command."
        : input.role === "planner"
          ? "Planner must stop this malformed command and use the Planner task tools or exact Doctor next/schedule."
          : input.role === "worker" && active?.status === "started"
            ? `Worker must continue ${active.taskPath} through its current transactional step; do not schedule or repeat the malformed command.`
            : input.role === "worker"
              ? `Worker must return BLOCKED for ${task}; no exact active Worker lifecycle instruction is available.`
              : "Stop this malformed Doctor command and wait for an explicit role-owned workflow action.",
    }
  }

  if (invocation && ["lint", "register"].includes(invocation.gate) && !input.todoTaskPaths.includes(invocation.taskPath)) {
    const requestedStem = taskStem(invocation.taskPath)
    const suggested = input.todoTaskPaths.find((path) => taskStem(path) === requestedStem)
      ?? input.todoTaskPaths[0]
      ?? "kanban/todo/<task>.md"
    return {
      code: "lifecycle.invalid_task_path",
      problem: `${invocation.taskPath} is not an exact Kanban task path.`,
      action: `Run npm run task:doctor:${invocation.gate} -- ${suggested}. Keep kanban/todo/ and the .md suffix.`,
      success: `TASK DOCTOR: ${invocation.gate === "lint" ? "LINT PASS" : "REGISTERED"} ${suggested}`,
    }
  }

  if (invocation && active?.status === "started" && invocation.taskPath !== active.taskPath) {
    return {
      code: "lifecycle.active_task_mismatch",
      problem: `${active.taskPath} is still active, so Doctor ${invocation.gate} cannot run for ${invocation.taskPath}.`,
      action: `Stay on ${active.taskPath}. Fix its latest in-scope finding through the transactional tools; Apply verifies mechanically. Never run Worker verify through Bash.`,
      success: `TASK DOCTOR: COMPLETED kanban/done/${active.taskPath.split("/").pop()}`,
    }
  }

  return null
}

function taskStem(path: string): string | undefined {
  return path.split("/").pop()?.replace(/\.md$/, "")
}

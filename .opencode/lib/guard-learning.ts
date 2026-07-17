import { createHash } from "node:crypto"

function stableID(key: string): string {
  return createHash("sha256").update(`guard-category:${key}`).digest("hex").slice(0, 6)
}

const STABLE_GUARD_IDS: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /Doctor command was combined, piped, redirected, or filtered/i, id: "726d21" },
  { pattern: /internal workflow path|workflow state files or directories|protected workflow files/i, id: "70717e" },
  { pattern: /Worker attempted Doctor start without reading WORKER\.md/i, id: "44cd0c" },
  { pattern: /before reading required rules in the current context/i, id: "44cd0c" },
  { pattern: /before reading the exact active task|Read kanban\/todo\/.*Then run .*task:doctor:verify/i, id: "5c9976" },
  { pattern: /Implementation was attempted before the current task was started|without a started task|not the exact active started task/i, id: "c84c34" },
  { pattern: /Scope is insufficient|outside (?:the active )?task Scope|outside Scope/i, id: "75e716" },
  { pattern: /mutating shell command has no target path|ordinary files.*missing parent directories/i, id: "7a5a6f" },
  { pattern: /same tool call was attempted three times/i, id: "59e858" },
  { pattern: /Worker attempted to create or rewrite a Kanban task/i, id: "0d5e4d" },
  { pattern: /not an exact Kanban task path|exact current task path/i, id: "736adb" },
  { pattern: /Planner asked unresolved user decisions|plain text instead of using the question tool/i, id: "a97c6d" },
  { pattern: /Planner attempted to ask whether tasks should be delegated or executed/i, id: "8331c4" },
  { pattern: /Planner attempted a shell command outside the read-only/i, id: "1210c5" },
  { pattern: /Executor attempted a shell command outside the read-only/i, id: "e71ef0" },
  { pattern: /mandatory context-threshold check is pending/i, id: "6a5d6a" },
  { pattern: /internal todo list has more than five entries/i, id: "b9283d" },
  { pattern: /not the first in-scope file named by the current Doctor failure/i, id: "5c9976" },
  { pattern: /another action after applying one project file|Run .*task:doctor:verify.*before another change/i, id: "5c9976" },
  { pattern: /preview target .* has not been fully read|Read .* fully with the read tool before previewing/i, id: "5c9976" },
  { pattern: /Worker preview contains .* project files|Preview exactly one project file/i, id: "f260c1" },
  { pattern: /Only Worker may request permission for an exceptional mutating command/i, id: stableID("command-permission-role") },
  { pattern: /permission request contains a path outside the project/i, id: stableID("command-permission-project-path") },
  { pattern: /protected and cannot be approved through a command exception/i, id: stableID("command-permission-protected") },
  { pattern: /Only Worker may request an exceptional task correction/i, id: stableID("task-change-role") },
  { pattern: /not the exact first Kanban task/i, id: stableID("task-change-current-task") },
  { pattern: /already (?:started|passed).*definition needs Planner correction/i, id: stableID("task-change-active-task") },
  { pattern: /No current Doctor lint failure requires changing/i, id: stableID("task-change-no-lint-failure") },
  { pattern: /proposed old text occurs .* replacement is unchanged/i, id: stableID("task-change-replacement") },
  { pattern: /Only Worker may request dependency installation/i, id: stableID("dependency-role") },
  { pattern: /not a project workspace with package\.json/i, id: stableID("dependency-workspace") },
  { pattern: /dependency request contains a URL, flag, path, or invalid package spec/i, id: stableID("dependency-invalid-spec") },
  { pattern: /not explicitly named in the active task/i, id: stableID("dependency-not-in-task") },
  { pattern: /not covered by the active task package scope/i, id: stableID("dependency-package-scope") },
  { pattern: /Dependency installation requires a dedicated user approval/i, id: stableID("dependency-dedicated-permission") },
  { pattern: /Worker delegation does not name exactly one Kanban task/i, id: stableID("delegation-one-task") },
  { pattern: /current user explicitly requested Planner recovery|Call escalate_to_planner.*exact recovery contract/i, id: "e33d18" },
  { pattern: /is active, so .* cannot be delegated/i, id: stableID("delegation-active-task") },
  { pattern: /already active and cannot receive a fresh lifecycle delegation/i, id: stableID("delegation-resume") },
  { pattern: /not READY in the current Doctor schedule/i, id: stableID("delegation-not-ready") },
  { pattern: /Worker claimed REVIEWABLE before Doctor PASS/i, id: stableID("worker-reviewable-before-pass") },
  { pattern: /Planner cannot run Doctor/i, id: stableID("planner-doctor-gate") },
  { pattern: /Planner attempted to change a path outside/i, id: stableID("planner-write-scope") },
  { pattern: /Executor attempted to change a file/i, id: stableID("executor-mutation") },
  { pattern: /Executor cannot run Doctor/i, id: stableID("executor-doctor-gate") },
  { pattern: /Worker attempted to run the Executor scheduling command/i, id: stableID("worker-schedule") },
  { pattern: /already (?:started|passed)\.$/i, id: stableID("doctor-task-already-active") },
  { pattern: /Doctor command is unsupported or missing its exact task path/i, id: stableID("doctor-command-unsupported") },
  { pattern: /still active, so Doctor .* cannot run/i, id: stableID("doctor-other-active-task") },
  { pattern: /read-only for the coding agent/i, id: stableID("read-only-agent-path") },
  { pattern: /More than one internal todo is in progress/i, id: stableID("todo-one-in-progress") },
  { pattern: /internal todo list mixes multiple Kanban tasks/i, id: stableID("todo-one-kanban-task") },
  { pattern: /was marked complete without matching successful tool output/i, id: stableID("todo-evidence") },
  { pattern: /is not registered, so .* cannot be created yet/i, id: stableID("planning-register-before-next") },
  { pattern: /inline interpreter command is opaque/i, id: stableID("opaque-inline-command") },
]

const STABLE_GUARD_RULES: Record<string, string> = {
  "726d21": "Run each Doctor command alone with the exact current task path. Do not pipe, redirect, filter, or chain it.",
  "70717e": "Treat Doctor, OpenCode, and Guard internals as opaque. Follow their public output without inspecting internal files.",
  "44cd0c": "Read WORKER.md before work and after compaction.",
  "c84c34": "Start the registered task before implementation. Resume an active task without restarting its lifecycle.",
  "75e716": "Edit only paths in the active task Scope. Report insufficient Scope instead of working around it.",
  "7a5a6f": "Use write or edit for ordinary files and scoped NEW files. They create missing parent directories.",
  "59e858": "After a failed or blocked action, change the approach once. If the same failure repeats, stop and report it.",
  "0d5e4d": "Do not create or rewrite Kanban tasks as Worker. Request an allowed task change or report the blocker.",
  "736adb": "Use the exact current Kanban task path reported by Doctor. Do not guess or reuse a stale path.",
  "a97c6d": "Planner uses the question tool for unresolved user decisions and emits no normal text before it.",
  "8331c4": "Planner prepares registered tasks and hands control to Executor. Planner does not delegate Worker.",
  "1210c5": "Planner uses only allowed read-only commands, fixed app operations, and Doctor planning commands.",
  "e71ef0": "Executor inspects and schedules work, then delegates implementation to Worker. Executor does not mutate project files.",
  "6a5d6a": "After task completion, stop tool use until the configured compaction check finishes.",
  "b9283d": "Keep the internal todo list to at most five steps for the current Kanban task.",
  "5c9976": "Run Doctor verify before implementation inspection and immediately after Apply. Read every preview target fully and start with Doctor's first named in-scope file.",
  "f260c1": "Preview and apply exactly one project file per change set.",
  [stableID("delegation-one-task")]: "Delegate one Worker for one exact current Kanban task, and repeat that same task path in both the delegation description and prompt.",
  "e33d18": "Call escalate_to_planner for an explicitly named task with file-backed evidence and an exact recovery contract; do not delegate until Planner returns COMPLETE.",
  [stableID("worker-reviewable-before-pass")]: "Return REVIEWABLE only after Doctor verify prints TASK DOCTOR: PASS for the exact active task.",
}

function canonicalProblem(problem: string): string {
  return problem
    .toLowerCase()
    .replace(/kanban\/(?:todo|done)\/[a-z0-9._-]+\.md/gi, "kanban/<state>/<task>.md")
    .replace(/(?:^|\s)[./a-z0-9_-]+\.(?:md|ts|tsx|js|mjs|json)(?=\s|$|[.,:])/gi, " <path>")
    .replace(/doctor\s+(?:lint|register|start|verify|complete|whitelist|test-file)/gi, "doctor <gate>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
}

export function stableGuardViolationId(problem: string, action = ""): string {
  const combined = `${problem}\n${action}`
  const known = STABLE_GUARD_IDS.find(({ pattern }) => pattern.test(combined))
  if (known) return known.id
  return createHash("sha256").update(`guard-v2:${canonicalProblem(problem)}`).digest("hex").slice(0, 6)
}

export function stableGuardRule(id: string, _fallback: string): string {
  return STABLE_GUARD_RULES[id.toLowerCase().slice(0, 6)]
    ?? "Follow the current Guard recovery response for this attempt without storing task-specific details as a durable rule."
}

export function knownStableGuardRule(id: string): string | null {
  return STABLE_GUARD_RULES[id.toLowerCase().slice(0, 6)] ?? null
}

export function learnedGuardRuleFromSources(
  id: string,
  sources: Array<{ path: string; content: string }>,
): { id: string; canonicalID: string; path: string; rule: string } | null {
  const normalizedID = id.toLowerCase().slice(0, 6)
  for (const source of sources) {
    const lines = source.content.split(/\r?\n/)
    const directRule = knownStableGuardRule(normalizedID)
    const direct = lines.find((line) => line.includes(`[${normalizedID}]`))
    if (direct && directRule) {
      return {
        id: normalizedID,
        canonicalID: normalizedID,
        path: source.path,
        rule: directRule,
      }
    }
    const alias = [...source.content.matchAll(/\b([a-f0-9]{6})=([a-f0-9]{6})\b/gi)]
      .find((match) => match[1].toLowerCase() === normalizedID)?.[2]?.toLowerCase()
    if (!alias) continue
    const canonicalRule = knownStableGuardRule(alias)
    const canonical = canonicalRule && lines.find((line) => line.includes(`[${alias}]`))
    if (canonical && canonicalRule) {
      return {
        id: normalizedID,
        canonicalID: alias,
        path: source.path,
        rule: canonicalRule,
      }
    }
  }
  return null
}

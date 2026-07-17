import { helpRequestedHandoffError } from "./worker-help.ts"

export type WorkerReturnIssue =
  | { kind: "pending_guard_learnings"; detail: string }
  | { kind: "reviewable_before_pass"; detail: string }
  | { kind: "doctor_state_mismatch"; detail: string }
  | { kind: "invalid_reviewable_handoff"; detail: string }
  | { kind: "invalid_blocked_handoff"; detail: string }
  | { kind: "invalid_help_handoff"; detail: string }

export function changedSnapshotPaths(before: Record<string, string>, after: Record<string, string>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort()
}

export function reviewableHandoffError(text: string, taskPath: string) {
  const required = [
    [/(?:^|\n)\s*(?:\*\*|__)?REVIEWABLE(?:\*\*|__)?\s*(?:\n|$)/i, "REVIEWABLE heading"],
    [new RegExp(taskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "exact task path"],
  ] as const
  return required.find(([pattern]) => !pattern.test(text))?.[1] ?? null
}

export function canonicalReviewableHandoff(taskPath: string) {
  return [
    "REVIEWABLE",
    `Task: ${taskPath}`,
  ].join("\n")
}

export function claimsReviewableHandoff(text: string) {
  return /(?:^|\n)\s*(?:\*\*|__)?REVIEWABLE(?:\*\*|__)?\s*(?:\n|$)/i.test(text)
}

export function blockedHandoffError(text: string, taskPath: string) {
  const required = [
    [/(?:^|\n)\s*(?:\*\*|__)?BLOCKED(?:\*\*|__)?\s*(?:\n|$)/i, "BLOCKED heading"],
    [new RegExp(taskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "exact task path"],
    [/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*|__)?Doctor status(?:\*\*|__)?\s*:/i, "Doctor status section"],
    [/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*|__)?Failure(?:\*\*|__)?\s*:/i, "Failure section"],
    [/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*|__)?Required owner(?:\*\*|__)?\s*:/i, "Required owner section"],
  ] as const
  return required.find(([pattern]) => !pattern.test(text))?.[1] ?? null
}

export function canonicalBlockedHandoff(input: {
  taskPath: string
  doctorStatus?: string | null
  failure: string
  requiredOwner?: "Executor" | "Planner" | "User"
}) {
  const failure = input.failure.replace(/\s+/g, " ").trim().slice(0, 1200)
  return [
    "BLOCKED",
    `Task: ${input.taskPath}`,
    `Doctor status: ${input.doctorStatus ?? "none"}`,
    `Failure: ${failure || "Worker ended before Doctor PASS without a usable failure description."}`,
    `Required owner: ${input.requiredOwner ?? "Executor"}`,
  ].join("\n")
}

export function workerReturnIssue(input: {
  text: string
  taskPath: string
  doctorStatus?: string | null
  doctorTaskPath?: string | null
  pendingGuardLearningIDs?: string[]
  requireTerminalHandoff?: boolean
  helpRequestID?: string | null
}): WorkerReturnIssue | null {
  const pending = [...new Set(input.pendingGuardLearningIDs ?? [])].sort()
  if (pending.length > 0) {
    return {
      kind: "pending_guard_learnings",
      detail: `pending Guard learnings: ${pending.join(", ")}`,
    }
  }

  const doctorPassed = input.doctorStatus === "passed" && input.doctorTaskPath === input.taskPath
  if (claimsReviewableHandoff(input.text) && !doctorPassed) {
    return {
      kind: "reviewable_before_pass",
      detail: `Doctor status is ${input.doctorStatus ?? "none"} for ${input.doctorTaskPath ?? "no task"}`,
    }
  }
  if (input.helpRequestID) {
    const missing = helpRequestedHandoffError(input.text, input.taskPath, input.helpRequestID)
    return missing
      ? { kind: "invalid_help_handoff", detail: `missing ${missing}` }
      : null
  }
  if (input.doctorStatus === "passed" && input.doctorTaskPath !== input.taskPath) {
    return {
      kind: "doctor_state_mismatch",
      detail: `Doctor passed ${input.doctorTaskPath ?? "no task"}, not ${input.taskPath}`,
    }
  }
  if (!doctorPassed) {
    const missing = input.requireTerminalHandoff ? blockedHandoffError(input.text, input.taskPath) : null
    return missing
      ? { kind: "invalid_blocked_handoff", detail: `missing ${missing}` }
      : null
  }

  const missing = reviewableHandoffError(input.text, input.taskPath)
  return missing
    ? { kind: "invalid_reviewable_handoff", detail: `missing ${missing}` }
    : null
}

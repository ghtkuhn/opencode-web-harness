export type WorkerHelpStatus = "pending" | "retry_approved" | "task_changed" | "planner_unavailable" | "planner_recovery_incomplete" | "delegated" | "resolved" | "obsolete"

export type DelegationLeasePhase = "launching" | "running" | "reviewable" | "retryable" | "closed"

export type DelegationLease = {
  version: 1
  phase: DelegationLeasePhase
  taskPath: string
  taskHash: string
  helpID: string
  priorStatus: "retry_approved" | "task_changed"
  parentSessionID?: string
  workerSessionID?: string
  callID?: string
  source?: "direct" | "mechanical"
  revision: number
  updatedAt: string
}

export type WorkerHelpRequest = {
  version: 1 | 2
  id: string
  status: WorkerHelpStatus
  taskPath: string
  taskHash: string
  workerSessionID: string
  category: string
  problem: string
  attemptedActions: string[]
  evidence: string[]
  relevantFiles: string[]
  suggestedNextStep: string
  createdAt: string
  retryOfHelpID?: string
  executorReview?: {
    sessionID: string
    decision: "retry_worker" | "planner_recovery" | "change_task"
    rootCause: string
    retryStrategy: string
    expectedResults: string[]
    reviewedFiles: string[]
    reviewedAt: string
  }
  delegatedAt?: string
  delegatedWorkerSessionID?: string
  delegationPriorStatus?: "retry_approved" | "task_changed"
  delegationParentSessionID?: string
  delegationDescription?: string
  delegationCallID?: string
  delegationSource?: "direct" | "mechanical"
  delegationAttemptNonce?: string
  delegation?: DelegationLease
  recoveryBoost?: {
    phase: "active" | "cleared" | "base_continuation_started" | "base_continuation_completed"
    hurdleTarget?: string
    hurdleFingerprint?: string
    activatedAt: string
    clearedAt?: string
    clearedByRunID?: string
    baseContinuationStartedAt?: string
    baseContinuationCompletedAt?: string
    baseContinuationModel?: string
    baseContinuationCallID?: string
    baseContinuationNonce?: string
    baseContinuationMessageID?: string
    baseContinuationAssistantID?: string
    baseContinuationResultText?: string
    baseContinuationResultHash?: string
    baseContinuationDeliveredAt?: string
  }
  closedAt?: string
  closureReason?: "task_completed" | "task_superseded" | "task_hash_replaced" | "scope_baseline_recovered" | "superseded_help_request"
}

export type WorkerHelpStore = {
  version: 1 | 2
  requests: WorkerHelpRequest[]
  updatedAt: string
}

export function reviewableWorkerHelpRequests(
  requests: WorkerHelpRequest[],
  taskPath: string,
  taskHash: string,
) {
  return requests.filter((request) => request.taskPath === taskPath
    && request.taskHash === taskHash
    && (request.status === "pending"
      || (request.status === "retry_approved" && !request.delegatedWorkerSessionID)))
}

export function selectWorkerHelpForReview(
  requests: WorkerHelpRequest[],
  taskPath: string,
  taskHash: string,
  helpID?: string | null,
) {
  const reviewable = reviewableWorkerHelpRequests(requests, taskPath, taskHash)
  if (helpID) return reviewable.find((request) => request.id.toLowerCase() === helpID.toLowerCase()) ?? null
  const newest = (values: WorkerHelpRequest[]) => [...values].sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id, undefined, { numeric: true })
  ))[0] ?? null
  return newest(reviewable.filter((request) => request.status === "pending")) ?? newest(reviewable)
}

export function supersedeCompetingWorkerHelp(
  requests: WorkerHelpRequest[],
  selectedID: string,
  closedAt: string,
) {
  const selected = requests.find((request) => request.id === selectedID)
  if (!selected) return requests
  return requests.map((request) => request.id !== selectedID
    && request.taskPath === selected.taskPath
    && request.taskHash === selected.taskHash
    && (request.status === "pending"
      || (request.status === "retry_approved" && !request.delegatedWorkerSessionID))
    ? { ...request, status: "obsolete" as const, closedAt, closureReason: "superseded_help_request" as const }
    : request)
}

export type LoopFailureFingerprint = {
  signature: string
  tool: string
  target: string
  category: string
  problem: string
  evidence?: string
}

export type ReplaceOccurrenceMismatch = {
  expected: number
  found: number
  path?: string
  evidence: string
}

export type RestoreOnlyOutsideScopeFailure = {
  codes: string[]
  paths: string[]
  evidence: string
}

function normalizedOccurrencePath(value: string | undefined) {
  let path = value?.trim()
  if (!path) return undefined

  path = path.replace(/[.!?:]+$/g, "")
  const wrappers = [
    ["`", "`"],
    ["\"", "\""],
    ["'", "'"],
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
    ["<", ">"],
  ] as const
  for (const [opening, closing] of wrappers) {
    if (path.startsWith(opening) && path.endsWith(closing)) {
      path = path.slice(opening.length, -closing.length).trim()
      break
    }
  }
  return path || undefined
}

export function replaceOccurrenceMismatches(text: string): ReplaceOccurrenceMismatch[] {
  const pattern = /Worker replace (?:(?:expected (\d+) occurrences but found (\d+))|(?:found (\d+) exact matches while (\d+) were expected))(?:[ \t]*:[ \t]*([^\s,;]+))?/gi
  return [...text.matchAll(pattern)].flatMap((match) => {
    const expected = Number(match[1] ?? match[4])
    const found = Number(match[2] ?? match[3])
    if (!Number.isSafeInteger(expected)
      || !Number.isSafeInteger(found)
      || expected <= 0
      || found < 0
      || expected === found) return []
    const path = normalizedOccurrencePath(match[5])
    return [{
      expected,
      found,
      ...(path ? { path } : {}),
      evidence: match[0].trim(),
    }]
  })
}

const outsideScopeRestoreActions = new Map([
  ["CHANGED_OUTSIDE_SCOPE_FILE", "CHANGED_FILE_ACTION"],
  ["MISSING_OUTSIDE_SCOPE_FILE", "MISSING_FILE_ACTION"],
  ["WHITELISTED_FILE_CHANGED", "WHITELIST_ACTION"],
  ["WHITELISTED_FILE_MISSING", "WHITELIST_ACTION"],
])

const outsideScopeRestoreActionCodes = new Set(outsideScopeRestoreActions.values())

export function restoreOnlyOutsideScopeFailure(output: string): RestoreOnlyOutsideScopeFailure | null {
  const lines = output
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())

  let latestDoctorHeader = -1
  let latestDoctorStatus = ""
  for (const [index, line] of lines.entries()) {
    const status = line.match(/^TASK DOCTOR:\s+([A-Z]+)\b/i)?.[1]
    if (!status) continue
    latestDoctorHeader = index
    latestDoctorStatus = status.toUpperCase()
  }
  if (latestDoctorHeader < 0 || latestDoctorStatus !== "FAIL") return null

  const findingLines = lines
    .slice(latestDoctorHeader + 1)
    .filter((line) => /^-\s+\S/.test(line))
  if (findingLines.length === 0) return null

  const codes: string[] = []
  const paths: string[] = []
  const requiredActions = new Set<string>()
  const observedActions = new Set<string>()
  for (const line of findingLines) {
    const finding = line.match(/^-\s+([A-Z][A-Z0-9_]*):\s*(\S.*)$/i)
    if (!finding) return null
    const code = finding[1].toUpperCase()
    const value = finding[2].trim()
    if (!codes.includes(code)) codes.push(code)

    const requiredAction = outsideScopeRestoreActions.get(code)
    if (requiredAction) {
      requiredActions.add(requiredAction)
      if (!paths.includes(value)) paths.push(value)
      continue
    }
    if (!outsideScopeRestoreActionCodes.has(code)) return null
    observedActions.add(code)
  }

  if (paths.length === 0
    || [...requiredActions].some((code) => !observedActions.has(code))
    || [...observedActions].some((code) => !requiredActions.has(code))) return null

  return {
    codes,
    paths,
    evidence: ["TASK DOCTOR: FAIL", ...findingLines].join("\n"),
  }
}

function doctorFailureLines(output: string) {
  const lines = output
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
  const start = lines.findIndex((line) => /^TASK DOCTOR:\s+FAIL\b/i.test(line))
  if (start < 0) return []
  const findings = lines
    .slice(start + 1)
    .filter((line) => /^-\s+\S/.test(line))
    .sort((left, right) => left.localeCompare(right))
  const diagnostics = lines
    .slice(0, start)
    .filter((line) => (
      /\(\d+,\d+\):\s+(?:error|warning)\s+[A-Z]+\d+:/i.test(line)
      || /^(?:Error|TypeError|ReferenceError|SyntaxError|AssertionError|TimeoutError):\s+\S/i.test(line)
      || /\b(?:ECONNREFUSED|EADDRINUSE|ENOTFOUND|ETIMEDOUT)\b/i.test(line)
      || /\bhttp proxy error:\s+\S/i.test(line)
      || /^(?:\d+\)|[×✘✖])\s+\S/.test(line)
      || /^(?:Expected|Received):\s+\S/i.test(line)
    ))
    .map((line) => {
      const nodeError = line.match(/\b(ECONNREFUSED|EADDRINUSE|ENOTFOUND|ETIMEDOUT)\b/i)?.[1]
      const proxyTarget = line.match(/\bhttp proxy error:\s+(\S+)/i)?.[1]
      return nodeError
        ? `NODE_ERROR ${nodeError.toUpperCase()}`
        : proxyTarget
          ? `PROXY_ERROR ${proxyTarget}`
          : line.slice(0, 400)
    })
    .filter((line, index, all) => all.indexOf(line) === index)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 40)
  return ["TASK DOCTOR: FAIL", ...findings, ...diagnostics.map((line) => `DIAGNOSTIC: ${line}`)]
}

export function doctorFailureFingerprint(
  gate: string,
  taskPath: string,
  output: string,
): LoopFailureFingerprint | null {
  const lines = doctorFailureLines(output)
  if (lines.length === 0) return null
  const findings = lines.slice(1)
  const problem = (findings.length > 0 ? findings.join("; ") : lines[0]).slice(0, 600)
  return {
    signature: `doctor|${gate}|${taskPath}|${lines.join("\n")}`,
    tool: `task:doctor:${gate}`,
    target: taskPath,
    category: "repeated-doctor-failure",
    problem,
    evidence: lines.join("\n").slice(0, 700),
  }
}

const monitoredTools = new Set([
  "read",
  "edit",
  "write",
  "patch",
  "apply_patch",
  "multiedit",
  "bash",
  "request_command_permission",
  "request_task_change_permission",
  "request_dependency_install_permission",
  "preview_worker_changes",
  "apply_worker_changes",
  "verify_worker_task",
  "discard_worker_changes",
])

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function claimsHelpRequestedHandoff(text: string) {
  return /(?:^|\n)\s*HELP_REQUESTED\s*(?:\n|$)/i.test(text)
}

export function helpRequestedHandoffError(text: string, taskPath: string, helpID: string) {
  const required = [
    [/(?:^|\n)\s*HELP_REQUESTED\s*(?:\n|$)/i, "HELP_REQUESTED heading"],
    [new RegExp(`(?:^|\\n)\\s*Help ID\\s*:\\s*${escaped(helpID)}\\s*(?:\\n|$)`, "i"), "exact Help ID"],
    [new RegExp(escaped(taskPath), "i"), "exact task path"],
    [/(?:^|\n)\s*(?:#{1,6}\s*)?Problem\s*:/i, "Problem section"],
    [/(?:^|\n)\s*(?:#{1,6}\s*)?Evidence\s*:/i, "Evidence section"],
    [/(?:^|\n)\s*(?:#{1,6}\s*)?Attempted\s*:/i, "Attempted section"],
    [/(?:^|\n)\s*(?:#{1,6}\s*)?Suggested next step\s*:/i, "Suggested next step section"],
  ] as const
  return required.find(([pattern]) => !pattern.test(text))?.[1] ?? null
}

function normalizedProblem(error: string) {
  return error
    .replace(/\b(?:0x)?[a-f0-9]{6,}\b/gi, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240)
}

function failureCategory(tool: string, error: string) {
  const replaceOccurrence = /Worker replace (?:expected \d+ occurrences but found (\d+)|found (\d+) exact matches while \d+ were expected)/i.exec(error)
  if (replaceOccurrence) {
    const found = Number(replaceOccurrence[1] ?? replaceOccurrence[2])
    return `replace-occurrence-${found === 0 ? "none" : found === 1 ? "one" : "many"}`
  }
  if (/requires .*expected_occurrences|requires .*old_text|model input invalid/i.test(error)) return "invalid-tool-input"
  if (/old\s*(?:string|text)|oldString|matched span|could not find|replacement.*match/i.test(error)) return "edit-match"
  if (/outside (?:the )?(?:active task )?scope|TASK_SCOPE|scope is insufficient/i.test(error)) return "task-scope"
  if (/no target path|cannot verify|opaque.*command/i.test(error)) return "unverifiable-mutation"
  if (/invalid unicode|syntax error|parse error|unexpected token/i.test(error)) return "syntax"
  if (/permission|not allowed/i.test(error)) return "permission"
  if (/WORKFLOW GUARD BLOCKED/.test(error)) {
    const problem = error.match(/(?:^|\n)Problem:\s*([^\n]+)/)?.[1]
    return `guard:${normalizedProblem(problem ?? error)}`
  }
  if (tool === "bash") return "command-failed"
  return `error:${normalizedProblem(error.split(/\r?\n/).find(Boolean) ?? error)}`
}

function failureTarget(tool: string, input: Record<string, unknown>) {
  const path = [input.filePath, input.path, input.filename]
    .find((value): value is string => typeof value === "string" && value.length > 0)
  if (path) return path.replace(/^\.\//, "")
  const operationPath = Array.isArray(input.operations)
    ? input.operations
      .map((operation) => operation && typeof operation === "object"
        ? [operation.path, operation.file_path, operation.filePath].find((value) => typeof value === "string" && value.length > 0)
        : null)
      .find((value): value is string => typeof value === "string")
    : null
  if (operationPath) return operationPath.replace(/^\.\//, "")
  if (tool === "bash") {
    const command = typeof input.command === "string" ? input.command.replace(/\s+/g, " ").trim() : ""
    return command.split(/\s+/).slice(0, 3).join(" ").slice(0, 120) || "<command>"
  }
  return `<${tool}>`
}

export function loopFailureFingerprint(tool: string, input: Record<string, unknown>, error: string): LoopFailureFingerprint | null {
  if (!monitoredTools.has(tool) || !error.trim() || /^WORKFLOW CONTROL\b/i.test(error.trim())) return null
  const target = failureTarget(tool, input)
  const category = failureCategory(tool, error)
  const evidence = error.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim().slice(0, 700)
  return {
    signature: `${tool}|${target}|${category}`,
    tool,
    target,
    category,
    problem: normalizedProblem(error),
    evidence,
  }
}

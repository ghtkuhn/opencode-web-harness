import { createHash } from "node:crypto"
import { plannerRecoveryContractExactGaps, type PlannerRecoveryContract } from "./planner-recovery-contract.ts"
import { parsePlannerTask } from "./planner-task.ts"
import type { WorkerHelpRequest, WorkerHelpStore } from "./worker-help.ts"

type HashValue = string | null | undefined

export type CompletedExactReceipt = {
  version: 1
  status: "pending" | "complete"
  taskPath: string
  initialTaskHash: string
  taskHash: string
  contractMode?: "merge" | "replace"
  contract?: PlannerRecoveryContract
  relevantFiles?: string[]
  completedAt?: string
}

export type ExactReceiptState = {
  status?: string
  taskPath?: string
  taskHash?: string
  snapshot?: Record<string, HashValue>
  taskRevision?: {
    previousTaskHash?: string
    revisedTaskHash?: string
    plannerSessionID?: string
    executorSessionID?: string
    revisedAt?: string
  }
}

export type ExactReceiptRegistration = {
  status?: string
  taskPath?: string
  taskHash?: string
  snapshot?: Record<string, HashValue>
}

export type ExactReceiptOwnership = {
  taskPath?: string
  taskHash?: string
  plannerSessionID?: string
  source?: string
}

export type AppliedWorkerChangeReceipt = {
  id: string
  status: string
  taskPath: string
  taskHash?: string
  sessionID?: string
  appliedAt?: string
  files: Array<{
    path: string
    beforeHash?: string | null
    afterHash?: string | null
  }>
}

export type TrustedBaselineSource = {
  source: "git-index" | "git-head" | "opencode-snapshot" | "persisted-baseline"
  hash: string
}

export type DoctorScopeFinding = {
  code: string
  detail: string
  path?: string
  line: string
}

export type ExactReceiptRestorePath = {
  path: string
  baselineHash: string
  currentHash: string
  baselineSource: TrustedBaselineSource["source"]
  provenanceReceiptIDs: string[]
  abandonedReceiptIDs: string[]
}

export type ExactReceiptHelpAction = {
  action: "obsolete" | "keep"
  requestID: string
  workerSessionID: string
  reason: string
  closureReason?: "exact_scope_reconciled"
  restoredPaths?: string[]
}

export type ExactReceiptStartupPlan = {
  status: "ready" | "noop" | "ineligible"
  reason: string
  taskPath?: string
  taskHash?: string
  restorePaths: ExactReceiptRestorePath[]
  independentDoctorFindings: DoctorScopeFinding[]
  workerChangesSinceRevision: string[]
  lastFailureAction: "resolve" | "keep"
  helpAction?: ExactReceiptHelpAction
}

export type ExactReceiptStartupInput = {
  receipt: CompletedExactReceipt | null | undefined
  state: ExactReceiptState | null | undefined
  taskContent: string
  registration: ExactReceiptRegistration | null | undefined
  ownership: ExactReceiptOwnership | null | undefined
  currentHashes: Record<string, HashValue>
  baselineSources: Record<string, TrustedBaselineSource | undefined>
  appliedWorkerChanges: AppliedWorkerChangeReceipt[]
  workerMutationPathsSinceRevision?: string[]
  workerHelp?: WorkerHelpStore | null
  lastDoctorFailure?: {
    version?: number
    sessionID?: string
    taskPath?: string
    taskHash?: string
    gate?: string
    output?: string
    failedAt?: string
  } | null
  protectedPaths?: string[]
}

function digest(content: string) {
  return createHash("sha256").update(content).digest("hex")
}

function canonicalPath(value: string) {
  const path = value.trim().replace(/^NEW:\s*/i, "").replace(/^`|`$/g, "").replaceAll("\\", "/")
  if (!path || path.startsWith("/") || path === ".." || path.startsWith("../") || path.includes("/../")) return null
  return path.replace(/^\.\//, "")
}

function normalizedScope(values: string[]) {
  return [...new Set(values.map(canonicalPath).filter((path): path is string => Boolean(path)))].sort()
}

function pathFromFinding(code: string, detail: string) {
  if (!/^(?:CHANGED_OUTSIDE_SCOPE_FILE|MISSING_OUTSIDE_SCOPE_FILE|NEW_OUTSIDE_SCOPE_FILE)$/.test(code)) return undefined
  return canonicalPath(detail.split(/[;,]/, 1)[0].trim()) ?? undefined
}

export function doctorScopeFindings(output: string): DoctorScopeFinding[] {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "")
  const marker = clean.lastIndexOf("TASK DOCTOR: FAIL")
  if (marker < 0) return []
  return clean.slice(marker).split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^-\s+([A-Z][A-Z0-9_]+):\s*(.*)$/)
    if (!match) return []
    const [, code, detail] = match
    const path = pathFromFinding(code, detail)
    return [{ code, detail, ...(path ? { path } : {}), line: line.trim() }]
  })
}

function pathIsProtected(path: string, protectedPaths: string[]) {
  return protectedPaths.some((entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, "")}/`))
}

function receiptEdges(path: string, taskPath: string, receipts: AppliedWorkerChangeReceipt[]) {
  return receipts
    .filter((receipt) => receipt.status === "applied" && receipt.taskPath === taskPath)
    .flatMap((receipt) => receipt.files
      .filter((file) => canonicalPath(file.path) === path && typeof file.beforeHash === "string" && typeof file.afterHash === "string")
      .map((file) => ({
        id: receipt.id,
        beforeHash: file.beforeHash as string,
        afterHash: file.afterHash as string,
        appliedAt: receipt.appliedAt ?? "",
      })))
    .sort((left, right) => left.appliedAt.localeCompare(right.appliedAt) || left.id.localeCompare(right.id))
}

function provenanceToCurrent(path: string, taskPath: string, baselineHash: string, currentHash: string, receipts: AppliedWorkerChangeReceipt[]) {
  const edges = receiptEdges(path, taskPath, receipts)
  const paths = new Map<string, string[]>([[baselineHash, []]])
  for (const edge of edges) {
    const prefix = paths.get(edge.beforeHash)
    if (prefix && !paths.has(edge.afterHash)) paths.set(edge.afterHash, [...prefix, edge.id])
  }
  const chain = paths.get(currentHash)
  if (!chain || chain.length === 0) return null
  const chainSet = new Set(chain)
  const terminalIndex = Math.max(...chain.map((id) => edges.findIndex((edge) => edge.id === id)))
  const abandonedReceiptIDs = edges.slice(terminalIndex + 1)
    .filter((edge) => !chainSet.has(edge.id))
    .map((edge) => edge.id)
  return { receiptIDs: chain, abandonedReceiptIDs }
}

function independentHelpReason(request: WorkerHelpRequest, restoredPaths: string[]) {
  const problem = request.problem.replace(/\s+/g, " ").trim()
  const mentionsScopeFailure = /CHANGED_OUTSIDE_SCOPE_FILE|CHANGED_FILE_ACTION/i.test(problem)
    && restoredPaths.some((path) => problem.includes(path))
  if (!mentionsScopeFailure) return "The pending Help primary problem is independent of the healed Doctor scope finding."
  const independentEvidence = [request.problem, ...request.evidence, ...request.attemptedActions]
    .find((value) => /WORKFLOW GUARD BLOCKED|Guard learning|shell command|transactional allowlist|model loop|TEST_FAILURE|PARSE_ERROR|TYPECHECK/i.test(value))
  if (independentEvidence) {
    return "The pending Help contains an independent Guard or tool-use finding."
  }
  return null
}

function ineligible(reason: string, extras: Partial<ExactReceiptStartupPlan> = {}): ExactReceiptStartupPlan {
  return {
    status: "ineligible",
    reason,
    restorePaths: [],
    independentDoctorFindings: [],
    workerChangesSinceRevision: [],
    lastFailureAction: "keep",
    ...extras,
  }
}

export function planExactReceiptStartupReconciliation(input: ExactReceiptStartupInput): ExactReceiptStartupPlan {
  const { receipt, state, registration, ownership } = input
  if (receipt?.version !== 1 || receipt.status !== "complete" || receipt.contractMode !== "replace"
    || !receipt.contract || typeof receipt.completedAt !== "string") {
    return ineligible("Only a completed replace-mode Planner receipt is eligible.")
  }
  const taskHash = digest(input.taskContent)
  if (state?.status !== "started"
    || state.taskPath !== receipt.taskPath
    || state.taskHash !== receipt.taskHash
    || taskHash !== receipt.taskHash) {
    return ineligible("Receipt, active state, and current task bytes are not hash-aligned.")
  }
  if (registration?.status !== "registered"
    || registration.taskPath !== receipt.taskPath
    || registration.taskHash !== receipt.taskHash) {
    return ineligible("The active registration is not hash-aligned with the completed receipt.")
  }
  if (ownership?.taskPath !== receipt.taskPath
    || ownership.taskHash !== receipt.taskHash
    || ownership.source !== "active_revision"
    || !ownership.plannerSessionID
    || ownership.plannerSessionID !== state.taskRevision?.plannerSessionID) {
    return ineligible("Planner ownership is not hash- and revision-aligned with the completed receipt.")
  }
  if (state.taskRevision?.previousTaskHash !== receipt.initialTaskHash
    || state.taskRevision?.revisedTaskHash !== receipt.taskHash
    || !state.taskRevision?.revisedAt) {
    return ineligible("The active taskRevision does not describe this exact completed replacement.")
  }
  const exactGaps = plannerRecoveryContractExactGaps(input.taskContent, receipt.contract)
  if (exactGaps.length > 0) return ineligible(`The current task no longer matches the exact receipt: ${exactGaps[0]}`)

  const parsedTask = parsePlannerTask(input.taskContent)
  if (!parsedTask || JSON.stringify(normalizedScope(parsedTask.scope)) !== JSON.stringify(normalizedScope(receipt.contract.scope))) {
    return ineligible("The current parsed Scope is not the exact replacement Scope.")
  }

  const revisedAt = Date.parse(state.taskRevision.revisedAt)
  const completedAt = Date.parse(receipt.completedAt)
  if (!Number.isFinite(revisedAt) || !Number.isFinite(completedAt) || completedAt < revisedAt) {
    return ineligible("The completed receipt and active revision timestamps are invalid or out of order.")
  }
  const receiptWorkerChanges = input.appliedWorkerChanges.filter((change) => (
    change.status === "applied"
    && change.taskPath === receipt.taskPath
    && ((change.taskHash === receipt.taskHash) || (change.appliedAt && Date.parse(change.appliedAt) >= revisedAt))
  )).flatMap((change) => change.files.map((file) => canonicalPath(file.path)).filter((path): path is string => Boolean(path)))
  const workerChangesSinceRevision = [...new Set([
    ...receiptWorkerChanges,
    ...(input.workerMutationPathsSinceRevision ?? []).map(canonicalPath).filter((path): path is string => Boolean(path)),
  ])].sort()
  if (workerChangesSinceRevision.length > 0) {
    return ineligible("A Worker changed application paths after the exact revision; startup reconciliation must not erase or classify that work.", {
      taskPath: receipt.taskPath,
      taskHash: receipt.taskHash,
      workerChangesSinceRevision,
    })
  }

  const failure = input.lastDoctorFailure
  if (!failure || failure.taskPath !== receipt.taskPath || failure.gate !== "verify" || !failure.sessionID) {
    return {
      status: "noop",
      reason: "There is no matching Worker Doctor verify failure to reconcile.",
      taskPath: receipt.taskPath,
      taskHash: receipt.taskHash,
      restorePaths: [],
      independentDoctorFindings: [],
      workerChangesSinceRevision: [],
      lastFailureAction: "keep",
    }
  }
  const hashBoundFailureHelp = (input.workerHelp?.requests ?? []).filter((request) => (
    request.status === "pending"
    && request.taskPath === receipt.taskPath
    && request.taskHash === receipt.taskHash
    && request.workerSessionID === failure.sessionID
  ))
  const legacyFailureTime = typeof failure.failedAt === "string" ? Date.parse(failure.failedAt) : Number.NaN
  const failureHashAligned = failure.taskHash === receipt.taskHash
    || (failure.taskHash === undefined
      && hashBoundFailureHelp.length === 1
      && Number.isFinite(legacyFailureTime)
      && legacyFailureTime >= revisedAt)
  if (!failureHashAligned) {
    return ineligible("The Doctor failure is not bound to the exact task hash, directly or through one matching pending Worker Help.", {
      taskPath: receipt.taskPath,
      taskHash: receipt.taskHash,
    })
  }
  const findings = doctorScopeFindings(failure.output ?? "")
  const outsidePaths = [...new Set(findings
    .filter((finding) => finding.code === "CHANGED_OUTSIDE_SCOPE_FILE" && finding.path)
    .map((finding) => finding.path!))]
  const independentDoctorFindings = findings.filter((finding) => (
    finding.code !== "CHANGED_OUTSIDE_SCOPE_FILE" && finding.code !== "CHANGED_FILE_ACTION"
  ))
  if (outsidePaths.length === 0 || independentDoctorFindings.length > 0) {
    return ineligible("The Doctor failure is not exclusively a healed out-of-scope change.", {
      taskPath: receipt.taskPath,
      taskHash: receipt.taskHash,
      independentDoctorFindings,
    })
  }

  const currentScope = new Set(normalizedScope(receipt.contract.scope))
  const relevantFiles = new Set((receipt.relevantFiles ?? []).map(canonicalPath).filter((path): path is string => Boolean(path)))
  const protectedPaths = (input.protectedPaths ?? [".opencode", ".task-doctor", "scripts/task-doctor.mjs"])
    .map(canonicalPath).filter((path): path is string => Boolean(path))
  const restorePaths: ExactReceiptRestorePath[] = []
  for (const path of outsidePaths) {
    const baselineHash = state.snapshot?.[path]
    const registrationHash = registration.snapshot?.[path]
    const currentHash = input.currentHashes[path]
    const source = input.baselineSources[path]
    if (path === receipt.taskPath || currentScope.has(path) || !relevantFiles.has(path) || pathIsProtected(path, protectedPaths)) {
      return ineligible(`The reported path is not an exclusively healed evidence path: ${path}`, { taskPath: receipt.taskPath, taskHash: receipt.taskHash })
    }
    if (typeof baselineHash !== "string" || typeof registrationHash !== "string" || typeof currentHash !== "string"
      || currentHash === baselineHash || registrationHash !== currentHash) {
      return ineligible(`Snapshot, registration, and current hashes do not prove a pre-revision changed file: ${path}`, { taskPath: receipt.taskPath, taskHash: receipt.taskHash })
    }
    if (!source || source.hash !== baselineHash) {
      return ineligible(`No trusted baseline bytes match state.snapshot for ${path}.`, { taskPath: receipt.taskPath, taskHash: receipt.taskHash })
    }
    const provenance = provenanceToCurrent(path, receipt.taskPath, baselineHash, currentHash, input.appliedWorkerChanges)
    if (!provenance) {
      return ineligible(`Applied Worker receipts do not prove the current changed bytes from state.snapshot for ${path}.`, { taskPath: receipt.taskPath, taskHash: receipt.taskHash })
    }
    restorePaths.push({
      path,
      baselineHash,
      currentHash,
      baselineSource: source.source,
      provenanceReceiptIDs: provenance.receiptIDs,
      abandonedReceiptIDs: provenance.abandonedReceiptIDs,
    })
  }

  const pending = (input.workerHelp?.requests ?? []).filter((request) => (
    request.status === "pending"
    && request.taskPath === receipt.taskPath
    && request.taskHash === receipt.taskHash
  ))
  let helpAction: ExactReceiptHelpAction | undefined
  if (pending.length === 1 && pending[0].workerSessionID === failure.sessionID) {
    const request = pending[0]
    const independentReason = independentHelpReason(request, restorePaths.map((entry) => entry.path))
    helpAction = independentReason
      ? { action: "keep", requestID: request.id, workerSessionID: request.workerSessionID, reason: independentReason }
      : {
          action: "obsolete",
          requestID: request.id,
          workerSessionID: request.workerSessionID,
          reason: "The exact replacement removed the reported evidence path from mutation Scope and trusted startup reconciliation restored its task-start bytes.",
          closureReason: "exact_scope_reconciled",
          restoredPaths: restorePaths.map((entry) => entry.path),
        }
  } else if (pending.length > 0) {
    const request = pending.at(-1)!
    helpAction = {
      action: "keep",
      requestID: request.id,
      workerSessionID: request.workerSessionID,
      reason: "Pending Help does not uniquely match the Worker that produced the reconciled Doctor failure.",
    }
  }

  return {
    status: "ready",
    reason: "The completed exact replacement safely isolates the reported pre-revision evidence-path drift.",
    taskPath: receipt.taskPath,
    taskHash: receipt.taskHash,
    restorePaths,
    independentDoctorFindings: [],
    workerChangesSinceRevision: [],
    lastFailureAction: "resolve",
    helpAction,
  }
}

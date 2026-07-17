import { tool, type Plugin } from "@opencode-ai/plugin"
import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { AsyncLocalStorage } from "node:async_hooks"
import { knownStableGuardRule, learnedGuardRuleFromSources, stableGuardViolationId } from "../lib/guard-learning.ts"
import {
  canonicalBlockedHandoff,
  changedSnapshotPaths,
  claimsReviewableHandoff,
  reviewableHandoffError,
  workerReturnIssue,
} from "../lib/review-contract.ts"
import { CUSTOM_MODEL_TOOL_NAMES, formatModelInputError, repairModelInput } from "../lib/model-input.ts"
import {
  canonicalUniqueNpmScript,
  hasTechnicalOperationEvidence,
  scopePathFormatError,
  shellCommandMutates,
  stripHarmlessOutputSuffix,
} from "../lib/workflow-guard-rules.ts"
import {
  canonicalWorkerDoctorCommand,
  isDoctorCommand,
  parseDoctorInvocation,
} from "../lib/doctor-command.ts"
import {
  runMechanicalDoctorVerify,
  validateMechanicalDoctorRun,
  type ValidatedMechanicalDoctorRun,
} from "../lib/mechanical-doctor.ts"
import {
  forgetWorkerHarnessRecoveryTerminal,
  loadWorkerHarnessRecoveryTerminals,
  rememberWorkerHarnessRecoveryTerminal,
} from "../lib/worker-harness-recovery-terminals.ts"
import { projectMemoryRecoveryStatus, recoverProjectMemory } from "../lib/project-memory.ts"
import { appendTaskMemory } from "../lib/task-memory.ts"
import {
  mergePlannerTaskRevision,
  normalizePlannerVerifyCommandSyntax,
  parsePlannerTask,
  plannerTaskCoverageGaps,
  renderPlannerTask,
} from "../lib/planner-task.ts"
import {
  canonicalPlannerRecoveryContract,
  plannerRecoveryContractExactGaps,
  plannerRecoveryContractGaps,
  type PlannerRecoveryContract,
} from "../lib/planner-recovery-contract.ts"
import { recoverTaskHarness, taskHarnessRecoveryStatus } from "../lib/task-harness-recovery.ts"
import {
  matchingWorkerModelFamily,
  workerModelFamiliesFromConfig,
} from "../lib/worker-model-rules.ts"
import {
  agentModelRef,
  modelRefString,
  resolveWorkerRecoveryBoost,
  workerRecoveryBoostAgentAvailable,
  WORKER_RECOVERY_BOOST_AGENT,
} from "../lib/worker-recovery-boost.ts"
import {
  applyWorkerChanges,
  cleanupWorkerChangesForSession,
  cleanupWorkerChangesForTask,
  discardWorkerChanges,
  readWorkerChangeBaseline,
  previewWorkerChanges,
  selectLatestPendingWorkerChange,
  type WorkerChangeOperation,
  type WorkerChangePolicy,
} from "../lib/worker-changes.ts"
import {
  applyWorkerScopeRecoveryPlan,
  planWorkerScopeRecovery,
  readWorkerScopeRecoveryReceipts,
  type WorkerScopeRecoveryPlan,
} from "../lib/worker-scope-recovery.ts"
import {
  doctorScopeFindings,
  planExactReceiptStartupReconciliation,
  type TrustedBaselineSource,
} from "../lib/exact-receipt-startup.ts"
import {
  doctorFailureFingerprint,
  loopFailureFingerprint,
  replaceOccurrenceMismatches,
  restoreOnlyOutsideScopeFailure,
  type LoopFailureFingerprint,
  type RestoreOnlyOutsideScopeFailure,
  type WorkerHelpRequest,
  type WorkerHelpStore,
} from "../lib/worker-help.ts"
import {
  claimPlannerOwnership,
  plannerOwnershipPath,
  readPlannerOwnership,
  type PlannerOwnership,
} from "../lib/planner-ownership.ts"
import { isOrnithModelIdentity, OrnithModelDriver, type DriverWorkflowState } from "./model-drivers/ornith.ts"
import { renderAuthoritativeWorkflow } from "../lib/workflow-engine/authoritative-state.ts"
import {
  guardNotice,
  renderGuardNotice,
  renderWorkflowGuardMessage,
  workflowAction,
} from "../lib/workflow-engine/notices.ts"
import { WorkflowRuntimeState } from "../lib/workflow-engine/runtime-state.ts"
import { readAuthoritativeWorkflowSnapshot as readWorkflowSnapshot } from "../lib/workflow-engine/snapshot.ts"
import { executeWorkflowEffects, reduceWorkflow } from "../lib/workflow-engine/engine.ts"
import { clearFailures, recordFailure } from "../lib/workflow-engine/failure-window.ts"
import type { AuthoritativeWorkflowDecision, WorkflowAction } from "../lib/workflow-engine/types.ts"

type Feature =
  | "modeGuard"
  | "taskStartGuard"
  | "planningEnforcer"
  | "plannerCompletionGuard"
  | "taskMemoryAppend"
  | "completionAuditor"
  | "failureFeedback"
  | "repetitionDetector"
  | "contextCheckpoint"
  | "idleReview"
  | "todoDiscipline"
  | "internalFileGuard"
  | "authoritativeContinuationState"
  | "userPermissionEscalation"
  | "taskChangePermission"
  | "dependencyInstallPermission"
  | "plannerQuestionEnforcer"
  | "guardLearning"
  | "executorReview"
  | "workerHelp"
  | "plannerRecovery"
  | "executorBaselineRecovery"
  | "transactionalWorkerChanges"
  | "workerSessionArchive"

type GuardConfig = Record<Feature, boolean>

const DEFAULTS: GuardConfig = {
  modeGuard: true,
  taskStartGuard: true,
  planningEnforcer: true,
  plannerCompletionGuard: true,
  taskMemoryAppend: true,
  completionAuditor: true,
  failureFeedback: true,
  repetitionDetector: true,
  contextCheckpoint: true,
  idleReview: true,
  todoDiscipline: true,
  internalFileGuard: true,
  authoritativeContinuationState: true,
  userPermissionEscalation: true,
  taskChangePermission: true,
  dependencyInstallPermission: true,
  plannerQuestionEnforcer: true,
  guardLearning: true,
  executorReview: true,
  workerHelp: true,
  plannerRecovery: true,
  executorBaselineRecovery: true,
  transactionalWorkerChanges: false,
  workerSessionArchive: false,
}

type GuardViolation = {
  id: string
  problem: string
  action: string
  agent?: string
}

type LearnedGuardRule = {
  id: string
  canonicalID: string
  path: string
  rule: string
}

type ActivePlannerRecovery = {
  executorSessionID: string
  taskPath: string
  taskHash: string
  lifecycle: "active" | "prestart"
  userRequest?: string
  contract: PlannerRecoveryContract
  exactContract: boolean
  supersededTasks: Set<string>
  problem: string
  evidence: string[]
  expectedResults: string[]
  relevantFiles: string[]
  helpID?: string
  resolved?: { taskHash: string; output: string }
}

type ExplicitPlannerRecoveryRequest = {
  text: string
  messageID: string
}

type ReviewWorkerHelpModelArgs = {
  help_id?: string
  task_path: string
  decision: "retry_worker" | "planner_recovery"
  root_cause: string
  retry_strategy: string
  expected_results: string[]
  reviewed_files: string[]
  contract_mode?: "replace"
  required_scope?: string[]
  required_requirements?: string[]
  required_verify?: string[]
}

type ExplicitPlannerReviewReceipt = {
  version: 1
  status: "pending" | "complete"
  executorSessionID: string
  userMessageID: string
  userRequestHash: string
  taskPath: string
  initialTaskHash: string
  taskHash: string
  contractMode?: "merge" | "replace"
  completedForMessageID?: string
  requestedAt: string
  contract?: PlannerRecoveryContract
  relevantFiles?: string[]
  problem?: string
  evidence?: string[]
  expectedResults?: string[]
  automaticContinuationAttempts?: number
  automaticContinuationAt?: string
  completedAt?: string
  lastError?: string
}

type GuardErrorFormatter = (problem: string, action: string, success?: string) => Error

const guardErrorContext = new AsyncLocalStorage<{ format: GuardErrorFormatter }>()

const DEFAULT_PROTECTED_PATHS = ["scripts/task-doctor.mjs", ".task-doctor", ".opencode"]

const DEFAULT_TASK_COMPACTION_THRESHOLD_PERCENT = 70
const DEFAULT_WORKER_HELP_FAILURE_THRESHOLD = 3
const DEFAULT_DOCTOR_FAILURE_THRESHOLD = 2
const DEFAULT_LONG_DOCTOR_FAILURE_MS = 2 * 60_000
const DEFAULT_DOCTOR_VERIFY_TIMEOUT_MS = 10 * 60_000
const writeTools = new Set(["write", "edit", "patch", "apply_patch", "multiedit"])
const planningPath = /^kanban\/todo\/[^/]+\.md$/
const doctorCommandMention = /(?:task:doctor:|scripts\/task-doctor\.mjs)/
const opaqueInlineCommand = /(?:^|[;&|]\s*)(?:(?:node|bun)\b[^;&|\n]*\s(?:-e|--eval|-p|--print)(?=\s|=)|deno\s+eval\b|python(?:3)?\s+-c\b|ruby\s+-e\b|perl\s+-e\b|php\s+-r\b)/
const dependencyInstallCommand = /(?:^|[;&|]\s*)(?:npm\s+(?:install|i)\b|(?:pnpm|yarn|bun)\s+(?:add|install)\b)/
const plannerAppCommand = /^npm\s+run\s+app:(?:status|start|stop|restart)\s*$/
const workerPortCommand = /^npm\s+run\s+app:clear-ports\s*$/
const workerRulesPath = /^WORKER(?:-[A-Za-z0-9._-]+)?\.md$/
const batchPattern = /(?:\bbatch\b|\ball tasks\b|\bremaining tasks\b|\bopen tasks\b|\balle tasks\b|\balles abarbeiten\b|\balle aufgaben\b|\bsämtliche tasks\b|\b(?:offene|offenen|offener|offenes|verbleibende|verbleibenden|verbleibender|verbleibendes)\s+(?:kanban[- ]?)?(?:tasks?|aufgaben)\b|\b(?:kanban[- ]?)?(?:tasks?|aufgaben)\s+(?:vollständig|komplett)\s+(?:ab(?:arbeiten)?|erledigen)\b|übrige[nr]? tasks|\brestliche[nr]? tasks\b)/i
const packageLockNames = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]

function coalesceLlamaCppSystemMessages(
  model: { providerID?: string } | undefined,
  output: { system: string[] },
) {
  if (model?.providerID !== "llamacpp-local") return
  const merged = output.system.filter((block) => typeof block === "string" && block.length > 0).join("\n\n")
  output.system.splice(0, output.system.length, ...(merged ? [merged] : []))
}

function doctorInvocation(command: string) {
  return parseDoctorInvocation(command)
}

function canonicalPlannerDoctorCommand(command: string) {
  const value = command.trim()
  if (!/^npm\s+run\s+task:doctor:/.test(value) || /[;&|><`\n]|\$\(/.test(value)) return null
  if (/task:doctor:schedule\b/.test(value)) return "npm run task:doctor:schedule"
  if (/task:doctor:next\b/.test(value)) return "npm run task:doctor:next"
  const gate = value.match(/task:doctor:(lint|register)\b/)?.[1]
  const tasks = [...new Set(value.match(/kanban\/todo\/[A-Za-z0-9._-]+\.md/g) ?? [])]
  return gate && tasks.length === 1 ? `npm run task:doctor:${gate} -- ${tasks[0]}` : null
}

function stripProjectCdPrefix(root: string, command: string) {
  const match = command.trim().match(/^cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*&&\s*(.+)$/s)
  if (!match) return command
  const directory = match[1] ?? match[2] ?? match[3]
  return resolve(directory) === resolve(root) ? match[4].trim() : command
}

function canonicalPlannerPackageScriptsCommand(root: string, command: string) {
  const value = command.trim()
  if (/[;&|><`\n]|\$\(/.test(value)) return null
  const match = value.match(/^npm\s+(?:run\s+)?--prefix(?:=|\s+)(["']?)([A-Za-z0-9._/-]+)\1(?:\s+run)?\s*$/)
  if (!match) return null
  const prefix = normalize(root, match[2])
  if (!prefix) return null
  const manifest = prefix === "." ? "package.json" : `${prefix}/package.json`
  return existsSync(resolve(root, manifest)) ? `jq '.scripts' ${manifest}` : null
}

function projectNpmScriptNames(root: string) {
  const scripts = readJson(resolve(root, "package.json"))?.scripts
  return scripts && typeof scripts === "object" && !Array.isArray(scripts)
    ? Object.keys(scripts)
    : []
}

function plannerReadOnlyCommand(command: string) {
  const value = command.trim()
  if (!value || /[;&|><`\n]|\$\(/.test(value)) return false
  if (value === "pwd") return true
  if (/^(?:ls|rg|cat|head|tail|wc|jq|stat|lsof|ps|pgrep)(?:\s|$)/.test(value)) return true
  if (/^sed\s+-n(?:\s|$)/.test(value)) return true
  return /^git\s+(?:status|diff|log|show)(?:\s|$)/.test(value)
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function fileHash(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

function projectRoot(start: string) {
  let current = resolve(start)
  while (true) {
    if (existsSync(resolve(current, "project.json"))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(start)
    current = parent
  }
}

function openCodeSettings(root: string) {
  return readJson(resolve(root, "project.json"))?.settings?.opencode ?? {}
}

function ornithDriverConfigFor(root: string) {
  return openCodeSettings(root).modelDrivers?.ornith ?? {}
}

function modelIdentity(model: unknown): string {
  if (!model || typeof model !== "object") return ""
  const value = model as Record<string, unknown>
  return [value.providerID, value.id, value.modelID, value.name]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("/")
}

function configFor(root: string): GuardConfig {
  const configured = openCodeSettings(root).workflowGuard ?? {}
  return Object.fromEntries(
    Object.entries(DEFAULTS).map(([key, fallback]) => [key, typeof configured[key] === "boolean" ? configured[key] : fallback]),
  ) as GuardConfig
}

function protectedPathsFor(root: string) {
  const configured = openCodeSettings(root).protectedAgentPaths
  return Array.isArray(configured) && configured.every((value) => typeof value === "string")
    ? configured.map((value) => String(value).replace(/^\.\//, "").replace(/\/$/, ""))
    : DEFAULT_PROTECTED_PATHS
}

function readOnlyPathsFor(root: string) {
  const configured = openCodeSettings(root).readOnlyAgentPaths
  return Array.isArray(configured) && configured.every((value) => typeof value === "string")
    ? configured.map((value) => String(value).replace(/^\.\//, "").replace(/\/$/, ""))
    : []
}

function taskCompactionThresholdPercentFor(root: string) {
  const configured = openCodeSettings(root).taskCompactionThresholdPercent
  const value = typeof configured === "string" ? Number(configured) : configured
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
    ? value
    : DEFAULT_TASK_COMPACTION_THRESHOLD_PERCENT
}

function workerHelpFailureThresholdFor(root: string) {
  const configured = openCodeSettings(root).workerHelp?.failureThreshold
  const value = typeof configured === "string" ? Number(configured) : configured
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 10
    ? value
    : DEFAULT_WORKER_HELP_FAILURE_THRESHOLD
}

function doctorFailureThresholdFor(root: string) {
  const configured = openCodeSettings(root).workerHelp?.doctorFailureThreshold
  const value = typeof configured === "string" ? Number(configured) : configured
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 10
    ? value
    : DEFAULT_DOCTOR_FAILURE_THRESHOLD
}

function longDoctorFailureMsFor(root: string) {
  const configured = openCodeSettings(root).workerHelp?.longDoctorFailureMs
  const value = typeof configured === "string" ? Number(configured) : configured
  return typeof value === "number" && Number.isInteger(value) && value >= 30_000 && value <= 8 * 60_000
    ? value
    : DEFAULT_LONG_DOCTOR_FAILURE_MS
}

function doctorVerifyTimeoutMsFor(root: string) {
  const configured = openCodeSettings(root).workflowGuard?.doctorVerifyTimeoutMs
  const value = typeof configured === "string" ? Number(configured) : configured
  return typeof value === "number" && Number.isInteger(value) && value >= 120_000 && value <= 30 * 60_000
    ? value
    : DEFAULT_DOCTOR_VERIFY_TIMEOUT_MS
}

function modeSettingsFor(root: string) {
  const configured = openCodeSettings(root).modes ?? {}
  const strings = (value: unknown, fallback: string[]) => Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : fallback
  return {
    plannerAgents: new Set(strings(configured.plannerAgents, ["planner"]).map((value) => value.toLowerCase())),
    executorAgents: new Set(strings(configured.executorAgents, ["executor"]).map((value) => value.toLowerCase())),
    workerAgents: new Set([...strings(configured.workerAgents, ["worker"]), WORKER_RECOVERY_BOOST_AGENT].map((value) => value.toLowerCase())),
    plannerWritablePaths: strings(configured.plannerWritablePaths, ["kanban/todo", "MEMORY.md"]).map((value) => value.replace(/^\.\//, "").replace(/\/$/, "")),
  }
}

function normalize(root: string, path: string) {
  const absolute = resolve(root, path)
  const rel = relative(root, absolute).split("\\").join("/")
  return rel.startsWith("../") ? null : rel
}

const customModelToolNames = new Set<string>(CUSTOM_MODEL_TOOL_NAMES)
const WORKFLOW_PAYLOAD_KEY = "__workflow_payload"

function workflowToolPayload(toolName: string, input: unknown) {
  if (!customModelToolNames.has(toolName) || !input || typeof input !== "object" || Array.isArray(input)) return input
  const payload = (input as Record<string, unknown>)[WORKFLOW_PAYLOAD_KEY]
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : input
}

function mechanicalWorkerHelpReviewSelector(root: string, input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false as const, reason: "review_worker_help input must be an object." }
  }
  const outer = input as Record<string, unknown>
  const hasPayload = Object.prototype.hasOwnProperty.call(outer, WORKFLOW_PAYLOAD_KEY)
  const rawPayload = outer[WORKFLOW_PAYLOAD_KEY]
  if (hasPayload && (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload))) {
    return { ok: false as const, reason: "review_worker_help __workflow_payload must be an object." }
  }
  const unwrapped = workflowToolPayload("review_worker_help", input)
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) {
    return { ok: false as const, reason: "review_worker_help payload must be an object." }
  }
  const payload = unwrapped as Record<string, unknown>
  const canonicalTaskPath = (value: unknown) => {
    if (typeof value !== "string" || value.length === 0) return null
    const path = normalize(root, value)
    return path && path === value ? path : null
  }
  const canonicalHelpID = (value: unknown) => (
    typeof value === "string" && /^H\d+$/i.test(value) ? value.toLowerCase() : null
  )
  const payloadHasTaskPath = Object.prototype.hasOwnProperty.call(payload, "task_path")
  const activeTaskPath = activeState(root)?.taskPath
  const taskPath = payloadHasTaskPath
    ? canonicalTaskPath(payload.task_path)
    : canonicalTaskPath(activeTaskPath)
  if (!taskPath) {
    return { ok: false as const, reason: "review_worker_help requires one explicit or active canonical project-relative task path." }
  }
  const payloadHasHelpID = Object.prototype.hasOwnProperty.call(payload, "help_id")
  const helpID = payloadHasHelpID ? canonicalHelpID(payload.help_id) : null
  if (payloadHasHelpID && !helpID) {
    return { ok: false as const, reason: "review_worker_help payload help_id must match H<digits>." }
  }

  if (hasPayload && Object.prototype.hasOwnProperty.call(outer, "task_path")) {
    const outerTaskPath = canonicalTaskPath(outer.task_path)
    if (!outerTaskPath || outerTaskPath !== taskPath) {
      return { ok: false as const, reason: "review_worker_help outer task_path conflicts with __workflow_payload.task_path." }
    }
  }
  if (hasPayload && Object.prototype.hasOwnProperty.call(outer, "help_id")) {
    const outerHelpID = canonicalHelpID(outer.help_id)
    if (!outerHelpID || outerHelpID !== helpID) {
      return { ok: false as const, reason: "review_worker_help outer help_id conflicts with __workflow_payload.help_id." }
    }
  }
  return { ok: true as const, taskPath, helpID }
}

function readableToolCallDescription(toolName: string, args: Record<string, unknown>) {
  const taskName = typeof args.task_path === "string" ? basename(args.task_path) : null
  const firstOperation = Array.isArray(args.operations) && args.operations[0] && typeof args.operations[0] === "object"
    ? args.operations[0] as Record<string, unknown>
    : [args.path, args.file_path, args.filePath].some((value) => typeof value === "string" && value.length > 0)
      ? args
      : null
  const operationPath = firstOperation
    ? [firstOperation.path, firstOperation.file_path, firstOperation.filePath].find((value): value is string => typeof value === "string" && value.length > 0)
    : null
  const operationKind = firstOperation
    ? [firstOperation.kind, firstOperation.operation].find((value): value is string => typeof value === "string" && value.length > 0)
    : null
  const changeID = typeof args.change_id === "string" ? args.change_id : null
  const suppliedDescription = typeof args.description === "string" ? args.description.replace(/\s+/g, " ").trim() : null
  const helpID = typeof args.help_id === "string" ? args.help_id : "pending help"
  const decision = typeof args.decision === "string" ? args.decision.replaceAll("_", " ") : null
  const category = typeof args.category === "string" ? args.category.replaceAll("_", " ") : null
  const descriptions: Record<string, string | null> = {
    register_planner_task: taskName ? `Register Planner task: ${taskName}` : "Register Planner task",
    preview_worker_changes: operationPath
      ? `Preview ${operationKind ?? "change"}: ${basename(operationPath)}`
      : suppliedDescription ? `Preview Worker change - ${suppliedDescription}` : "Preview Worker change",
    apply_worker_changes: `Apply Worker change${changeID ? ` ${changeID}` : ""}${taskName ? `: ${taskName}` : ""}`,
    verify_worker_task: "Verify active Worker task",
    discard_worker_changes: `Discard Worker change${changeID ? ` ${changeID}` : ""}`,
    revise_active_task: taskName ? `Revise active task: ${taskName}` : "Revise active task",
    supersede_registered_task: taskName ? `Supersede task: ${taskName}` : "Supersede registered task",
    escalate_to_planner: taskName ? `Return task to Planner: ${taskName}` : "Return task to Planner",
    recover_harness_baseline: taskName ? `Recover Harness baseline: ${taskName}` : "Recover Harness baseline",
    recover_project_memory: "Recover project memory",
    append_task_memory: taskName ? `Append task memory: ${taskName}` : "Append task memory",
    request_executor_help: `Request Executor help${category ? `: ${category}` : ""}`,
    review_worker_help: `Review ${helpID}${decision ? `: ${decision}` : ""}`,
    submit_task_review: taskName ? `Submit task review: ${taskName}` : "Submit task review",
    record_guard_learning: "Record pending Guard learnings",
    request_command_permission: "Request command permission",
    request_task_change_permission: taskName ? `Request task change: ${taskName}` : "Request task change",
    request_dependency_install_permission: "Request dependency permission",
  }
  return descriptions[toolName]?.slice(0, 160) ?? null
}

function doctorProject(root: string) {
  return existsSync(resolve(root, "scripts/task-doctor.mjs"))
}

function run(root: string, command: string, args: string[] = []) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 })
}

function todoTasks(root: string) {
  const directory = resolve(root, "kanban/todo")
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((name) => name.endsWith(".md")).sort()
}

function taskRegistrationValid(root: string, name: string) {
  const taskPath = resolve(root, "kanban/todo", name)
  const registration = readJson(resolve(root, ".task-doctor/registrations", `${name}.json`))
  return Boolean(registration?.status === "registered" && registration.taskHash === hash(readFileSync(taskPath, "utf8")))
}

function plannerOwnedTodoTasks(root: string, sessionID: string) {
  return todoTasks(root)
    .map((name) => `kanban/todo/${name}`)
    .filter((taskPath) => readPlannerOwnership(root, taskPath)?.plannerSessionID === sessionID)
}

function activeState(root: string) {
  return readJson(resolve(root, ".task-doctor/state.json"))
}

function plannerRecoveryState(root: string) {
  return readJson(resolve(root, ".task-doctor/planner-recovery.json"))
}

type WorkerHelpStoreTransaction = {
  store: WorkerHelpStore
  original: string
}

const workerHelpStoreTransactions = new Map<string, WorkerHelpStoreTransaction>()
let workerHelpTempSequence = 0

function workerHelpStoreFiles(root: string) {
  const directory = resolve(root, ".task-doctor")
  return {
    directory,
    primary: resolve(directory, "worker-help.json"),
    backup: resolve(directory, "worker-help.backup.json"),
  }
}

function ensurePrivateWorkerHelpDirectory(root: string) {
  const { directory } = workerHelpStoreFiles(root)
  if (existsSync(directory)) {
    const info = lstatSync(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`WORKER HELP STORE UNSAFE: ${directory} must be a real directory, not a symlink.`)
    }
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  chmodSync(directory, 0o700)
  return directory
}

function assertWorkerHelpFileSafe(path: string) {
  if (!existsSync(path)) return
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`WORKER HELP STORE UNSAFE: ${path} must be a regular file, not a symlink.`)
  }
  chmodSync(path, 0o600)
}

function validWorkerHelpStore(value: unknown): value is WorkerHelpStore {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<WorkerHelpStore>
  if (candidate.version !== 1 || !Array.isArray(candidate.requests)) return false
  const ids = new Set<string>()
  for (const request of candidate.requests) {
    if (!request || typeof request !== "object" || typeof request.id !== "string" || !/^H\d+$/i.test(request.id)) return false
    if (ids.has(request.id)) return false
    ids.add(request.id)
  }
  return true
}

function parseWorkerHelpStoreFile(path: string) {
  assertWorkerHelpFileSafe(path)
  if (!existsSync(path)) return { status: "missing" as const }
  const text = readFileSync(path, "utf8")
  try {
    const store = JSON.parse(text)
    return validWorkerHelpStore(store)
      ? { status: "valid" as const, store, text }
      : { status: "invalid" as const }
  } catch {
    return { status: "invalid" as const }
  }
}

function fsyncWorkerHelpDirectory(directory: string) {
  const descriptor = openSync(directory, fsConstants.O_RDONLY)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function atomicWriteWorkerHelpFile(root: string, destination: string, text: string) {
  const directory = ensurePrivateWorkerHelpDirectory(root)
  assertWorkerHelpFileSafe(destination)
  const temporary = resolve(directory, `.worker-help.${process.pid}.${++workerHelpTempSequence}.tmp`)
  const descriptor = openSync(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  )
  let closed = false
  try {
    writeFileSync(descriptor, text, "utf8")
    fsyncSync(descriptor)
    closeSync(descriptor)
    closed = true
    renameSync(temporary, destination)
    fsyncWorkerHelpDirectory(directory)
  } catch (error) {
    if (!closed) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }
}

function durableWorkerHelpStore(root: string): WorkerHelpStore {
  const { primary, backup } = workerHelpStoreFiles(root)
  ensurePrivateWorkerHelpDirectory(root)
  const main = parseWorkerHelpStoreFile(primary)
  const recovery = parseWorkerHelpStoreFile(backup)

  if (main.status === "valid") {
    if (recovery.status !== "valid" || recovery.text !== main.text) {
      atomicWriteWorkerHelpFile(root, backup, main.text)
    }
    return main.store
  }
  if (recovery.status === "valid") {
    atomicWriteWorkerHelpFile(root, primary, recovery.text)
    return recovery.store
  }
  if (main.status === "missing" && recovery.status === "missing") {
    return { version: 1, requests: [], updatedAt: new Date(0).toISOString() }
  }
  throw new Error("WORKER HELP STORE CORRUPT: neither worker-help.json nor its durable backup is valid; refusing to continue with an empty workflow.")
}

function serializeWorkerHelpStore(store: WorkerHelpStore) {
  return `${JSON.stringify({
    ...store,
    version: 1,
    requests: store.requests.slice(-200),
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`
}

function publishWorkerHelpStore(root: string, store: WorkerHelpStore) {
  const { primary, backup } = workerHelpStoreFiles(root)
  const text = serializeWorkerHelpStore(store)
  // Publish the recovery copy first. Until the primary rename commits, the old
  // primary remains authoritative; after it commits, both contain the new state.
  atomicWriteWorkerHelpFile(root, backup, text)
  atomicWriteWorkerHelpFile(root, primary, text)
}

function mutateWorkerHelpStore<T>(root: string, mutation: (store: WorkerHelpStore) => T): T {
  const key = workerHelpStoreFiles(root).primary
  const active = workerHelpStoreTransactions.get(key)
  if (active) return mutation(active.store)

  const store = durableWorkerHelpStore(root)
  const transaction = { store, original: JSON.stringify(store) }
  workerHelpStoreTransactions.set(key, transaction)
  try {
    const result = mutation(store)
    if (JSON.stringify(store) !== transaction.original) publishWorkerHelpStore(root, store)
    return result
  } finally {
    workerHelpStoreTransactions.delete(key)
  }
}

function workerHelpStore(root: string): WorkerHelpStore {
  return workerHelpStoreTransactions.get(workerHelpStoreFiles(root).primary)?.store
    ?? durableWorkerHelpStore(root)
}

function latestWorkerHelp(root: string, taskPath: string | null, taskHash?: string | null) {
  if (!taskPath) return null
  return [...workerHelpStore(root).requests].reverse().find((request) => (
    request.taskPath === taskPath
    && (!taskHash || request.taskHash === taskHash)
  )) ?? null
}

function currentWorkerHelp(root: string, taskPath: string | null, taskHash?: string | null) {
  const latest = latestWorkerHelp(root, taskPath, taskHash)
  return latest && !["delegated", "resolved", "obsolete"].includes(latest.status) ? latest : null
}

function reviewLogPath(root: string, taskPath: string) {
  return resolve(root, ".task-doctor/reviews", `${taskPath.split("/").pop()}.json`)
}

function changedFilesForReview(root: string, state: any): string[] {
  const report = typeof state?.reportPath === "string" ? readJson(resolve(root, state.reportPath)) : null
  return Array.isArray(report?.changedFiles)
    ? [...new Set<string>(report.changedFiles.filter((path: unknown): path is string => typeof path === "string"))].sort()
    : changedSnapshotPaths(state?.snapshot ?? {}, state?.verifiedSnapshot ?? {})
}

function authoritativeWorkflowState(root: string) {
  const transition = reduceWorkflow({ type: "authoritative.snapshot", snapshot: readWorkflowSnapshot({
    doctorState: () => activeState(root),
    checkpoint: () => readJson(resolve(root, ".task-doctor/workflow-checkpoint.json")),
    lastDoctorFailure: () => readJson(resolve(root, ".task-doctor/last-doctor-failure.json")),
    openTasks: () => todoTasks(root).map((name) => `kanban/todo/${name}`),
    currentHelp: (taskPath, taskHash) => currentWorkerHelp(root, taskPath, taskHash),
    memoryRecovery: () => projectMemoryRecoveryStatus(root),
    harnessRecovery: () => configFor(root).executorBaselineRecovery ? taskHarnessRecoveryStatus(root) : null,
    plannerOwner: (taskPath) => readPlannerOwnership(root, taskPath),
    plannerRecovery: () => plannerRecoveryState(root),
  }) })
  const decision = transition.value as AuthoritativeWorkflowDecision
  return {
    revision: decision.revision,
    doctorStatus: decision.doctor.status,
    doctorTask: decision.doctor.taskPath,
    doctorDestination: decision.doctor.destination,
    completedTask: decision.completedTask,
    openTasks: decision.openTasks,
    nextAction: decision.nextAction.text,
    decision,
  }
}

function authoritativeWorkflowStateText(root: string, nextActionOverride?: string, plannerRecoveryOverride?: string) {
  const state = authoritativeWorkflowState(root)
  const override = nextActionOverride
    ? workflowAction("workflow.session_override", "unknown", "continue", nextActionOverride)
    : undefined
  const rendered = renderAuthoritativeWorkflow(state.decision, override)
  return plannerRecoveryOverride
    ? rendered.replace(/^Planner recovery:.*$/m, `Planner recovery: ${plannerRecoveryOverride}`)
    : rendered
}

function projectPathHasSymlink(root: string, path: string) {
  const segments = path.split("/").filter(Boolean)
  let current = root
  for (const segment of segments) {
    current = resolve(current, segment)
    try {
      if (lstatSync(current).isSymbolicLink()) return true
    } catch (error: any) {
      if (error?.code === "ENOENT") return false
      throw error
    }
  }
  return false
}

function scopeFromTask(root: string, taskPath: string) {
  if (normalize(root, taskPath) !== taskPath || projectPathHasSymlink(root, taskPath)) throw guardError(
    `The active task is not one canonical non-symbolic-link project file: ${taskPath}.`,
    "Stop and report TASK_FILE_INVALID. Planner must restore one regular canonical task file before the lifecycle continues.",
  )
  const absoluteTaskPath = resolve(root, taskPath)
  if (!existsSync(absoluteTaskPath)) throw guardError(
    `The active task file does not exist: ${taskPath}.`,
    "Stop and report TASK_FILE_INVALID. Planner must restore the registered task file before the lifecycle continues.",
  )
  const taskInfo = lstatSync(absoluteTaskPath)
  if (!taskInfo.isFile() || taskInfo.isSymbolicLink()) throw guardError(
    `The active task is not a regular non-symbolic-link file: ${taskPath}.`,
    "Stop and report TASK_FILE_INVALID. Planner must restore one regular canonical task file before the lifecycle continues.",
  )
  const content = readFileSync(absoluteTaskPath, "utf8")
  const block = content.match(/## (?:Allowed scope|Scope)\s+([\s\S]*?)(?=\n## |$)/)?.[1] ?? ""
  const contextBlock = content.match(/## Context\s+([\s\S]*?)(?=\n## |$)/)?.[1] ?? ""
  const paths: string[] = []
  const newPaths: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (!paths.length && line.trim() === "") continue
    const match = line.match(/^-\s+((?:NEW):\s*)?`?([^`]+?)`?\s*$/)
    if (!match) break
    const path = match[2].replace(/^\.\//, "").replace(/\/$/, "")
    const formatError = scopePathFormatError(path)
    if (formatError) throw guardError(
      `The active task has an invalid Scope entry: ${path}; ${formatError}.`,
      "Stop and report TASK_SCOPE_FORMAT_INVALID. Planner must replace the entry with one exact project-relative path, then lint and register the task again.",
    )
    paths.push(path)
    if (match[1]) newPaths.push(path)
  }
  const contextPaths: string[] = []
  for (const line of contextBlock.split(/\r?\n/)) {
    if (!contextPaths.length && line.trim() === "") continue
    const match = line.match(/^-\s+`?([^`]+?)`?\s*$/)
    if (!match) break
    const path = match[1].replace(/^\.\//, "").replace(/\/$/, "")
    const formatError = scopePathFormatError(path)
    const absolutePath = resolve(root, path)
    if (formatError || !existsSync(absolutePath) || projectPathHasSymlink(root, path)) throw guardError(
      `The active task has an invalid Context entry: ${path}${formatError ? `; ${formatError}` : !existsSync(absolutePath) ? "; file does not exist" : "; path traverses a symbolic link"}.`,
      "Stop and report TASK_CONTEXT_INVALID. Planner must replace it with one existing regular project-relative file, then lint and register the task again.",
    )
    const info = lstatSync(absolutePath)
    if (!info.isFile() || info.isSymbolicLink()) throw guardError(
      `The active task Context entry is not a regular non-symbolic-link file: ${path}.`,
      "Stop and report TASK_CONTEXT_INVALID. Planner must replace it with one existing regular project-relative file, then lint and register the task again.",
    )
    if (!contextPaths.includes(path)) contextPaths.push(path)
  }
  const overlappingContext = contextPaths.find((path) => paths.includes(path))
  if (overlappingContext) throw guardError(
    `The active task lists ${overlappingContext} as both mutation Scope and read-only Context.`,
    "Stop and report TASK_CONTEXT_INVALID. Planner must keep the path in exactly one section, then lint and register the task again.",
  )
  for (const manifest of paths.filter((path) => path.endsWith("/package.json") || path === "package.json")) {
    const directory = dirname(manifest)
    for (const name of packageLockNames) {
      const companion = directory === "." ? name : `${directory}/${name}`
      if (existsSync(resolve(root, companion)) && !paths.includes(companion)) paths.push(companion)
    }
  }
  return { content, paths, newPaths, contextPaths }
}

function packageName(spec: string) {
  const value = spec.trim()
  if (!/^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)(?:@[^\s]+)?$/i.test(value)) return null
  if (value.startsWith("@")) {
    const separator = value.indexOf("@", 1)
    return separator === -1 ? value : value.slice(0, separator)
  }
  return value.split("@")[0]
}

function allowed(path: string, scope: string[]) {
  return scope.some((entry) => path === entry || path.startsWith(`${entry}/`))
}

function allowedNewParentDirectory(path: string, newScope: string[]) {
  return newScope.some((entry) => entry.startsWith(`${path}/`))
}

function isProtected(path: string, protectedPaths: string[]) {
  return protectedPaths.some((entry) => path === entry || path.startsWith(`${entry}/`))
}

function guardViolationId(problem: string, action: string) {
  return stableGuardViolationId(problem, action)
}

function normalizeGuardViolationId(id: string) {
  return id.toLowerCase().slice(0, 6)
}

function canonicalPersistedGuardViolationId(savedID: unknown, problem: string, action: string) {
  const derivedID = guardViolationId(problem, action)
  if (knownStableGuardRule(derivedID)) return derivedID
  const normalizedSavedID = typeof savedID === "string" && /^[a-f0-9]{6,12}$/i.test(savedID)
    ? normalizeGuardViolationId(savedID)
    : null
  return normalizedSavedID && !knownStableGuardRule(normalizedSavedID)
    ? normalizedSavedID
    : derivedID
}

function defaultGuardError(problem: string, action: string, success?: string, learned?: LearnedGuardRule) {
  const id = guardViolationId(problem, action)
  const persistable = knownStableGuardRule(id) !== null
  return new Error(renderGuardNotice(guardNotice(
    id,
    problem,
    workflowAction(id, "unknown", "continue", action),
    {
      success,
      learning: {
        id,
        status: learned ? "already" : persistable ? "new" : "transient",
        rule: learned?.rule,
      },
    },
  )))
}

function guardError(problem: string, action: string, success?: string) {
  return guardErrorContext.getStore()?.format(problem, action, success)
    ?? defaultGuardError(problem, action, success)
}

function parseGuardViolation(error: unknown): GuardViolation | null {
  const text = String(error ?? "")
  if (!text.includes("WORKFLOW GUARD BLOCKED")) return null
  const problem = text.match(/(?:^|\n)Problem:\s*([^\n]+)/)?.[1]?.trim()
  const action = text.match(/(?:^|\n)Do next:\s*([^\n]+)/)?.[1]?.trim()
  if (!problem || !action) return null
  const savedId = text.match(/(?:^|\n)Guard learning ID:\s*([a-f0-9]{6,12})\b/i)?.[1]
  return {
    id: canonicalPersistedGuardViolationId(savedId, problem, action),
    problem,
    action,
  }
}

function targetPaths(root: string, tool: string, args: any): string[] {
  const candidates = [args?.filePath, args?.path, args?.filename]
  const patch = String(args?.patchText ?? args?.patch ?? "")
  for (const match of patch.matchAll(/(?:Add|Update|Delete) File:\s+([^\n]+)/g)) candidates.push(match[1].trim())
  if (tool === "bash") candidates.push(...(simpleMkdirTargets(String(args?.command ?? "")) ?? []))
  return [...new Set(candidates.filter((value): value is string => typeof value === "string").map((value) => normalize(root, value)).filter(Boolean) as string[])]
}

function simpleMkdirTargets(command: string): string[] | null {
  const match = command.trim().match(/^mkdir\s+(?:(?:-p|--parents)\s+)?((?:(?:"[^"]+"|'[^']+'|[^\s;&|><`$()]+)(?:\s+|$))+?)$/)
  if (!match) return null
  return [...match[1].matchAll(/"([^"]+)"|'([^']+)'|([^\s]+)/g)].map((entry) => entry[1] ?? entry[2] ?? entry[3])
}

function delegatedTaskPaths(args: any) {
  const text = `${String(args?.description ?? "")}\n${String(args?.prompt ?? "")}`
  return [...new Set(text.match(/kanban\/todo\/[A-Za-z0-9._-]+\.md/g) ?? [])]
}

function reviewedHelpFindingTarget(root: string, taskPath: string, reviewedHelp: WorkerHelpRequest | null) {
  if (!reviewedHelp || !existsSync(resolve(root, taskPath))) return null
  const scope = scopeFromTask(root, taskPath).paths
  const candidates = reviewedHelp.relevantFiles
    .map((path) => normalize(root, path))
    .filter((path): path is string => path !== null && path !== taskPath && scope.includes(path))
  if (candidates.length === 0) return null

  const evidence = [
    reviewedHelp.problem,
    ...reviewedHelp.evidence,
    reviewedHelp.executorReview?.rootCause,
    reviewedHelp.executorReview?.retryStrategy,
  ].filter((value): value is string => typeof value === "string").join("\n")
  const escapedToken = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const tokenIndex = (token: string) => {
    const match = new RegExp(`(^|[^A-Za-z0-9._/-])${escapedToken(token)}(?=$|[^A-Za-z0-9._/-])`, "i").exec(evidence)
    return match?.index ?? -1
  }
  return candidates
    .flatMap((path, order) => {
      const indexes = [tokenIndex(path), tokenIndex(basename(path))].filter((index) => index >= 0)
      return indexes.length > 0 ? [{ path, order, index: Math.min(...indexes) }] : []
    })
    .sort((left, right) => left.index - right.index || left.order - right.order)[0]?.path ?? null
}

function reviewedReplaceOccurrenceMismatch(
  root: string,
  taskPath: string,
  scope: string[],
  request: WorkerHelpRequest,
  workerHelpText: string,
  reviewedFiles: string[],
) {
  const escapedToken = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const mentionsPathToken = (path: string) => [path, basename(path)].some((token) => (
    new RegExp(`(^|[^A-Za-z0-9._/-])${escapedToken(token)}(?=$|[^A-Za-z0-9._/-])`, "i").test(workerHelpText)
  ))
  const usablePath = (path: string | null): path is string => Boolean(
    path
    && path !== taskPath
    && allowed(path, scope)
    && reviewedFiles.includes(path)
    && existsSync(resolve(root, path))
    && statSync(resolve(root, path)).isFile(),
  )
  const inferredPaths = [...new Set(request.relevantFiles
    .map((path) => normalize(root, path))
    .filter((path): path is string => usablePath(path) && mentionsPathToken(path)))]
  const inferredPath = inferredPaths.length === 1 ? inferredPaths[0] : null
  const relevant = replaceOccurrenceMismatches(workerHelpText).flatMap((mismatch) => {
    const explicitPath = mismatch.path ? normalize(root, mismatch.path) : null
    const path = usablePath(explicitPath) ? explicitPath : inferredPath
    if (!usablePath(path)) return []
    return [{ ...mismatch, path }]
  })
  return relevant.at(-1) ?? null
}

function configuredWorkerModelFamily(root: string, selectedModel?: unknown) {
  const settings = openCodeSettings(root)
  const configuredModel = settings.agentModels?.worker
  const identity = selectedModel
    ? modelIdentity(selectedModel)
    : typeof configuredModel === "string" ? configuredModel : modelIdentity(configuredModel)
  return matchingWorkerModelFamily(identity, workerModelFamiliesFromConfig(settings.workerModelFamilies))
}

function automaticAgentModel(root: string, agent: string, latestInfo?: unknown) {
  const configuredModels = openCodeSettings(root).agentModels
  const configured = configuredModels && typeof configuredModels === "object" && !Array.isArray(configuredModels)
    ? Object.entries(configuredModels).find(([name]) => name.toLowerCase() === agent.toLowerCase())?.[1]
    : undefined
  return agentModelRef(configured) ?? agentModelRef(latestInfo)
}

type WorkerDelegationModelDecision = {
  model: { providerID: string; modelID: string } | undefined
  boosted: boolean
  invalidBoost: boolean
  reason: string
  selector: string | null
}

function workerDelegationModelDecision(root: string, freshReviewedRetry: boolean): WorkerDelegationModelDecision {
  const baseModel = automaticAgentModel(root, "worker")
  if (!freshReviewedRetry) {
    return { model: baseModel, boosted: false, invalidBoost: false, reason: "normal-or-resumed-worker-delegation", selector: null }
  }

  const boost = resolveWorkerRecoveryBoost(openCodeSettings(root))
  if (boost.model && workerRecoveryBoostAgentAvailable(root)) {
    return { model: boost.model, boosted: true, invalidBoost: false, reason: boost.reason, selector: boost.selector }
  }
  if (boost.model) {
    return {
      model: baseModel,
      boosted: false,
      invalidBoost: true,
      reason: "worker-recovery-boost-agent-unavailable",
      selector: boost.selector,
    }
  }
  return { model: baseModel, boosted: false, invalidBoost: boost.invalid, reason: boost.reason, selector: boost.selector }
}

function workerSubagentType(value: unknown) {
  const normalized = String(value ?? "").toLowerCase()
  return normalized === "worker" || normalized === WORKER_RECOVERY_BOOST_AGENT
}

function canonicalWorkerPrompt(root: string, taskPath: string, state: any, reviewedHelp: WorkerHelpRequest | null) {
  const active = state?.status === "started" && state?.taskPath === taskPath
  const reviewedRetry = active && reviewedHelp?.status === "retry_approved"
  const reviewedTarget = reviewedRetry ? reviewedHelpFindingTarget(root, taskPath, reviewedHelp) : null
  const targetedReviewedRetry = reviewedRetry && reviewedTarget !== null
  const taskContent = existsSync(resolve(root, taskPath)) ? readFileSync(resolve(root, taskPath), "utf8") : ""
  const memoryAction = active
    ? state.memoryAction
    : taskContent.match(/^Action:\s+`?(none|append|update|remove)`?\s*$/m)?.[1]
  const sections = [active
    ? [
        "ACTIVE TASK",
        `Task: ${taskPath}`,
        "Read WORKER.md and task.",
        targetedReviewedRetry
          ? `Read ${reviewedTarget ?? "the finding target"} first. Use the review below.`
          : "Implement mutable Scope. Follow Guard.",
        "Call the next tool now.",
      ].join("\n")
    : [
        "TASK",
        `Task: ${taskPath}`,
        "Read WORKER.md and task.",
        `Start: npm run task:doctor:start -- ${taskPath}`,
        "Implement mutable Scope. Follow Guard.",
        "Call the next tool now.",
      ].join("\n")]

  if (memoryAction === "append") {
    sections.push([
      "MEMORY APPEND",
      `Before first Apply, call append_task_memory once for ${taskPath} with one concise durable fact.`,
      "Do not edit MEMORY.md directly.",
    ].join("\n"))
  }

  if (reviewedHelp?.status === "retry_approved") {
    const earlyStop = reviewedHelp.category === "invalid-worker-return"
      || reviewedHelp.category === "reviewed-retry-incomplete"
    sections.push(earlyStop
      ? `RETRY ${reviewedHelp.id}\nPrior Worker stopped early. Continue with tools; do not announce actions.`
      : [
          `RETRY ${reviewedHelp.id}`,
          `Problem: ${reviewedHelp.executorReview?.rootCause ?? reviewedHelp.problem}`,
          `Action: ${reviewedHelp.executorReview?.retryStrategy ?? "Use a different in-scope operation."}`,
        ].join("\n"))
  } else if (reviewedHelp?.status === "task_changed") {
    sections.push([
      `TASK UPDATED ${reviewedHelp.id}`,
      "Ignore prior help. Follow the current task and Guard.",
    ].join("\n"))
  }

  return sections.join("\n\n")
}

function executorRecoveryHandoff(taskPath: string, paths: string[]) {
  return [
    "BLOCKED",
    `Task: ${taskPath}`,
    "Doctor status: started",
    `Failure: Harness baseline drift requires Executor recovery for ${paths.join(", ")}.`,
    "Required owner: Executor",
  ].join("\n")
}

function withExecutorRecoveryAction(resultText: string, taskPath: string, paths: string[]) {
  return [
    resultText,
    `EXECUTOR NEXT ACTION: Inspect readable Harness paths, keep WORKER rule files opaque, then call recover_harness_baseline for ${taskPath} with exactly ${paths.join(", ")}. Do not escalate this blocker to Planner or delegate another Worker first.`,
  ].join("\n\n")
}

function workerTaskSessionID(output: { output?: string; metadata?: any }) {
  const metadataID = output.metadata?.sessionId ?? output.metadata?.sessionID
  if (typeof metadataID === "string" && metadataID.length > 0) return metadataID
  return String(output.output ?? "").match(/<task\s+id="([^"]+)"/)?.[1] ?? null
}

function workerTaskResultText(output: string) {
  return output.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/)?.[1]?.trim() ?? output.trim()
}

function replaceWorkerTaskResult(output: string, sessionID: string, text: string) {
  const result = text.trim()
  if (/<task_result>[\s\S]*<\/task_result>/.test(output)) {
    return output.replace(/<task_result>[\s\S]*<\/task_result>/, `<task_result>\n${result}\n</task_result>`)
  }
  return `<task id="${sessionID}" state="completed">\n<task_result>\n${result}\n</task_result>\n</task>`
}

function isNewTodoWrite(root: string, paths: string[]) {
  return paths.find((path) => /^kanban\/todo\/[^/]+\.md$/.test(path) && !existsSync(resolve(root, path)))
}

function checkpoint(root: string, completedPath: string) {
  const changed = run(root, "git", ["diff", "--name-only"]).stdout.trim().split(/\r?\n/).filter(Boolean)
  const data = {
    version: 1,
    completedTask: completedPath,
    openTasks: todoTasks(root).map((name) => `kanban/todo/${name}`),
    changedFiles: changed,
    nextAction: todoTasks(root)[0] ? `Start kanban/todo/${todoTasks(root)[0]} through the Doctor lifecycle.` : "No open Kanban task.",
    createdAt: new Date().toISOString(),
  }
  const directory = resolve(root, ".task-doctor")
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, "workflow-checkpoint.json"), `${JSON.stringify(data, null, 2)}\n`)
  return data
}

function unwrap<T>(result: any): T {
  return (result?.data ?? result) as T
}

function unwrapMessages(result: any): any[] {
  const value = unwrap<any>(result)
  if (Array.isArray(value)) return value
  return Array.isArray(value?.data) ? value.data : []
}

function activeContextTokens(messages: any[]) {
  const tokens = [...messages].reverse().find((item) => item?.info?.role === "assistant" && item?.info?.tokens)?.info?.tokens
  if (!tokens) return 0
  const total = Number(tokens.total)
  if (Number.isFinite(total) && total >= 0) return total
  return Number(tokens.input ?? 0)
    + Number(tokens.output ?? 0)
    + Number(tokens.cache?.read ?? 0)
    + Number(tokens.cache?.write ?? 0)
}

function latestAssistantFinished(messages: any[]) {
  const info = [...messages].reverse().find((item) => item?.info?.role === "assistant")?.info
  return Boolean(info?.time?.completed && info?.finish)
}

function latestAssistantMessage(messages: any[]) {
  return [...messages].reverse().find((item) => item?.info?.role === "assistant")
}

function textParts(messages: any[]) {
  return messages.flatMap((item) => item?.parts ?? []).filter((part) => part?.type === "text").map((part) => String(part.text ?? ""))
}

function latestAssistantText(messages: any[]) {
  const message = latestAssistantMessage(messages)
  return message?.parts?.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n") ?? ""
}

function latestRelevantToolFailure(messages: any[]) {
  const latest = latestAssistantMessage(messages)
  const parentID = latest?.info?.parentID
  const events: Array<{
    at: number
    sequence: number
    status: "error" | "completed"
    fingerprint: LoopFailureFingerprint
  }> = []
  let sequence = 0
  const timestamp = (...values: unknown[]) => {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value)) return value
      if (typeof value === "string") {
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
      }
    }
    return 0
  }
  for (const message of messages) {
    if (message?.info?.role !== "assistant" || (parentID && message?.info?.parentID !== parentID)) continue
    for (const part of message?.parts ?? []) {
      const status = part?.state?.status
      if (part?.type !== "tool" || !["error", "completed"].includes(status)) continue
      const toolName = String(part.tool ?? "")
      const input = part?.state?.input && typeof part.state.input === "object" ? part.state.input : {}
      const error = status === "error" ? String(part?.state?.error ?? "") : "completed"
      const fingerprint = loopFailureFingerprint(toolName, input, error)
      if (!fingerprint) continue
      events.push({
        at: timestamp(
          part?.state?.time?.end,
          part?.state?.time?.start,
          part?.time?.end,
          part?.time?.start,
          message?.info?.time?.completed,
          message?.info?.time?.created,
        ),
        sequence: sequence++,
        status,
        fingerprint,
      })
    }
  }
  const unresolved = new Map<string, typeof events[number]>()
  for (const event of events.sort((left, right) => left.at - right.at || left.sequence - right.sequence)) {
    const key = `${event.fingerprint.tool}|${event.fingerprint.target}`
    if (event.status === "completed") unresolved.delete(key)
    else unresolved.set(key, event)
  }
  return [...unresolved.values()].sort((left, right) => right.at - left.at || right.sequence - left.sequence)[0] ?? null
}

function plannerRejectedByUser(text: string) {
  return /\b(?:do\s+not|don't|never)\s+(?:use|call|return|escalate|send|resume|involve|ask)\w*\b[^.;!?\n]{0,60}\bplanner\b/i.test(text)
    || /\b(?:without|ohne)\s+(?:(?:the|den|dem)\s+)?planner\b/i.test(text)
    || /\b(?:no|kein(?:e|en|em|er|es)?)\s+planner\b/i.test(text)
    || /\b(?:nutze|verwende|rufe|schicke|sende|eskaliere|beziehe)\w*\s+(?:den\s+)?planner\s+nicht\b/i.test(text)
    || /\b(?:nutze|verwende|rufe|schicke|sende|eskaliere|beziehe)\w*\s+(?:(?:ihn|sie|es|das|den\s+task|die\s+aufgabe)\s+)?nicht\b[^.;!?\n]{0,60}\bplanner\b/i.test(text)
    || /\b(?:nicht|niemals)\b[^.;!?\n]{0,50}\bplanner\b[^.;!?\n]{0,50}\b(?:nutzen|verwenden|rufen|schicken|senden|eskalieren|einbeziehen)\b/i.test(text)
}

function latestUserMessageText(messages: any[]) {
  const message = [...messages].reverse().find((item) => item?.info?.role === "user")
  const text = message?.parts
    ?.filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text ?? ""))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim() ?? ""
  return { message, text }
}

function explicitUserRejectsPlanner(messages: any[], taskPath: string) {
  const { text } = latestUserMessageText(messages)
  return text.toLowerCase().includes(taskPath.toLowerCase()) && plannerRejectedByUser(text)
}

function explicitUserPlannerRecoveryRequest(messages: any[], taskPath: string): ExplicitPlannerRecoveryRequest | null {
  const { message, text } = latestUserMessageText(messages)
  if (!text.toLowerCase().includes(taskPath.toLowerCase())) return null
  if (plannerRejectedByUser(text)) return null
  const requestsPlanner = /\bescalate_to_planner\b/i.test(text)
    || /\b(?:use|call|return|escalate|send|resume|involve|ask|nutze|verwende|rufe|schicke|sende|eskaliere|beziehe)\w*\b[^.\n]{0,100}\bplanner\b/i.test(text)
    || /\bplanner\b[^.\n]{0,60}\b(?:must|should|shall|has\s+to|needs?\s+to|muss|soll|sollte)\b[^.\n]{0,80}\b(?:recover|revise|correct|repair|review|audit|update|supersede|korrig|pr[uü]f|[uü]berarbeit|anpass|reparier|zur[uü]ck)\w*/i.test(text)
  if (!requestsPlanner) return null
  const clipped = text.slice(0, 4000)
  return {
    text: clipped,
    messageID: String(message?.info?.id ?? message?.id ?? hash(clipped)).trim(),
  }
}

function plannerRecoveryContinuation(request: ExplicitPlannerRecoveryRequest) {
  return /\b(?:pending|finali[sz](?:e|ing|ed|ation)?|retry|continue|continuation|resume|again|fortsetz\w*|erneut|abschlie(?:ss|ß)\w*)\b/i.test(request.text)
    && /\b(?:escalate_to_planner|planner[ -]recovery|planner[ -]wiederherstellung)\b/i.test(request.text)
}

function unresolvedPlannerQuestions(text: string) {
  const lines = text.split(/\r?\n/)
  const openQuestionHeading = /^\s*(?:#{1,6}\s*)?\*{0,2}(?:offene\s+(?:fragen|punkte)|r[uü]ckfragen|kl[aä]rungsbedarf|open questions|questions? for (?:the )?user|decisions? needed)\s*:?\*{0,2}\s*$/i
  let headingIndex = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!openQuestionHeading.test(lines[index])) continue
    headingIndex = index
    break
  }
  const hasTrailingOpenQuestionSection = headingIndex >= Math.max(0, lines.length - 24)
  const candidates = hasTrailingOpenQuestionSection ? lines.slice(headingIndex + 1) : lines.slice(-8)
  const decisionQuestion = /\b(?:soll(?:en)?|m[oö]chtest(?:\s+du)?|m[oö]chten\s+sie|willst\s+du|wollen\s+sie|welch(?:e|er|es|en)|should|would\s+you|do\s+you\s+want|which)\b/i
  return candidates
    .map((line) => line.trim())
    .filter((line) => {
      const hasQuestionMark = hasTrailingOpenQuestionSection ? line.includes("?") : line.endsWith("?")
      return hasQuestionMark && line.length <= 800 && (hasTrailingOpenQuestionSection || decisionQuestion.test(line))
    })
}

function usedQuestionTool(message: any) {
  return Boolean(message?.parts?.some((part: any) => part?.type === "tool" && part?.tool === "question"))
}

function plannerExecutionQuestion(args: any) {
  const text = JSON.stringify(args?.questions ?? args ?? {})
  const role = /\b(?:worker|executor)\b/i.test(text)
  const action = /(?:ausf[uü]hr|start(?:e|en)?|delegier|[uü]berg(?:e|a|ä)|handoff|spawn|execut|run\s+(?:the\s+)?tasks?)/i.test(text)
  return role && action
}

function reportsUserBlocker(text: string) {
  return /(?:^|\n)\s*(?:stop\b[^\n]{0,60}\b(?:blocker|blocked|blockiert)\b|(?:echter|real|genuine)\s+blocker\b|(?:ben[oö]tigte|erforderliche)\s+benutzerentscheidung\b|(?:i am|ich bin)\s+block(?:ed|iert)\b)|(?:user|benutzer)(?: action| input| decision|entscheidung)[^\n]{0,60}(?:required|ben[oö]tigt|erforderlich)/im.test(text)
}

export const WorkflowGuard: Plugin = async ({ directory, worktree, client, serverUrl }) => {
  const root = projectRoot(worktree || directory)
  const features = configFor(root)
  const workerModelFamilies = workerModelFamiliesFromConfig(openCodeSettings(root).workerModelFamilies)
  const ornithDriverConfig = ornithDriverConfigFor(root)
  let ornithDriver: OrnithModelDriver | null = null
  const protectedPaths = protectedPathsFor(root)
  const readOnlyPaths = [...new Set([
    ...readOnlyPathsFor(root),
    ...workerModelFamilies.map((family) => family.rulesFile),
  ])]
  const taskCompactionThresholdPercent = taskCompactionThresholdPercentFor(root)
  const workerHelpFailureThreshold = workerHelpFailureThresholdFor(root)
  const doctorFailureThreshold = doctorFailureThresholdFor(root)
  const longDoctorFailureMs = longDoctorFailureMsFor(root)
  const doctorVerifyTimeoutMs = doctorVerifyTimeoutMsFor(root)
  const modeSettings = modeSettingsFor(root)
  const enabled = doctorProject(root)
  const runtimeState = new WorkflowRuntimeState()
  const sessionFeedback = runtimeState.map<string>("sessionFeedback")
  const repetitions = runtimeState.map<{ signature: string; count: number }>("repetitions")
  const pendingCompact = runtimeState.set("pendingCompact")
  const idlePromptedFor = runtimeState.map<string>("idlePromptedFor")
  const sessionTodos = runtimeState.map<Array<{ content: string; status: string }>>("sessionTodos")
  const doctorEvidence = runtimeState.map<Set<string>>("doctorEvidence")
  const contextLimits = runtimeState.map<number>("contextLimits")
  const sessionAgents = runtimeState.map<string>("sessionAgents")
  const sessionModels = runtimeState.map<string>("sessionModels")
  const plannerQuestionCorrections = runtimeState.map<string>("plannerQuestionCorrections")
  const plannerCompletionCorrections = runtimeState.map<string>("plannerCompletionCorrections")
  const plannerEmptyStopRecoveries = runtimeState.map<number>("plannerEmptyStopRecoveries")
  const executorReadyAfterSchedule = runtimeState.map<string>("executorReadyAfterSchedule")
  const executorScheduledNoReady = runtimeState.set("executorScheduledNoReady")
  const pendingGuardLearnings = runtimeState.map<Map<string, GuardViolation>>("pendingGuardLearnings")
  const guardLearningPromptedFor = runtimeState.map<string>("guardLearningPromptedFor")
  const workerRuleReads = runtimeState.map<Set<string>>("workerRuleReads")
  const workerTaskReads = runtimeState.map<{ taskPath: string; taskHash: string }>("workerTaskReads")
  const workerFileReads = runtimeState.map<Map<string, { taskPath: string; taskHash: string; fileHash: string }>>("workerFileReads")
  const pendingAutomaticWorkerTaskReads = runtimeState.map<{
    callID: string | null
    taskPath: string
    taskHash: string
    taskContent: string
    targetPath: string
    targetHash: string
    modelIdentity: string
    modelFamily: string
    modelRulesFile: string
    requiredRuleHashes: Array<{ path: string; hash: string }>
    mutationRevision: number
  }>("pendingAutomaticWorkerTaskReads")
  const workerDoctorPreflights = runtimeState.map<{ taskPath: string; taskHash: string; mutationRevision: number }>("workerDoctorPreflights")
  const workerFindingTargets = runtimeState.map<string>("workerFindingTargets")
  const workerFindingReads = runtimeState.map<string>("workerFindingReads")
  const workerVerifyRequired = runtimeState.set("workerVerifyRequired")
  const workerMechanicalDoctorNotices = runtimeState.map<{
    taskPath: string
    taskHash: string
    status: ValidatedMechanicalDoctorRun["status"]
    output: string
    findingTarget: string | null
    runID: string
  }>("workerMechanicalDoctorNotices")
  const mechanicalDoctorPreflightInFlight = runtimeState.map<Promise<{
    run: ValidatedMechanicalDoctorRun
    mutationRevision: number
  }>>("mechanicalDoctorPreflightInFlight")
  let mechanicalDoctorQueueTail: Promise<void> = Promise.resolve()
  let workerMutationRevision = 0
  const pendingReviewedWorkerRetries = runtimeState.map<Array<{
    helpID: string
    taskPath: string
    taskHash: string
    findingTarget: string | null
    findingTargetRevision: string | null
    queuedAt: number
  }>>("pendingReviewedWorkerRetries")
  const pendingHelpDelegations = runtimeState.map<Array<{
    helpID: string
    priorStatus: "retry_approved" | "task_changed"
    queuedAt: number
    callID: string | null
    source: "direct" | "mechanical"
    attemptNonce: string | null
  }>>("pendingHelpDelegations")
  const baseContinuationPrompts = runtimeState.map<Promise<void>>("baseContinuationPrompts")
  const activeBoostResumeCalls = runtimeState.map<{ callID: string; parentSessionID: string }>("activeBoostResumeCalls")
  const executorReviewReads = runtimeState.map<Map<string, string>>("executorReviewReads")
  const executorHelpReviewPending = runtimeState.map<string>("executorHelpReviewPending")
  const executorHelpReReviewRequested = runtimeState.map<string>("executorHelpReReviewRequested")
  const executorPlannerRecoveryRequested = runtimeState.map<{ taskPath: string; taskHash: string }>("executorPlannerRecoveryRequested")
  const malformedWorkflowToolRetries = runtimeState.map<{
    target: string
    revision: string
    attempts: number
    seenCallIDs: Set<string>
    feedback: string
  }>("malformedWorkflowToolRetries")
  const sessionIdentityHydrations = runtimeState.map<Promise<void>>("sessionIdentityHydrations")
  const subagentParents = runtimeState.map<string>("subagentParents")
  const observedTerminalToolParts = runtimeState.map<Set<string>>("observedTerminalToolParts")
  const archivedWorkerSessions = runtimeState.set("archivedWorkerSessions")
  const workerSessionArchiveAttempts = runtimeState.map<Promise<boolean>>("workerSessionArchiveAttempts")
  const reviewableWorkerSessions = runtimeState.map<Set<string>>("reviewableWorkerSessions")
  const requestedWorkerSessionResumes = runtimeState.map<number>("requestedWorkerSessionResumes")
  const loopFailures = runtimeState.map<Map<string, { count: number; lastAt: number; fingerprint: LoopFailureFingerprint }>>("loopFailures")
  const doctorFailures = runtimeState.map<Map<string, { count: number; lastAt: number; fingerprint: LoopFailureFingerprint }>>("doctorFailures")
  const workerHelpRequired = runtimeState.map<{ count: number; fingerprint: LoopFailureFingerprint; reason?: "repeated" | "slow" }>("workerHelpRequired")
  const workerDoctorStartedAt = runtimeState.map<{
    startedAt: number
    mutationRevision: number
    taskPath: string
    taskHash: string | null
  }>("workerDoctorStartedAt")
  const workerHelpTerminalSessions = runtimeState.set("workerHelpTerminalSessions")
  const workerHarnessRecoveryTerminals = runtimeState.map<{ taskPath: string; taskHash: string }>("workerHarnessRecoveryTerminals")
  const terminalExecutorReasons = runtimeState.map<string>("terminalExecutorReasons")
  const terminalRoleLoopReasons = runtimeState.map<string>("terminalRoleLoopReasons")
  const activePlannerRecoveries = runtimeState.map<ActivePlannerRecovery>("activePlannerRecoveries")
  const guardLearningResumePending = runtimeState.map<string>("guardLearningResumePending")
  const lastDoctorFailurePath = resolve(root, ".task-doctor/last-doctor-failure.json")
  const guardLearningQueuePath = resolve(root, ".task-doctor/pending-guard-learnings.json")
  const guardLearningAuthorizationPath = resolve(root, ".task-doctor/authorized-custom-changes.json")
  const workerHelpStatePath = resolve(root, ".task-doctor/worker-help.json")
  const plannerRecoveryStatePath = resolve(root, ".task-doctor/planner-recovery.json")
  const explicitPlannerReviewPath = resolve(root, ".task-doctor/planner-review.json")
  const authoritativePlannerBlockerPath = resolve(root, ".task-doctor/authoritative-planner-blocker.json")
  const reviewableWorkerSessionsPath = resolve(root, ".task-doctor/reviewable-worker-sessions.json")
  const workerSessionArchiveMinimumAgeMs = 60 * 60 * 1000
  const workerSessionResumeProtectionMs = 24 * 60 * 60 * 1000
  const workerSessionMaintenanceThrottleMs = 6 * 60 * 60 * 1000
  let workerSessionMaintenanceTimer: ReturnType<typeof setTimeout> | null = null
  let workerSessionMaintenancePromise: Promise<void> | null = null
  let lastWorkerSessionMaintenanceAt = 0

  for (const entry of loadWorkerHarnessRecoveryTerminals(root)) {
    workerHarnessRecoveryTerminals.set(entry.sessionID, {
      taskPath: entry.taskPath,
      taskHash: entry.taskHash,
    })
  }
  const persistedDoctorFailure = readJson(lastDoctorFailurePath)
  const persistedHarnessRecovery = features.executorBaselineRecovery ? taskHarnessRecoveryStatus(root) : null
  if (persistedHarnessRecovery
    && typeof persistedDoctorFailure?.sessionID === "string"
    && persistedDoctorFailure.taskPath === persistedHarnessRecovery.taskPath
    && persistedDoctorFailure.taskHash === persistedHarnessRecovery.taskHash
    && /TASK DOCTOR:\s+EXECUTOR RECOVERY REQUIRED|HARNESS_BASELINE_DRIFT/i.test(String(persistedDoctorFailure.output ?? ""))) {
    markWorkerHarnessRecoveryTerminal(persistedDoctorFailure.sessionID, {
      taskPath: persistedHarnessRecovery.taskPath,
      taskHash: persistedHarnessRecovery.taskHash,
    })
  }

  if (features.workerSessionArchive) {
    const stored = readJson(reviewableWorkerSessionsPath)
    if (stored?.version === 1 && Array.isArray(stored.sessions)) {
      for (const entry of stored.sessions) {
        if (typeof entry?.taskPath === "string" && typeof entry?.workerSessionID === "string") {
          const sessions = reviewableWorkerSessions.get(entry.taskPath) ?? new Set<string>()
          sessions.add(entry.workerSessionID)
          reviewableWorkerSessions.set(entry.taskPath, sessions)
        }
      }
    }
  }

  function writeReviewableWorkerSessions() {
    if (!features.workerSessionArchive) return
    if (reviewableWorkerSessions.size === 0) {
      rmSync(reviewableWorkerSessionsPath, { force: true })
      return
    }
    mkdirSync(dirname(reviewableWorkerSessionsPath), { recursive: true })
    writeFileSync(reviewableWorkerSessionsPath, `${JSON.stringify({
      version: 1,
      sessions: [...reviewableWorkerSessions].flatMap(([taskPath, workerSessionIDs]) => (
        [...workerSessionIDs].map((workerSessionID) => ({ taskPath, workerSessionID }))
      )),
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`)
  }

  function rememberReviewableWorker(taskPath: string, workerSessionID: string) {
    if (!features.workerSessionArchive) return
    const sessions = reviewableWorkerSessions.get(taskPath) ?? new Set<string>()
    sessions.add(workerSessionID)
    reviewableWorkerSessions.set(taskPath, sessions)
    writeReviewableWorkerSessions()
  }

  function forgetReviewableWorker(taskPath: string, workerSessionID?: string) {
    const sessions = reviewableWorkerSessions.get(taskPath)
    if (!sessions) return
    if (workerSessionID) {
      if (!sessions.delete(workerSessionID)) return
      if (sessions.size === 0) reviewableWorkerSessions.delete(taskPath)
    } else {
      reviewableWorkerSessions.delete(taskPath)
    }
    writeReviewableWorkerSessions()
  }

  async function archiveTerminalWorkerSession(sessionID: string, reason: string) {
    const injectedUpdate = (client as any)?.session?.update
    if (typeof injectedUpdate !== "function") return false
    if (archivedWorkerSessions.has(sessionID)) {
      clearWorkerHarnessRecoveryTerminal(sessionID)
      return true
    }
    const pending = workerSessionArchiveAttempts.get(sessionID)
    if (pending) return pending

    const attempt = (async () => {
      try {
        const archived = Date.now()
        const response = await client.session.update({
          path: { id: sessionID },
          query: { directory: root },
          body: { time: { archived } },
        } as any)
        if ((response as any)?.error) throw new Error(String((response as any).error?.message ?? (response as any).error))
        archivedWorkerSessions.add(sessionID)
        clearWorkerHarnessRecoveryTerminal(sessionID)
        if (pendingGuardLearnings.delete(sessionID)) persistPendingGuardLearnings()
        await log("info", "Archived terminal Worker session", { sessionID, reason })
        return true
      } catch (error) {
        await log("warn", "Could not archive terminal Worker session", {
          sessionID,
          reason,
          error: error instanceof Error ? error.message : String(error),
        })
        return false
      } finally {
        workerSessionArchiveAttempts.delete(sessionID)
      }
    })()
    workerSessionArchiveAttempts.set(sessionID, attempt)
    return attempt
  }

  async function retryClosedReviewableWorkerArchives() {
    for (const [taskPath, workerSessionIDs] of [...reviewableWorkerSessions]) {
      if (existsSync(resolve(root, taskPath))) continue
      for (const workerSessionID of [...workerSessionIDs]) {
        if (await archiveTerminalWorkerSession(workerSessionID, "recovered terminal Worker after restart")) {
          forgetReviewableWorker(taskPath, workerSessionID)
        }
      }
    }
  }

  function protectedWorkerSessionIDs(currentSessionID?: string) {
    const protectedIDs = new Set<string>()
    const now = Date.now()
    for (const [workerSessionID, requestedAt] of requestedWorkerSessionResumes) {
      if (now - requestedAt <= workerSessionResumeProtectionMs) protectedIDs.add(workerSessionID)
      else requestedWorkerSessionResumes.delete(workerSessionID)
    }
    if (currentSessionID) protectedIDs.add(currentSessionID)
    for (const workerSessionIDs of reviewableWorkerSessions.values()) {
      for (const workerSessionID of workerSessionIDs) protectedIDs.add(workerSessionID)
    }

    const state = activeState(root)
    if (!state?.taskPath || !state?.taskHash) return protectedIDs
    for (const request of workerHelpStore(root).requests) {
      if (request.taskPath !== state.taskPath || request.taskHash !== state.taskHash) continue
      if (["pending", "retry_approved", "planner_unavailable", "planner_recovery_incomplete"].includes(request.status)) {
        protectedIDs.add(request.workerSessionID)
      }
      if (request.status === "delegated" && request.delegatedWorkerSessionID) {
        protectedIDs.add(request.delegatedWorkerSessionID)
      }
    }
    return protectedIDs
  }

  function idleArchiveStatus(status: any) {
    return status === undefined || status?.type === "idle"
  }

  async function maintainWorkerSessionArchive(currentSessionID?: string) {
    await retryClosedReviewableWorkerArchives()

    const injectedList = (client as any)?.session?.list
    const injectedStatus = (client as any)?.session?.status
    if (typeof injectedList !== "function" || typeof injectedStatus !== "function") return

    const [listResponse, statusResponse] = await Promise.all([
      client.session.list({ query: { directory: root } } as any),
      client.session.status({ query: { directory: root } } as any),
    ])
    if ((listResponse as any)?.error || (statusResponse as any)?.error) {
      throw new Error("OpenCode session list or status request failed.")
    }
    const sessions = unwrap<any[]>(listResponse)
    const statuses = unwrap<Record<string, any>>(statusResponse)
    if (!Array.isArray(sessions) || !statuses || typeof statuses !== "object" || Array.isArray(statuses)) {
      throw new Error("OpenCode session maintenance returned an invalid response shape.")
    }

    const cutoff = Date.now() - workerSessionArchiveMinimumAgeMs
    const protectedIDs = protectedWorkerSessionIDs(currentSessionID)
    const candidates = sessions
      .filter((session) => (
        typeof session?.id === "string"
        && typeof session?.parentID === "string"
        && modeSettings.workerAgents.has(String(session?.agent ?? "").toLowerCase())
        && session?.time?.archived == null
        && Number.isFinite(Number(session?.time?.updated))
        && Number(session.time.updated) <= cutoff
        && !protectedIDs.has(session.id)
        && idleArchiveStatus(statuses[session.id])
      ))
      .sort((left, right) => Number(left.time.updated) - Number(right.time.updated))
      .slice(0, 50)

    const transcriptComplete: any[] = []
    for (const session of candidates) {
      try {
        const messages = await loadSessionMessages(session.id)
        const latest = messages.at(-1)?.info
        const explicitlyAborted = latest?.error?.name === "MessageAbortedError"
        if (latest?.role === "assistant" && latest?.time?.completed && (latest?.finish || explicitlyAborted)) {
          transcriptComplete.push(session)
        }
      } catch {
        // A missing or unreadable transcript is not safe to archive automatically.
      }
    }
    if (transcriptComplete.length === 0) {
      lastWorkerSessionMaintenanceAt = Date.now()
      return
    }

    const freshStatusResponse = await client.session.status({ query: { directory: root } } as any)
    if ((freshStatusResponse as any)?.error) throw new Error("OpenCode session status recheck failed.")
    const freshStatuses = unwrap<Record<string, any>>(freshStatusResponse)
    if (!freshStatuses || typeof freshStatuses !== "object" || Array.isArray(freshStatuses)) {
      throw new Error("OpenCode session status recheck returned an invalid response shape.")
    }

    for (const session of transcriptComplete) {
      if (protectedWorkerSessionIDs(currentSessionID).has(session.id)) continue
      if (!idleArchiveStatus(freshStatuses[session.id])) continue
      await archiveTerminalWorkerSession(session.id, "periodic idle Worker cleanup")
    }
    lastWorkerSessionMaintenanceAt = Date.now()
  }

  function scheduleWorkerSessionMaintenance(currentSessionID?: string) {
    if (!features.workerSessionArchive
      || workerSessionMaintenanceTimer
      || workerSessionMaintenancePromise
      || Date.now() - lastWorkerSessionMaintenanceAt < workerSessionMaintenanceThrottleMs
      || typeof (client as any)?.session?.update !== "function") return

    workerSessionMaintenanceTimer = setTimeout(() => {
      workerSessionMaintenanceTimer = null
      workerSessionMaintenancePromise = maintainWorkerSessionArchive(currentSessionID)
        .catch(async (error) => {
          await log("warn", "Could not maintain terminal Worker sessions", {
            error: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => {
          lastWorkerSessionMaintenanceAt = Date.now()
          workerSessionMaintenancePromise = null
        })
    }, 0)
  }

  function explicitPlannerReviewReceipt(): ExplicitPlannerReviewReceipt | null {
    const receipt = readJson(explicitPlannerReviewPath)
    if (!(receipt?.version === 1
      && ["pending", "complete"].includes(receipt.status)
      && typeof receipt.executorSessionID === "string"
      && typeof receipt.userMessageID === "string"
      && typeof receipt.taskPath === "string")) return null
    const normalized = receipt.contract ? {
      ...receipt,
      contract: canonicalPlannerRecoveryContract(receipt.contract),
    } as ExplicitPlannerReviewReceipt : receipt as ExplicitPlannerReviewReceipt
    if (JSON.stringify(normalized) !== JSON.stringify(receipt)) writeExplicitPlannerReviewReceipt(normalized)
    return normalized
  }

  function writeExplicitPlannerReviewReceipt(receipt: ExplicitPlannerReviewReceipt) {
    const normalized = receipt.contract ? {
      ...receipt,
      contract: canonicalPlannerRecoveryContract(receipt.contract),
    } : receipt
    mkdirSync(dirname(explicitPlannerReviewPath), { recursive: true })
    writeFileSync(explicitPlannerReviewPath, `${JSON.stringify(normalized, null, 2)}\n`)
  }

  async function loadSessionTranscript(sessionID: string, limit = 200, maxPages = 20) {
    if (typeof (client as any)?.session?.messages !== "function") {
      return { messages: [] as any[], complete: false }
    }
    const messages: any[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < maxPages; page += 1) {
      const response: any = await client.session.messages({
        path: { id: sessionID },
        query: { directory: root, limit, ...(cursor ? { cursor } : {}) },
      })
      if (response?.error) throw new Error(String(response.error?.message ?? response.error))
      const value = unwrap<any>(response)
      const pageMessages = unwrapMessages(response)
      messages.push(...pageMessages)

      // The installed v1 SDK returns a bare array and exposes only `limit`.
      // A short page is its only proof of completeness. Some OpenCode clients
      // expose a cursor envelope at runtime; consume that shape when present so
      // older and newer harness sessions retain their full-history semantics.
      if (Array.isArray(value)) return { messages, complete: pageMessages.length < limit }
      const next = typeof value?.cursor?.next === "string" ? value.cursor.next : undefined
      if (!next) return { messages, complete: Array.isArray(value?.data) }
      if (seenCursors.has(next)) return { messages, complete: false }
      seenCursors.add(next)
      cursor = next
    }
    return { messages, complete: false }
  }

  async function loadSessionMessages(sessionID: string, limit = 200, maxPages = 20) {
    return (await loadSessionTranscript(sessionID, limit, maxPages)).messages
  }

  function canonicalPlannerRecoveryFiles(sessionID: string, taskPath: string, rawPaths: string[]) {
    const task = parsePlannerTask(readFileSync(resolve(root, taskPath), "utf8"))
    const scopedFiles = (task?.scope ?? [])
      .map((entry) => entry.replace(/^NEW:\s*/i, ""))
      .filter((path) => existsSync(resolve(root, path)))
    const readFiles = [...(executorReviewReads.get(sessionID)?.keys() ?? [])]
      .filter((path) => existsSync(resolve(root, path)))
    const candidates = [...new Set([taskPath, ...scopedFiles, ...readFiles])]
    const result: string[] = []

    for (const rawPath of rawPaths) {
      const normalized = normalize(root, rawPath)
      if (!normalized) {
        throw projectGuardError(sessionID,
          `Planner recovery file is outside the project: ${rawPath}.`,
          "List only exact project-relative task or application files.",
        )
      }
      if (normalized === taskPath || (existsSync(resolve(root, normalized)) && statSync(resolve(root, normalized)).isFile())) {
        result.push(normalized)
        continue
      }
      const matches = candidates.filter((candidate) => basename(candidate).toLowerCase() === basename(normalized).toLowerCase())
      if (matches.length === 1) {
        result.push(matches[0])
        continue
      }
      throw projectGuardError(sessionID,
        matches.length > 1
          ? `Planner recovery file is ambiguous: ${rawPath} could mean ${matches.join(", ")}.`
          : `Planner recovery file does not exist and could not be repaired: ${rawPath}.`,
        matches.length > 1
          ? "Pass the exact project-relative path from the active task Scope or a file read in this Executor session."
          : "Read the existing application file first and pass its exact project-relative path. Put intended new files in required_scope with NEW: instead.",
      )
    }
    return [...new Set([taskPath, ...result])]
  }

  function taskIsAlreadySuperseded(taskPath: string, coveringTaskPath: string) {
    const name = basename(taskPath)
    const registration = readJson(resolve(root, ".task-doctor/registrations", `${name}.json`))
    const archivePath = typeof registration?.archivePath === "string" ? registration.archivePath : `kanban/superseded/${name}`
    const archiveAbsolutePath = resolve(root, archivePath)
    return registration?.status === "superseded"
      && registration.coveringTaskPath === coveringTaskPath
      && typeof registration.archiveHash === "string"
      && existsSync(archiveAbsolutePath)
      && fileHash(archiveAbsolutePath) === registration.archiveHash
  }

  function normalizedPlannerFiles(sessionID: string, values: unknown[]) {
    const scope: string[] = []
    const context: string[] = []
    const repairs: string[] = []
    const classification = new Map<string, "scope" | "context">()
    for (const rawValue of values) {
      const value = String(rawValue).trim()
      const prefix = value.match(/^(READ|NEW):\s*/i)?.[1]?.toUpperCase() as "READ" | "NEW" | undefined
      const rawPath = value.replace(/^(?:READ|NEW):\s*/i, "").replace(/^`([^`]*)`$/, "$1")
      const leadingDotPath = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath
      const hasInteriorDotSegment = leadingDotPath.split("/").some((segment) => segment === "." || segment === "..")
      const normalized = normalize(root, leadingDotPath)
      const formatError = hasInteriorDotSegment
        ? "path must not contain dot segments"
        : normalized
          ? scopePathFormatError(normalized)
          : scopePathFormatError(leadingDotPath)
      if (!normalized || formatError || planningPath.test(normalized)) {
        throw projectGuardError(sessionID,
          `Planner file entry is invalid: ${value}${formatError ? `; ${formatError}` : ""}.`,
          "Use one exact project-relative file path. Prefix an existing read-only context file with READ:. Omit NEW: because the Harness derives it from the filesystem.",
        )
      }
      if (rawPath.startsWith("./")) repairs.push(`removed leading ./ from ${rawPath}`)
      if (isAbsolute(rawPath)) repairs.push(`converted in-project absolute path ${rawPath} to ${normalized}`)
      if (isProtected(normalized, protectedPaths)) {
        throw projectGuardError(sessionID,
          `${normalized} is workflow infrastructure and cannot be a Planner file entry.`,
          "Use only application, test, package, project-documentation, or MEMORY.md files.",
        )
      }
      if (prefix !== "READ" && isProtected(normalized, readOnlyPaths)) {
        throw projectGuardError(sessionID,
          `${normalized} is read-only workflow input and cannot be mutation Scope.`,
          `Use READ: ${normalized} when it is required only as implementation context.`,
        )
      }
      if (projectPathHasSymlink(root, normalized)) {
        throw projectGuardError(sessionID,
          `Planner file entry traverses or targets a symbolic link: ${normalized}.`,
          "Use one exact project-local regular file path that does not traverse a symbolic link.",
        )
      }
      const absolutePath = resolve(root, normalized)
      const exists = existsSync(absolutePath)
      if (exists) {
        const info = lstatSync(absolutePath)
        if (!info.isFile() || info.isSymbolicLink()) {
          throw projectGuardError(sessionID,
            `Planner file entry is not a regular non-symbolic-link file: ${normalized}.`,
            "Use one exact existing regular file, or one exact missing file that the task will create.",
          )
        }
      }
      if (prefix === "READ" && !exists) {
        throw projectGuardError(sessionID,
          `Planner Context file does not exist: ${normalized}.`,
          "Use READ: only with one exact existing project-local regular file.",
        )
      }
      const kind = prefix === "READ" ? "context" : "scope"
      const previous = classification.get(normalized)
      if (previous && previous !== kind) {
        throw projectGuardError(sessionID,
          `Planner file is both mutation Scope and read-only Context: ${normalized}.`,
          `Keep exactly one entry: ${kind === "context" ? `READ: ${normalized}` : normalized}.`,
        )
      }
      if (previous) continue
      classification.set(normalized, kind)
      if (kind === "context") {
        context.push(normalized)
        continue
      }
      const canonical = exists ? normalized : `NEW: ${normalized}`
      scope.push(canonical)
      if (prefix === "NEW" && exists) repairs.push(`removed NEW: from existing file ${normalized}`)
      if (!prefix && !exists) repairs.push(`marked missing file NEW: ${normalized}`)
    }
    if (scope.length === 0) {
      throw projectGuardError(sessionID,
        "Planner files contain no mutation target.",
        "Include at least one exact file without READ:. Use READ: only for existing context that Worker must inspect but not change.",
      )
    }
    return { scope, context, repairs }
  }

  function normalizedPlannerDependencies(sessionID: string, values: unknown[]) {
    const dependencies: string[] = []
    const repairs: string[] = []
    for (const rawValue of values) {
      const raw = String(rawValue).replace(/\s+/g, " ").trim().replace(/^`([^`]*)`$/, "$1")
      if (!raw || raw.toLowerCase() === "none") {
        if (raw) repairs.push("removed depends_on=none")
        continue
      }
      const withoutPath = raw.replace(/^\.\//, "").replace(/^kanban\/(?:todo|done)\//, "")
      if (!/^[^/\s]+(?:\.md)?$/.test(withoutPath)) {
        throw projectGuardError(sessionID,
          `Task dependency is invalid: ${raw}.`,
          "Use one exact prerequisite task filename, with or without its .md suffix.",
        )
      }
      const name = withoutPath.endsWith(".md") ? withoutPath : `${withoutPath}.md`
      const existingCandidates = ["kanban/todo", "kanban/done"]
        .map((directory) => `${directory}/${name}`)
        .filter((path) => existsSync(resolve(root, path)))
      const unsafeCandidate = existingCandidates.find((path) => {
        const info = lstatSync(resolve(root, path))
        return !info.isFile() || info.isSymbolicLink() || projectPathHasSymlink(root, path)
      })
      if (unsafeCandidate) {
        throw projectGuardError(sessionID,
          `Task dependency is not a regular non-symbolic-link file: ${unsafeCandidate}.`,
          `Replace ${unsafeCandidate} with one regular canonical task file, then retry.`,
        )
      }
      const candidates = existingCandidates
      if (candidates.length !== 1) {
        throw projectGuardError(sessionID,
          candidates.length === 0
            ? `Task dependency does not exist: ${name}.`
            : `Task dependency is ambiguous because both todo and done contain ${name}.`,
          candidates.length === 0
            ? `Register ${name} first, then retry this task with depends_on: ["${name}"].`
            : `Keep exactly one canonical task file for ${name}, then retry.`,
        )
      }
      if (raw !== name) repairs.push(`normalized dependency ${raw} to ${name}`)
      if (!dependencies.includes(name)) dependencies.push(name)
    }
    return { dependencies, repairs }
  }

  function nearestPlannerPackage(path: string) {
    let directory = dirname(path.replace(/^NEW:\s*/i, ""))
    while (true) {
      const manifest = directory === "." ? "package.json" : `${directory}/package.json`
      const absoluteManifest = resolve(root, manifest)
      if (existsSync(absoluteManifest)) {
        const info = lstatSync(absoluteManifest)
        if (info.isFile() && !info.isSymbolicLink() && !projectPathHasSymlink(root, manifest)) return manifest
      }
      if (directory === ".") return null
      const parent = dirname(directory)
      directory = parent === directory ? "." : parent
    }
  }

  function plannerPackageScripts(manifest: string) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(root, manifest), "utf8"))
      return Object.fromEntries(Object.entries(parsed?.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    } catch {
      return {}
    }
  }

  function plannerShellWord(value: string) {
    return /^[A-Za-z0-9_./:@+-]+$/.test(value)
      ? value
      : `'${value.replace(/'/g, `'"'"'`)}'`
  }

  function plannerNpmCommand(manifest: string, script: string, argument?: string) {
    const directory = dirname(manifest)
    const prefix = directory === "." ? "" : ` --prefix ${plannerShellWord(directory)}`
    return `npm${prefix} run ${plannerShellWord(script)}${argument ? ` -- ${plannerShellWord(argument)}` : ""}`
  }

  function plannerNpmDirectTestCommand(manifest: string, runner: string, argument: string) {
    const directory = dirname(manifest)
    const prefix = directory === "." ? "" : ` --prefix ${plannerShellWord(directory)}`
    return `npm${prefix} exec -- ${runner} ${plannerShellWord(argument)}`
  }

  function deriveMinimalPlannerVerify(scope: string[]) {
    const paths = scope.map((entry) => entry.replace(/^NEW:\s*/i, ""))
    const testPaths = paths.filter((path) => /\.(?:test|spec)\.[^/]+$/i.test(path))
    const manifests = [...new Set(paths.map(nearestPlannerPackage).filter((value): value is string => Boolean(value)))]
    const scriptsByManifest = new Map(manifests.map((manifest) => [manifest, plannerPackageScripts(manifest)]))
    const commands: string[] = []

    for (const testPath of testPaths) {
      const manifest = nearestPlannerPackage(testPath)
      if (!manifest) continue
      const scripts = scriptsByManifest.get(manifest) ?? plannerPackageScripts(manifest)
      const testScripts = Object.entries(scripts).filter(([name]) => /^(?:test)(?::|$)/.test(name))
      const packageDirectory = dirname(manifest)
      const packageRelativePath = packageDirectory === "." ? testPath : relative(packageDirectory, testPath).split("\\").join("/")
      const candidates = testScripts.map(([name, command]) => {
        const lowerCommand = command.toLowerCase()
        const exactTarget = lowerCommand.includes(packageRelativePath.toLowerCase())
        const namesAnotherExactTest = /\.(?:test|spec)\.[A-Za-z0-9]+/i.test(command) && !exactTarget
        const genericRunner = /(?:^|\s)(?:playwright\s+test|vitest(?:\s+run)?|jest|(?:node|tsx)\s+--test)(?:\s|$)/i.test(command)
          && !namesAnotherExactTest
        return { name, command, exactTarget, genericRunner }
      })
      const exactTargets = candidates.filter((candidate) => candidate.exactTarget)
      const genericGroups = [...new Set(candidates.filter((candidate) => candidate.genericRunner).map((candidate) => {
        const ancestors = testScripts
          .map(([name]) => name)
          .filter((name) => candidate.name.startsWith(`${name}:`))
          .sort((left, right) => right.length - left.length)
        return ancestors[0] ?? candidate.name
      }))]
      if (exactTargets.length > 0) {
        commands.push(...exactTargets.map((candidate) => plannerNpmCommand(manifest, candidate.name)))
        continue
      }
      const selectedGenericName = [...genericGroups].sort()[0]
      const selectedGeneric = selectedGenericName
        ? candidates.find((candidate) => candidate.name === selectedGenericName)
        : undefined
      if (selectedGeneric) {
        commands.push(plannerNpmCommand(manifest, selectedGeneric.name, packageRelativePath))
        continue
      }
      const directRunners = [...new Set(testScripts.flatMap(([, command]) => {
        const match = command.trim().match(/^((?:node|tsx)\s+--test)\s+[^\s]+$/)
        return match ? [match[1]] : []
      }))]
      if (directRunners.length === 1) {
        commands.push(plannerNpmDirectTestCommand(manifest, directRunners[0], packageRelativePath))
      }
    }

    for (const manifest of manifests) {
      const scripts = scriptsByManifest.get(manifest) ?? {}
      if (typeof scripts.typecheck === "string") commands.push(plannerNpmCommand(manifest, "typecheck"))
      if (typeof scripts.build === "string") commands.push(plannerNpmCommand(manifest, "build"))
    }
    return [...new Set(commands)]
  }

  function availableMinimalPlannerTaskPath(sessionID: string, baseTaskPath: string, content: string) {
    const stem = baseTaskPath.replace(/\.md$/, "")
    for (let index = 1; index <= 10_000; index += 1) {
      const candidate = index === 1 ? baseTaskPath : `${stem}-${index}.md`
      const absolutePath = resolve(root, candidate)
      if (!existsSync(absolutePath)) return candidate
      const owner = readPlannerOwnership(root, candidate)
      if (owner?.plannerSessionID === sessionID && readFileSync(absolutePath, "utf8") === content) return candidate
    }
    throw projectGuardError(sessionID,
      `No free deterministic task path remains for ${baseTaskPath}.`,
      "Use a more specific title and retry the same flat Planner call.",
    )
  }

  function portablePlannerVerifyCommands(sessionID: string, values: unknown) {
    const rawVerify = Array.isArray(values) ? values.map(String) : []
    if (rawVerify.some((command) => /[\r\n]/.test(command))) {
      throw projectGuardError(sessionID,
        "A Planner Verify item contains more than one shell command line.",
        "Pass each exact executable Verify command as one array item.",
      )
    }
    const commands = [...new Set(rawVerify.map(normalizePlannerVerifyCommandSyntax).filter(Boolean))]
    return commands.map((rawCommand) => {
      const command = rawCommand.replace(
        /(\s(?:--grep(?:=|\s+)|-g\s+))(?!["'])([^;&|]+?)(?=\s+-{1,2}[A-Za-z0-9][A-Za-z0-9-]*(?:=|\s|$)|$)/g,
        (_match, prefix: string, rawPattern: string) => {
          const pattern = rawPattern.trim()
          return /\s/.test(pattern) ? `${prefix}${JSON.stringify(pattern)}` : `${prefix}${pattern}`
        },
      )
      const prefixMatch = command.match(/\bnpm\s+--prefix(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/)
      const prefixPath = prefixMatch?.[1] ?? prefixMatch?.[2] ?? prefixMatch?.[3]
      const normalizedPrefix = prefixPath ? normalize(root, prefixPath) : ""
      if (prefixPath && normalizedPrefix === null) {
        throw projectGuardError(sessionID,
          `Planner recovery Verify uses an npm --prefix directory outside the project: ${prefixPath}.`,
          "Use an exact project-relative --prefix directory.",
        )
      }
      const commandRoot = resolve(root, normalizedPrefix ?? "")
      const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const absoluteProjectPath = new RegExp(`(^|[\\s\"'=])(${escapedRoot}(?:/[^\\s\"';&|]+)?)`, "g")
      const portable = command.replace(absoluteProjectPath, (_match, delimiter: string, absolutePath: string) => {
        const projectPath = normalize(root, absolutePath)
        if (projectPath === null) return _match
        if (prefixPath && isAbsolute(prefixPath) && absolutePath === prefixPath) {
          return `${delimiter}${normalizedPrefix}`
        }
        const fromCommandRoot = relative(commandRoot, resolve(root, projectPath)).split("\\").join("/") || "."
        return `${delimiter}${fromCommandRoot}`
      })
      const absoluteArgument = [...portable.matchAll(/(?:^|\s)(?:"([^"]*)"|'([^']*)'|([^\s]+))/g)]
        .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
        .map((token) => token.replace(/^--[^=]+=|^[A-Za-z_][A-Za-z0-9_]*=/, ""))
        .find((token) => isAbsolute(token))
      if (absoluteArgument) {
        throw projectGuardError(sessionID,
          `Planner recovery Verify contains a non-portable absolute path: ${absoluteArgument}.`,
          "Use project-relative paths. In-project absolute paths are repaired automatically relative to the command's npm --prefix directory.",
        )
      }
      return portable
    })
  }

  function plannerRecoveryContractFromArgs(sessionID: string, taskPath: string, args: Record<string, any>) {
    const oneLineValues = (values: unknown) => [...new Set((Array.isArray(values) ? values : [])
      .map((value) => String(value).replace(/\s+/g, " ").trim())
      .filter(Boolean))]
    const scope = oneLineValues(args.required_scope).map((entry) => {
      const rawPath = entry.replace(/^NEW:\s*/i, "")
      const normalized = normalize(root, rawPath)
      const formatError = scopePathFormatError(rawPath)
      if (!normalized || formatError || isProtected(normalized, protectedPaths) || planningPath.test(normalized)) {
        throw projectGuardError(sessionID,
          `Planner recovery Scope entry is invalid: ${entry}${formatError ? `; ${formatError}` : ""}.`,
          "Use one exact project-relative application or test path. Prefix a file that does not exist yet with NEW:.",
        )
      }
      const exists = existsSync(resolve(root, normalized))
      return `${exists ? "" : "NEW: "}${normalized}`
    })
    const verify = portablePlannerVerifyCommands(sessionID, args.required_verify)
    const supersedeTasks = oneLineValues(args.supersede_tasks).map((entry) => {
      const normalized = normalize(root, entry)
      if (!normalized || !planningPath.test(normalized) || normalized === taskPath
        || (!existsSync(resolve(root, normalized)) && !taskIsAlreadySuperseded(normalized, taskPath))) {
        throw projectGuardError(sessionID,
          `Planner recovery supersede target is invalid: ${entry}.`,
          "Pass one unchanged existing kanban/todo/<exact-name>.md task other than the active task.",
        )
      }
      return normalized
    })
    return canonicalPlannerRecoveryContract({
      scope,
      requirements: oneLineValues(args.required_requirements),
      verify,
      supersedeTasks,
    } satisfies PlannerRecoveryContract)
  }

  function currentPathHash(path: string) {
    const normalized = normalize(root, path)
    if (!normalized || normalized !== path) return undefined
    const absolutePath = resolve(root, path)
    if (!existsSync(absolutePath)) return null
    if (!statSync(absolutePath).isFile()) return undefined
    return fileHash(absolutePath)
  }

  function currentScopeSnapshot(scope: string[], state: any, receipts: ReturnType<typeof readWorkerScopeRecoveryReceipts>) {
    const normalizedScope = scope.map((entry) => entry.replace(/^NEW:\s*/i, ""))
    const candidates = new Set<string>()
    for (const path of Object.keys(state?.snapshot ?? {})) {
      if (allowed(path, normalizedScope)) candidates.add(path)
    }
    for (const receipt of receipts) {
      const appliedAt = Date.parse(String(receipt.appliedAt ?? ""))
      if (receipt.status !== "applied" || receipt.taskPath !== state.taskPath
        || !Number.isFinite(appliedAt) || appliedAt < Date.parse(String(state.startedAt ?? ""))) continue
      for (const file of receipt.files ?? []) {
        if (typeof file?.path === "string" && allowed(file.path, normalizedScope)) candidates.add(file.path)
      }
    }

    const ignoredDirectories = new Set([".git", ".opencode", ".task-doctor", "node_modules", "dist", "build", "coverage", "test-results"])
    let visited = 0
    const visit = (path: string) => {
      if (visited++ > 20_000) throw new Error("Worker Scope recovery refused to scan more than 20,000 current Scope entries.")
      const absolutePath = resolve(root, path)
      if (!existsSync(absolutePath)) return
      const info = lstatSync(absolutePath)
      if (info.isSymbolicLink()) throw new Error(`Worker Scope recovery rejects a symlink in the previous Scope: ${path}`)
      if (info.isFile()) {
        candidates.add(path)
        return
      }
      if (!info.isDirectory()) throw new Error(`Worker Scope recovery accepts regular files and directories only: ${path}`)
      for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
        if (ignoredDirectories.has(entry.name)) continue
        visit(`${path}/${entry.name}`)
      }
    }
    for (const path of normalizedScope) visit(path)

    return Object.fromEntries([...candidates].flatMap((path) => {
      const currentHash = currentPathHash(path)
      if (currentHash === undefined) throw new Error(`Worker Scope recovery cannot hash the previous Scope path: ${path}`)
      return currentHash === null ? [] : [[path, currentHash] as const]
    }))
  }

  function trustedScopeBaselineSource(state: any, path: string, expectedHash: string): TrustedBaselineSource | undefined {
    const stored = readWorkerChangeBaseline(root, expectedHash)
    if (stored) return { source: "persisted-baseline", hash: expectedHash }
    if (typeof state?.head !== "string" || !/^[a-f0-9]{7,64}$/.test(state.head)) return undefined
    const result = spawnSync("git", ["show", `${state.head}:${path}`], {
      cwd: root,
      encoding: null,
      maxBuffer: 12 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return undefined
    const sourceHash = createHash("sha256").update(result.stdout).digest("hex")
    return sourceHash === expectedHash ? { source: "git-head", hash: expectedHash } : undefined
  }

  function restoreFileBackups(backups: Array<{ path: string; content: Buffer | null }>) {
    for (const backup of backups) {
      if (backup.content === null) rmSync(backup.path, { force: true })
      else {
        mkdirSync(dirname(backup.path), { recursive: true })
        writeFileSync(backup.path, backup.content)
      }
    }
  }

  async function reconcileCompletedExactScopeRecovery() {
    if (!enabled) return
    let applied: ReturnType<typeof applyWorkerScopeRecoveryPlan> | null = null
    let backups: Array<{ path: string; content: Buffer | null }> = []
    try {
      const receipt = explicitPlannerReviewReceipt()
      const state = activeState(root)
      if (receipt?.status !== "complete" || receipt.contractMode !== "replace" || !receipt.contract
        || state?.status !== "started" || state.taskPath !== receipt.taskPath || state.taskHash !== receipt.taskHash) return
      const taskAbsolutePath = resolve(root, receipt.taskPath)
      if (!existsSync(taskAbsolutePath)) return
      const taskContent = readFileSync(taskAbsolutePath, "utf8")
      const task = parsePlannerTask(taskContent)
      if (!task) return
      const registrationPath = resolve(root, ".task-doctor/registrations", `${basename(receipt.taskPath)}.json`)
      const registration = readJson(registrationPath)
      const ownership = readPlannerOwnership(root, receipt.taskPath)
      const failure = readJson(lastDoctorFailurePath)
      const findings = doctorScopeFindings(String(failure?.output ?? ""))
      const candidatePaths = [...new Set(findings.flatMap((finding) => finding.path ? [finding.path] : []))]
      if (candidatePaths.length === 0) return

      // A restart recovery may only repair the pre-revision evidence path. If any
      // current-Scope file moved after registration, preserve it and leave Doctor/Help authoritative.
      const registeredSnapshot = registration?.snapshot ?? {}
      const currentScopeStable = Object.entries(registeredSnapshot).every(([path, registeredHash]) => (
        !allowed(path, task.scope.map((entry) => entry.replace(/^NEW:\s*/i, "")))
        || currentPathHash(path) === registeredHash
      ))
      if (!currentScopeStable) return

      const currentHashes = Object.fromEntries(candidatePaths.map((path) => [path, currentPathHash(path)]))
      if (Object.values(currentHashes).some((value) => value === undefined)) return
      const baselineSources = Object.fromEntries(candidatePaths.flatMap((path) => {
        const baselineHash = state.snapshot?.[path]
        if (typeof baselineHash !== "string") return []
        const source = trustedScopeBaselineSource(state, path, baselineHash)
        return source ? [[path, source] as const] : []
      }))
      const workerReceipts = readWorkerScopeRecoveryReceipts(root)
      const startup = planExactReceiptStartupReconciliation({
        receipt,
        state,
        taskContent,
        registration,
        ownership,
        currentHashes,
        baselineSources,
        appliedWorkerChanges: workerReceipts,
        workerHelp: workerHelpStore(root),
        lastDoctorFailure: failure,
        protectedPaths,
      })
      if (startup.status !== "ready" || startup.restorePaths.length === 0) return

      const recoveryPlan = planWorkerScopeRecovery({
        root,
        state,
        currentSnapshot: currentHashes as Record<string, string>,
        nextScope: task.scope,
        candidatePaths: startup.restorePaths.map((entry) => entry.path),
        receipts: workerReceipts,
        readBaselineBlob: (baselineHash) => readWorkerChangeBaseline(root, baselineHash),
      })
      const plannedPaths = recoveryPlan.entries.map((entry) => entry.path).sort()
      const authorizedPaths = startup.restorePaths.map((entry) => entry.path).sort()
      if (JSON.stringify(plannedPaths) !== JSON.stringify(authorizedPaths)) {
        throw new Error("Exact startup authorization and Worker Scope recovery planned different paths.")
      }

      const statePath = resolve(root, ".task-doctor/state.json")
      const mutablePaths = [statePath, registrationPath, lastDoctorFailurePath, workerHelpStatePath]
      backups = mutablePaths.map((path) => ({ path, content: existsSync(path) ? readFileSync(path) : null }))
      applied = applyWorkerScopeRecoveryPlan(recoveryPlan)
      const restoredAt = new Date().toISOString()
      const restoredPaths = recoveryPlan.entries.map((entry) => ({
        path: entry.path,
        baselineHash: entry.baselineHash,
        previousHash: entry.currentHash,
        source: entry.source,
        workerChangeReceipts: entry.receiptIDs,
      }))

      const nextRegistrationSnapshot = { ...(registration.snapshot ?? {}) }
      for (const entry of recoveryPlan.entries) {
        if (entry.baselineHash === null) delete nextRegistrationSnapshot[entry.path]
        else nextRegistrationSnapshot[entry.path] = entry.baselineHash
      }
      writeFileSync(registrationPath, `${JSON.stringify({
        ...registration,
        snapshot: nextRegistrationSnapshot,
        scopeRecovery: { kind: "exact_scope_reconciled", restoredPaths, restoredAt },
      }, null, 2)}\n`)
      writeFileSync(statePath, `${JSON.stringify({
        ...state,
        taskRevision: {
          ...state.taskRevision,
          restoredRemovedScopePaths: restoredPaths,
          scopeRecoveredAt: restoredAt,
        },
      }, null, 2)}\n`)
      rmSync(lastDoctorFailurePath, { force: true })

      if (startup.helpAction?.action === "obsolete") {
        const store = workerHelpStore(root)
        store.requests = store.requests.map((request) => request.id === startup.helpAction!.requestID
          ? {
              ...request,
              status: "resolved" as const,
              closedAt: restoredAt,
              closureReason: "scope_baseline_recovered",
            }
          : request)
        writeWorkerHelpStore(store)
      }
      await log("info", "Reconciled removed Worker Scope paths after exact Planner replacement", {
        task: receipt.taskPath,
        paths: plannedPaths,
        helpAction: startup.helpAction?.action ?? "none",
      })
      applied.finalize()
      applied = null
    } catch (error) {
      let rollbackError: unknown
      if (applied) {
        try {
          applied.rollback()
        } catch (candidate) {
          rollbackError = candidate
        }
      }
      if (backups.length > 0) restoreFileBackups(backups)
      await log("warn", "Could not reconcile removed Worker Scope paths after restart", {
        error: error instanceof Error ? error.message : String(error),
        rollbackError: rollbackError instanceof Error ? rollbackError.message : rollbackError ? String(rollbackError) : undefined,
      })
    }
  }

  await reconcileCompletedExactScopeRecovery()
  const startupWorkerHelpStore = reconcileWorkerHelpLifecycle()
  for (const request of startupWorkerHelpStore.requests) {
    if (request.status === "pending") workerHelpTerminalSessions.add(request.workerSessionID)
  }
  await reconcilePersistedHelpDelegationAfterRestart()
  await reconcileStartedBaseContinuationsAfterRestart()
  function writeWorkerHelpStore(store: WorkerHelpStore) {
    mutateWorkerHelpStore(root, (current) => {
      if (current === store) return
      current.version = 1
      current.requests = store.requests
      current.updatedAt = store.updatedAt
    })
  }

  function reconcileWorkerHelpLifecycle(state = activeState(root)) {
    return mutateWorkerHelpStore(root, (store) => {
      const reviewableStatuses = new Set<string>(["pending", "retry_approved", "planner_unavailable", "planner_recovery_incomplete"])

      store.requests = store.requests.map((stored, index, requests) => {
        let request = stored
        if (!request.retryOfHelpID) {
          const parent = requests.slice(0, index).findLast((candidate) => (
            candidate.status === "delegated"
            && candidate.delegatedWorkerSessionID === request.workerSessionID
            && candidate.taskPath === request.taskPath
            && candidate.taskHash === request.taskHash
            && candidate.executorReview?.decision === "retry_worker"
          ))
          if (parent) request = { ...request, retryOfHelpID: parent.id }
        }

        if (reviewableStatuses.has(request.status)) {
          const taskName = basename(request.taskPath)
          const completed = existsSync(resolve(root, "kanban/done", taskName))
          const superseded = existsSync(resolve(root, "kanban/superseded", taskName))
          const taskExists = existsSync(resolve(root, request.taskPath))
          const revisedByRequest = state?.status === "started"
            && state.taskPath === request.taskPath
            && state.taskRevision?.helpID === request.id
            && state.taskRevision?.previousTaskHash === request.taskHash
            && state.taskRevision?.revisedTaskHash === state.taskHash
          const activeHashReplaced = state?.status === "started"
            && state.taskPath === request.taskPath
            && typeof state.taskHash === "string"
            && state.taskHash !== request.taskHash

          if (revisedByRequest) {
            // Keep the pending request reviewable so review_worker_help can return its
            // established "already resolved" result and persist the Executor review.
          } else if (completed) {
            request = {
              ...request,
              status: "resolved",
              closedAt: request.closedAt ?? new Date().toISOString(),
              closureReason: "task_completed",
            }
          } else if (superseded || !taskExists) {
            request = {
              ...request,
              status: "obsolete",
              closedAt: request.closedAt ?? new Date().toISOString(),
              closureReason: "task_superseded",
            }
          } else if (activeHashReplaced) {
            request = {
              ...request,
              status: "obsolete",
              closedAt: request.closedAt ?? new Date().toISOString(),
              closureReason: "task_hash_replaced",
            }
          }
        }

        return request
      })
      return store
    })
  }

  function writePlannerRecoveryState(input: {
    status: "unavailable" | "incomplete"
    taskPath: string
    taskHash: string
    plannerSessionID: string | null
    executorSessionID: string
    reason: string
    helpID?: string
  }) {
    mkdirSync(dirname(plannerRecoveryStatePath), { recursive: true })
    writeFileSync(plannerRecoveryStatePath, `${JSON.stringify({
      version: 1,
      ...input,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`)
  }

  function clearPlannerRecoveryState(taskPath: string) {
    const stored = plannerRecoveryState(root)
    if (!stored || stored.taskPath === taskPath) rmSync(plannerRecoveryStatePath, { force: true })
  }

  function cancelRejectedPendingPlannerRecovery(sessionID: string, taskPath: string, taskHash: string) {
    const help = currentWorkerHelp(root, taskPath, taskHash)
    if (!help
      || !["retry_approved", "task_changed"].includes(help.status)
      || help.delegatedWorkerSessionID) return false

    const receipt = explicitPlannerReviewReceipt()
    const supersedeTasks = receipt?.contract?.supersedeTasks ?? []
    const safelyUncommitted = receipt?.status === "pending"
      && receipt.executorSessionID === sessionID
      && receipt.taskPath === taskPath
      && receipt.initialTaskHash === taskHash
      && receipt.taskHash === taskHash
      && supersedeTasks.length === 0
    if (!safelyUncommitted) return false

    rmSync(explicitPlannerReviewPath, { force: true })
    const recovery = plannerRecoveryState(root)
    if (recovery?.taskPath === taskPath
      && recovery.taskHash === taskHash
      && recovery.executorSessionID === sessionID) {
      clearPlannerRecoveryState(taskPath)
    }
    clearAuthoritativePlannerBlocker(taskPath)
    executorPlannerRecoveryRequested.delete(sessionID)
    terminalExecutorReasons.delete(sessionID)
    return true
  }

  function clearAuthoritativePlannerBlocker(taskPath?: string) {
    const stored = readJson(authoritativePlannerBlockerPath)
    if (!stored || !taskPath || stored.taskPath === taskPath) rmSync(authoritativePlannerBlockerPath, { force: true })
  }

  function recordAuthoritativeWorkerOwner(input: {
    executorSessionID: string
    workerSessionID: string
    taskPath: string
    taskHash: string
    resultText: string
  }) {
    const owner = input.resultText.match(/(?:^|\n)\s*Required owner\s*:\s*(Executor|Planner|User)\s*(?:\n|$)/i)?.[1]
    if (owner?.toLowerCase() !== "planner") {
      clearAuthoritativePlannerBlocker(input.taskPath)
      return
    }
    mkdirSync(dirname(authoritativePlannerBlockerPath), { recursive: true })
    writeFileSync(authoritativePlannerBlockerPath, `${JSON.stringify({
      version: 1,
      owner: "Planner",
      taskPath: input.taskPath,
      taskHash: input.taskHash,
      workerSessionID: input.workerSessionID,
      executorSessionID: input.executorSessionID,
      recordedAt: new Date().toISOString(),
    }, null, 2)}\n`)
  }

  function nextWorkerHelpID(store: WorkerHelpStore) {
    const highest = store.requests.reduce((value, request) => {
      const candidate = Number(request.id.match(/^H(\d+)$/i)?.[1] ?? 0)
      return Math.max(value, candidate)
    }, 0)
    return `H${highest + 1}`
  }

  function updateWorkerHelp(id: string, update: (request: WorkerHelpRequest) => WorkerHelpRequest) {
    return mutateWorkerHelpStore(root, (store) => {
      const index = store.requests.findIndex((request) => request.id === id)
      if (index < 0) return null
      const request = update(store.requests[index])
      store.requests[index] = request
      return request
    })
  }

  function reconcileWorkerHelpRevision(state = activeState(root), helpID?: string | null) {
    const revision = state?.taskRevision
    if (state?.status !== "started"
      || typeof state.taskPath !== "string"
      || typeof state.taskHash !== "string"
      || typeof revision?.helpID !== "string"
      || revision.revisedTaskHash !== state.taskHash
      || (helpID && revision.helpID !== helpID)) return null
    const reconciled = mutateWorkerHelpStore(root, (store) => {
      const index = store.requests.findIndex((request) => request.id === revision.helpID)
      if (index < 0) return null
      const request = store.requests[index]
      if (request.taskPath !== state.taskPath
        || ![revision.previousTaskHash, revision.revisedTaskHash].includes(request.taskHash)) return null
      const next = request.status === "delegated"
        ? request
        : { ...request, status: "task_changed" as const, taskHash: state.taskHash }
      store.requests[index] = next
      return next
    })
    if (!reconciled) return null
    const recovery = plannerRecoveryState(root)
    if (recovery?.helpID === reconciled.id && recovery.taskPath === reconciled.taskPath) {
      clearPlannerRecoveryState(reconciled.taskPath)
    }
    return reconciled
  }

  function pendingWorkerHelp(taskPath?: string | null, taskHash?: string | null) {
    return [...reconcileWorkerHelpLifecycle().requests].reverse().find((request) => (
      request.status === "pending"
      && (!taskPath || request.taskPath === taskPath)
      && (!taskHash || request.taskHash === taskHash)
    )) ?? null
  }

  function workerHelpForSession(sessionID: string, taskPath?: string | null, taskHash?: string | null) {
    return [...reconcileWorkerHelpLifecycle().requests].reverse().find((request) => (
      request.workerSessionID === sessionID
      && (!taskPath || request.taskPath === taskPath)
      && (!taskHash || request.taskHash === taskHash)
      && request.status === "pending"
    )) ?? null
  }

  function workerHelpHandoff(request: WorkerHelpRequest) {
    return [
      "HELP_REQUESTED",
      `Help ID: ${request.id}`,
      `Task: ${request.taskPath}`,
      `Problem: ${request.problem}`,
      "Evidence:",
      ...request.evidence.map((item) => `- ${item}`),
      "Attempted:",
      ...request.attemptedActions.map((item) => `- ${item}`),
      `Suggested next step: ${request.suggestedNextStep}`,
      `EXECUTOR NEXT ACTION: Inspect ${request.relevantFiles.join(", ")}, then call review_worker_help for ${request.id}. Choose retry_worker only for an in-scope implementation failure. Choose planner_recovery when Scope, requirements, dependencies, or Verify are wrong. Do not bypass the review.`,
    ].join("\n")
  }

  function persistWorkerOutputLimitHelp(
    sessionID: string,
    taskPath: string,
    taskHash: string,
    outputTokens: number,
  ) {
    const persisted = mutateWorkerHelpStore(root, (store) => {
      const existing = [...store.requests].reverse().find((request) => (
        request.workerSessionID === sessionID
        && request.taskPath === taskPath
        && request.taskHash === taskHash
        && request.status === "pending"
      ))
      if (existing) return { request: existing, created: false }
      const request: WorkerHelpRequest = {
        version: 1,
        id: nextWorkerHelpID(store),
        status: "pending",
        taskPath,
        taskHash,
        workerSessionID: sessionID,
        category: "output-limit",
        problem: `Worker response reached the fixed ${outputTokens}-token output limit before completing its next tool call.`,
        attemptedActions: [
          "Worker read the required rules, task, and current Scope files, then began a change response that ended before a complete mutation tool call was available.",
        ],
        evidence: [
          "Assistant finish reason: length.",
          `Assistant output tokens: ${outputTokens}.`,
          "No complete transactional preview or apply was returned by the truncated response.",
        ],
        relevantFiles: [taskPath],
        suggestedNextStep: "Approve one fresh Worker retry that reads one incomplete Scope file, previews one small exact change for only that file, applies it, and only then continues with another file.",
        createdAt: new Date().toISOString(),
      }
      store.requests.push(request)
      return { request, created: true }
    })
    if (!persisted.created) return persisted.request
    workerHelpTerminalSessions.add(sessionID)
    workerHelpRequired.delete(sessionID)
    doctorFailures.delete(sessionID)
    cleanupWorkerChangesForSession(root, sessionID)
    return persisted.request
  }

  function persistRequiredWorkerHelp(
    sessionID: string,
    taskPath: string,
    taskHash: string,
    required: { count: number; fingerprint: LoopFailureFingerprint; reason?: "repeated" | "slow" },
  ) {
    const target = normalize(root, required.fingerprint.target)
    const failureText = [required.fingerprint.problem, required.fingerprint.evidence].filter(Boolean).join("\n").toLowerCase()
    const taskScope = scopeFromTask(root, taskPath)
    const directlyNamed = taskScope.paths.filter((path) => (
      failureText.includes(path.toLowerCase()) || failureText.includes(basename(path).toLowerCase())
    ))
    const genericPathTokens = new Set([
      "app", "backend", "code", "frontend", "index", "main", "module", "modules", "page", "pages", "source", "spec", "src", "test", "tests",
    ])
    const topicTokens = [...new Set(directlyNamed.flatMap((path) => (
      path.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length >= 4 && !genericPathTokens.has(part))
    )))]
    const relatedScopePaths = taskScope.paths.filter((path) => {
      if (!existsSync(resolve(root, path)) || isProtected(path, protectedPaths)) return false
      if (directlyNamed.includes(path)) return true
      const tokens = path.toLowerCase().split(/[^a-z0-9]+/)
      return topicTokens.some((token) => tokens.includes(token))
    })
    const relevantFiles = [...new Set([
      taskPath,
      ...relatedScopePaths,
      ...(target && target !== taskPath && existsSync(resolve(root, target)) && !isProtected(target, protectedPaths) ? [target] : []),
    ])].slice(0, 10)
    const persisted = mutateWorkerHelpStore(root, (store) => {
      const existing = [...store.requests].reverse().find((request) => (
        request.workerSessionID === sessionID
        && request.taskPath === taskPath
        && request.taskHash === taskHash
        && request.status === "pending"
      ))
      if (existing) return { request: existing, created: false }
      const retryParent = [...store.requests].reverse().find((entry) => (
        entry.status === "delegated"
        && entry.delegatedWorkerSessionID === sessionID
        && entry.taskPath === taskPath
        && entry.taskHash === taskHash
        && entry.executorReview?.decision === "retry_worker"
      ))
      const request: WorkerHelpRequest = {
        version: 1,
        id: nextWorkerHelpID(store),
        status: "pending",
        taskPath,
        taskHash,
        workerSessionID: sessionID,
        category: required.fingerprint.category,
        problem: required.fingerprint.problem,
        attemptedActions: [
          required.reason === "slow"
            ? `Worker ran ${required.fingerprint.tool}; the failed verification exceeded the safe duration for one Worker subagent lifecycle.`
            : `Worker attempted a correction and reran ${required.fingerprint.tool}; the equivalent failure remained.`,
        ],
        evidence: [
          required.reason === "slow"
            ? `${required.fingerprint.tool} failed after at least ${longDoctorFailureMs} ms, so another long retry would risk detaching the Worker from Executor.`
            : `${required.count} equivalent failures occurred for ${required.fingerprint.tool} on ${required.fingerprint.target}.`,
          required.fingerprint.evidence ?? required.fingerprint.problem,
        ],
        relevantFiles,
        suggestedNextStep: "Executor must inspect the recorded failure. Retry only for an in-scope implementation problem; use Planner recovery when the task definition or Verify command is wrong.",
        createdAt: new Date().toISOString(),
        retryOfHelpID: retryParent?.id,
      }
      store.requests.push(request)
      return { request, created: true }
    })
    if (!persisted.created) return persisted.request
    workerHelpTerminalSessions.add(sessionID)
    workerHelpRequired.delete(sessionID)
    doctorFailures.delete(sessionID)
    cleanupWorkerChangesForSession(root, sessionID)
    return persisted.request
  }

  function canonicalOutsideScopeDoctorFailure(taskPath: string, output: string) {
    const parsed = restoreOnlyOutsideScopeFailure(output)
    if (!parsed || !existsSync(resolve(root, taskPath))) return null
    const taskScope = scopeFromTask(root, taskPath).paths
    const normalizedPaths: string[] = []
    for (const rawPath of parsed.paths) {
      const path = normalize(root, rawPath)
      if (!path
        || path === "."
        || path === ".."
        || path.startsWith("../")
        || isAbsolute(rawPath)
        || path !== rawPath
        || path === taskPath
        || isProtected(path, protectedPaths)
        || allowed(path, taskScope)) return null

      let current = root
      for (const segment of path.split("/")) {
        current = resolve(current, segment)
        if (!existsSync(current)) break
        if (lstatSync(current).isSymbolicLink()) return null
      }
      if (existsSync(resolve(root, path)) && !statSync(resolve(root, path)).isFile()) return null
      normalizedPaths.push(path)
    }
    if (new Set(normalizedPaths).size !== parsed.paths.length) return null
    return { ...parsed, paths: normalizedPaths }
  }

  function persistOutsideScopeDoctorHelp(
    sessionID: string,
    taskPath: string,
    taskHash: string,
    failure: RestoreOnlyOutsideScopeFailure,
  ) {
    const persisted = mutateWorkerHelpStore(root, (store) => {
      const existing = [...store.requests].reverse().find((request) => (
        request.workerSessionID === sessionID
        && request.taskPath === taskPath
        && request.taskHash === taskHash
        && request.status === "pending"
      ))
      if (existing) return { request: existing, created: false }
      const retryParent = [...store.requests].reverse().find((entry) => (
        entry.status === "delegated"
        && entry.delegatedWorkerSessionID === sessionID
        && entry.taskPath === taskPath
        && entry.taskHash === taskHash
        && entry.executorReview?.decision === "retry_worker"
      ))
      const request: WorkerHelpRequest = {
        version: 1,
        id: nextWorkerHelpID(store),
        status: "pending",
        taskPath,
        taskHash,
        workerSessionID: sessionID,
        category: "task_scope",
        problem: `Doctor found only restorable baseline drift outside the active Scope: ${failure.paths.join(", ")}.`,
        attemptedActions: [
          "Worker ran the required Doctor verify once. The Harness stopped the run before any retry or restoration attempt after this finding.",
        ],
        evidence: [failure.evidence],
        relevantFiles: [...new Set([taskPath, ...failure.paths])],
        suggestedNextStep: "Executor must determine whether the reported paths are mechanically recoverable Worker-owned baseline drift or an intentional requirement missing from the task. Do not retry a Worker against the unchanged failure; use Planner recovery only when the task contract must change.",
        createdAt: new Date().toISOString(),
        retryOfHelpID: retryParent?.id,
      }
      store.requests.push(request)
      return { request, created: true }
    })
    if (!persisted.created) return persisted
    workerHelpTerminalSessions.add(sessionID)
    workerHelpRequired.delete(sessionID)
    doctorFailures.delete(sessionID)
    loopFailures.delete(sessionID)
    cleanupWorkerChangesForSession(root, sessionID)
    return persisted
  }

  async function terminalizeOutsideScopeDoctorFailure(
    sessionID: string,
    taskPath: string,
    taskHash: string,
    failure: RestoreOnlyOutsideScopeFailure,
  ) {
    const persisted = persistOutsideScopeDoctorHelp(sessionID, taskPath, taskHash, failure)
    sessionFeedback.set(sessionID, [
      "WORKER HELP IS TERMINAL",
      `Help ID: ${persisted.request.id}`,
      "The outside-Scope Doctor finding was stored mechanically. Do not call another tool or continue implementation.",
      "End now; the parent hook constructs the canonical Executor handoff.",
    ].join("\n"))

    if (persisted.created && typeof (client as any)?.session?.abort === "function") {
      try {
        const result = await client.session.abort({
          path: { id: sessionID },
          query: { directory: root },
        })
        if ((result as any)?.error) throw new Error(String((result as any).error?.message ?? (result as any).error))
      } catch (error) {
        await log("warn", "Could not abort Worker after terminal outside-Scope Doctor finding", {
          sessionID,
          helpID: persisted.request.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return persisted.request
  }

  async function terminalizeRepeatedWorkerFailure(
    sessionID: string,
    count: number,
    fingerprint: LoopFailureFingerprint,
  ) {
    const state = activeState(root)
    if (state?.status !== "started"
      || typeof state.taskPath !== "string"
      || typeof state.taskHash !== "string"
      || pendingGuardLearningsForAgent(sessionID).size > 0) return null
    const request = persistRequiredWorkerHelp(sessionID, state.taskPath, state.taskHash, {
      count,
      fingerprint,
      reason: "repeated",
    })
    sessionFeedback.set(sessionID, [
      "WORKER HELP IS TERMINAL",
      `Help ID: ${request.id}`,
      "The repeated failure was stored mechanically. Do not call request_executor_help or another tool.",
      "End now; the parent hook constructs the canonical Executor handoff.",
    ].join("\n"))
    if (typeof (client as any)?.session?.abort === "function") {
      try {
        const result = await client.session.abort({
          path: { id: sessionID },
          query: { directory: root },
        })
        if ((result as any)?.error) throw new Error(String((result as any).error?.message ?? (result as any).error))
      } catch (error) {
        await log("warn", "Could not abort Worker after mechanically persisted loop help", {
          sessionID,
          helpID: request.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return request
  }

  function persistInvalidWorkerReturnHelp(input: {
    sessionID: string
    taskPath: string
    taskHash: string
    issue: string
    failure: LoopFailureFingerprint | null
    failureSource?: "doctor" | "tool"
    secondaryEvidence?: string[]
    retryOfHelpID?: string
    relevantFiles?: string[]
  }) {
    const evidence = [
      input.failure?.evidence ?? `Worker ended without a valid terminal handoff: ${input.issue}.`,
      ...(input.secondaryEvidence ?? []),
    ]
    const persisted = mutateWorkerHelpStore(root, (store) => {
      const existing = [...store.requests].reverse().find((request) => (
        request.workerSessionID === input.sessionID
        && request.taskPath === input.taskPath
        && request.taskHash === input.taskHash
        && request.status === "pending"
      ))
      if (existing) return { request: existing, created: false }
      const request: WorkerHelpRequest = {
        version: 1,
        id: nextWorkerHelpID(store),
        status: "pending",
        taskPath: input.taskPath,
        taskHash: input.taskHash,
        workerSessionID: input.sessionID,
        category: input.retryOfHelpID
          ? "reviewed-retry-incomplete"
          : input.failure
            ? input.failureSource === "tool" ? "tool-failure" : "doctor-failure"
            : "invalid-worker-return",
        problem: input.failure?.problem
          ?? `Worker ended without a usable terminal handoff (${input.issue}).`,
        attemptedActions: [
          input.retryOfHelpID
            ? `Worker ran the Executor-approved retry for ${input.retryOfHelpID} and ended before returning a valid REVIEWABLE, BLOCKED, or structured help result.`
            : input.failureSource === "tool" && input.failure
              ? `Worker called ${input.failure.tool}; the tool failed and the Worker ended before returning a valid REVIEWABLE, BLOCKED, or structured help result.`
              : "Worker ran the active Doctor lifecycle and ended before returning a valid REVIEWABLE, BLOCKED, or structured help result.",
        ],
        evidence,
        relevantFiles: [...new Set([input.taskPath, ...(input.relevantFiles ?? [])])],
        suggestedNextStep: "Executor must inspect the task and failure evidence. Retry only for an in-scope implementation problem; use Planner recovery when the task definition or Verify command cannot pass in the managed project environment.",
        createdAt: new Date().toISOString(),
        retryOfHelpID: input.retryOfHelpID,
      }
      store.requests.push(request)
      return { request, created: true }
    })
    if (!persisted.created) return persisted.request
    workerHelpTerminalSessions.add(input.sessionID)
    cleanupWorkerChangesForSession(root, input.sessionID)
    return persisted.request
  }

  function taskRevisionPaths(taskPath: string, state: any) {
    const name = taskPath.split("/").pop()!
    return [
      resolve(root, taskPath),
      resolve(root, ".task-doctor/lints", `${name}.json`),
      resolve(root, ".task-doctor/registrations", `${name}.json`),
      resolve(root, ".task-doctor/state.json"),
      lastDoctorFailurePath,
      reviewLogPath(root, taskPath),
      plannerOwnershipPath(root, taskPath),
      plannerRecoveryStatePath,
      typeof state?.reportPath === "string" ? resolve(root, state.reportPath) : null,
    ].filter((path): path is string => Boolean(path))
  }

  function reviseActiveTask(input: {
    taskPath: string
    expectedTaskHash: string
    replacement?: string
    title?: string
    outcome?: string
    addScope?: string[]
    addRequirements?: string[]
    verify?: string[]
    reason: string
    plannerSessionID: string
    plannerAgent: string
    executorSessionID?: string
    helpID?: string
    recoveryContract?: PlannerRecoveryContract
    exactRecoveryContract?: boolean
    coveredTasks?: string[]
  }) {
    const state = activeState(root)
    if (state?.status !== "started" || state.taskPath !== input.taskPath || state.taskHash !== input.expectedTaskHash) {
      throw new Error(`Task ${input.taskPath} is no longer the exact active state the Planner was asked to revise.`)
    }
    const taskPath = resolve(root, input.taskPath)
    const original = readFileSync(taskPath, "utf8")
    if (hash(original) !== state.taskHash) throw new Error("The active task changed outside the Planner recovery transition.")
    const exactContract = input.exactRecoveryContract ? input.recoveryContract : undefined
    const structuredRevision = Boolean(
      exactContract
      || input.title
      || input.outcome
      || input.addScope?.length
      || input.addRequirements?.length
      || input.verify?.length,
    )
    let replacement = structuredRevision
      ? mergePlannerTaskRevision(original, {
          title: input.title,
          outcome: input.outcome,
          addScope: input.addScope,
          addRequirements: input.addRequirements,
          exactScope: exactContract?.scope,
          exactRequirements: exactContract?.requirements,
          verify: exactContract?.verify ?? input.verify,
        })
      : input.replacement?.endsWith("\n") ? input.replacement : input.replacement ? `${input.replacement}\n` : original
    const parsedReplacement = parsePlannerTask(replacement)
    if (parsedReplacement) {
      const portableVerify = portablePlannerVerifyCommands(input.plannerSessionID, parsedReplacement.verify)
      replacement = renderPlannerTask({ ...parsedReplacement, verify: portableVerify })
    }
    const finalTask = parsePlannerTask(replacement)
    if (exactContract && !finalTask) throw new Error("The exact Planner replacement is not in canonical task format.")
    if (replacement === original) throw new Error("The Planner replacement is unchanged.")
    if (input.recoveryContract) {
      const gaps = input.exactRecoveryContract
        ? plannerRecoveryContractExactGaps(replacement, input.recoveryContract)
        : plannerRecoveryContractGaps(replacement, input.recoveryContract)
      if (gaps.length > 0) {
        throw new Error([
          "PLANNER RECOVERY CONTRACT INCOMPLETE",
          ...gaps.map((gap) => `- ${gap}`),
          "Revise the same active task again and include every exact contract item. No task file was changed.",
        ].join("\n"))
      }
    }
    for (const coveredTaskPath of input.coveredTasks ?? []) {
      if (!taskIsAlreadySuperseded(coveredTaskPath, input.taskPath)) {
        throw new Error(`PLANNER SUPERSEDE COVERAGE INVALID\n- ${coveredTaskPath} is not durably superseded by ${input.taskPath}.`)
      }
      const registration = readJson(resolve(root, ".task-doctor/registrations", `${basename(coveredTaskPath)}.json`))
      const archivedContent = readFileSync(resolve(root, registration.archivePath), "utf8")
      const coverageGaps = plannerTaskCoverageGaps(archivedContent, replacement)
      if (coverageGaps.length > 0) {
        throw new Error([
          "PLANNER SUPERSEDE COVERAGE INCOMPLETE",
          `The final revision no longer covers ${coveredTaskPath}:`,
          ...coverageGaps.map((gap) => `- ${gap}`),
          "Revise the same active task again without dropping superseded Scope, Requirements, or exact verification commands. No active task file was changed.",
        ].join("\n"))
      }
    }

    let scopeRecoveryPlan: WorkerScopeRecoveryPlan | null = null
    if (exactContract) {
      const previousTask = parsePlannerTask(original)
      if (!previousTask) throw new Error("The active task is not in canonical Planner task format.")
      const workerReceipts = readWorkerScopeRecoveryReceipts(root)
      const currentSnapshot = currentScopeSnapshot(previousTask.scope, state, workerReceipts)
      const previousScope = previousTask.scope.map((entry) => entry.replace(/^NEW:\s*/i, ""))
      const nextScope = finalTask!.scope.map((entry) => entry.replace(/^NEW:\s*/i, ""))
      const possibleRecoveryPaths = new Set<string>([
        ...Object.keys(currentSnapshot),
        ...Object.keys(state.snapshot ?? {}),
        ...workerReceipts.flatMap((receipt) => (receipt.files ?? []).flatMap((file) => (
          typeof file?.path === "string" ? [file.path] : []
        ))),
      ])
      const removedScopePathsExist = [...possibleRecoveryPaths].some((path) => (
        allowed(path, previousScope) && !allowed(path, nextScope)
      ))
      if (removedScopePathsExist) {
        scopeRecoveryPlan = planWorkerScopeRecovery({
          root,
          state,
          currentSnapshot,
          previousScope: previousTask.scope,
          nextScope: finalTask!.scope,
          receipts: workerReceipts,
          readBaselineBlob: (baselineHash) => readWorkerChangeBaseline(root, baselineHash),
        })
      }
    }

    const paths = taskRevisionPaths(input.taskPath, state)
    const backups = paths.map((path) => ({
      path,
      content: existsSync(path) ? readFileSync(path) : null,
    }))
    const restore = () => {
      for (const backup of backups) {
        if (backup.content === null) rmSync(backup.path, { force: true })
        else {
          mkdirSync(dirname(backup.path), { recursive: true })
          writeFileSync(backup.path, backup.content)
        }
      }
    }

    let appliedScopeRecovery: ReturnType<typeof applyWorkerScopeRecoveryPlan> | null = null
    try {
      appliedScopeRecovery = scopeRecoveryPlan ? applyWorkerScopeRecoveryPlan(scopeRecoveryPlan) : null
      writeFileSync(taskPath, replacement)
      const lint = run(root, "node", ["scripts/task-doctor.mjs", "lint", input.taskPath])
      if (lint.status !== 0) throw new Error([lint.stdout, lint.stderr].filter(Boolean).join("\n").trim() || "Doctor lint rejected the proposed task revision.")
      const registration = run(root, "node", ["scripts/task-doctor.mjs", "register", input.taskPath])
      if (registration.status !== 0) throw new Error([registration.stdout, registration.stderr].filter(Boolean).join("\n").trim() || "Doctor could not register the proposed task revision.")

      const name = input.taskPath.split("/").pop()!
      const registered = readJson(resolve(root, ".task-doctor/registrations", `${name}.json`))
      if (!registered?.taskHash || registered.taskHash !== fileHash(taskPath)) {
        throw new Error("Doctor registration did not bind the revised task content.")
      }
      const ownership = claimPlannerOwnership(root, {
        taskPath: input.taskPath,
        plannerSessionID: input.plannerSessionID,
        plannerAgent: input.plannerAgent,
        source: "active_revision",
      })
      clearPlannerRecoveryState(input.taskPath)
      rmSync(lastDoctorFailurePath, { force: true })
      rmSync(reviewLogPath(root, input.taskPath), { force: true })
      if (typeof state.reportPath === "string") rmSync(resolve(root, state.reportPath), { force: true })
      const revisedAt = new Date().toISOString()
      const restoredRemovedScopePaths = scopeRecoveryPlan?.entries.map((entry) => ({
        path: entry.path,
        baselineHash: entry.baselineHash,
        previousHash: entry.currentHash,
        source: entry.source,
        workerChangeReceipts: entry.receiptIDs,
      })) ?? []
      writeFileSync(resolve(root, ".task-doctor/state.json"), `${JSON.stringify({
        ...state,
        taskHash: registered.taskHash,
        lint: registered.lint,
        registeredAt: registered.registeredAt,
        memoryAction: registered.memoryAction,
        memoryReason: registered.memoryReason,
        taskRevision: {
          helpID: input.helpID,
          previousTaskHash: state.taskHash,
          revisedTaskHash: registered.taskHash,
          plannerSessionID: input.plannerSessionID,
          plannerAgent: input.plannerAgent,
          executorSessionID: input.executorSessionID,
          reason: input.reason.replace(/\s+/g, " ").trim(),
          revisedAt,
          ...(input.exactRecoveryContract ? {
            restoredRemovedScopePaths,
            scopeRecoveredAt: revisedAt,
          } : {}),
        },
      }, null, 2)}\n`)
      appliedScopeRecovery?.finalize()
      appliedScopeRecovery = null
      return {
        taskHash: registered.taskHash as string,
        output: [
          restoredRemovedScopePaths.length > 0
            ? `TASK SCOPE BASELINE RESTORED ${restoredRemovedScopePaths.map((entry) => entry.path).join(", ")}`
            : null,
          lint.stdout.trim(),
          registration.stdout.trim(),
        ].filter(Boolean).join("\n"),
        ownership,
      }
    } catch (error) {
      let rollbackError: unknown
      if (appliedScopeRecovery) {
        try {
          appliedScopeRecovery.rollback()
        } catch (candidate) {
          rollbackError = candidate
        }
      }
      restore()
      if (rollbackError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nWorker Scope recovery rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
      }
      throw error
    }
  }

  function supersedeRegisteredTask(input: {
    taskPath: string
    reason: string
    plannerSessionID: string
    plannerAgent: string
  }) {
    const state = activeState(root)
    if (state?.status !== "started" || !planningPath.test(String(state.taskPath ?? ""))) {
      throw new Error("A registered task can be superseded only while its covering task is actively started.")
    }
    if (input.taskPath === state.taskPath) throw new Error("The active task cannot supersede itself.")

    const targetName = input.taskPath.split("/").pop()!
    const activeName = state.taskPath.split("/").pop()!
    const targetPath = resolve(root, input.taskPath)
    const activePath = resolve(root, state.taskPath)
    if (!existsSync(targetPath) || !existsSync(activePath)) throw new Error("Both the superseded and active task files must exist.")

    const targetContent = readFileSync(targetPath, "utf8")
    const activeContent = readFileSync(activePath, "utf8")
    const targetHash = hash(targetContent)
    const activeHash = hash(activeContent)
    if (activeHash !== state.taskHash) throw new Error("The active task content no longer matches Doctor state.")

    const targetRegistrationPath = resolve(root, ".task-doctor/registrations", `${targetName}.json`)
    const activeRegistrationPath = resolve(root, ".task-doctor/registrations", `${activeName}.json`)
    const targetRegistration = readJson(targetRegistrationPath)
    const activeRegistration = readJson(activeRegistrationPath)
    if (targetRegistration?.status !== "registered" || targetRegistration.taskHash !== targetHash) {
      throw new Error(`${input.taskPath} is not an unchanged registered task.`)
    }
    if (activeRegistration?.status !== "registered" || activeRegistration.taskHash !== activeHash) {
      throw new Error(`${state.taskPath} is not bound to its current Doctor registration.`)
    }

    const targetOwner = readPlannerOwnership(root, input.taskPath)
    const activeOwner = readPlannerOwnership(root, state.taskPath)
    if (!targetOwner || !activeOwner
      || targetOwner.plannerSessionID !== input.plannerSessionID
      || activeOwner.plannerSessionID !== input.plannerSessionID
      || targetOwner.taskHash !== targetHash
      || activeOwner.taskHash !== activeHash) {
      throw new Error("Both tasks must be unchanged and owned by this exact Planner session.")
    }

    const coverageGaps = plannerTaskCoverageGaps(targetContent, activeContent)
    if (coverageGaps.length > 0) throw new Error(`The active task does not fully cover ${input.taskPath}:\n- ${coverageGaps.join("\n- ")}`)
    const targetTask = parsePlannerTask(targetContent)
    if (!targetTask) throw new Error(`${input.taskPath} is not in canonical Planner task format.`)
    const invalidDependency = targetTask.dependsOn.find((dependency) => (
      dependency !== activeName && !existsSync(resolve(root, "kanban/done", dependency))
    ))
    if (invalidDependency) {
      throw new Error(`${input.taskPath} depends on unresolved task ${invalidDependency}; only the active covering task or completed tasks are allowed.`)
    }

    const dependent = todoTasks(root).find((name) => {
      if (name === targetName || name === activeName) return false
      const content = readFileSync(resolve(root, "kanban/todo", name), "utf8")
      const task = parsePlannerTask(content)
      if (!task) throw new Error(`Cannot safely supersede while kanban/todo/${name} is not in canonical Planner task format.`)
      return task.dependsOn.includes(targetName)
    })
    if (dependent) throw new Error(`${input.taskPath} cannot be superseded while kanban/todo/${dependent} depends on it.`)

    if (state.snapshot?.[input.taskPath] !== targetHash) {
      throw new Error(`${input.taskPath} is not unchanged in the active Doctor snapshot.`)
    }
    const archivePath = `kanban/superseded/${targetName}`
    const archiveAbsolutePath = resolve(root, archivePath)
    if (existsSync(archiveAbsolutePath) || state.snapshot?.[archivePath]) {
      throw new Error(`${archivePath} already exists.`)
    }

    const statePath = resolve(root, ".task-doctor/state.json")
    const affectedPaths = [targetPath, archiveAbsolutePath, targetRegistrationPath, statePath]
    const backups = affectedPaths.map((path) => ({ path, content: existsSync(path) ? readFileSync(path) : null }))
    const archiveDirectory = dirname(archiveAbsolutePath)
    const archiveDirectoryExisted = existsSync(archiveDirectory)
    const restore = () => {
      for (const backup of backups) {
        if (backup.content === null) rmSync(backup.path, { force: true })
        else {
          mkdirSync(dirname(backup.path), { recursive: true })
          writeFileSync(backup.path, backup.content)
        }
      }
      if (!archiveDirectoryExisted && existsSync(archiveDirectory) && readdirSync(archiveDirectory).length === 0) {
        rmSync(archiveDirectory)
      }
    }

    const supersededAt = new Date().toISOString()
    const reason = input.reason.replace(/\s+/g, " ").trim()
    const disposition = [
      targetContent.trimEnd(),
      "",
      "## Disposition",
      "",
      "Status: superseded",
      `Superseded by: ${activeName}`,
      `Reason: ${reason}`,
      `Superseded at: ${supersededAt}`,
      "",
    ].join("\n")

    try {
      mkdirSync(archiveDirectory, { recursive: true })
      renameSync(targetPath, archiveAbsolutePath)
      writeFileSync(archiveAbsolutePath, disposition)
      const archiveHash = fileHash(archiveAbsolutePath)
      writeFileSync(targetRegistrationPath, `${JSON.stringify({
        ...targetRegistration,
        status: "superseded",
        originalTaskHash: targetHash,
        archivePath,
        archiveHash,
        coveringTaskPath: state.taskPath,
        coveringTaskHash: activeHash,
        plannerSessionID: input.plannerSessionID,
        plannerAgent: input.plannerAgent,
        reason,
        supersededAt,
      }, null, 2)}\n`)
      const snapshot = { ...(state.snapshot ?? {}) }
      delete snapshot[input.taskPath]
      snapshot[archivePath] = archiveHash
      writeFileSync(statePath, `${JSON.stringify({ ...state, snapshot }, null, 2)}\n`)

      if (existsSync(targetPath)
        || fileHash(archiveAbsolutePath) !== archiveHash
        || readJson(targetRegistrationPath)?.status !== "superseded"
        || readJson(targetRegistrationPath)?.archiveHash !== archiveHash
        || readJson(targetRegistrationPath)?.originalTaskHash !== targetHash
        || activeState(root)?.snapshot?.[archivePath] !== archiveHash) {
        throw new Error("The supersede transition did not persist atomically.")
      }
      return { archivePath, archiveHash, activeTaskPath: state.taskPath, activeTaskHash: activeHash }
    } catch (error) {
      restore()
      throw error
    }
  }

  function plannerUnavailable(taskPath: string, owner: PlannerOwnership | null, reason: string) {
    return {
      status: "unavailable" as const,
      taskPath,
      plannerSessionID: owner?.plannerSessionID ?? null,
      reason,
    }
  }

  async function recoverWithOwningPlanner(input: {
    executorSessionID: string
    taskPath: string
    lifecycle?: "active" | "prestart"
    userRequest?: string
    contract?: PlannerRecoveryContract
    exactContract?: boolean
    problem: string
    evidence: string[]
    expectedResults: string[]
    relevantFiles: string[]
    helpID?: string
  }) {
    const lifecycle = input.lifecycle ?? "active"
    const taskPath = normalize(root, input.taskPath)
    if (!taskPath || !planningPath.test(taskPath) || !existsSync(resolve(root, taskPath))) {
      return plannerUnavailable(input.taskPath, null, "The requested task is not an existing kanban/todo task.")
    }
    const owner = readPlannerOwnership(root, taskPath)
    if (!owner) return plannerUnavailable(taskPath, null, "No owning Planner session is recorded for this task.")
    const currentTaskHash = fileHash(resolve(root, taskPath))
    if (owner.taskHash !== currentTaskHash) {
      return plannerUnavailable(taskPath, owner, "The recorded Planner ownership is stale because the task changed outside that Planner session.")
    }

    let sessionResponse: any
    try {
      sessionResponse = await client.session.get({ path: { id: owner.plannerSessionID }, query: { directory: root } })
    } catch (error) {
      return plannerUnavailable(taskPath, owner, `OpenCode could not load the recorded Planner session: ${String(error)}`)
    }
    const session = unwrap<any>(sessionResponse)
    if (sessionResponse?.error || !session?.id || session.id !== owner.plannerSessionID || resolve(session.directory ?? "") !== root) {
      return plannerUnavailable(taskPath, owner, "The recorded Planner session ID is no longer valid for this project.")
    }
    if (activePlannerRecoveries.has(owner.plannerSessionID)) {
      return {
        status: "incomplete" as const,
        taskPath,
        plannerSessionID: owner.plannerSessionID,
        reason: "The owning Planner session already has an active recovery request.",
      }
    }

    let messages: any[] = []
    try {
      messages = await loadSessionMessages(owner.plannerSessionID)
    } catch {
      messages = []
    }
    const latestPlannerAssistant = latestAssistantMessage(messages)
    const contract = canonicalPlannerRecoveryContract(input.contract
      ?? { scope: [], requirements: [], verify: [], supersedeTasks: [] })
    const alreadySuperseded = contract.supersedeTasks.filter((target) => taskIsAlreadySuperseded(target, taskPath))
    if (lifecycle === "active" && input.exactContract) {
      try {
        const completedSupersedes = new Set(alreadySuperseded)
        for (const target of contract.supersedeTasks) {
          if (completedSupersedes.has(target)) continue
          supersedeRegisteredTask({
            taskPath: target,
            reason: `The hash-bound exact recovery contract for ${taskPath} marks this task as redundant.`,
            plannerSessionID: owner.plannerSessionID,
            plannerAgent: owner.plannerAgent,
          })
          completedSupersedes.add(target)
        }
        const result = reviseActiveTask({
          taskPath,
          expectedTaskHash: currentTaskHash,
          reason: `Apply the hash-bound exact recovery contract requested by Executor ${input.executorSessionID}.`,
          plannerSessionID: owner.plannerSessionID,
          plannerAgent: owner.plannerAgent,
          executorSessionID: input.executorSessionID,
          helpID: input.helpID,
          recoveryContract: contract,
          exactRecoveryContract: true,
          coveredTasks: [...completedSupersedes],
        })
        clearAuthoritativePlannerBlocker(taskPath)
        return {
          status: "recovered" as const,
          taskPath,
          plannerSessionID: owner.plannerSessionID,
          taskHash: result.taskHash,
          output: [
            "The complete hash-bound recovery contract was applied mechanically under the recorded Planner ownership; no model retry was needed.",
            result.output,
          ].filter(Boolean).join("\n"),
        }
      } catch (error) {
        return {
          status: "incomplete" as const,
          taskPath,
          plannerSessionID: owner.plannerSessionID,
          reason: `The mechanical exact-contract transition stopped without a model retry: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
    const recovery: ActivePlannerRecovery = {
      executorSessionID: input.executorSessionID,
      taskPath,
      taskHash: currentTaskHash,
      lifecycle,
      userRequest: input.userRequest,
      contract,
      exactContract: Boolean(input.exactContract),
      supersededTasks: new Set(alreadySuperseded),
      problem: input.problem,
      evidence: input.evidence,
      expectedResults: input.expectedResults,
      relevantFiles: [...new Set([taskPath, ...input.relevantFiles])],
      helpID: input.helpID,
    }
    activePlannerRecoveries.set(owner.plannerSessionID, recovery)
    const missingSupersedeAtStart = recovery.contract.supersedeTasks.filter((target) => !recovery.supersededTasks.has(target))
    const correctionInstructions = lifecycle === "active"
      ? [
          ...(missingSupersedeAtStart.length > 0 ? [
            `First call supersede_registered_task for each required redundant task while the current active definition still covers it: ${missingSupersedeAtStart.join(", ")}. Do not merely report that it should be superseded.`,
          ] : []),
          ...(alreadySuperseded.length > 0 ? [
            `These supersede transitions are already complete and must not be repeated: ${alreadySuperseded.join(", ")}.`,
          ] : []),
          recovery.exactContract
            ? `Your only remaining revision action is revise_active_task. Call it now with task_path ${taskPath} and one concise reason. Do not pass replacement, add_scope, add_requirements, or verify. The trusted tool already holds and renders the exact final contract, including removals, then validates, lints, registers, updates Doctor state, and records this Planner session as owner atomically. Do not reason about how to edit the sections yourself.`
            : "Then call revise_active_task once with the exact task path and only the structured additions needed: add_scope, add_requirements, and verify. Do not edit the Markdown directly. Omit replacement unless the whole task truly must be replaced. The trusted tool preserves canonical structure, validates the recovery contract before writing, lints, registers, updates Doctor state, and records this Planner session as owner atomically.",
        ]
      : [
          "The task has not started. Edit its Markdown file directly, then run the exact Doctor lint command and the exact Doctor register command for this task. Do not call revise_active_task and do not implement or delegate.",
        ]

    try {
      const promptResult: any = await client.session.prompt({
        path: { id: owner.plannerSessionID },
        query: { directory: root },
        body: {
          agent: owner.plannerAgent,
          model: automaticAgentModel(root, owner.plannerAgent, latestPlannerAssistant?.info),
          parts: [{ type: "text", text: [
            "PLANNER RECOVERY REQUEST",
            `You are the owning Planner for ${taskPath}. Executor ${input.executorSessionID} needs a task-definition correction in this original Planner session.`,
            ...(input.userRequest ? [
              "Authorizing user request:",
              `The current user explicitly authorized the owning Planner to review and correct ${taskPath} before Worker delegation.`,
              "Executor-owned prerequisites are already complete. Do not repeat recovery, scheduling, delegation, or implementation steps from the original user message.",
              "Treat Executor evidence as hypotheses. Verify every claim against the current task and named application files before revising it.",
            ] : []),
            ...(recovery.contract.scope.length > 0
              || recovery.contract.requirements.length > 0
              || recovery.contract.verify.length > 0
              || recovery.contract.supersedeTasks.length > 0 ? [
              "Required exact recovery contract:",
              ...recovery.contract.scope.map((item) => `- Scope: ${item}`),
              ...recovery.contract.requirements.map((item) => `- Requirement: ${item}`),
              ...recovery.contract.verify.map((item) => `- Verify: ${item}`),
              ...recovery.contract.supersedeTasks.map((item) => `- Supersede before revision: ${item}${recovery.supersededTasks.has(item) ? " (already complete)" : ""}`),
              "The trusted revision tool rejects a task that omits any exact contract item.",
            ] : []),
            `Problem: ${input.problem}`,
            "Evidence:",
            ...input.evidence.map((item) => `- ${item}`),
            "Expected results:",
            ...input.expectedResults.map((item) => `- ${item}`),
            `Inspect these files: ${recovery.relevantFiles.join(", ")}.`,
            "Read CUSTOM.md and the task. Do not implement or delegate.",
            ...correctionInstructions,
            "Use the question tool only if a real unresolved user decision prevents a correct task definition. You must call every required trusted tool; a prose promise or summary does not complete recovery. After all calls succeed, report the correction and stop.",
          ].join("\n") }],
        },
      })
      if (promptResult?.error) {
        return {
          status: "incomplete" as const,
          taskPath,
          plannerSessionID: owner.plannerSessionID,
          reason: "OpenCode rejected the recovery prompt after the Planner session was validated.",
        }
      }
      let missingSupersede = recovery.contract.supersedeTasks.filter((taskPath) => !recovery.supersededTasks.has(taskPath))
      if (!recovery.resolved || missingSupersede.length > 0) {
        const retryResult: any = await client.session.prompt({
          path: { id: owner.plannerSessionID },
          query: { directory: root },
          body: {
            agent: owner.plannerAgent,
            model: automaticAgentModel(root, owner.plannerAgent, latestPlannerAssistant?.info),
            parts: [{ type: "text", text: [
              "PLANNER RECOVERY RETRY",
              `Your previous turn did not complete the trusted recovery for ${taskPath}. Do not analyze, summarize, inspect files, implement, or delegate.`,
              ...(missingSupersede.length > 0
                ? [`Call supersede_registered_task now for: ${missingSupersede.join(", ")}. Then continue to the required revision action.`]
                : []),
              recovery.exactContract
                ? `Call revise_active_task now with only task_path ${taskPath} and a concise reason. The tool already holds the exact final contract and performs every edit and validation mechanically.`
                : `Call revise_active_task now for ${taskPath} with the previously requested structured additions.`,
              "A prose response is not valid. Make the required tool call now.",
            ].join("\n") }],
          },
        })
        if (retryResult?.error) {
          return {
            status: "incomplete" as const,
            taskPath,
            plannerSessionID: owner.plannerSessionID,
            reason: "OpenCode rejected the single automatic Planner recovery retry.",
          }
        }
        missingSupersede = recovery.contract.supersedeTasks.filter((taskPath) => !recovery.supersededTasks.has(taskPath))
      }
      if (!recovery.resolved || missingSupersede.length > 0) {
        return {
          status: "incomplete" as const,
          taskPath,
          plannerSessionID: owner.plannerSessionID,
          reason: !recovery.resolved
            ? "The owning Planner session returned without linting and registering a corrected task."
            : `The owning Planner session returned before superseding: ${missingSupersede.join(", ")}.`,
        }
      }
      return {
        status: "recovered" as const,
        taskPath,
        plannerSessionID: owner.plannerSessionID,
        taskHash: recovery.resolved.taskHash,
        output: recovery.resolved.output,
      }
    } catch (error) {
      return {
        status: "incomplete" as const,
        taskPath,
        plannerSessionID: owner.plannerSessionID,
        reason: `The recorded Planner session could not complete recovery: ${String(error)}`,
      }
    } finally {
      activePlannerRecoveries.delete(owner.plannerSessionID)
    }
  }

  function rememberSessionIdentity(sessionID: string, info: unknown, suppliedModel?: unknown) {
    const value = info && typeof info === "object" ? info as Record<string, any> : {}
    const agent = [value.agent, value.mode]
      .find((candidate) => typeof candidate === "string" && candidate.length > 0)
    if (agent) sessionAgents.set(sessionID, agent.toLowerCase())
    if (typeof value.parentID === "string" && value.parentID.length > 0) subagentParents.set(sessionID, value.parentID)
    const directIdentity = modelIdentity(suppliedModel) || modelIdentity(value.model)
    const messageIdentity = [value.providerID, value.modelID]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("/")
    if (directIdentity || messageIdentity) sessionModels.set(sessionID, directIdentity || messageIdentity)
  }

  async function hydrateSessionIdentity(sessionID: string, suppliedModel?: unknown) {
    rememberSessionIdentity(sessionID, {}, suppliedModel)
    if (sessionAgents.has(sessionID) && sessionModels.has(sessionID)) return
    const current = sessionIdentityHydrations.get(sessionID)
    if (current) return current

    const hydration = (async () => {
      try {
        if (typeof (client as any)?.session?.get === "function") {
          const response: any = await client.session.get({ path: { id: sessionID }, query: { directory: root } })
          if (!response?.error) rememberSessionIdentity(sessionID, unwrap<any>(response))
        }
      } catch (error) {
        await log("debug", "Could not hydrate role or model from session metadata", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      if (sessionAgents.has(sessionID) && sessionModels.has(sessionID)) return
      try {
        if (typeof (client as any)?.session?.messages !== "function") return
        const latest = latestAssistantMessage(await loadSessionMessages(sessionID))
        if (latest?.info) rememberSessionIdentity(sessionID, latest.info)
      } catch (error) {
        await log("debug", "Could not hydrate role or model from session messages", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
    sessionIdentityHydrations.set(sessionID, hydration)
    try {
      await hydration
    } finally {
      if (sessionIdentityHydrations.get(sessionID) === hydration) sessionIdentityHydrations.delete(sessionID)
    }
  }

  function requiredWorkerRuleFiles(sessionID: string) {
    const family = matchingWorkerModelFamily(sessionModels.get(sessionID), workerModelFamilies)
    return [
      "WORKER.md",
      ...(family?.requireRead ? [family.rulesFile] : []),
    ]
  }

  function missingWorkerRuleFiles(sessionID: string) {
    const read = workerRuleReads.get(sessionID) ?? new Set<string>()
    return requiredWorkerRuleFiles(sessionID).filter((path) => !read.has(path))
  }

  function markWorkerRuleRead(sessionID: string, path: string) {
    if (!requiredWorkerRuleFiles(sessionID).includes(path)) return
    const read = workerRuleReads.get(sessionID) ?? new Set<string>()
    read.add(path)
    workerRuleReads.set(sessionID, read)
  }

  function markWorkerTaskRead(sessionID: string, path: string) {
    if (!planningPath.test(path)) return
    const file = safeCurrentRegularFile(path)
    if (!file) return
    workerTaskReads.set(sessionID, { taskPath: path, taskHash: file.hash })
  }

  function workerTaskWasRead(sessionID: string, state: any) {
    const read = workerTaskReads.get(sessionID)
    return Boolean(read && state?.taskPath === read.taskPath && state?.taskHash === read.taskHash)
  }

  function safeCurrentRegularFile(path: string) {
    if (normalize(root, path) !== path || projectPathHasSymlink(root, path)) return null
    const absolutePath = resolve(root, path)
    if (!existsSync(absolutePath)) return null
    const info = lstatSync(absolutePath)
    if (!info.isFile() || info.isSymbolicLink()) return null
    return { absolutePath, hash: fileHash(absolutePath) }
  }

  function completeFileReadOutput(path: string, output: { output?: string; metadata?: any }) {
    const metadata = output.metadata ?? {}
    if (metadata.truncated === true || metadata.display?.truncated === true) return false
    if (metadata.truncated === false || metadata.display?.truncated === false) return true
    if (/\(End of file - total \d+ lines\)\s*(?:\n<\/content>)?\s*$/m.test(String(output.output ?? ""))) return true
    const file = safeCurrentRegularFile(path)
    return Boolean(file && String(output.output ?? "") === readFileSync(file.absolutePath, "utf8"))
  }

  function markWorkerFileRead(sessionID: string, path: string, state: any) {
    if (state?.status !== "started" || typeof state.taskPath !== "string" || typeof state.taskHash !== "string") return
    const file = safeCurrentRegularFile(path)
    if (!file) return
    const evidence = workerFileReads.get(sessionID) ?? new Map<string, { taskPath: string; taskHash: string; fileHash: string }>()
    evidence.set(path, { taskPath: state.taskPath, taskHash: state.taskHash, fileHash: file.hash })
    workerFileReads.set(sessionID, evidence)
  }

  function workerFileWasFullyRead(sessionID: string, path: string, state: any) {
    const evidence = workerFileReads.get(sessionID)?.get(path)
    const file = safeCurrentRegularFile(path)
    return Boolean(
      evidence
      && state?.taskPath === evidence.taskPath
      && state?.taskHash === evidence.taskHash
      && file
      && file.hash === evidence.fileHash,
    )
  }

  function automaticWorkerTaskReadCandidate(
    sessionID: string,
    callID: unknown,
    requestedPath: string | null,
    state: any,
  ) {
    if (!features.transactionalWorkerChanges
      || state?.status !== "started"
      || typeof state.taskPath !== "string"
      || typeof state.taskHash !== "string"
      || !requestedPath
      || pendingAutomaticWorkerTaskReads.has(sessionID)
      || workerTaskWasRead(sessionID, state)
      || workerVerifyRequired.has(sessionID)
      || !workerPreflightComplete(sessionID, state)) return null

    const identity = sessionModels.get(sessionID)
    const family = matchingWorkerModelFamily(identity, workerModelFamilies)
    if (!identity || !family?.requireRead) return null
    const requiredRules = requiredWorkerRuleFiles(sessionID)
    if (requiredRules.length !== 2
      || requiredRules[0] !== "WORKER.md"
      || requiredRules[1] !== family.rulesFile
      || missingWorkerRuleFiles(sessionID).length > 0) return null

    const findingTarget = workerFindingTargets.get(sessionID)
    if (!findingTarget
      || requestedPath !== findingTarget
      || workerFindingReads.get(sessionID) === findingTarget) return null
    const taskScope = scopeFromTask(root, state.taskPath)
    if (findingTarget === state.taskPath
      || !allowed(findingTarget, taskScope.paths)
      || isProtected(findingTarget, protectedPaths)) return null

    const taskFile = safeCurrentRegularFile(state.taskPath)
    const targetFile = safeCurrentRegularFile(findingTarget)
    if (!taskFile || taskFile.hash !== state.taskHash || !targetFile) return null
    const requiredRuleHashes = requiredRules.flatMap((path) => {
      const file = safeCurrentRegularFile(path)
      return file && workerFileWasFullyRead(sessionID, path, state)
        ? [{ path, hash: file.hash }]
        : []
    })
    if (requiredRuleHashes.length !== requiredRules.length) return null

    return {
      callID: typeof callID === "string" && callID.length > 0 ? callID : null,
      taskPath: state.taskPath,
      taskHash: state.taskHash,
      taskContent: readFileSync(taskFile.absolutePath, "utf8"),
      targetPath: findingTarget,
      targetHash: targetFile.hash,
      modelIdentity: identity,
      modelFamily: family.family,
      modelRulesFile: family.rulesFile,
      requiredRuleHashes,
      mutationRevision: workerMutationRevision,
    }
  }

  function consumeAutomaticWorkerTaskRead(
    sessionID: string,
    callID: unknown,
    toolName: string,
    paths: string[],
    fullFileRead: boolean,
  ) {
    const pending = pendingAutomaticWorkerTaskReads.get(sessionID)
    if (!pending) return null
    const currentCallID = typeof callID === "string" && callID.length > 0 ? callID : null
    if (pending.callID && currentCallID && pending.callID !== currentCallID) return null
    if (toolName !== "read" || paths.length !== 1 || paths[0] !== pending.targetPath) return null
    pendingAutomaticWorkerTaskReads.delete(sessionID)
    if ((pending.callID || currentCallID) && pending.callID !== currentCallID) {
      throw new Error("Automatic required task read rejected a mismatched read call identity.")
    }
    if (!fullFileRead) {
      throw new Error(`Automatic required task read requires one complete unbounded read of ${pending.targetPath}.`)
    }

    const state = activeState(root)
    const identity = sessionModels.get(sessionID)
    const family = matchingWorkerModelFamily(identity, workerModelFamilies)
    const taskFile = safeCurrentRegularFile(pending.taskPath)
    const targetFile = safeCurrentRegularFile(pending.targetPath)
    const rulesCurrent = pending.requiredRuleHashes.every((entry) => {
      const file = safeCurrentRegularFile(entry.path)
      return file?.hash === entry.hash && workerFileWasFullyRead(sessionID, entry.path, state)
    })
    if (state?.status !== "started"
      || state.taskPath !== pending.taskPath
      || state.taskHash !== pending.taskHash
      || workerTaskWasRead(sessionID, state)
      || workerMutationRevision !== pending.mutationRevision
      || identity !== pending.modelIdentity
      || family?.family !== pending.modelFamily
      || family.rulesFile !== pending.modelRulesFile
      || !family.requireRead
      || missingWorkerRuleFiles(sessionID).length > 0
      || !rulesCurrent
      || !workerPreflightComplete(sessionID, state)
      || workerVerifyRequired.has(sessionID)
      || workerFindingTargets.get(sessionID) !== pending.targetPath
      || workerFindingReads.get(sessionID) === pending.targetPath
      || !taskFile
      || taskFile.hash !== pending.taskHash
      || readFileSync(taskFile.absolutePath, "utf8") !== pending.taskContent
      || !targetFile
      || targetFile.hash !== pending.targetHash) {
      throw new Error("Automatic required task read evidence drifted before the target read completed; no task-read evidence was recorded.")
    }
    return pending
  }

  function workerPreflightComplete(sessionID: string, state: any) {
    const preflight = workerDoctorPreflights.get(sessionID)
    return Boolean(
      preflight
      && state?.taskPath === preflight.taskPath
      && state?.taskHash === preflight.taskHash
      && preflight.mutationRevision === workerMutationRevision,
    )
  }

  function reviewedFindingTargetRevision(path: string | null) {
    if (!path) return null
    const absolutePath = resolve(root, path)
    if (!existsSync(absolutePath)) return "missing"
    const info = lstatSync(absolutePath)
    return info.isFile() && !info.isSymbolicLink() ? fileHash(absolutePath) : "invalid"
  }

  function queueReviewedWorkerRetry(parentSessionID: string, state: any, reviewedHelp: WorkerHelpRequest) {
    if (state?.status !== "started" || state.taskPath !== reviewedHelp.taskPath || state.taskHash !== reviewedHelp.taskHash) return
    const findingTarget = reviewedHelpFindingTarget(root, reviewedHelp.taskPath, reviewedHelp)
    const findingTargetRevision = reviewedFindingTargetRevision(findingTarget)
    const queued = (pendingReviewedWorkerRetries.get(parentSessionID) ?? [])
      .filter((entry) => entry.helpID !== reviewedHelp.id)
    queued.push({
      helpID: reviewedHelp.id,
      taskPath: reviewedHelp.taskPath,
      taskHash: reviewedHelp.taskHash,
      findingTarget,
      findingTargetRevision,
      queuedAt: Date.now(),
    })
    pendingReviewedWorkerRetries.set(parentSessionID, queued)
  }

  function stageHelpDelegation(
    parentSessionID: string,
    reviewedHelp: WorkerHelpRequest,
    callID: unknown,
    source: "direct" | "mechanical",
    attemptNonce?: string,
  ) {
    if (reviewedHelp.status !== "retry_approved" && reviewedHelp.status !== "task_changed") return
    const queued = (pendingHelpDelegations.get(parentSessionID) ?? [])
      .filter((entry) => entry.helpID !== reviewedHelp.id)
    queued.push({
      helpID: reviewedHelp.id,
      priorStatus: reviewedHelp.status,
      queuedAt: Date.now(),
      callID: typeof callID === "string" && callID.length > 0 ? callID : null,
      source,
      attemptNonce: typeof attemptNonce === "string" && attemptNonce.length > 0 ? attemptNonce : null,
    })
    pendingHelpDelegations.set(parentSessionID, queued)
  }

  function newMechanicalDelegationNonce() {
    return randomBytes(16).toString("hex")
  }

  function mechanicalDelegationPrompt(prompt: string, nonce: string) {
    return `${prompt}\n\n<!-- harness-worker-delegation:${nonce} -->`
  }

  function recoveryBoostState(reviewedHelp: WorkerHelpRequest): NonNullable<WorkerHelpRequest["recoveryBoost"]> {
    const hurdleTarget = reviewedHelpFindingTarget(root, reviewedHelp.taskPath, reviewedHelp)
    const savedFailure = readJson(lastDoctorFailurePath)
    const savedOutput = String(savedFailure?.output ?? "")
    const savedTarget = savedFailure?.taskPath === reviewedHelp.taskPath
      && savedFailure?.taskHash === reviewedHelp.taskHash
      ? firstScopedFailurePath(reviewedHelp.taskPath, savedOutput)
      : null
    const doctorFingerprint = savedTarget && savedTarget === hurdleTarget
      ? doctorFailureFingerprint(String(savedFailure?.gate ?? "verify"), reviewedHelp.taskPath, savedOutput)?.signature
      : undefined
    const fallbackFingerprint = `help|${hash(JSON.stringify({
      category: reviewedHelp.category,
      problem: reviewedHelp.problem,
      evidence: reviewedHelp.evidence,
      target: hurdleTarget,
    }))}`
    return {
      phase: "active",
      ...(hurdleTarget ? { hurdleTarget } : {}),
      hurdleFingerprint: doctorFingerprint ?? fallbackFingerprint,
      activatedAt: new Date().toISOString(),
    }
  }

  function persistedHelpDelegation(
    parentSessionID: string,
    reviewedHelp: WorkerHelpRequest,
    callID: unknown,
    source: "direct" | "mechanical",
    attemptNonce?: string,
    boosted = false,
  ) {
    const normalizedCallID = typeof callID === "string" && callID.length > 0 ? callID : undefined
    return {
      status: "delegated" as const,
      delegatedAt: new Date().toISOString(),
      delegationPriorStatus: reviewedHelp.status as "retry_approved" | "task_changed",
      delegationParentSessionID: parentSessionID,
      delegationDescription: `Resume ${reviewedHelp.taskPath}`,
      ...(normalizedCallID ? { delegationCallID: normalizedCallID } : {}),
      delegationSource: source,
      ...(typeof attemptNonce === "string" && attemptNonce.length > 0
        ? { delegationAttemptNonce: attemptNonce }
        : {}),
      ...(boosted ? { recoveryBoost: recoveryBoostState(reviewedHelp) } : {}),
    }
  }

  function bindPersistedHelpDelegation(request: WorkerHelpRequest, workerSessionID: string): WorkerHelpRequest {
    const recoveryPriorStatus = request.recoveryBoost ? request.delegationPriorStatus : undefined
    const {
      delegationPriorStatus: _priorStatus,
      delegationParentSessionID: _parentSessionID,
      delegationDescription: _description,
      delegationCallID: _callID,
      delegationSource: _source,
      delegationAttemptNonce: _attemptNonce,
      ...current
    } = request
    return {
      ...current,
      ...(recoveryPriorStatus ? { delegationPriorStatus: recoveryPriorStatus } : {}),
      delegatedWorkerSessionID: workerSessionID,
    }
  }

  function restorePersistedHelpDelegation(request: WorkerHelpRequest, priorStatus: "retry_approved" | "task_changed"): WorkerHelpRequest {
    const {
      delegatedAt: _delegatedAt,
      delegatedWorkerSessionID: _delegatedWorkerSessionID,
      delegationPriorStatus: _priorStatus,
      delegationParentSessionID: _parentSessionID,
      delegationDescription: _description,
      delegationCallID: _callID,
      delegationSource: _source,
      delegationAttemptNonce: _attemptNonce,
      recoveryBoost: _recoveryBoost,
      ...current
    } = request
    return { ...current, status: priorStatus }
  }

  async function reconcilePersistedHelpDelegationAfterRestart() {
    if (!features.workerHelp) return
    const state = activeState(root)
    if (state?.status !== "started"
      || typeof state.taskPath !== "string"
      || typeof state.taskHash !== "string") return
    const orphan = latestWorkerHelp(root, state.taskPath, state.taskHash)
    if (!orphan || orphan.status !== "delegated" || orphan.delegatedWorkerSessionID) return

    const priorStatus = orphan.delegationPriorStatus
    const parentSessionID = orphan.delegationParentSessionID
    const description = orphan.delegationDescription
    const delegatedAt = Date.parse(orphan.delegatedAt ?? "")
    const source = orphan.delegationSource
    const provenanceValid = (priorStatus === "retry_approved" || priorStatus === "task_changed")
      && typeof parentSessionID === "string" && parentSessionID.length > 0
      && description === `Resume ${orphan.taskPath}`
      && Number.isFinite(delegatedAt)
      && (source === "mechanical"
        || (source === "direct" && typeof orphan.delegationCallID === "string" && orphan.delegationCallID.length > 0))
    if (!provenanceValid) {
      await log("warn", "Kept unbound Worker help delegated because restart provenance is incomplete", {
        helpID: orphan.id,
        task: orphan.taskPath,
        source: source ?? null,
      })
      return
    }

    const injectedList = (client as any)?.session?.list
    if (typeof injectedList !== "function") {
      await log("warn", "Kept unbound Worker help delegated because session listing is unavailable", {
        helpID: orphan.id,
        task: orphan.taskPath,
      })
      return
    }

    let sessions: any[]
    try {
      const response = await client.session.list({
        query: {
          directory: root,
          roots: false,
          start: delegatedAt,
          search: description,
          limit: 101,
        },
      } as any)
      if ((response as any)?.error) throw new Error(String((response as any).error?.message ?? (response as any).error))
      const listed = unwrap<any[]>(response)
      if (!Array.isArray(listed)) throw new Error("invalid session list response")
      if (listed.length >= 101) throw new Error("session list result was saturated")
      sessions = listed
    } catch (error) {
      await log("warn", "Kept unbound Worker help delegated because restart session discovery was inconclusive", {
        helpID: orphan.id,
        task: orphan.taskPath,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const expectedTitle = `${description} (@worker subagent)`
    const plausible = sessions.filter((session) => (
      session?.parentID === parentSessionID
      && session?.title === expectedTitle
      && (!Number.isFinite(Number(session?.time?.created)) || Number(session.time.created) >= delegatedAt)
    ))
    const exact = plausible.filter((session) => (
      typeof session?.id === "string"
      && session.id.length > 0
      && Number.isFinite(Number(session?.time?.created))
      && Number(session.time.created) >= delegatedAt
      && typeof session?.directory === "string"
      && resolve(session.directory) === root
      && String(session?.agent ?? "").toLowerCase() === "worker"
    ))
    const incompletePlausible = plausible.filter((session) => !exact.includes(session))

    if (exact.length === 1 && incompletePlausible.length === 0) {
      const workerSessionID = exact[0].id as string
      updateWorkerHelp(orphan.id, (request) => request.status === "delegated" && !request.delegatedWorkerSessionID
        ? bindPersistedHelpDelegation(request, workerSessionID)
        : request)
      rememberSessionIdentity(workerSessionID, exact[0], exact[0]?.model)
      subagentParents.set(workerSessionID, parentSessionID)
      sessionAgents.set(workerSessionID, "worker")
      await log("info", "Bound one exact Worker child to an orphaned persisted delegation after restart", {
        parentSessionID,
        workerSessionID,
        helpID: orphan.id,
        task: orphan.taskPath,
      })
      return
    }

    if (exact.length === 0 && incompletePlausible.length === 0) {
      updateWorkerHelp(orphan.id, (request) => request.status === "delegated" && !request.delegatedWorkerSessionID
        ? restorePersistedHelpDelegation(request, priorStatus)
        : request)
      await log("warn", "Restored orphaned Worker help after restart found no matching child", {
        parentSessionID,
        helpID: orphan.id,
        task: orphan.taskPath,
        priorStatus,
      })
      return
    }

    await log("warn", "Kept orphaned Worker help delegated because child-session matching was ambiguous", {
      parentSessionID,
      helpID: orphan.id,
      task: orphan.taskPath,
      exactMatches: exact.length,
      incompletePlausibleMatches: incompletePlausible.length,
    })
  }

  function forgetStagedHelpDelegation(parentSessionID: string, helpID: string) {
    const remaining = (pendingHelpDelegations.get(parentSessionID) ?? []).filter((entry) => entry.helpID !== helpID)
    if (remaining.length > 0) pendingHelpDelegations.set(parentSessionID, remaining)
    else pendingHelpDelegations.delete(parentSessionID)
  }

  async function restoreStagedHelpDelegations(
    parentSessionID: string,
    reason: string,
    callID?: unknown,
    helpID?: string,
  ) {
    const staged = pendingHelpDelegations.get(parentSessionID)
    if (!staged?.length) return false
    const normalizedCallID = typeof callID === "string" && callID.length > 0 ? callID : null
    const selected = staged.filter((entry) => (
      (normalizedCallID === null || entry.callID === normalizedCallID)
      && (!helpID || entry.helpID === helpID)
    ))
    if (selected.length === 0) return false
    const remainingStaged = staged.filter((entry) => !selected.includes(entry))
    if (remainingStaged.length > 0) pendingHelpDelegations.set(parentSessionID, remainingStaged)
    else pendingHelpDelegations.delete(parentSessionID)
    const helpIDs = new Set(selected.map((entry) => entry.helpID))
    const reviewedRetries = (pendingReviewedWorkerRetries.get(parentSessionID) ?? [])
      .filter((entry) => !helpIDs.has(entry.helpID))
    if (reviewedRetries.length > 0) pendingReviewedWorkerRetries.set(parentSessionID, reviewedRetries)
    else pendingReviewedWorkerRetries.delete(parentSessionID)
    for (const entry of selected) {
      updateWorkerHelp(entry.helpID, (request) => {
        if (request.status !== "delegated" || request.delegatedWorkerSessionID) return request
        return restorePersistedHelpDelegation(request, entry.priorStatus)
      })
    }
    await log("warn", "Restored Worker help after delegation failed before a child session was bound", {
      parentSessionID,
      callID: normalizedCallID,
      requestedHelpID: helpID ?? null,
      helpIDs: [...helpIDs],
      reason,
    })
    return true
  }

  async function confirmStagedHelpDelegations(parentSessionID: string, workerSessionID: string, callID?: unknown) {
    const staged = pendingHelpDelegations.get(parentSessionID)
    if (!staged?.length) return
    const normalizedCallID = typeof callID === "string" && callID.length > 0 ? callID : null
    const selected = normalizedCallID === null
      ? staged
      : staged.filter((entry) => entry.callID === normalizedCallID)
    if (selected.length === 0) return
    const remainingStaged = staged.filter((entry) => !selected.includes(entry))
    if (remainingStaged.length > 0) pendingHelpDelegations.set(parentSessionID, remainingStaged)
    else pendingHelpDelegations.delete(parentSessionID)
    const helpIDs = new Set(selected.map((entry) => entry.helpID))
    const reviewedRetries = (pendingReviewedWorkerRetries.get(parentSessionID) ?? [])
      .filter((entry) => !helpIDs.has(entry.helpID))
    if (reviewedRetries.length > 0) pendingReviewedWorkerRetries.set(parentSessionID, reviewedRetries)
    else pendingReviewedWorkerRetries.delete(parentSessionID)
    for (const entry of selected) {
      updateWorkerHelp(entry.helpID, (request) => request.status === "delegated" && !request.delegatedWorkerSessionID
        ? bindPersistedHelpDelegation(request, workerSessionID)
        : request)
    }
    await log("warn", "Bound completed Worker task to staged help after child-session event was not observed", {
      parentSessionID,
      callID: normalizedCallID,
      workerSessionID,
      helpIDs: [...helpIDs],
    })
  }

  async function initializeReviewedWorkerRetry(sessionID: string) {
    const agent = sessionAgents.get(sessionID) ?? ""
    const parentSessionID = subagentParents.get(sessionID)
    if (!parentSessionID || !modeSettings.workerAgents.has(agent)) return
    const queued = pendingReviewedWorkerRetries.get(parentSessionID)
    if (!queued?.length) return
    if (queued.some((entry) => Date.now() - entry.queuedAt > 5 * 60_000)) {
      await restoreStagedHelpDelegations(parentSessionID, "reviewed retry queue expired before Worker session creation")
      return
    }

    const state = activeState(root)
    const store = workerHelpStore(root)
    const index = queued.findIndex((entry) => (
      state?.status === "started"
      && state.taskPath === entry.taskPath
      && state.taskHash === entry.taskHash
      && store.requests.some((request) => request.id === entry.helpID && request.status === "delegated")
    ))
    if (index < 0) return

    const [retry] = queued.splice(index, 1)
    if (queued.length > 0) pendingReviewedWorkerRetries.set(parentSessionID, queued)
    else pendingReviewedWorkerRetries.delete(parentSessionID)
    const reviewedRequest = store.requests.find((request) => request.id === retry.helpID) ?? null
    const currentFindingTarget = reviewedHelpFindingTarget(root, retry.taskPath, reviewedRequest)
    const currentFindingRevision = reviewedFindingTargetRevision(currentFindingTarget)
    const findingTarget = currentFindingTarget === retry.findingTarget
      && currentFindingRevision === retry.findingTargetRevision
      && currentFindingRevision !== "invalid"
      ? currentFindingTarget
      : null
    if (findingTarget) {
      workerDoctorPreflights.set(sessionID, {
        taskPath: retry.taskPath,
        taskHash: retry.taskHash,
        mutationRevision: workerMutationRevision,
      })
    } else {
      workerDoctorPreflights.delete(sessionID)
    }
    workerFindingReads.delete(sessionID)
    workerVerifyRequired.delete(sessionID)
    if (findingTarget) workerFindingTargets.set(sessionID, findingTarget)
    else workerFindingTargets.delete(sessionID)
    updateWorkerHelp(retry.helpID, (request) => bindPersistedHelpDelegation(request, sessionID))
    forgetStagedHelpDelegation(parentSessionID, retry.helpID)
    await log("info", findingTarget
      ? "Bound targeted reviewed Worker retry as the fresh session preflight"
      : "Bound untargeted reviewed Worker retry and required a fresh Doctor preflight", {
      parentSessionID,
      workerSessionID: sessionID,
      helpID: retry.helpID,
      task: retry.taskPath,
      findingTarget,
      queuedFindingTarget: retry.findingTarget,
      findingTargetChanged: findingTarget !== retry.findingTarget,
      queueDelayMs: Date.now() - retry.queuedAt,
    })
  }

  async function initializeStagedHelpDelegation(sessionID: string) {
    const agent = sessionAgents.get(sessionID) ?? ""
    const parentSessionID = subagentParents.get(sessionID)
    if (!parentSessionID || !modeSettings.workerAgents.has(agent)) return
    const staged = pendingHelpDelegations.get(parentSessionID)
    if (!staged?.length) return
    const state = activeState(root)
    const store = workerHelpStore(root)
    const entry = staged.find((candidate) => store.requests.some((request) => (
      request.id === candidate.helpID
      && request.status === "delegated"
      && !request.delegatedWorkerSessionID
      && state?.taskPath === request.taskPath
      && state?.taskHash === request.taskHash
    )))
    if (!entry) return
    updateWorkerHelp(entry.helpID, (request) => bindPersistedHelpDelegation(request, sessionID))
    forgetStagedHelpDelegation(parentSessionID, entry.helpID)
    await log("info", "Bound fresh Worker session to staged help delegation", {
      parentSessionID,
      workerSessionID: sessionID,
      helpID: entry.helpID,
      priorStatus: entry.priorStatus,
    })
  }

  function firstScopedFailurePath(taskPath: string, output: string) {
    if (!existsSync(resolve(root, taskPath))) return null
    const runMarkers = [...output.matchAll(/(?:^|\n)TASK DOCTOR:\s+RUN\b/g)]
    const relevantOutput = runMarkers.length > 0
      ? output.slice(runMarkers.at(-1)!.index)
      : output
    const scope = scopeFromTask(root, taskPath).paths
    const candidatePaths = new Set(scope)
    let visited = 0
    const visit = (path: string) => {
      if (visited++ >= 5_000) return
      const absolutePath = resolve(root, path)
      if (!existsSync(absolutePath) || projectPathHasSymlink(root, path)) return
      const info = lstatSync(absolutePath)
      if (info.isFile() && !info.isSymbolicLink()) {
        candidatePaths.add(path)
        return
      }
      if (!info.isDirectory() || info.isSymbolicLink()) return
      for (const name of readdirSync(absolutePath).sort()) visit(`${path}/${name}`)
    }
    for (const path of scope) visit(path)
    for (const match of relevantOutput.matchAll(/(?:^|[\s("'`])((?:[A-Za-z0-9_@+.-]+\/)+[A-Za-z0-9_@+.-]+)/g)) {
      const path = match[1].replace(/^\.\//, "")
      if (normalize(root, path) === path && allowed(path, scope)) candidatePaths.add(path)
    }
    const candidates = [...candidatePaths]
      .map((path) => ({ path, index: relevantOutput.indexOf(path) }))
      .filter((entry) => entry.index >= 0)
      .sort((left, right) => left.index - right.index || right.path.length - left.path.length)
    return candidates[0]?.path ?? null
  }

  async function withMechanicalDoctorQueue<T>(work: () => Promise<T>): Promise<T> {
    const preceding = mechanicalDoctorQueueTail
    let release!: () => void
    mechanicalDoctorQueueTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await preceding
    try {
      return await work()
    } finally {
      release()
    }
  }

  async function executeMechanicalDoctorVerify(
    sessionID: string,
    state: { taskPath: string; taskHash: string },
    abortSignal?: AbortSignal,
    preflightOnly = false,
  ) {
    await log("info", "Starting mechanical Worker Doctor verify", {
      sessionID,
      task: state.taskPath,
      taskHash: state.taskHash,
      preflightOnly,
    })
    const run = validateMechanicalDoctorRun(await runMechanicalDoctorVerify({
      root,
      taskPath: state.taskPath,
      timeoutMs: doctorVerifyTimeoutMs,
      abortSignal,
      preflightOnly,
    }))
    const latest = activeState(root)
    if (latest?.taskPath !== state.taskPath || latest?.taskHash !== state.taskHash) {
      throw new Error("The active Doctor task or task hash changed during mechanical verification.")
    }
    await log("info", "Mechanical Worker Doctor verify finished", {
      sessionID,
      task: state.taskPath,
      runID: run.runID,
      status: run.status,
      exitCode: run.exitCode,
      elapsedMs: run.elapsedMs,
      preflightOnly,
    })
    return run
  }

  async function ensureMechanicalDoctorPreflight(
    sessionID: string,
    state: { taskPath: string; taskHash: string },
  ) {
    const expectedMutationRevision = workerMutationRevision
    const key = `${state.taskPath}\0${state.taskHash}\0${expectedMutationRevision}`
    const existing = mechanicalDoctorPreflightInFlight.get(key)
    if (existing) return existing
    const promise = withMechanicalDoctorQueue(async () => {
      const latest = activeState(root)
      if (latest?.taskPath !== state.taskPath || latest?.taskHash !== state.taskHash) {
        throw new Error("The active Doctor task changed while the mechanical preflight was queued.")
      }
      if (workerMutationRevision !== expectedMutationRevision) {
        throw new Error("A Worker change was applied while the mechanical preflight was queued; retry against the current project revision.")
      }
      const run = await executeMechanicalDoctorVerify(sessionID, state, undefined, true)
      if (workerMutationRevision !== expectedMutationRevision) {
        throw new Error("A Worker change was applied during the mechanical preflight; its evidence was discarded.")
      }
      return { run, mutationRevision: expectedMutationRevision }
    })
    mechanicalDoctorPreflightInFlight.set(key, promise)
    try {
      return await promise
    } finally {
      if (mechanicalDoctorPreflightInFlight.get(key) === promise) {
        mechanicalDoctorPreflightInFlight.delete(key)
      }
    }
  }

  function markWorkerHarnessRecoveryTerminal(
    sessionID: string,
    state: { taskPath: string; taskHash: string },
    runID?: string,
  ) {
    workerFileReads.delete(sessionID)
    pendingAutomaticWorkerTaskReads.delete(sessionID)
    workerDoctorPreflights.delete(sessionID)
    workerFindingTargets.delete(sessionID)
    workerFindingReads.delete(sessionID)
    workerMechanicalDoctorNotices.delete(sessionID)
    loopFailures.delete(sessionID)
    workerHarnessRecoveryTerminals.set(sessionID, state)
    const persisted = rememberWorkerHarnessRecoveryTerminal(root, {
      sessionID,
      taskPath: state.taskPath,
      taskHash: state.taskHash,
      ...(runID ? { runID } : {}),
    })
    workerHarnessRecoveryTerminals.set(sessionID, {
      taskPath: persisted.entry.taskPath,
      taskHash: persisted.entry.taskHash,
    })
    sessionFeedback.set(sessionID, [
      "TASK DOCTOR: EXECUTOR RECOVERY REQUIRED",
      `Task: ${persisted.entry.taskPath}`,
      `Task hash: ${persisted.entry.taskHash}`,
      "This Worker session is terminal. Return BLOCKED with Required owner: Executor and stop; Executor must delegate a fresh Worker after recovery.",
    ].join("\n"))
  }

  function clearWorkerHarnessRecoveryTerminal(sessionID: string) {
    forgetWorkerHarnessRecoveryTerminal(root, sessionID)
    workerHarnessRecoveryTerminals.delete(sessionID)
  }

  async function abortWorkerForHarnessRecovery(sessionID: string, taskPath: string) {
    if (typeof (client as any)?.session?.abort !== "function") return
    try {
      const result = await client.session.abort({
        path: { id: sessionID },
        query: { directory: root },
      })
      if ((result as any)?.error) {
        throw new Error(String((result as any).error?.message ?? (result as any).error))
      }
      await log("info", "Aborted Worker after Executor-owned Harness recovery", {
        sessionID,
        task: taskPath,
      })
    } catch (error) {
      await log("warn", "Could not abort Worker after Harness recovery; terminal feedback remains active", {
        sessionID,
        task: taskPath,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function activeRecoveryBoostHelp(sessionID: string, taskPath: string, taskHash: string) {
    return [...workerHelpStore(root).requests].reverse().find((request) => (
      request.status === "delegated"
      && request.taskPath === taskPath
      && request.taskHash === taskHash
      && request.delegatedWorkerSessionID === sessionID
      && request.recoveryBoost?.phase === "active"
    )) ?? null
  }

  function clearedRecoveryBoostHelp(sessionID: string, taskPath: string, taskHash: string) {
    return [...workerHelpStore(root).requests].reverse().find((request) => (
      request.status === "delegated"
      && request.taskPath === taskPath
      && request.taskHash === taskHash
      && request.delegatedWorkerSessionID === sessionID
      && request.recoveryBoost?.phase === "cleared"
    )) ?? null
  }

  function startBaseWorkerContinuation(
    helpID: string,
    baseModel: { providerID: string; modelID: string },
    callID?: unknown,
    nonce?: string,
    messageID?: string,
  ) {
    const startedAt = new Date().toISOString()
    const normalizedCallID = typeof callID === "string" && callID.length > 0 ? callID : undefined
    return updateWorkerHelp(helpID, (request) => request.recoveryBoost
      && ["active", "cleared"].includes(request.recoveryBoost.phase)
      ? {
          ...request,
          recoveryBoost: {
            ...request.recoveryBoost,
            phase: "base_continuation_started",
            clearedAt: request.recoveryBoost.clearedAt ?? startedAt,
            baseContinuationStartedAt: startedAt,
            baseContinuationModel: modelRefString(baseModel),
            ...(normalizedCallID ? { baseContinuationCallID: normalizedCallID } : {}),
            ...(nonce ? { baseContinuationNonce: nonce } : {}),
            ...(messageID ? { baseContinuationMessageID: messageID } : {}),
          },
        }
      : request)
  }

  function baseContinuationMarker(nonce: string) {
    return `<!-- harness-base-continuation:${nonce} -->`
  }

  function sessionMessageNotFound(result: any) {
    return Number(result?.response?.status ?? result?.error?.status ?? result?.error?.statusCode) === 404
  }

  function releaseActiveBoostResume(callID?: unknown, sessionID?: string) {
    const normalizedCallID = typeof callID === "string" && callID.length > 0 ? callID : null
    for (const [workerSessionID, active] of activeBoostResumeCalls) {
      if ((normalizedCallID && active.callID === normalizedCallID)
        || (sessionID && (workerSessionID === sessionID || active.parentSessionID === sessionID))) {
        activeBoostResumeCalls.delete(workerSessionID)
      }
    }
  }

  function baseContinuationTranscript(
    messages: any[],
    recoveryBoost: NonNullable<WorkerHelpRequest["recoveryBoost"]>,
  ) {
    const nonce = recoveryBoost.baseContinuationNonce
    const model = recoveryBoost.baseContinuationModel
    if (!nonce || !model) return { status: "legacy" as const, assistant: null }
    const marker = baseContinuationMarker(nonce)
    const markerIndexes = messages.flatMap((message, index) => (
      message?.info?.role === "user"
      && (message?.parts ?? []).some((part: any) => part?.type === "text" && String(part.text ?? "").includes(marker))
        ? [index]
        : []
    ))
    if (markerIndexes.length === 0) return { status: "absent" as const, assistant: null }
    if (markerIndexes.length !== 1) return { status: "ambiguous" as const, assistant: null }
    const markerIndex = markerIndexes[0]
    const markerUserID = messages[markerIndex]?.info?.id
    if (typeof markerUserID !== "string" || markerUserID.length === 0) {
      return { status: "pending" as const, assistant: null }
    }
    if (recoveryBoost.baseContinuationMessageID
      && markerUserID !== recoveryBoost.baseContinuationMessageID) {
      return { status: "mismatched" as const, assistant: null }
    }
    const followingAssistants = messages.slice(markerIndex + 1).filter((message) => (
      message?.info?.role === "assistant" && message?.info?.parentID === markerUserID
    ))
    const assistant = followingAssistants.at(-1) ?? null
    if (!assistant || !assistant?.info?.time?.completed || !assistant?.info?.finish) {
      return { status: "pending" as const, assistant }
    }
    const identity = [assistant?.info?.providerID, assistant?.info?.modelID]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("/")
    return identity === model
      ? { status: "completed" as const, assistant }
      : { status: "mismatched" as const, assistant }
  }

  async function reconcileStartedBaseContinuation(request: WorkerHelpRequest) {
    if (request.status !== "delegated"
      || !request.delegatedWorkerSessionID
      || request.recoveryBoost?.phase !== "base_continuation_started"
      || !request.recoveryBoost.baseContinuationNonce) return request
    let messages: any[]
    let transcriptComplete = false
    try {
      const transcript = await loadSessionTranscript(request.delegatedWorkerSessionID)
      messages = transcript.messages
      transcriptComplete = transcript.complete
    } catch {
      return request
    }
    const evidence = baseContinuationTranscript(messages, request.recoveryBoost)
    const exactIdlePendingTurn = evidence.status === "pending"
      && evidence.assistant === null
      && typeof request.recoveryBoost.baseContinuationMessageID === "string"
      && request.recoveryBoost.baseContinuationMessageID.length > 0
    if ((evidence.status === "absent" || exactIdlePendingTurn)
      && transcriptComplete
      && typeof (client as any)?.session?.status === "function") {
      try {
        const messageID = request.recoveryBoost.baseContinuationMessageID
        const [messageResult, statusResult] = await Promise.all([
          evidence.status === "absent"
            && messageID
            && typeof (client as any)?.session?.message === "function"
            ? client.session.message({
                path: { id: request.delegatedWorkerSessionID, messageID },
                query: { directory: root },
              })
            : Promise.resolve(null),
          client.session.status({ query: { directory: root } }),
        ])
        const statuses = unwrap<any>(statusResult)
        const targetedMessageMissing = messageID
          ? sessionMessageNotFound(messageResult)
          : Boolean(request.recoveryBoost.baseContinuationCallID)
        const safelyOrphaned = idleArchiveStatus(statuses?.[request.delegatedWorkerSessionID])
          && (exactIdlePendingTurn || targetedMessageMissing)
        if (safelyOrphaned) {
          return updateWorkerHelp(request.id, (current) => {
            if (current.recoveryBoost?.phase !== "base_continuation_started") return current
            const {
              baseContinuationStartedAt: _startedAt,
              baseContinuationCompletedAt: _completedAt,
              baseContinuationModel: _model,
              baseContinuationCallID: _callID,
              baseContinuationNonce: _nonce,
              baseContinuationMessageID: _messageID,
              baseContinuationAssistantID: _assistantID,
              baseContinuationResultText: _resultText,
              baseContinuationResultHash: _resultHash,
              baseContinuationDeliveredAt: _deliveredAt,
              ...recoveryBoost
            } = current.recoveryBoost
            return {
              ...current,
              recoveryBoost: { ...recoveryBoost, phase: "cleared" },
            }
          }) ?? request
        }
      } catch {
        return request
      }
    }
    if (evidence.status !== "completed") return request
    const completedAt = new Date().toISOString()
    const resultText = evidence.assistant?.parts
      ?.filter((part: any) => part?.type === "text")
      .map((part: any) => String(part.text ?? ""))
      .join("\n") ?? ""
    return updateWorkerHelp(request.id, (current) => current.recoveryBoost?.phase === "base_continuation_started"
      ? {
          ...current,
          recoveryBoost: {
            ...current.recoveryBoost,
            phase: "base_continuation_completed",
            baseContinuationCompletedAt: completedAt,
            baseContinuationMessageID: current.recoveryBoost.baseContinuationMessageID
              ?? evidence.assistant?.info?.parentID,
            baseContinuationAssistantID: evidence.assistant?.info?.id,
            baseContinuationResultText: resultText,
            baseContinuationResultHash: hash(resultText),
          },
        }
      : current) ?? request
  }

  async function reconcileStartedBaseContinuationsAfterRestart() {
    if (!features.workerHelp || typeof (client as any)?.session?.messages !== "function") return
    for (const request of workerHelpStore(root).requests) {
      await reconcileStartedBaseContinuation(request)
    }
  }

  async function observeRecoveryBoostHurdle(
    sessionID: string,
    expectedState: { taskPath: string; taskHash: string },
    run: ValidatedMechanicalDoctorRun,
    findingTarget: string | null,
  ) {
    const help = activeRecoveryBoostHelp(sessionID, expectedState.taskPath, expectedState.taskHash)
    if (!help?.recoveryBoost) return { active: false, cleared: false }
    const currentFingerprint = run.status === "fail"
      ? doctorFailureFingerprint("verify", expectedState.taskPath, run.output)?.signature
      : undefined
    const hurdlePersists = run.status === "fail"
      && Boolean(help.recoveryBoost.hurdleTarget)
      && findingTarget === help.recoveryBoost.hurdleTarget
      && help.recoveryBoost.hurdleFingerprint?.startsWith("doctor|") === true
      && currentFingerprint === help.recoveryBoost.hurdleFingerprint
    if (hurdlePersists) {
      await log("info", "Kept Worker recovery boost bounded to the still-identical reviewed hurdle", {
        sessionID,
        helpID: help.id,
        task: help.taskPath,
        target: findingTarget,
        runID: run.runID,
      })
      return { active: true, cleared: false }
    }

    const clearedAt = new Date().toISOString()
    updateWorkerHelp(help.id, (request) => request.status === "delegated"
      && request.delegatedWorkerSessionID === sessionID
      && request.recoveryBoost?.phase === "active"
      ? {
          ...request,
          recoveryBoost: {
            ...request.recoveryBoost,
            phase: "cleared",
            clearedAt,
            clearedByRunID: run.runID,
          },
        }
      : request)
    if (run.status !== "pass") {
      sessionFeedback.set(sessionID, [
        "WORKER RECOVERY BOOST COMPLETE",
        `The reviewed hurdle from ${help.id} is no longer the current Doctor finding.`,
        "Do not call another tool in the boosted turn. End this response now; the Harness continues the same Worker session once with the base Worker model.",
      ].join("\n"))
    }
    await log("info", "Ended Worker recovery boost after the reviewed hurdle cleared", {
      sessionID,
      helpID: help.id,
      task: help.taskPath,
      priorTarget: help.recoveryBoost.hurdleTarget ?? null,
      currentTarget: findingTarget,
      doctorStatus: run.status,
      runID: run.runID,
    })
    return { active: false, cleared: true }
  }

  async function observeMechanicalWorkerDoctor(
    sessionID: string,
    expectedState: { taskPath: string; taskHash: string },
    run: ValidatedMechanicalDoctorRun,
    source: "initial_preflight" | "post_apply",
    expectedMutationRevision = workerMutationRevision,
  ) {
    const state = activeState(root)
    if (state?.taskPath !== expectedState.taskPath || state?.taskHash !== expectedState.taskHash) {
      throw new Error("Mechanical Doctor evidence no longer matches the active task and was discarded.")
    }
    if (workerMutationRevision !== expectedMutationRevision) {
      throw new Error("Mechanical Doctor evidence no longer matches the current Worker mutation revision and was discarded.")
    }

    const failed = run.status !== "pass"
    const findingTarget = run.status === "fail" ? firstScopedFailurePath(expectedState.taskPath, run.output) : null
    const findingWasReadAtCurrentHash = findingTarget
      ? workerFileWasFullyRead(sessionID, findingTarget, state)
      : false

    if (failed) {
      mkdirSync(dirname(lastDoctorFailurePath), { recursive: true })
      writeFileSync(lastDoctorFailurePath, `${JSON.stringify({
        version: 1,
        sessionID,
        taskPath: expectedState.taskPath,
        taskHash: expectedState.taskHash,
        gate: "verify",
        command: run.command,
        output: run.output.slice(-3000),
        failedAt: new Date().toISOString(),
        source: `mechanical_${source}`,
        runID: run.runID,
      }, null, 2)}\n`)
    }

    if (run.status === "executor_recovery_required" || taskHarnessRecoveryStatus(root)) {
      markWorkerHarnessRecoveryTerminal(sessionID, {
        taskPath: expectedState.taskPath,
        taskHash: expectedState.taskHash,
      }, run.runID)
      sessionFeedback.set(sessionID, [
        run.output,
        "TASK DOCTOR: EXECUTOR RECOVERY REQUIRED",
        "Do not call another tool, retry verify, restore files, or escalate to Planner.",
        "Return BLOCKED with Doctor status started and Required owner: Executor, then stop.",
      ].join("\n\n"))
      await abortWorkerForHarnessRecovery(sessionID, expectedState.taskPath)
      return { failed: true, findingTarget: null, terminal: true, helpID: null }
    }

    workerFileReads.delete(sessionID)
    workerDoctorPreflights.set(sessionID, {
      taskPath: expectedState.taskPath,
      taskHash: expectedState.taskHash,
      mutationRevision: expectedMutationRevision,
    })
    workerVerifyRequired.delete(sessionID)
    workerFindingReads.delete(sessionID)
    loopFailures.delete(sessionID)
    if (findingTarget) {
      workerFindingTargets.set(sessionID, findingTarget)
      if (findingWasReadAtCurrentHash) {
        markWorkerFileRead(sessionID, findingTarget, state)
        workerFindingReads.set(sessionID, findingTarget)
      }
    } else workerFindingTargets.delete(sessionID)
    const recoveryBoost = source === "post_apply"
      ? await observeRecoveryBoostHurdle(sessionID, expectedState, run, findingTarget)
      : { active: false, cleared: false }

    if (run.status === "pass") {
      if (source === "initial_preflight") {
        sessionFeedback.set(sessionID, [
          run.output,
          "Task remains started. Preview/Apply. Do not return REVIEWABLE.",
        ].join("\n\n"))
        return { failed: false, findingTarget, terminal: false, helpID: null, boostCleared: false }
      }
      const evidence = doctorEvidence.get(sessionID) ?? new Set<string>()
      evidence.add("verify")
      doctorEvidence.set(sessionID, evidence)
      const savedFailure = readJson(lastDoctorFailurePath)
      if (savedFailure?.gate === "verify" && savedFailure?.taskPath === expectedState.taskPath) {
        rmSync(lastDoctorFailurePath, { force: true })
      }
      const remainingFailures = clearFailures(doctorFailures.get(sessionID), (fingerprint) => (
        fingerprint.tool === "task:doctor:verify" && fingerprint.target === expectedState.taskPath
      ))
      if (remainingFailures.size === 0) doctorFailures.delete(sessionID)
      else doctorFailures.set(sessionID, remainingFailures)
      sessionFeedback.set(sessionID, [
        run.output,
        `Mechanical Doctor verify passed for ${expectedState.taskPath}.`,
        "Do not inspect or change another file. Return the canonical REVIEWABLE handoff now.",
      ].join("\n\n"))
      return { failed: false, findingTarget, terminal: false, helpID: null, boostCleared: recoveryBoost.cleared }
    }

    const restoreOnlyFailure = canonicalOutsideScopeDoctorFailure(expectedState.taskPath, run.output)
    if (restoreOnlyFailure) {
      const request = await terminalizeOutsideScopeDoctorFailure(
        sessionID,
        expectedState.taskPath,
        expectedState.taskHash,
        restoreOnlyFailure,
      )
      return { failed: true, findingTarget, terminal: true, helpID: request.id, boostCleared: recoveryBoost.cleared }
    }

    sessionFeedback.set(sessionID, [
      run.output.slice(-12_000),
      `Mechanical Doctor ${source === "initial_preflight" ? "preflight" : "post-apply verification"} completed for ${expectedState.taskPath}.`,
      findingTarget
        ? `Read ${findingTarget} first, correct every applicable requirement in that file together, then use one preview/apply transaction.`
        : "Use the exact Doctor findings for one in-scope correction. Do not rerun the unchanged verification first.",
    ].join("\n\n"))

    if (source === "post_apply") {
      const fingerprint = doctorFailureFingerprint("verify", expectedState.taskPath, run.output)
      if (fingerprint) {
        const slowFailure = run.elapsedMs >= longDoctorFailureMs
        const window = recordFailure({
          history: doctorFailures.get(sessionID),
          fingerprint,
          now: Date.now(),
          windowMs: 10 * 60_000,
          threshold: doctorFailureThreshold,
          slow: slowFailure,
        })
        doctorFailures.set(sessionID, window.history)
        if (window.terminal) {
          const required = { count: window.count, fingerprint, reason: window.reason! }
          workerHelpRequired.set(sessionID, required)
          const pendingLearnings = pendingGuardLearningsForAgent(sessionID)
          const persistedHelp = pendingLearnings.size === 0
            ? persistRequiredWorkerHelp(sessionID, expectedState.taskPath, expectedState.taskHash, required)
            : null
          sessionFeedback.set(sessionID, persistedHelp
            ? [
                "WORKER HELP IS TERMINAL",
                `Help ID: ${persistedHelp.id}`,
                "Do not call another tool or continue implementation. End now; the parent hook constructs the canonical handoff.",
              ].join("\n")
            : [
                "MODEL LOOP STOP",
                `${window.count} equivalent Doctor failures occurred for ${expectedState.taskPath} at verify.`,
                `Latest problem: ${fingerprint.problem}`,
                "Record pending Guard learning, then call request_executor_help and stop.",
              ].join("\n"))
          return {
            failed: true,
            findingTarget,
            terminal: true,
            helpID: persistedHelp?.id ?? null,
            boostCleared: recoveryBoost.cleared,
          }
        }
      }
    }

    return { failed: true, findingTarget, terminal: false, helpID: null, boostCleared: recoveryBoost.cleared }
  }

  function doctorDiagnosticPaths(output: string) {
    const prefix = output.match(/TASK DOCTOR:\s+RUN\s+npm\s+--prefix\s+([^\s]+)/i)?.[1]?.replace(/^['"]|['"]$/g, "")
    const paths = [...output.matchAll(/(?:^|\n)([A-Za-z0-9._/-]+\.(?:[cm]?[jt]sx?|vue|svelte))(?=\(|:\d)/g)]
      .map((match) => match[1])
      .map((path) => prefix && !path.startsWith(`${prefix}/`) ? `${prefix}/${path}` : path)
      .map((path) => normalize(root, path))
      .filter((path): path is string => Boolean(path))
    return [...new Set(paths)]
  }

  function scopedDoctorDiagnostics(taskPath: string, output: string) {
    if (!existsSync(resolve(root, taskPath))) return { scoped: [] as string[], outside: [] as string[] }
    const scope = scopeFromTask(root, taskPath).paths
    const diagnostics = doctorDiagnosticPaths(output)
    const scoped = diagnostics.filter((path) => scope.some((entry) => path === entry || path.startsWith(`${entry}/`)))
    return { scoped, outside: diagnostics.filter((path) => !scoped.includes(path)) }
  }

  function commandReadsRule(command: string, path: string) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`^(?:cat|head|tail|sed\\s+-n)\\b[^;&|><\\x60\\n]*(?:^|[\\s'\"])(?:\\./)?${escaped}(?=$|[\\s'\"])`).test(command.trim())
  }

  function workerRuleFilesReadByTool(sessionID: string, paths: string[], command: string) {
    return requiredWorkerRuleFiles(sessionID).filter((path) => paths.includes(path) || commandReadsRule(command, path))
  }

  function driverForSession(sessionID: string) {
    const identity = sessionModels.get(sessionID)
    if (ornithDriverConfig.enabled === false || !isOrnithModelIdentity(identity)) return null
    ornithDriver ??= new OrnithModelDriver(root, ornithDriverConfig)
    return ornithDriver
  }

  function workerModelFamilySystemBlock(sessionID: string) {
    const family = matchingWorkerModelFamily(sessionModels.get(sessionID), workerModelFamilies)
    if (!family) return null
    const path = resolve(root, family.rulesFile)
    if (!existsSync(path)) {
      return [
        "## Worker model-family configuration error",
        `Model family: ${family.family}`,
        `Required rules file is missing: ${family.rulesFile}`,
        "Stop and report this project configuration error.",
      ].join("\n")
    }
    return [
      "## Worker model-family rules",
      `Model family: ${family.family}`,
      `Source: ${family.rulesFile}`,
      "These rules supplement WORKER.md and apply only while this model runs as Worker.",
      family.requireRead
        ? `Read ${family.rulesFile} before the first non-inspection tool call and again after every compaction.`
        : null,
      readFileSync(path, "utf8").trim(),
    ].filter(Boolean).join("\n\n")
  }

  function workerChangePolicy(sessionID: string, rawTaskPath: string): WorkerChangePolicy {
    const taskPath = normalize(root, rawTaskPath)
    const state = activeState(root)
    if (!taskPath || !planningPath.test(taskPath) || state?.status !== "started" || state.taskPath !== taskPath) {
      throw projectGuardError(sessionID,
        `${rawTaskPath} is not the exact active started task.`,
        state?.status === "started"
          ? `Use ${state.taskPath} for the Worker change set.`
          : "Start the registered task before previewing implementation changes.",
      )
    }
    if (!existsSync(resolve(root, taskPath)) || fileHash(resolve(root, taskPath)) !== state.taskHash) {
      throw projectGuardError(sessionID,
        "The active task content no longer matches Doctor state.",
        "Stop and return the invalid lifecycle state to Executor. Do not preview or apply changes.",
      )
    }
    const scope = scopeFromTask(root, taskPath)
    return {
      root,
      sessionID,
      taskPath,
      taskHash: state.taskHash,
      scope: scope.paths,
      newScope: scope.newPaths,
      protectedPaths,
      readOnlyPaths,
    }
  }

  function workerChangeOperations(values: unknown): WorkerChangeOperation[] {
    if (!Array.isArray(values)) throw new Error("Worker change operations must be an array.")
    return values.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`Worker change operation ${index + 1} must be an object.`)
      }
      const value = raw as Record<string, unknown>
      const kind = String(value.kind ?? value.operation ?? "").toLowerCase()
      const path = value.path ?? value.file_path ?? value.filePath
      if (!["replace", "rewrite", "create", "delete"].includes(String(kind)) || typeof path !== "string") {
        throw new Error(`Worker change operation ${index + 1} requires kind and path.`)
      }
      if (kind === "delete") return { kind, path }
      if (kind === "rewrite" || kind === "create") {
        const content = value.content ?? value.new_text ?? value.newText
        if (typeof content !== "string") throw new Error(`Worker ${kind} operation ${index + 1} requires content.`)
        return { kind, path, content }
      }
      const oldText = value.old_text ?? value.oldText
      const newText = value.new_text ?? value.newText
      const rawExpected = value.expected_occurrences ?? value.expectedOccurrences
      const expectedOccurrences = rawExpected === undefined || rawExpected === null
        ? 1
        : typeof rawExpected === "string" && /^\d+$/.test(rawExpected.trim())
        ? Number(rawExpected)
        : rawExpected
      if (typeof oldText !== "string" || oldText.length === 0 || typeof newText !== "string") {
        throw new Error(`Worker replace operation ${index + 1} requires non-empty string old_text and string new_text.`)
      }
      if (!Number.isInteger(expectedOccurrences) || Number(expectedOccurrences) < 1) {
        throw new Error(`Worker replace operation ${index + 1} requires positive integer expected_occurrences when provided; omit it to default safely to 1.`)
      }
      return {
        kind: "replace",
        path,
        oldText,
        newText,
        expectedOccurrences: expectedOccurrences as number,
      }
    })
  }

  function flatWorkerChangeOperation(input: Record<string, unknown>) {
    const operation: Record<string, unknown> = {}
    for (const field of ["kind", "path", "old_text", "new_text", "content", "expected_occurrences"]) {
      if (input[field] !== undefined) operation[field] = input[field]
    }
    const actionableFlatFields = ["kind", "path", "old_text", "new_text", "content"]
    if (actionableFlatFields.some((field) => input[field] !== undefined)) return [operation]
    return Array.isArray(input.operations) ? input.operations : []
  }

  function exactOccurrenceCount(content: string, needle: string) {
    if (!needle) return 0
    let count = 0
    let offset = 0
    while (true) {
      const index = content.indexOf(needle, offset)
      if (index < 0) return count
      count += 1
      offset = index + needle.length
    }
  }

  function deriveSingleWorkerChangeOperation(
    sessionID: string,
    policy: WorkerChangePolicy,
    state: any,
    values: unknown,
  ) {
    if (!Array.isArray(values) || values.length !== 1) return { values, inputRepairs: [] as string[] }
    const raw = values[0]
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { values, inputRepairs: [] as string[] }
    const operation = { ...(raw as Record<string, unknown>) }
    const inputRepairs: string[] = []
    const normalizePath = (value: unknown) => typeof value === "string" ? normalize(root, value) : null
    const explicitPathValues = [operation.path, operation.file_path, operation.filePath]
      .filter((value) => value !== undefined)
      .map(normalizePath)
    if (explicitPathValues.some((value) => value === null) || new Set(explicitPathValues).size > 1) {
      throw new Error("Worker change operation path is invalid or ambiguous.")
    }

    const explicitKindValues = [operation.kind, operation.operation]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => value.toLowerCase())
    if (new Set(explicitKindValues).size > 1) throw new Error("Worker change operation kind is ambiguous.")
    const hasReplacePair = typeof operation.old_text === "string" || typeof operation.oldText === "string"
      || typeof operation.new_text === "string" || typeof operation.newText === "string"
    const hasContent = typeof operation.content === "string"
    const hintedPath = explicitPathValues[0]
    const operationKindHint = explicitKindValues[0]
      ?? (hasReplacePair
        ? "replace"
        : hasContent && hintedPath
          ? existsSync(resolve(root, hintedPath)) ? "rewrite" : "create"
          : undefined)

    const eligiblePath = (path: string) => {
      if (!allowed(path, policy.scope)
        || isProtected(path, policy.protectedPaths)
        || isProtected(path, policy.readOnlyPaths)) return false
      const absolutePath = resolve(root, path)
      if (!existsSync(absolutePath)) {
        return (operationKindHint === undefined || operationKindHint === "create")
          && (policy.newScope.includes(path) || policy.scope.some((entry) => path.startsWith(`${entry}/`)))
      }
      const info = lstatSync(absolutePath)
      return operationKindHint !== "create"
        && info.isFile()
        && !info.isSymbolicLink()
        && !projectPathHasSymlink(root, path)
    }
    const eligiblePaths = () => policy.scope.filter(eligiblePath)
    const eligiblePathInstruction = (paths: string[], attemptedPath?: string | null) => {
      if (paths.length === 0) return "No technically eligible Scope path exists; request Executor help for the active task contract."
      const sameDirectory = attemptedPath
        ? paths.filter((path) => dirname(path) === dirname(attemptedPath))
        : []
      return [
        `Use one exact path from this mechanically eligible list: ${paths.join(", ")}.`,
        ...(sameDirectory.length === 1
          ? [`The sole eligible path in ${dirname(attemptedPath!)} is ${sameDirectory[0]}.`]
          : []),
      ].join(" ")
    }
    let selectedPath = explicitPathValues[0] ?? null
    if (!selectedPath) {
      const findingPath = workerFindingTargets.get(sessionID)
      if (findingPath && eligiblePath(findingPath)) selectedPath = findingPath
    }
    if (!selectedPath) {
      const eligible = eligiblePaths()
      if (eligible.length === 1) selectedPath = eligible[0]
      else {
        throw projectGuardError(sessionID,
          `Cannot derive one Worker change target from ${eligible.length} technically eligible Scope paths.`,
          eligiblePathInstruction(eligible),
        )
      }
    }
    if (!eligiblePath(selectedPath)) {
      const eligible = eligiblePaths()
      const oldText = operation.old_text ?? operation.oldText
      const newText = operation.new_text ?? operation.newText
      const rawExpected = operation.expected_occurrences ?? operation.expectedOccurrences
      const expectedOccurrences = rawExpected === undefined || rawExpected === null
        ? 1
        : typeof rawExpected === "string" && /^\d+$/.test(rawExpected.trim())
        ? Number(rawExpected)
        : rawExpected
      const exactAnchorMatches = operationKindHint === "replace"
        && !hasContent
        && typeof oldText === "string" && oldText.length > 0
        && typeof newText === "string"
        && Number.isInteger(expectedOccurrences) && Number(expectedOccurrences) > 0
        ? eligible.filter((path) => {
            const absolutePath = resolve(root, path)
            return existsSync(absolutePath)
              && exactOccurrenceCount(readFileSync(absolutePath, "utf8"), oldText) === Number(expectedOccurrences)
          })
        : []
      if (eligible.length === 1) {
        selectedPath = eligible[0]
        operation.path = selectedPath
        delete operation.file_path
        delete operation.filePath
        inputRepairs.push(`${selectedPath}: repaired path from the sole technically eligible Scope file`)
      } else if (exactAnchorMatches.length === 1) {
        selectedPath = exactAnchorMatches[0]
        operation.path = selectedPath
        delete operation.file_path
        delete operation.filePath
        inputRepairs.push(`${selectedPath}: repaired path from the unique exact in-scope anchor match`)
      } else {
        throw projectGuardError(sessionID,
          `${selectedPath} is not one technically eligible file in the active task Scope.`,
          eligiblePathInstruction(eligible, selectedPath),
        )
      }
    }
    const pathWasCanonical = operation.path === selectedPath
      && operation.file_path === undefined
      && operation.filePath === undefined
    operation.path = selectedPath
    delete operation.file_path
    delete operation.filePath
    if (!pathWasCanonical) {
      inputRepairs.push(`${selectedPath}: canonicalized path from explicit input, active Doctor finding, or unique Scope`)
    }

    let selectedKind = explicitKindValues[0]
    if (!selectedKind) {
      if (hasReplacePair && hasContent) throw new Error("Worker change operation contains both replace text and full content.")
      if (hasReplacePair) selectedKind = "replace"
      else if (hasContent) selectedKind = existsSync(resolve(root, selectedPath)) ? "rewrite" : "create"
      if (selectedKind) {
        operation.kind = selectedKind
        inputRepairs.push(`${selectedPath}: derived kind=${selectedKind} from the supplied technical payload and filesystem state`)
      }
    }

    if (selectedKind === "replace"
      && operation.expected_occurrences === undefined
      && operation.expectedOccurrences === undefined) {
      const oldText = operation.old_text ?? operation.oldText
      const absolutePath = resolve(root, selectedPath)
      if (typeof oldText === "string" && oldText.length > 0 && existsSync(absolutePath)) {
        const count = exactOccurrenceCount(readFileSync(absolutePath, "utf8"), oldText)
        if (count > 0) {
          operation.expected_occurrences = count
          inputRepairs.push(`${selectedPath}: derived expected_occurrences=${count} from current bytes`)
        }
      }
    }
    return { values: [operation], inputRepairs }
  }

  function repairMalformedWorkerChangeOperations(values: unknown) {
    if (!Array.isArray(values)) return { values, inputRepairs: [] as string[], ambiguous: false }
    const aliases: Record<string, string> = {
      kind: "kind",
      operation: "kind",
      path: "path",
      filepath: "path",
      filename: "path",
      oldtext: "old_text",
      before: "old_text",
      newtext: "new_text",
      after: "new_text",
      expectedoccurrences: "expected_occurrences",
      occurrences: "expected_occurrences",
      count: "expected_occurrences",
      content: "content",
    }
    const normalizedKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")
    const strictScalarWrapper = (value: unknown) => {
      if (typeof value === "string" || typeof value === "number") return value
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
      const record = value as Record<string, unknown>
      const entries = Object.entries(record)
      if (entries.length !== 1 || !["value", "text", "name", "path", "filepath"].includes(normalizedKey(entries[0][0]))) return undefined
      return typeof entries[0][1] === "string" || typeof entries[0][1] === "number" ? entries[0][1] : undefined
    }
    const strictReplaceTextWrapper = (value: unknown) => {
      const scalar = strictScalarWrapper(value)
      if (typeof scalar === "string") return scalar
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
      const entries = Object.entries(value as Record<string, unknown>)
      if (entries.length !== 1 || normalizedKey(entries[0][0]) !== "content") return undefined
      return typeof entries[0][1] === "string" ? entries[0][1] : undefined
    }
    const actionable = (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false
      const record = value as Record<string, unknown>
      return ["kind", "operation", "path", "file_path", "filePath", "old_text", "oldText", "new_text", "newText", "content"]
        .some((field) => record[field] !== undefined)
    }
    const repaired = values.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { value: raw, changed: false, repairs: [] as string[], ambiguous: false }
      }
      const original = raw as Record<string, unknown>
      const operation: Record<string, unknown> = { ...original }
      const repairs: string[] = []
      let changed = false
      let conflicted = false
      let malformedReplaceContainer = false
      const assign = (field: string, value: unknown, source: string) => {
        if (value === undefined) return
        if (!(field in operation) || operation[field] === undefined) {
          operation[field] = value
          repairs.push(`operation ${index + 1}: recovered ${field} from ${source}`)
          changed = true
          return
        }
        if (JSON.stringify(operation[field]) !== JSON.stringify(value)) conflicted = true
      }

      for (const [rawName, rawValue] of Object.entries(original)) {
        const key = normalizedKey(rawName)
        let field = aliases[key]
        const impliedKind = !field
          ? /^(?:kind|operation)(replace|rewrite|create|delete)$/.exec(key)?.[1]
          : undefined
        if (!field && impliedKind) field = "kind"
        if (!field) continue
        if (rawName === field && (rawValue === null || typeof rawValue !== "object" || Array.isArray(rawValue))) continue

        delete operation[rawName]
        changed = true
        if (field === "path") {
          const path = strictScalarWrapper(rawValue)
          if (path === undefined) conflicted = true
          else assign("path", path, rawName)
          continue
        }
        if (field === "kind") {
          const scalar = strictScalarWrapper(rawValue)
          if (typeof scalar === "string" && ["replace", "rewrite", "create", "delete"].includes(scalar.toLowerCase())) {
            assign("kind", scalar.toLowerCase(), rawName)
          } else if (impliedKind) {
            assign("kind", impliedKind, rawName)
          }
          if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
            const nestedEntries = Object.entries(rawValue as Record<string, unknown>)
            const allowedNested = new Set(["old_text", "new_text", "expected_occurrences"])
            const nested = nestedEntries.map(([nestedName, nestedValue]) => ({
              rawName: nestedName,
              field: aliases[normalizedKey(nestedName)],
              value: nestedValue,
            }))
            if (nestedEntries.length === 0
              || nested.some((entry) => !entry.field || !allowedNested.has(entry.field))) {
              conflicted = true
            } else {
              malformedReplaceContainer = true
              for (const entry of nested) {
                const scalar = entry.field === "old_text" || entry.field === "new_text"
                  ? strictReplaceTextWrapper(entry.value)
                  : strictScalarWrapper(entry.value)
                if (scalar === undefined) conflicted = true
                else assign(entry.field!, scalar, `${rawName}.${entry.rawName}`)
              }
            }
          } else if (scalar === undefined) {
            conflicted = true
          }
          continue
        }
        const scalar = field === "old_text" || field === "new_text"
          ? strictReplaceTextWrapper(rawValue)
          : strictScalarWrapper(rawValue)
        if (scalar === undefined) conflicted = true
        else assign(field, scalar, rawName)
      }

      if (malformedReplaceContainer
        && typeof operation.old_text === "string"
        && typeof operation.path !== "string") {
        const normalizedQuotes = operation.old_text.replace(/[“”]/g, '"')
        const embeddedPath = /^(.*?)[,;]\s*["']?path["']?\s*:\s*["']?([A-Za-z0-9._/-]+)["']?\s*$/i.exec(normalizedQuotes)
        if (embeddedPath) {
          operation.old_text = embeddedPath[1]
          operation.path = embeddedPath[2]
          repairs.push(`operation ${index + 1}: separated embedded path from old_text`)
          changed = true
        }
      }
      if (operation.kind === undefined
        && typeof operation.old_text === "string"
        && typeof operation.new_text === "string") {
        operation.kind = "replace"
        repairs.push(`operation ${index + 1}: inferred kind=replace from exact old_text and new_text`)
        changed = true
      }
      return conflicted
        ? { value: raw, changed: false, repairs: [] as string[], ambiguous: true }
        : { value: changed ? operation : raw, changed, repairs, ambiguous: false }
    })

    if (repaired.some((entry) => entry.ambiguous)) {
      return { values, inputRepairs: [] as string[], ambiguous: true }
    }
    const actionableCount = repaired.filter((entry) => actionable(entry.value)).length
    const changedCount = repaired.filter((entry) => entry.changed).length
    if (changedCount > 0 && actionableCount !== 1) return { values, inputRepairs: [] as string[], ambiguous: false }
    const inputRepairs = repaired.flatMap((entry) => entry.repairs)
    const valuesWithoutMetadata = actionableCount === 1
      ? repaired.filter((entry, index) => {
          if (actionable(entry.value)) return true
          if (!entry.value || typeof entry.value !== "object" || Array.isArray(entry.value)) return true
          const keys = Object.keys(entry.value as Record<string, unknown>).map(normalizedKey)
          const metadataOnly = keys.length > 0 && keys.every((key) => ["description", "purpose", "reason"].includes(key))
          if (metadataOnly) inputRepairs.push(`operation ${index + 1}: dropped metadata-only pseudo-operation`)
          return !metadataOnly
        })
      : repaired
    return {
      values: valuesWithoutMetadata.map((entry) => entry.value),
      inputRepairs: [...new Set(inputRepairs)],
      ambiguous: false,
    }
  }

  function driverWorkflowState(): DriverWorkflowState {
    const state = authoritativeWorkflowState(root)
    const taskPath = state.doctorTask
    const allowedPaths = taskPath && existsSync(resolve(root, taskPath))
      ? scopeFromTask(root, taskPath).paths
      : []
    return {
      revision: state.revision,
      doctorStatus: state.doctorStatus,
      doctorTask: state.doctorTask,
      openTasks: state.openTasks,
      nextAction: state.nextAction,
      allowedPaths,
    }
  }

  const savedGuardLearningQueue = readJson(guardLearningQueuePath)?.sessions
  let guardLearningQueueDirty = false
  if (savedGuardLearningQueue && typeof savedGuardLearningQueue === "object") {
    for (const [sessionID, values] of Object.entries(savedGuardLearningQueue)) {
      if (!Array.isArray(values)) continue
      const pending = new Map<string, GuardViolation>()
      for (const value of values) {
        const violation = value as GuardViolation
        if (typeof violation?.id === "string" && typeof violation?.problem === "string" && typeof violation?.action === "string") {
          const agent = String(violation.agent ?? "").toLowerCase()
          if (!agent) {
            guardLearningQueueDirty = true
            continue
          }
          const id = canonicalPersistedGuardViolationId(violation.id, violation.problem, violation.action)
          if (violation.id !== id) guardLearningQueueDirty = true
          pending.set(`${agent}:${id}`, { ...violation, id, agent })
        }
      }
      if (pending.size > 0) pendingGuardLearnings.set(sessionID, pending)
    }
  }

  function persistPendingGuardLearnings() {
    const sessions = Object.fromEntries(
      [...pendingGuardLearnings.entries()]
        .filter(([, pending]) => pending.size > 0)
        .map(([sessionID, pending]) => [sessionID, [...pending.values()]]),
    )
    if (Object.keys(sessions).length === 0) {
      rmSync(guardLearningQueuePath, { force: true })
      return
    }
    mkdirSync(dirname(guardLearningQueuePath), { recursive: true })
    writeFileSync(guardLearningQueuePath, `${JSON.stringify({ version: 1, sessions, updatedAt: new Date().toISOString() }, null, 2)}\n`)
  }
  if (guardLearningQueueDirty) persistPendingGuardLearnings()

  function authorizeRuleChange(path: string, beforeHash: string | null, afterHash: string, violationID: string) {
    const stored = readJson(guardLearningAuthorizationPath)
    const changes = Array.isArray(stored?.changes) ? stored.changes : []
    if (!changes.some((entry: any) => (entry?.path ?? "CUSTOM.md") === path && entry?.beforeHash === beforeHash && entry?.afterHash === afterHash)) {
      changes.push({ path, beforeHash, afterHash, violationID, recordedAt: new Date().toISOString() })
    }
    mkdirSync(dirname(guardLearningAuthorizationPath), { recursive: true })
    writeFileSync(guardLearningAuthorizationPath, `${JSON.stringify({ version: 1, changes: changes.slice(-500) }, null, 2)}\n`)
  }

  function guardLearningPath(agent: string) {
    return modeSettings.workerAgents.has(agent.toLowerCase()) ? "WORKER.md" : "CUSTOM.md"
  }

  function guardLearning(id: string, agent: string): LearnedGuardRule | null {
    const sources = [guardLearningPath(agent)]
      .map((name) => ({ path: name, absolutePath: resolve(root, name) }))
      .filter(({ absolutePath }) => existsSync(absolutePath))
      .map(({ path, absolutePath }) => ({ path, content: readFileSync(absolutePath, "utf8") }))
    return learnedGuardRuleFromSources(id, sources)
  }

  function hasGuardLearning(id: string, agent: string) {
    return guardLearning(id, agent) !== null
  }

  function recordGuardLearningFile(id: string, agent: string) {
    const rule = knownStableGuardRule(id)
    if (!rule) return null
    const existing = guardLearning(id, agent)
    if (existing) return { learning: existing, recorded: false }
    const relativePath = guardLearningPath(agent)
    const path = resolve(root, relativePath)
    const originalContent = existsSync(path) ? readFileSync(path, "utf8") : ""
    const content = originalContent.trimEnd()
    const nextContent = `${content ? `${content}\n` : ""}- [${id}] ${rule.endsWith(".") ? rule : `${rule}.`}\n`
    writeFileSync(path, nextContent)
    authorizeRuleChange(relativePath, originalContent ? hash(originalContent) : null, hash(nextContent), id)
    return {
      learning: { id, canonicalID: id, path: relativePath, rule } satisfies LearnedGuardRule,
      recorded: true,
    }
  }

  let reconciledStableGuardLearning = false
  for (const [sessionID, pending] of [...pendingGuardLearnings]) {
    for (const [key, violation] of pending) {
      const canonicalRule = knownStableGuardRule(violation.id)
      if (!violation.agent || !canonicalRule) {
        pending.delete(key)
        reconciledStableGuardLearning = true
        continue
      }
      recordGuardLearningFile(violation.id, violation.agent)
      pending.delete(key)
      reconciledStableGuardLearning = true
    }
    if (pending.size === 0) pendingGuardLearnings.delete(sessionID)
  }
  if (reconciledStableGuardLearning) persistPendingGuardLearnings()

  function projectGuardError(sessionID: string, problem: string, action: string, success?: string) {
    const id = guardViolationId(problem, action)
    const driver = driverForSession(sessionID)
    const agent = sessionAgents.get(sessionID) ?? ""
    let learned = guardLearning(id, agent)
    let recorded = false
    const canonicalRule = knownStableGuardRule(id)
    if (!learned && agent && canonicalRule) {
      const result = recordGuardLearningFile(id, agent)
      if (result) {
        learned = result.learning
        recorded = result.recorded
      }
    }
    if (driver) {
      return new Error(driver.guardViolation(
        sessionID,
        { id, problem, action },
        success,
        driverWorkflowState().revision,
        learned ? { status: recorded ? "recorded" : "already", rule: learned.rule } : undefined,
      ))
    }
    return defaultGuardError(problem, action, success, learned ?? undefined)
  }

  function addPendingGuardLearning(sessionID: string, violation: GuardViolation) {
    const agent = String(violation.agent ?? sessionAgents.get(sessionID) ?? "").toLowerCase()
    if (!agent || hasGuardLearning(violation.id, agent)) return false
    const canonicalRule = knownStableGuardRule(violation.id)
    if (canonicalRule) recordGuardLearningFile(violation.id, agent)
    return false
  }

  function pendingGuardLearningsForAgent(sessionID: string, agent = sessionAgents.get(sessionID) ?? "") {
    const normalizedAgent = agent.toLowerCase()
    const pending = pendingGuardLearnings.get(sessionID)
    return new Map([...(pending?.values() ?? [])]
      .filter((violation) => violation.agent === normalizedAgent)
      .map((violation) => [violation.id, violation]))
  }

  function guardViolationsInLatestTurn(messages: any[], sessionID: string) {
    const latestUser = [...messages].reverse().find((message) => message?.info?.role === "user")
    if (!latestUser?.info?.id) return []
    const violations = new Map<string, GuardViolation>()
    for (const message of messages) {
      if (message?.info?.role !== "assistant" || message?.info?.parentID !== latestUser.info.id) continue
      for (const part of message?.parts ?? []) {
        if (part?.type !== "tool" || part?.state?.status !== "error") continue
        const violation = parseGuardViolation(part.state.error)
        if (violation) violations.set(violation.id, {
          ...violation,
          agent: String(message?.info?.agent ?? message?.info?.mode ?? sessionAgents.get(sessionID) ?? "").toLowerCase() || undefined,
        })
      }
    }
    return [...violations.values()]
  }

  async function refreshPendingGuardLearnings(sessionID: string, messages?: any[], agent?: string) {
    const currentMessages = messages ?? await loadSessionMessages(sessionID)
    for (const violation of guardViolationsInLatestTurn(currentMessages, sessionID)) addPendingGuardLearning(sessionID, violation)
    const pending = pendingGuardLearnings.get(sessionID)
    if (!pending) return []
    for (const [key, violation] of pending) {
      const canonicalRule = knownStableGuardRule(violation.id)
      if (!violation.agent) {
        pending.delete(key)
        continue
      }
      if (!canonicalRule) continue
      if (!hasGuardLearning(violation.id, violation.agent)) recordGuardLearningFile(violation.id, violation.agent)
      pending.delete(key)
    }
    if (pending.size === 0) pendingGuardLearnings.delete(sessionID)
    persistPendingGuardLearnings()
    return [...pendingGuardLearningsForAgent(sessionID, agent).values()]
  }

  async function log(level: "debug" | "info" | "warn" | "error", message: string, extra: Record<string, unknown> = {}) {
    if (typeof (client as any)?.app?.log !== "function") return
    try {
      await client.app.log({ body: { service: "workflow-guard", level, message, extra: { root, ...extra } } })
    } catch {
      // Observability is best-effort and must never change or roll back workflow state.
    }
  }

  function normalizeSessionTodos(value: unknown) {
    if (!Array.isArray(value)) return null
    return value
      .filter((todo: any) => todo && typeof todo.content === "string" && typeof todo.status === "string")
      .map((todo: any) => ({ content: todo.content, status: todo.status }))
  }

  async function refreshSessionTodos(sessionID: string) {
    if (!features.todoDiscipline || typeof (client as any)?.session?.todo !== "function") {
      return sessionTodos.get(sessionID) ?? []
    }
    try {
      const loaded = normalizeSessionTodos(unwrap<unknown>(await client.session.todo({
        path: { id: sessionID },
        query: { directory: root },
      })))
      if (!loaded) throw new Error("OpenCode returned an invalid todo list.")
      sessionTodos.set(sessionID, loaded)
      return loaded
    } catch (error) {
      await log("warn", "Could not refresh session todos; retaining the last known list", {
        sessionID,
        error: error instanceof Error ? error.message : String(error),
      })
      return sessionTodos.get(sessionID) ?? []
    }
  }

  async function checkedModelArgs(toolName: string, input: unknown, sessionID: string, rejectIssues = true, context?: any) {
    const unwrappedInput = workflowToolPayload(toolName, input)
    const modelInput = toolName !== "preview_worker_changes"
      && customModelToolNames.has(toolName)
      && unwrappedInput && typeof unwrappedInput === "object" && !Array.isArray(unwrappedInput)
      ? (() => {
          const value = { ...(unwrappedInput as Record<string, unknown>) }
          delete value.description
          return value
        })()
      : unwrappedInput
    let result = repairModelInput(toolName, modelInput)
    if (toolName === "preview_worker_changes") {
      const state = activeState(root)
      const missingTaskPath = result.value.task_path === undefined
        || (typeof result.value.task_path === "string" && !result.value.task_path.trim())
      if (missingTaskPath && state?.status === "started" && typeof state.taskPath === "string") {
        result.value.task_path = state.taskPath
        const rechecked = repairModelInput(toolName, result.value)
        result = {
          ...rechecked,
          repairs: [...new Set([
            ...result.repairs,
            `filled task_path from active Doctor state (${state.taskPath})`,
            ...rechecked.repairs,
          ])],
        }
      }
    }
    if (toolName === "request_executor_help") {
      const contextualRepairs: string[] = []
      const state = activeState(root)
      const contextuallyMissing = (value: unknown) => value === undefined || (typeof value === "string" && value.trim() === "")
      if (contextuallyMissing(result.value.task_path)
        && state?.status === "started" && typeof state.taskPath === "string") {
        result.value.task_path = state.taskPath
        contextualRepairs.push(`filled task_path from active Doctor state (${state.taskPath})`)
      }
      const evidence = Array.isArray(result.value.evidence)
        ? result.value.evidence.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : []
      const attempts = Array.isArray(result.value.attempted_actions)
        ? result.value.attempted_actions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : []
      if (contextuallyMissing(result.value.problem) && evidence.length > 0) {
        result.value.problem = `Executor review is required. Evidence: ${evidence[0].replace(/\s+/g, " ").trim()}`.slice(0, 1200)
        contextualRepairs.push("derived problem from the first exact evidence item")
      }
      if (contextuallyMissing(result.value.suggested_next_step)
        && evidence.length > 0 && attempts.length > 0) {
        result.value.suggested_next_step = "Executor should inspect the evidence, classify whether a fresh Worker can resolve the blocker, and choose the next safe workflow action."
        contextualRepairs.push("derived a conservative Executor review step from evidence and attempted actions")
      }
      if (contextualRepairs.length > 0) {
        const rechecked = repairModelInput(toolName, result.value)
        result = {
          ...rechecked,
          repairs: [...new Set([...result.repairs, ...contextualRepairs, ...rechecked.repairs])],
        }
      }
    }
    const repairAbsolutePath = (record: Record<string, unknown>, field: string, label: string) => {
      const value = record[field]
      if (typeof value !== "string" || !isAbsolute(value)) return
      const repaired = normalize(root, value)
      if (!repaired) return
      record[field] = repaired
      result.repairs.push(`converted absolute in-project ${label} to ${repaired}`)
    }
    repairAbsolutePath(result.value, "task_path", "task_path")
    if (toolName === "preview_worker_changes" && Array.isArray(result.value.operations)) {
      for (const [index, rawOperation] of result.value.operations.entries()) {
        if (!rawOperation || typeof rawOperation !== "object" || Array.isArray(rawOperation)) continue
        const operation = rawOperation as Record<string, unknown>
        for (const field of ["path", "file_path", "filePath"]) {
          repairAbsolutePath(operation, field, `operations[${index}].${field}`)
        }
      }
    }
    if (result.repairs.length > 0) {
      await log("warn", "Repaired model tool input", {
        sessionID,
        tool: toolName,
        repairs: result.repairs,
      })
    }
    if (result.issues.length > 0) {
      if (customModelToolNames.has(toolName)) {
        const visibleInput = unwrappedInput && typeof unwrappedInput === "object" && !Array.isArray(unwrappedInput)
          ? { ...(unwrappedInput as Record<string, unknown>) }
          : result.value
        compactWorkflowToolArgsInPlace(toolName, input, visibleInput)
        persistReadableToolCall(context, toolName, visibleInput)
      }
      await log(rejectIssues ? "warn" : "debug", rejectIssues ? "Rejected unrecoverable model tool input" : "Observed incomplete post-tool input", {
        sessionID,
        tool: toolName,
        issues: result.issues,
        attemptedRepairs: result.repairs,
      })
      if (rejectIssues) throw new Error(formatModelInputError(toolName, result))
    }
    if (customModelToolNames.has(toolName)) {
      compactWorkflowToolArgsInPlace(toolName, input, result.value)
      persistReadableToolCall(context, toolName, result.value)
    }
    return result.value
  }

  function replaceModelArgsInPlace(target: unknown, value: Record<string, unknown>) {
    if (!target || typeof target !== "object" || Array.isArray(target)) return value
    const record = target as Record<string, unknown>
    for (const key of Object.keys(record)) delete record[key]
    Object.assign(record, value)
    return record
  }

  function persistReadableToolCall(context: any, toolName: string, canonical: Record<string, unknown>) {
    if (typeof context?.metadata !== "function") return
    const title = readableToolCallDescription(toolName, canonical)
      ?? `Run ${toolName.replaceAll("_", " ")}`.slice(0, 160)
    try {
      context.metadata({
        title,
        metadata: {
          workflowTool: toolName,
          task: typeof canonical.task_path === "string" ? canonical.task_path : undefined,
          changeID: typeof canonical.change_id === "string" ? canonical.change_id : undefined,
          helpID: typeof canonical.help_id === "string" ? canonical.help_id : undefined,
          decision: typeof canonical.decision === "string" ? canonical.decision : undefined,
        },
      })
    } catch {
      // Readability metadata must never change workflow behavior.
    }
  }

  function compactWorkflowToolArgsInPlace(toolName: string, target: unknown, canonicalValue?: Record<string, unknown>) {
    if (!customModelToolNames.has(toolName)) return target
    const payload = workflowToolPayload(toolName, target)
    const canonical = canonicalValue
      ? { ...canonicalValue }
      : payload && typeof payload === "object" && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>) }
        : {}
    return replaceModelArgsInPlace(target, canonical)
  }

  async function validateWorkerTaskReturn(
    input: { tool: string; sessionID: string; callID?: string; args: any },
    output: { title: string; output: string; metadata: any },
  ) {
    if (!features.executorReview || input.tool !== "task" || !workerSubagentType(input.args?.subagent_type)) return

    const taskPath = delegatedTaskPaths(input.args)[0]
    const workerSessionID = workerTaskSessionID(output)
    if (!taskPath || !workerSessionID) {
      throw new Error("WORKER RETURN REJECTED\nThe Worker task result did not identify one exact task and child session. The Executor received no reviewable result.")
    }
    subagentParents.set(workerSessionID, input.sessionID)

    const loadMessages = async () => loadSessionMessages(workerSessionID)

    let messages = await loadMessages()
    let latestAssistant = latestAssistantMessage(messages)
    const immediateState = activeState(root)
    const immediateHelp = features.workerHelp
      && immediateState?.status === "started"
      && immediateState.taskPath === taskPath
      && typeof immediateState.taskHash === "string"
      ? workerHelpForSession(workerSessionID, taskPath, immediateState.taskHash)
      : null
    if ((!latestAssistant || !latestAssistantFinished(messages)) && immediateHelp) {
      const resultText = workerHelpHandoff(immediateHelp)
      cleanupWorkerChangesForSession(root, workerSessionID)
      clearAuthoritativePlannerBlocker(taskPath)
      output.output = replaceWorkerTaskResult(output.output, workerSessionID, resultText)
      output.metadata = {
        ...output.metadata,
        workerReturnValidated: true,
        workerReturnCanonicalized: true,
        workerHelpSynthesized: true,
        workerHelpID: immediateHelp.id,
      }
      await log("info", "Canonicalized interrupted Worker from mechanically persisted help", {
        parentSessionID: input.sessionID,
        workerSessionID,
        task: taskPath,
        helpID: immediateHelp.id,
      })
      return
    }
    const immediateHarnessRecovery = features.executorBaselineRecovery ? taskHarnessRecoveryStatus(root) : null
    if ((!latestAssistant || !latestAssistantFinished(messages)) && immediateHarnessRecovery?.taskPath === taskPath) {
      const resultText = withExecutorRecoveryAction(
        executorRecoveryHandoff(taskPath, immediateHarnessRecovery.paths.map((entry) => entry.path)),
        taskPath,
        immediateHarnessRecovery.paths.map((entry) => entry.path),
      )
      cleanupWorkerChangesForSession(root, workerSessionID)
      output.output = replaceWorkerTaskResult(output.output, workerSessionID, resultText)
      output.metadata = {
        ...output.metadata,
        workerReturnValidated: true,
        workerReturnCanonicalized: true,
        workerAbortedForExecutorRecovery: true,
      }
      const state = activeState(root)
      if (state?.taskPath === taskPath && typeof state.taskHash === "string") {
        recordAuthoritativeWorkerOwner({
          executorSessionID: input.sessionID,
          workerSessionID,
          taskPath,
          taskHash: state.taskHash,
          resultText,
        })
      }
      await log("info", "Canonicalized aborted Worker after Executor-owned Harness recovery", {
        parentSessionID: input.sessionID,
        workerSessionID,
        task: taskPath,
        paths: immediateHarnessRecovery.paths.map((entry) => entry.path),
      })
      return
    }
    let earlyCompletedBaseTranscript = false
    if (!latestAssistant || !latestAssistantFinished(messages)) {
      const startedBoost = immediateState?.taskPath === taskPath && typeof immediateState.taskHash === "string"
        ? [...workerHelpStore(root).requests].reverse().find((request) => (
            request.status === "delegated"
            && request.taskPath === taskPath
            && request.taskHash === immediateState.taskHash
            && request.delegatedWorkerSessionID === workerSessionID
            && request.recoveryBoost?.phase === "base_continuation_started"
          ))
        : null
      if (startedBoost?.recoveryBoost) {
        const evidence = baseContinuationTranscript(messages, startedBoost.recoveryBoost)
        if (evidence.status === "completed") {
          latestAssistant = evidence.assistant
          earlyCompletedBaseTranscript = true
        } else {
          throw new Error([
            "WORKER RETURN REJECTED",
            `The same-session base continuation for ${workerSessionID} has an inconclusive persisted start state.`,
            evidence.status === "pending"
              ? "Its causally marked user turn is still pending. Do not launch another Worker or repeat the continuation."
              : "No causally marked completed Base turn is proven. Do not launch another Worker or repeat the continuation automatically.",
          ].join("\n"))
        }
      }
    }
    if (!latestAssistant || (!latestAssistantFinished(messages) && !earlyCompletedBaseTranscript)) {
      throw new Error(`WORKER RETURN REJECTED\nWorker ${workerSessionID} has no finished assistant response. The Executor received no reviewable result.`)
    }
    cleanupWorkerChangesForSession(root, workerSessionID)

    let baseContinuationApplied = false
    const continuationState = activeState(root)
    const boostContinuationHelp = [...workerHelpStore(root).requests].reverse().find((request) => (
      request.status === "delegated"
      && request.taskPath === taskPath
      && typeof continuationState?.taskHash === "string"
      && request.taskHash === continuationState.taskHash
      && request.delegatedWorkerSessionID === workerSessionID
      && request.recoveryBoost
      && ["cleared", "base_continuation_started", "base_continuation_completed"].includes(request.recoveryBoost.phase)
      && !(request.recoveryBoost.phase === "base_continuation_completed" && request.recoveryBoost.baseContinuationDeliveredAt)
    )) ?? null
    const pendingTerminalHelp = continuationState?.taskPath === taskPath
      ? workerHelpForSession(workerSessionID, taskPath, continuationState?.taskHash)
      : null
    const persistedBaseModel = boostContinuationHelp?.recoveryBoost?.baseContinuationModel
    const latestAssistantModel = [latestAssistant?.info?.providerID, latestAssistant?.info?.modelID]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("/")
    let continuationTranscript = boostContinuationHelp?.recoveryBoost
      ? baseContinuationTranscript(messages, boostContinuationHelp.recoveryBoost)
      : { status: "legacy" as const, assistant: null }
    const exactExternalContinuation = Boolean(
      boostContinuationHelp?.recoveryBoost?.baseContinuationCallID
      && input.callID === boostContinuationHelp.recoveryBoost.baseContinuationCallID
      && (input.args?.task_id ?? input.args?.taskID ?? input.args?.session_id ?? input.args?.sessionID) === workerSessionID
      && input.args?.subagent_type === "worker",
    )
    let continuationResultText = boostContinuationHelp?.recoveryBoost?.baseContinuationResultText ?? ""
    const markBaseContinuationCompleted = () => {
      const completedAt = new Date().toISOString()
      const causalAssistant = continuationTranscript.status === "completed"
        ? continuationTranscript.assistant
        : latestAssistant
      continuationResultText = causalAssistant?.parts
        ?.filter((part: any) => part?.type === "text")
        .map((part: any) => String(part.text ?? ""))
        .join("\n") ?? continuationResultText
      updateWorkerHelp(boostContinuationHelp!.id, (request) => request.recoveryBoost?.phase === "base_continuation_started"
        ? {
            ...request,
            recoveryBoost: {
              ...request.recoveryBoost,
              phase: "base_continuation_completed",
              baseContinuationCompletedAt: completedAt,
              baseContinuationMessageID: request.recoveryBoost.baseContinuationMessageID
                ?? causalAssistant?.info?.parentID,
              baseContinuationAssistantID: causalAssistant?.info?.id,
              baseContinuationResultText: continuationResultText,
              baseContinuationResultHash: hash(continuationResultText),
            },
          }
        : request)
    }
    const markBaseContinuationDelivered = () => {
      if (!baseContinuationApplied || !boostContinuationHelp) return
      updateWorkerHelp(boostContinuationHelp.id, (request) => request.recoveryBoost?.phase === "base_continuation_completed"
        ? {
            ...request,
            recoveryBoost: {
              ...request.recoveryBoost,
              baseContinuationDeliveredAt: request.recoveryBoost.baseContinuationDeliveredAt ?? new Date().toISOString(),
            },
          }
        : request)
    }
    if (boostContinuationHelp?.recoveryBoost?.phase === "cleared"
      && continuationState?.status === "started"
      && continuationState.taskPath === taskPath
      && !pendingTerminalHelp
      && !(features.executorBaselineRecovery && taskHarnessRecoveryStatus(root))) {
      const baseModel = automaticAgentModel(root, "worker", latestAssistant.info)
      if (!baseModel) {
        throw new Error("WORKER RETURN REJECTED\nThe recovery boost ended, but the base Worker model could not be resolved for same-session continuation.")
      }
      let continuationNonce = newMechanicalDelegationNonce()
      // Match OpenCode's native 30-character message identifier shape instead
      // of reusing the longer 32-hex continuation nonce as an ID.
      let continuationMessageID = `msg_${randomBytes(13).toString("hex")}`
      const started = startBaseWorkerContinuation(
        boostContinuationHelp.id,
        baseModel,
        undefined,
        continuationNonce,
        continuationMessageID,
      )
      if (started?.recoveryBoost?.phase === "base_continuation_started") {
        continuationNonce = started.recoveryBoost.baseContinuationNonce ?? continuationNonce
        continuationMessageID = started.recoveryBoost.baseContinuationMessageID ?? continuationMessageID
      }
      await log("info", "Continuing the same Worker session with the base model after recovery hurdle clearance", {
        parentSessionID: input.sessionID,
        workerSessionID,
        helpID: boostContinuationHelp.id,
        task: taskPath,
        model: modelRefString(baseModel),
      })
      let promptInFlight = baseContinuationPrompts.get(continuationMessageID)
      if (!promptInFlight) {
        promptInFlight = (async () => {
          const promptResult: any = await client.session.prompt({
            path: { id: workerSessionID },
            query: { directory: root },
            body: {
              messageID: continuationMessageID,
              agent: "worker",
              model: baseModel,
              parts: [{ type: "text", text: [
                "WORKER RECOVERY BOOST COMPLETE",
                `The reviewed hurdle from ${boostContinuationHelp.id} is cleared. Continue ${taskPath} in this same Worker session using the current authoritative Doctor result and the base Worker model.`,
                "Do not repeat the applied receipt or the cleared correction. Continue only the remaining task work, using transactional preview/apply and its mechanical verification.",
                "Finish with the required REVIEWABLE, BLOCKED, or mechanically persisted HELP_REQUESTED handoff.",
                baseContinuationMarker(continuationNonce),
              ].join("\n") }],
            },
          })
          if (promptResult?.error) {
            throw new Error(`WORKER RETURN REJECTED\nThe same-session base Worker continuation failed: ${JSON.stringify(promptResult.error)}`)
          }
        })()
        baseContinuationPrompts.set(continuationMessageID, promptInFlight)
      }
      try {
        await promptInFlight
      } finally {
        if (baseContinuationPrompts.get(continuationMessageID) === promptInFlight) {
          baseContinuationPrompts.delete(continuationMessageID)
        }
      }
      messages = await loadMessages()
      latestAssistant = latestAssistantMessage(messages)
      const persisted = latestWorkerHelp(root, taskPath, continuationState.taskHash)
      continuationTranscript = persisted?.recoveryBoost
        ? baseContinuationTranscript(messages, persisted.recoveryBoost)
        : { status: "legacy" as const, assistant: null }
      if (continuationTranscript.status !== "completed") {
        const reconciled = persisted
          ? await reconcileStartedBaseContinuation(persisted)
          : null
        if (reconciled?.recoveryBoost?.phase === "cleared") {
          throw new Error([
            "WORKER BASE CONTINUATION RETRY REQUIRED",
            `Task: ${taskPath}`,
            `Worker session: ${workerSessionID}`,
            "The exact causally marked Base turn remained idle without an Assistant and was reopened mechanically.",
            `Retry exactly this Worker session with task_id=${workerSessionID}; do not start a different Worker.`,
          ].join("\n"))
        }
        throw new Error(`WORKER RETURN REJECTED\nWorker ${workerSessionID} did not finish its causally marked same-session base-model continuation.`)
      }
      latestAssistant = continuationTranscript.assistant
      markBaseContinuationCompleted()
      output.metadata = {
        ...output.metadata,
        workerRecoveryBoostCleared: true,
        workerBaseContinuation: true,
        workerBaseContinuationSessionID: workerSessionID,
        workerBaseContinuationModel: modelRefString(baseModel),
      }
      baseContinuationApplied = true
    } else if (boostContinuationHelp?.recoveryBoost?.phase === "cleared"
      && continuationState?.status === "passed"
      && continuationState.taskPath === taskPath) {
      const completedAt = new Date().toISOString()
      updateWorkerHelp(boostContinuationHelp.id, (request) => request.recoveryBoost?.phase === "cleared"
        ? {
            ...request,
            recoveryBoost: {
              ...request.recoveryBoost,
              phase: "base_continuation_completed",
              baseContinuationCompletedAt: completedAt,
            },
          }
        : request)
    } else if (boostContinuationHelp?.recoveryBoost?.phase === "base_continuation_started") {
      const continuationNonce = boostContinuationHelp.recoveryBoost.baseContinuationNonce
      const continuationMessageID = boostContinuationHelp.recoveryBoost.baseContinuationMessageID
      if (continuationTranscript.status === "absent"
        && continuationNonce
        && continuationMessageID
        && persistedBaseModel) {
        let safeUnsentTakeover = false
        if (typeof (client as any)?.session?.message === "function"
          && typeof (client as any)?.session?.status === "function") {
          try {
            const [messageResult, statusResult] = await Promise.all([
              client.session.message({
                path: { id: workerSessionID, messageID: continuationMessageID },
                query: { directory: root },
              }),
              client.session.status({ query: { directory: root } }),
            ])
            const missingMessage = sessionMessageNotFound(messageResult)
            const statuses = unwrap<any>(statusResult)
            safeUnsentTakeover = missingMessage && statuses?.[workerSessionID]?.type === "idle"
          } catch {
            safeUnsentTakeover = false
          }
        }
        if (safeUnsentTakeover) {
          const baseModel = agentModelRef(persistedBaseModel)
          if (!baseModel) {
            throw new Error("WORKER RETURN REJECTED\nThe persisted base Worker continuation model is invalid.")
          }
          let promptInFlight = baseContinuationPrompts.get(continuationMessageID)
          if (!promptInFlight) {
            promptInFlight = (async () => {
              const promptResult: any = await client.session.prompt({
                path: { id: workerSessionID },
                query: { directory: root },
                body: {
                  messageID: continuationMessageID,
                  agent: "worker",
                  model: baseModel,
                  parts: [{ type: "text", text: [
                    "WORKER RECOVERY BOOST COMPLETE",
                    `The reviewed hurdle from ${boostContinuationHelp.id} is cleared. Continue ${taskPath} in this same Worker session using the current authoritative Doctor result and the base Worker model.`,
                    "Do not repeat the cleared correction. Continue only the remaining task work and finish with the required terminal handoff.",
                    baseContinuationMarker(continuationNonce),
                  ].join("\n") }],
                },
              })
              if (promptResult?.error) {
                throw new Error(`WORKER RETURN REJECTED\nThe safe unsent base Worker continuation failed: ${JSON.stringify(promptResult.error)}`)
              }
            })()
            baseContinuationPrompts.set(continuationMessageID, promptInFlight)
          }
          try {
            await promptInFlight
          } finally {
            if (baseContinuationPrompts.get(continuationMessageID) === promptInFlight) {
              baseContinuationPrompts.delete(continuationMessageID)
            }
          }
          messages = await loadMessages()
          latestAssistant = latestAssistantMessage(messages)
          continuationTranscript = baseContinuationTranscript(messages, boostContinuationHelp.recoveryBoost)
        }
      }
      if (continuationTranscript.status === "completed"
        || (exactExternalContinuation && persistedBaseModel === latestAssistantModel && latestAssistantFinished(messages))) {
        if (continuationTranscript.status === "completed") latestAssistant = continuationTranscript.assistant
        markBaseContinuationCompleted()
        output.metadata = {
          ...output.metadata,
          workerRecoveryBoostCleared: true,
          workerBaseContinuation: true,
          workerBaseContinuationSessionID: workerSessionID,
        }
        baseContinuationApplied = true
      } else {
        throw new Error([
          "WORKER RETURN REJECTED",
          `The same-session base continuation for ${workerSessionID} has an inconclusive persisted start state.`,
          continuationTranscript.status === "pending"
            ? "Its causally marked user turn is still pending. Do not launch another Worker or repeat the continuation."
            : continuationTranscript.status === "mismatched"
              ? "Its causally linked assistant used a different model. Do not accept or repeat the continuation automatically."
              : "No causally marked completed Base turn is proven. Do not launch another Worker or repeat the continuation automatically.",
        ].join("\n"))
      }
    } else if (boostContinuationHelp?.recoveryBoost?.phase === "base_continuation_completed"
      && persistedBaseModel) {
      const completedEvidence = continuationTranscript.status === "completed"
        || (exactExternalContinuation && persistedBaseModel === latestAssistantModel && latestAssistantFinished(messages))
      if (!completedEvidence) {
        throw new Error([
          "WORKER RETURN REJECTED",
          `The persisted base continuation for ${workerSessionID} has no matching finished base-model assistant evidence.`,
          "Do not repeat the continuation or launch another Worker; resume only after the bound session evidence is available.",
        ].join("\n"))
      }
      if (continuationTranscript.status === "completed") latestAssistant = continuationTranscript.assistant
      continuationResultText = boostContinuationHelp.recoveryBoost.baseContinuationResultText
        ?? continuationTranscript.assistant?.parts
          ?.filter((part: any) => part?.type === "text")
          .map((part: any) => String(part.text ?? ""))
          .join("\n")
        ?? ""
      output.metadata = {
        ...output.metadata,
        workerRecoveryBoostCleared: true,
        workerBaseContinuation: true,
        workerBaseContinuationSessionID: workerSessionID,
        workerBaseContinuationRehydrated: true,
      }
      baseContinuationApplied = true
    }

    const rememberWorkerIdentity = () => {
      const agent = String(latestAssistant?.info?.agent ?? latestAssistant?.info?.mode ?? "worker").toLowerCase()
      sessionAgents.set(workerSessionID, agent)
      const identity = [latestAssistant?.info?.providerID, latestAssistant?.info?.modelID]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join("/")
      if (identity) sessionModels.set(workerSessionID, identity)
      return agent
    }
    let workerAgent = rememberWorkerIdentity()
    let resultText = baseContinuationApplied
      ? continuationResultText
      : workerTaskResultText(output.output) || latestAssistantText(messages)
    clearAuthoritativePlannerBlocker(taskPath)

    const persistWorkerOwner = (text: string) => {
      const state = activeState(root)
      if (state?.taskPath !== taskPath || typeof state?.taskHash !== "string") return
      recordAuthoritativeWorkerOwner({
        executorSessionID: input.sessionID,
        workerSessionID,
        taskPath,
        taskHash: state.taskHash,
        resultText: text,
      })
    }

    const evaluate = async () => {
      const state = activeState(root)
      const doctorPassed = state?.status === "passed" && state?.taskPath === taskPath
      const harnessRecovery = features.executorBaselineRecovery ? taskHarnessRecoveryStatus(root) : null
      const help = features.workerHelp ? workerHelpForSession(workerSessionID, taskPath, state?.taskHash) : null
      if (help) return { state, pending: [] as GuardViolation[], help, issue: null, harnessRecovery }
      const driver = driverForSession(workerSessionID)
      if (claimsReviewableHandoff(resultText) && !doctorPassed && features.guardLearning) {
        const problem = `Worker claimed REVIEWABLE before Doctor PASS for ${taskPath}.`
        const action = `Continue ${taskPath} until Doctor verify prints TASK DOCTOR: PASS. If it cannot pass, return a BLOCKED handoff instead.`
        const violation: GuardViolation = { id: guardViolationId(problem, action), problem, action }
        if (driver?.automaticLearning) {
          if (!hasGuardLearning(violation.id, workerAgent)) recordGuardLearningFile(violation.id, workerAgent)
        } else {
          addPendingGuardLearning(workerSessionID, violation)
        }
      }
      const pending = features.guardLearning && !driver?.automaticLearning
        ? await refreshPendingGuardLearnings(workerSessionID, messages)
        : []
      const terminalHarnessRecovery = harnessRecovery?.taskPath === taskPath
      const pendingForReturn = terminalHarnessRecovery ? [] : pending
      let issue = workerReturnIssue({
        text: resultText,
        taskPath,
        doctorStatus: state?.status,
        doctorTaskPath: state?.taskPath,
        pendingGuardLearningIDs: pendingForReturn.map((violation) => violation.id),
        requireTerminalHandoff: true,
      })
      if (harnessRecovery?.taskPath === taskPath && (
        !/(?:^|\n)\s*BLOCKED\s*(?:\n|$)/i.test(resultText)
        || !/(?:^|\n)\s*Required owner\s*:\s*Executor\s*(?:\n|$)/i.test(resultText)
      )) {
        issue = { kind: "invalid_blocked_handoff", detail: "Harness recovery requires BLOCKED with Required owner: Executor" }
      }
      return { state, pending: pendingForReturn, help, issue, harnessRecovery }
    }

    const initialState = activeState(root)
    const outputLimited = latestAssistant?.info?.finish === "length"
      && initialState?.status === "started"
      && initialState.taskPath === taskPath
      && typeof initialState.taskHash === "string"
    const outputLimitTokens = Number(latestAssistant?.info?.tokens?.output ?? 0)
    if (features.workerHelp && outputLimited) {
      persistWorkerOutputLimitHelp(workerSessionID, taskPath, initialState.taskHash, outputLimitTokens)
    }

    let evaluation = await evaluate()
    const canonicalizeInvalidBlocker = async (current: Awaited<ReturnType<typeof evaluate>>) => {
      if (current.issue?.kind !== "invalid_blocked_handoff" || current.pending.length > 0) return false
      const savedFailure = readJson(lastDoctorFailurePath)
      const childFailure = savedFailure?.taskPath === taskPath && savedFailure?.sessionID === workerSessionID
      const authoritativeFailure = childFailure
        ? doctorFailureFingerprint(String(savedFailure.gate ?? "verify"), taskPath, String(savedFailure.output ?? ""))
        : null
      const transcriptFailure = latestRelevantToolFailure(messages)
      const doctorFailedAt = typeof savedFailure?.failedAt === "string" ? Date.parse(savedFailure.failedAt) : 0
      const toolFailureIsNewer = Boolean(transcriptFailure
        && (!childFailure || !Number.isFinite(doctorFailedAt) || transcriptFailure.at > doctorFailedAt))
      const primaryFailure = toolFailureIsNewer ? transcriptFailure!.fingerprint : authoritativeFailure
      const failureSource = toolFailureIsNewer ? "tool" as const : authoritativeFailure ? "doctor" as const : undefined
      const reviewedHelpID = String(input.args?.prompt ?? "").match(/REVIEWED WORKER HELP\s+(H\d+)/i)?.[1]?.toUpperCase()
      const reviewedHelp = reviewedHelpID
        ? workerHelpStore(root).requests.find((request) => (
            request.id.toUpperCase() === reviewedHelpID
            && request.status === "delegated"
            && request.taskPath === taskPath
            && request.taskHash === current.state?.taskHash
          ))
        : null
      const explicitOwner = resultText.match(/(?:^|\n)\s*Required owner\s*:\s*(Executor|Planner|User)\s*(?:\n|$)/i)?.[1]
      const diagnostics = childFailure
        ? scopedDoctorDiagnostics(taskPath, String(savedFailure.output ?? ""))
        : { scoped: [] as string[], outside: [] as string[] }
      const taskDefinitionFailure = failureSource === "doctor" && childFailure && (
        savedFailure.gate === "lint"
        || /TASK_SCOPE_INSUFFICIENT|TASK_FORMAT|task definition/i.test(String(savedFailure.output ?? ""))
        || (savedFailure.gate === "verify" && diagnostics.scoped.length === 0 && diagnostics.outside.length > 0)
      )
      const requiredOwner = current.harnessRecovery?.taskPath === taskPath
        ? "Executor"
        : explicitOwner
          ? `${explicitOwner[0].toUpperCase()}${explicitOwner.slice(1).toLowerCase()}` as "Executor" | "Planner" | "User"
          : taskDefinitionFailure
            ? "Planner"
            : "Executor"
      resultText = current.harnessRecovery?.taskPath === taskPath
        ? executorRecoveryHandoff(taskPath, current.harnessRecovery.paths.map((entry) => entry.path))
        : canonicalBlockedHandoff({
            taskPath,
            doctorStatus: current.state?.status,
            failure: primaryFailure?.problem
              ?? `Worker ended before Doctor PASS with an invalid blocker handoff (${current.issue.detail}).`,
            requiredOwner,
          })
      if (current.harnessRecovery?.taskPath === taskPath) {
        resultText = withExecutorRecoveryAction(resultText, taskPath, current.harnessRecovery.paths.map((entry) => entry.path))
      } else if (features.plannerRecovery && requiredOwner === "Planner") {
        resultText = [
          resultText,
          "EXECUTOR NEXT ACTION: This is a Planner-owned task-definition blocker. Call escalate_to_planner for the exact task now. Do not merely announce the handoff and do not delegate another Worker.",
        ].join("\n\n")
      } else if (requiredOwner === "Executor" && features.workerHelp && current.state?.status === "started"
        && current.state.taskPath === taskPath && typeof current.state.taskHash === "string") {
        const help = persistInvalidWorkerReturnHelp({
          sessionID: workerSessionID,
          taskPath,
          taskHash: current.state.taskHash,
          issue: current.issue.detail,
          failure: primaryFailure,
          failureSource,
          secondaryEvidence: toolFailureIsNewer && authoritativeFailure
            ? [`Earlier Doctor context: ${authoritativeFailure.evidence ?? authoritativeFailure.problem}`]
            : [],
          retryOfHelpID: reviewedHelp?.id,
          relevantFiles: [...new Set([
            ...(reviewedHelp?.relevantFiles ?? []),
            ...(toolFailureIsNewer
              ? [normalize(root, transcriptFailure!.fingerprint.target)]
                  .filter((path): path is string => Boolean(path && existsSync(resolve(root, path)) && !isProtected(path, protectedPaths)))
              : []),
          ])],
        })
        resultText = workerHelpHandoff(help)
        output.metadata = {
          ...output.metadata,
          workerHelpSynthesized: true,
          workerHelpID: help.id,
        }
      } else if (requiredOwner === "Executor") {
        resultText = [
          resultText,
          "EXECUTOR NEXT ACTION: Run npm run task:doctor:schedule and delegate its READY task to a fresh Worker. Do not read Worker rules or announce the action.",
        ].join("\n\n")
      }
      output.output = replaceWorkerTaskResult(output.output, workerSessionID, resultText)
      output.metadata = {
        ...output.metadata,
        workerReturnValidated: true,
        workerReturnCanonicalized: true,
        workerBlockedCanonicalized: true,
      }
      persistWorkerOwner(resultText)
      await log("info", "Canonicalized invalid Worker blocker without another model call", {
        parentSessionID: input.sessionID,
        workerSessionID,
        task: taskPath,
        issue: current.issue.detail,
        requiredOwner,
      })
      return true
    }
    if (evaluation.help) {
      resultText = workerHelpHandoff(evaluation.help)
      output.output = replaceWorkerTaskResult(output.output, workerSessionID, resultText)
      output.metadata = {
        ...output.metadata,
        workerReturnValidated: true,
        workerReturnCanonicalized: true,
        workerHelpSynthesized: outputLimited || output.metadata?.workerHelpSynthesized,
        workerOutputLimit: outputLimited || output.metadata?.workerOutputLimit,
        workerOutputTokens: outputLimited ? outputLimitTokens : output.metadata?.workerOutputTokens,
        workerHelpID: evaluation.help.id,
      }
      await log("info", outputLimited
        ? "Synthesized terminal Worker help after output-limit truncation"
        : "Canonicalized terminal Worker help handoff from persisted structured data", {
        parentSessionID: input.sessionID,
        workerSessionID,
        task: taskPath,
        helpID: evaluation.help.id,
        outputTokens: outputLimited ? outputLimitTokens : undefined,
      })
      markBaseContinuationDelivered()
      return
    }
    const terminalLoopHelp = features.workerHelp ? workerHelpRequired.get(workerSessionID) : null
    if (terminalLoopHelp && evaluation.pending.length === 0 && evaluation.state?.taskPath === taskPath && evaluation.state?.taskHash) {
      const help = persistRequiredWorkerHelp(workerSessionID, taskPath, evaluation.state.taskHash, terminalLoopHelp)
      resultText = workerHelpHandoff(help)
      output.output = replaceWorkerTaskResult(output.output, workerSessionID, resultText)
      output.metadata = {
        ...output.metadata,
        workerReturnValidated: true,
        workerReturnCanonicalized: true,
        workerHelpSynthesized: true,
        workerHelpID: help.id,
      }
      await log("info", "Synthesized terminal Worker help after a required loop stop", {
        parentSessionID: input.sessionID,
        workerSessionID,
        task: taskPath,
        helpID: help.id,
        count: terminalLoopHelp.count,
        category: terminalLoopHelp.fingerprint.category,
      })
      markBaseContinuationDelivered()
      return
    }
    if (await canonicalizeInvalidBlocker(evaluation)) {
      markBaseContinuationDelivered()
      return
    }
    if (!evaluation.issue) {
      if (baseContinuationApplied) {
        output.output = replaceWorkerTaskResult(output.output, workerSessionID, resultText)
      }
      if (evaluation.harnessRecovery?.taskPath === taskPath) {
        resultText = withExecutorRecoveryAction(resultText, taskPath, evaluation.harnessRecovery.paths.map((entry) => entry.path))
        output.output = replaceWorkerTaskResult(output.output, workerSessionID, resultText)
      } else if (features.plannerRecovery && /(?:^|\n)\s*BLOCKED\s*(?:\n|$)/i.test(resultText)
        && /(?:^|\n)\s*Required owner\s*:\s*Planner\s*(?:\n|$)/i.test(resultText)) {
        resultText = [
          resultText,
          "EXECUTOR NEXT ACTION: This is a Planner-owned task-definition blocker. Call escalate_to_planner for the exact task now. Do not merely announce the handoff and do not delegate another Worker.",
        ].join("\n\n")
        output.output = replaceWorkerTaskResult(output.output, workerSessionID, resultText)
      }
      output.metadata = { ...output.metadata, workerReturnValidated: true }
      persistWorkerOwner(resultText)
      markBaseContinuationDelivered()
      return
    }

    const recordingInstruction = evaluation.pending.length === 0
      ? null
      : evaluation.pending.length === 1
        ? [
            "First call record_guard_learning once without arguments; it records every pending lesson for this role mechanically.",
            `${evaluation.pending[0].id}: ${evaluation.pending[0].action}`,
          ].join("\n")
        : [
            "First call record_guard_learning once without arguments; it records every pending lesson for this role mechanically.",
            ...evaluation.pending.map((violation) => `${violation.id}: ${violation.action}`),
          ].join("\n")
    const passed = evaluation.state?.status === "passed" && evaluation.state?.taskPath === taskPath
    const requiredHelp = features.workerHelp ? workerHelpRequired.get(workerSessionID) : null
    const terminalInstruction = evaluation.harnessRecovery?.taskPath === taskPath
      ? [
          "Doctor requires Executor-owned Harness baseline recovery. Do not edit, restore, delete, whitelist, or retry the reported Harness files.",
          "Call no more tools. Return only this structure:",
          executorRecoveryHandoff(taskPath, evaluation.harnessRecovery.paths.map((entry) => entry.path)),
        ].join("\n")
      : requiredHelp
        ? [
            `The loop guard recorded ${requiredHelp.count} equivalent failures for ${requiredHelp.fingerprint.tool} on ${requiredHelp.fingerprint.target}.`,
            "After recording every pending learning, call request_executor_help for the active task.",
            "Use category model_loop, include the distinct attempted approaches, this exact failure evidence, relevant application files, and a concrete suggested next step. Then stop; the parent hook constructs the handoff.",
          ].join("\n")
      : passed
      ? `Doctor passed ${taskPath}. After recording every pending learning, return only:\nREVIEWABLE\nTask: ${taskPath}`
      : [
          `Doctor has not passed ${taskPath}. Current Doctor status: ${evaluation.state?.status ?? "none"}.`,
          "Do not claim REVIEWABLE and do not substitute manual checks for Doctor verify.",
          evaluation.state?.status === "started" && evaluation.state?.taskPath === taskPath
            ? features.transactionalWorkerChanges
              ? "If the current failure is correctable inside the active Scope, fix it; Apply verifies mechanically. If a trusted fallback is explicitly required, call verify_worker_task."
              : `If the current failure is correctable inside the active Scope, fix it and run npm run task:doctor:verify -- ${taskPath}.`
            : `Continue the original Doctor lifecycle for ${taskPath} from the authoritative current state without restarting an active lifecycle.`,
          "If Doctor still cannot pass, return only this structure with concrete content:",
          `BLOCKED\nTask: ${taskPath}\nDoctor status: ...\nFailure: ...\nRequired owner: ...`,
          `If Doctor passes, return the REVIEWABLE structure for ${taskPath} instead.`,
        ].join("\n")
    const correction = [
      "WORKER RETURN BLOCKED: The Executor has not received your result yet.",
      `Reason: ${evaluation.issue.detail}.`,
      recordingInstruction,
      terminalInstruction,
      "Do not inspect workflow internals, run Doctor complete, or end with a generic readiness statement.",
    ].filter(Boolean).join("\n\n")

    await log("info", "Correcting Worker return before releasing Executor task tool", {
      parentSessionID: input.sessionID,
      workerSessionID,
      task: taskPath,
      issue: evaluation.issue.kind,
      pendingLearningIDs: evaluation.pending.map((violation) => violation.id),
    })
    const promptResult: any = await client.session.prompt({
      path: { id: workerSessionID },
      query: { directory: root },
      body: {
        agent: workerAgent,
        model: automaticAgentModel(root, workerAgent, latestAssistant?.info),
        parts: [{ type: "text", text: correction }],
      },
    })
    if (promptResult?.error) {
      throw new Error(`WORKER RETURN REJECTED\nThe synchronous Worker correction failed: ${JSON.stringify(promptResult.error)}`)
    }

    messages = await loadMessages()
    latestAssistant = latestAssistantMessage(messages)
    if (!latestAssistant || !latestAssistantFinished(messages)) {
      throw new Error(`WORKER RETURN REJECTED\nWorker ${workerSessionID} did not finish its required return correction. The Executor received no reviewable result.`)
    }
    workerAgent = rememberWorkerIdentity()
    resultText = latestAssistantText(messages)
    evaluation = await evaluate()
    if (evaluation.issue) {
      if (await canonicalizeInvalidBlocker(evaluation)) {
        markBaseContinuationDelivered()
        return
      }
      await log("warn", "Rejecting Worker result after one synchronous return correction", {
        parentSessionID: input.sessionID,
        workerSessionID,
        task: taskPath,
        issue: evaluation.issue.kind,
        detail: evaluation.issue.detail,
      })
      throw new Error([
        "WORKER RETURN REJECTED",
        `Task: ${taskPath}`,
        `Problem: ${evaluation.issue.detail}.`,
        "The Executor received neither an authoritative REVIEWABLE handoff, a valid BLOCKED handoff, nor the recorded HELP_REQUESTED handoff.",
      ].join("\n"))
    }

    output.output = replaceWorkerTaskResult(output.output, workerSessionID, resultText)
    if (evaluation.harnessRecovery?.taskPath === taskPath) {
      output.output = replaceWorkerTaskResult(output.output, workerSessionID, withExecutorRecoveryAction(
        resultText,
        taskPath,
        evaluation.harnessRecovery.paths.map((entry) => entry.path),
      ))
    } else if (features.plannerRecovery && /(?:^|\n)\s*BLOCKED\s*(?:\n|$)/i.test(resultText)
      && /(?:^|\n)\s*Required owner\s*:\s*Planner\s*(?:\n|$)/i.test(resultText)) {
      output.output = replaceWorkerTaskResult(output.output, workerSessionID, [
        resultText,
        "EXECUTOR NEXT ACTION: This is a Planner-owned task-definition blocker. Call escalate_to_planner for the exact task now. Do not merely announce the handoff and do not delegate another Worker.",
      ].join("\n\n"))
    }
    output.metadata = {
      ...output.metadata,
      workerReturnValidated: true,
      workerReturnCorrected: true,
      workerHelpID: evaluation.help?.id,
    }
    persistWorkerOwner(resultText)
    markBaseContinuationDelivered()
  }

  function volatileWorkflowGuardText(sessionID: string) {
    const feedback = sessionFeedback.get(sessionID)
    const savedCheckpoint = readJson(resolve(root, ".task-doctor/workflow-checkpoint.json"))
    const pendingHelpReviewID = executorHelpReviewPending.get(sessionID)
    const requestedHelpReReviewID = executorHelpReReviewRequested.get(sessionID)
    const requestedPlannerRecovery = executorPlannerRecoveryRequested.get(sessionID)
    const activePlannerRecovery = activePlannerRecoveries.get(sessionID)
    const currentState = activeState(root)
    const currentPlannerReceipt = explicitPlannerReviewReceipt()
    const pendingFrozenPlannerReview = currentPlannerReceipt?.status === "pending"
      && currentPlannerReceipt.executorSessionID === sessionID
      && currentPlannerReceipt.taskPath === currentState?.taskPath
      && currentPlannerReceipt.taskHash === currentState?.taskHash
      && Boolean(currentPlannerReceipt.contract)
    const currentPlannerRecoveryRequest = requestedPlannerRecovery
      && currentState?.status === "started"
      && currentState.taskPath === requestedPlannerRecovery.taskPath
      && currentState.taskHash === requestedPlannerRecovery.taskHash
      ? requestedPlannerRecovery
      : null
    if (requestedPlannerRecovery && !currentPlannerRecoveryRequest) executorPlannerRecoveryRequested.delete(sessionID)
    const deterministicRecoveryPending = projectMemoryRecoveryStatus(root)
      || (features.executorBaselineRecovery ? taskHarnessRecoveryStatus(root) : null)
    const agent = sessionAgents.get(sessionID) ?? ""
    const scheduledReady = executorReadyAfterSchedule.get(sessionID)
    const role = modeSettings.plannerAgents.has(agent)
      ? "planner"
      : modeSettings.executorAgents.has(agent)
        ? "executor"
        : modeSettings.workerAgents.has(agent)
          ? "worker"
          : "unknown"
    const sessionAction = reduceWorkflow({ type: "session.action", input: {
      role,
      doctorStatus: currentState?.status ?? "none",
      deterministicRecoveryPending: Boolean(deterministicRecoveryPending),
      terminalExecutorReason: terminalExecutorReasons.get(sessionID),
      activePlannerRecovery: activePlannerRecovery
        ? {
            lifecycle: activePlannerRecovery.lifecycle,
            taskPath: activePlannerRecovery.taskPath,
            exactContract: activePlannerRecovery.exactContract,
            supersedeTasks: activePlannerRecovery.contract.supersedeTasks,
            supersededTasks: [...activePlannerRecovery.supersededTasks],
          }
        : null,
      pendingHelpReviewID,
      requestedHelpReReviewID,
      plannerRecoveryRequest: currentPlannerRecoveryRequest
        ? { taskPath: currentPlannerRecoveryRequest.taskPath, frozen: pendingFrozenPlannerReview }
        : null,
      plannerHasRegisteredTasks: role === "planner"
        && plannerOwnedTodoTasks(root, sessionID).some((taskPath) => taskRegistrationValid(root, taskPath.split("/").pop()!)),
      scheduledReadyTask: role === "executor" ? scheduledReady : null,
      executorScheduleRequired: role === "executor"
        && currentState?.status !== "started"
        && currentState?.status !== "passed"
        && !executorScheduledNoReady.has(sessionID),
    } }).value as WorkflowAction | null
    const liveState = features.authoritativeContinuationState
      ? authoritativeWorkflowStateText(
          root,
          sessionAction?.text,
          activePlannerRecovery ? `active trusted recovery for ${activePlannerRecovery.taskPath}` : undefined,
        )
      : null
    const terminalWorkerHarnessRecovery = features.executorBaselineRecovery
      && modeSettings.workerAgents.has(agent)
      && (taskHarnessRecoveryStatus(root) !== null || workerHarnessRecoveryTerminals.has(sessionID))
    const pendingLearnings = features.guardLearning && !terminalWorkerHarnessRecovery
      ? [...pendingGuardLearningsForAgent(sessionID).values()]
      : []
    return renderWorkflowGuardMessage({
      feedback,
      learningActions: pendingLearnings.map((violation) => ({ id: violation.id, action: violation.action })),
      liveState,
      checkpoint: savedCheckpoint,
    })
  }

  return {
    tool: {
      ...(features.planningEnforcer ? {
      register_planner_task: tool({
        description: "Register one minimal Planner task. Provide a title, exact files, concrete done facts, and dependencies only when needed; the Harness derives the canonical task and verification.",
        args: {
          title: tool.schema.string().min(3).max(160).describe("Short task title; the Harness derives the task path."),
          files: tool.schema.array(tool.schema.string().min(1)).min(1).max(40).describe("Exact project-relative files. Prefix existing read-only implementation context with READ:."),
          done: tool.schema.array(tool.schema.string().min(3)).min(1).max(30).describe("Concrete facts that are true when the task is done."),
          depends_on: tool.schema.array(tool.schema.string().min(1)).max(20).optional().describe("Exact prerequisite task filenames; omit when none."),
        },
        async execute(rawArgs, context) {
          const args: any = await checkedModelArgs("register_planner_task", rawArgs, context.sessionID, true, context)
          const agent = context.agent.toLowerCase()
          if (!modeSettings.plannerAgents.has(agent)) {
            throw projectGuardError(context.sessionID,
              "Only Planner may create and register task definitions.",
              "Return planning to Planner. Executor delegates registered tasks and Worker implements them.",
            )
          }
          const preferredFiles = Array.isArray(args.files) ? args.files : []
          const preferredDone = Array.isArray(args.done) ? args.done : []
          const completePreferredInput = typeof args.title === "string" && Boolean(args.title.trim())
            && preferredFiles.length > 0 && preferredDone.length > 0
          const suppliedContent = typeof args.content === "string" ? args.content.trim() : ""
          const parsedLegacyContent = suppliedContent ? parsePlannerTask(suppliedContent) : null
          if (suppliedContent && !parsedLegacyContent && !completePreferredInput) {
            throw new Error("PLANNER TASK REGISTRATION FAILED\nThe supplied legacy content is missing one canonical title, Outcome, Scope, Requirements, Scheduling, or Memory value. No file was changed.")
          }
          const parsedContent = completePreferredInput ? null : parsedLegacyContent
          const ignoredLegacyContent = completePreferredInput && Boolean(suppliedContent)
          const preferredMinimal = !parsedContent && (preferredFiles.length > 0 || preferredDone.length > 0)
          if (preferredMinimal && (typeof args.title !== "string" || !args.title.trim() || preferredFiles.length === 0 || preferredDone.length === 0)) {
            throw projectGuardError(context.sessionID,
              "Minimal Planner registration requires title, files, and done.",
              "Call register_planner_task once with title, at least one exact files entry, at least one concrete done fact, and depends_on only when needed.",
            )
          }
          const taskTitle = String(parsedContent?.title ?? args.title ?? "").replace(/\s+/g, " ").trim()
          const derivedName = taskTitle
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80)
          const rawTaskPath = preferredMinimal
            ? derivedName ? `kanban/todo/${derivedName}.md` : ""
            : args.task_path ?? (derivedName ? `kanban/todo/${derivedName}.md` : "")
          const normalizedTaskPath = normalize(root, rawTaskPath)
          if (!normalizedTaskPath || !planningPath.test(normalizedTaskPath)) {
            throw projectGuardError(context.sessionID,
              `${rawTaskPath || "the derived path"} is not an exact project-relative kanban/todo task path.`,
              "Provide one title that produces a non-empty task slug. Legacy content may also provide one exact kanban/todo/<short-name>.md task_path.",
            )
          }
          const fileInput = parsedContent
            ? [...parsedContent.scope, ...(parsedContent.context ?? []).map((path) => `READ: ${path}`)]
            : preferredMinimal
              ? preferredFiles
              : (args.scope ?? [])
          const normalizedFiles = normalizedPlannerFiles(context.sessionID, fileInput)
          const scope = normalizedFiles.scope
          const normalizedDependencies = normalizedPlannerDependencies(
            context.sessionID,
            parsedContent?.dependsOn ?? args.depends_on ?? [],
          )
          const dependencies = normalizedDependencies.dependencies
          const rawVerify: string[] = parsedContent?.verify ?? args.verify ?? []
          const verify = preferredMinimal
            ? deriveMinimalPlannerVerify(scope)
            : portablePlannerVerifyCommands(context.sessionID, rawVerify)
          const verifyRepaired = JSON.stringify(verify) !== JSON.stringify(rawVerify)
          const scopedPaths = scope.map((entry) => entry.replace(/^NEW:\s*/, ""))
          const ownsMemory = scopedPaths.includes("MEMORY.md")
          const requestedMemoryAction = parsedContent?.memoryAction ?? args.memory_action ?? "none"
          const memoryAction = preferredMinimal
            ? ownsMemory ? "update" : "none"
            : ownsMemory ? requestedMemoryAction === "none" ? "update" : requestedMemoryAction : "none"
          const memoryReason = memoryAction === "none"
            ? "No durable project knowledge changes."
            : parsedContent?.memoryReason ?? args.memory_reason ?? "Update durable project knowledge explicitly listed in task files."
          const memoryActionRepaired = memoryAction !== requestedMemoryAction
          const draft = parsedContent
            ? {
                ...parsedContent,
                scope,
                context: normalizedFiles.context,
                dependsOn: dependencies,
                memoryAction,
                memoryReason,
                verify,
              }
            : preferredMinimal
              ? {
                  title: taskTitle,
                  outcome: String(preferredDone[0]).replace(/\s+/g, " ").trim(),
                  scope,
                  context: normalizedFiles.context,
                  requirements: preferredDone,
                  parallel: false,
                  dependsOn: dependencies,
                  resources: ["repo"],
                  memoryAction,
                  memoryReason,
                  verify,
                }
              : {
                  title: taskTitle,
                  outcome: args.outcome,
                  scope,
                  context: normalizedFiles.context,
                  requirements: args.requirements,
                  parallel: args.parallel ?? false,
                  dependsOn: dependencies,
                  resources: args.resources ?? ["repo"],
                  memoryAction,
                  memoryReason,
                  verify,
                }
          const content = renderPlannerTask(draft)
          let taskPath = normalizedTaskPath
          if (preferredMinimal) taskPath = availableMinimalPlannerTaskPath(context.sessionID, normalizedTaskPath, content)
          const pathCollisionRepaired = taskPath !== normalizedTaskPath
          const state = activeState(root)
          if (state?.taskPath === taskPath && ["started", "passed"].includes(state.status)) {
            throw projectGuardError(context.sessionID,
              `${taskPath} already has an active Doctor lifecycle.`,
              "Use revise_active_task only for an explicitly returned Planner-owned active-task correction.",
            )
          }
          const existingOwner = readPlannerOwnership(root, taskPath)
          if (existsSync(resolve(root, taskPath)) && existingOwner?.plannerSessionID !== context.sessionID) {
            throw projectGuardError(context.sessionID,
              `${taskPath} exists but is not owned by this Planner session.`,
              "Retry with the same flat input; the Harness will derive the first free deterministic suffix.",
            )
          }
          const name = taskPath.split("/").pop()!
          const taskAbsolute = resolve(root, taskPath)
          const managedPaths = [
            taskAbsolute,
            resolve(root, ".task-doctor/lints", `${name}.json`),
            resolve(root, ".task-doctor/registrations", `${name}.json`),
            plannerOwnershipPath(root, taskPath),
          ]
          const backups = managedPaths.map((path) => ({ path, content: existsSync(path) ? readFileSync(path) : null }))
          const restore = () => {
            for (const backup of backups) {
              if (backup.content === null) rmSync(backup.path, { force: true })
              else {
                mkdirSync(dirname(backup.path), { recursive: true })
                writeFileSync(backup.path, backup.content)
              }
            }
          }

          try {
            mkdirSync(dirname(taskAbsolute), { recursive: true })
            writeFileSync(taskAbsolute, content)
            const lint = run(root, "node", ["scripts/task-doctor.mjs", "lint", taskPath])
            if (lint.status !== 0 || !lint.stdout.includes(`TASK DOCTOR: LINT PASS ${taskPath}`)) {
              throw new Error([lint.stdout, lint.stderr].filter(Boolean).join("\n").trim() || "Doctor lint rejected the generated task.")
            }
            const registration = run(root, "node", ["scripts/task-doctor.mjs", "register", taskPath])
            if (registration.status !== 0 || !registration.stdout.includes(`TASK DOCTOR: REGISTERED ${taskPath}`)) {
              throw new Error([registration.stdout, registration.stderr].filter(Boolean).join("\n").trim() || "Doctor could not register the generated task.")
            }
            claimPlannerOwnership(root, {
              taskPath,
              plannerSessionID: context.sessionID,
              plannerAgent: agent,
              source: "registration",
            })
            if (!taskRegistrationValid(root, name)) throw new Error("Doctor registration did not match the generated task hash.")
            plannerEmptyStopRecoveries.delete(context.sessionID)
            context.metadata({ title: `Planner task registered: ${taskPath}`, metadata: { task: taskPath } })
            return {
              title: `Planner task registered: ${taskPath}`,
              output: [
                `PLANNER TASK REGISTERED ${taskPath}`,
                normalizedFiles.repairs.length + normalizedDependencies.repairs.length > 0
                  ? `Input repair: ${[...normalizedFiles.repairs, ...normalizedDependencies.repairs].join("; ")}.`
                  : null,
                ignoredLegacyContent ? "Input repair: ignored stale legacy content because title, files, and done were complete." : null,
                pathCollisionRepaired ? `Input repair: derived free task path ${taskPath} after a title collision.` : null,
                preferredMinimal ? `Derived Verify: ${verify.length > 0 ? verify.join(" | ") : "none mechanically available"}` : null,
                memoryActionRepaired ? "Input repair: reset memory_action to none because MEMORY.md is not in Scope." : null,
                verifyRepaired ? "Input repair: converted in-project absolute Verify paths to portable paths for the command working directory." : null,
                lint.stdout.trim(),
                registration.stdout.trim(),
                "Create the next approved task with register_planner_task, or run npm run task:doctor:schedule once when planning is complete. Do not run lint or register separately.",
              ].filter(Boolean).join("\n"),
              metadata: { task: taskPath, taskHash: fileHash(taskAbsolute), context: normalizedFiles.context, ignoredLegacyContent, pathCollisionRepaired, memoryActionRepaired, verifyRepaired },
            }
          } catch (error) {
            restore()
            const message = String(error instanceof Error ? error.message : error)
            throw new Error([
              "PLANNER TASK REGISTRATION FAILED",
              message,
              "No partial task, lint, registration, or ownership change from this tool call was kept.",
              "Correct only the named title, files, done, or depends_on value and retry register_planner_task once.",
            ].filter(Boolean).join("\n"))
          }
        },
      }),
      } : {}),
      ...(features.transactionalWorkerChanges ? {
      preview_worker_changes: tool({
        description: "Preview one technically valid scoped file operation without mutating the project. Omit values the Harness can derive from the active task, current bytes, and filesystem state.",
        args: {
          kind: tool.schema.enum(["replace", "rewrite", "create", "delete"]).optional().describe("Operation kind; omit when the payload determines it."),
          path: tool.schema.string().optional().describe("Project-relative target; omit when the active finding or Scope identifies exactly one file."),
          old_text: tool.schema.string().optional().describe("Exact current text for replace."),
          new_text: tool.schema.string().optional().describe("Replacement text for replace."),
          content: tool.schema.string().optional().describe("Complete content for rewrite or create."),
        },
        async execute(args, context) {
          const previewInputRepairs: string[] = []
          if (typeof (args as any).task_path !== "string" || !(args as any).task_path.trim()) {
            const state = activeState(root)
            if (state?.status === "started" && typeof state.taskPath === "string") {
              ;(args as any).task_path = state.taskPath
              previewInputRepairs.push(`inferred task_path=${state.taskPath} from the sole active started task`)
            }
          }
          args = await checkedModelArgs("preview_worker_changes", args, context.sessionID, true, context) as typeof args
          const invocation = args as Record<string, any>
          const agent = context.agent.toLowerCase()
          if (!modeSettings.workerAgents.has(agent)) {
            throw projectGuardError(context.sessionID,
              "Only Worker may preview implementation changes.",
              "Planner writes task definitions. Executor reviews results. Delegate implementation to Worker.",
            )
          }
          sessionAgents.set(context.sessionID, agent)
          const policy = workerChangePolicy(context.sessionID, String(invocation.task_path ?? ""))
          const state = activeState(root)
          if (!workerPreflightComplete(context.sessionID, state)) {
            const { run, mutationRevision } = await ensureMechanicalDoctorPreflight(context.sessionID, state)
            const observation = await observeMechanicalWorkerDoctor(
              context.sessionID,
              state,
              run,
              "initial_preflight",
              mutationRevision,
            )
            if (observation.terminal || run.status !== "pass") {
              throw new Error(sessionFeedback.get(context.sessionID) ?? run.output)
            }
          }
          const findingTarget = workerFindingTargets.get(context.sessionID)
          if (findingTarget && workerFindingReads.get(context.sessionID) !== findingTarget) {
            throw projectGuardError(context.sessionID,
              `${findingTarget} has not been read since the current Doctor failure.`,
              `Read ${findingTarget} now. Then preview one technically valid operation for that file.`,
            )
          }
          const taskFiles = scopeFromTask(root, policy.taskPath)
          const unreadContext = taskFiles.contextPaths.filter((path) => !workerFileWasFullyRead(context.sessionID, path, state))
          if (unreadContext.length > 0) {
            throw projectGuardError(context.sessionID,
              `Worker has not fully read required task Context at its current hash: ${unreadContext.join(", ")}.`,
              `Read ${unreadContext[0]} fully without offset or limit, then retry the same preview.`,
            )
          }
          const pendingPreview = selectLatestPendingWorkerChange(policy)
          if (pendingPreview) {
            throw projectGuardError(context.sessionID,
              `${pendingPreview.id} is already the latest pending preview for ${pendingPreview.paths.join(", ")}.`,
              "Call apply_worker_changes without arguments to apply it, or discard_worker_changes without arguments to discard it. Do not call preview_worker_changes again until one succeeds.",
            )
          }
          const repairedOperations = repairMalformedWorkerChangeOperations(flatWorkerChangeOperation(invocation))
          if (repairedOperations.ambiguous) {
            throw new Error("Worker change operation repair is ambiguous; use one canonical value for each field and one scalar wrapper candidate.")
          }
          previewInputRepairs.push(...repairedOperations.inputRepairs)
          const repairedShape = deriveSingleWorkerChangeOperation(
            context.sessionID,
            policy,
            state,
            repairedOperations.values,
          )
          const operations = workerChangeOperations(repairedShape.values)
          const operationPaths = [...new Set(operations.map((operation) => normalize(root, operation.path) ?? operation.path))]
          if (operationPaths.length !== 1) {
            throw projectGuardError(context.sessionID,
              `Worker preview contains ${operationPaths.length} project files: ${operationPaths.join(", ")}.`,
              "Preview exactly one project file. Split the operations into sequential previews and apply each file before preparing the next.",
            )
          }
          const unreadExistingPath = operations.find((operation) => {
            if (operation.kind === "delete") return false
            const path = normalize(root, operation.path) ?? operation.path
            const absolutePath = resolve(root, path)
            return existsSync(absolutePath)
              && statSync(absolutePath).isFile()
              && !workerFileWasFullyRead(context.sessionID, path, state)
          })?.path
          if (unreadExistingPath) {
            throw projectGuardError(context.sessionID,
              `Worker preview target ${unreadExistingPath} has not been fully read at its current hash in this task context.`,
              `Read ${unreadExistingPath} fully without offset or limit, then prepare a new exact preview from those current bytes.`,
            )
          }
          const previewPurpose = typeof invocation.description === "string" && invocation.description.trim()
            ? invocation.description
            : `Preview ${operations[0].kind} for ${operationPaths[0]}`
          let result: ReturnType<typeof previewWorkerChanges>
          try {
            result = previewWorkerChanges(policy, previewPurpose, operations)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (/\bno-op\b|produced no changes|would not change bytes/i.test(message)) {
              const metadata = { task: policy.taskPath, paths: operationPaths, noChange: true }
              context.metadata({ title: "Worker operation already current", metadata })
              return {
                title: "Worker operation already current",
                output: [
                  "WORKER OPERATION VALIDATED: NO BYTE CHANGE",
                  `Task: ${policy.taskPath}`,
                  `Path: ${operationPaths[0] ?? "unknown"}`,
                  "The operation is technically valid, but the target bytes are already identical. Nothing was stored or applied.",
                ].join("\n"),
                metadata,
              }
            }
            throw error
          }
          result.inputRepairs.unshift(...previewInputRepairs, ...repairedShape.inputRepairs)
          try {
          } catch (error) {
            discardWorkerChanges(policy, result.id)
            throw error
          }
          context.metadata({ title: `Worker change preview ${result.id}`, metadata: { changeID: result.id, task: result.taskPath, paths: result.paths } })
          return {
            title: `Worker change preview ${result.id}`,
            output: [
              `WORKER CHANGE PREVIEW ${result.id}`,
              `Task: ${result.taskPath}`,
              `Paths: ${result.paths.join(", ")}`,
              `Preview token: ${result.previewToken}`,
              result.inputRepairs.length > 0 ? `Input repair: ${result.inputRepairs.join("; ")}` : null,
              result.diffTruncated ? "The bounded diff was truncated. Discard this change set and split it before applying." : null,
              result.diff,
              result.diffTruncated
                ? "NEXT: call zero-argument discard_worker_changes."
                : "NEXT: call zero-argument apply_worker_changes. Do not end first.",
            ].filter(Boolean).join("\n\n"),
            metadata: { changeID: result.id, previewToken: result.previewToken, task: result.taskPath, paths: result.paths, diffTruncated: result.diffTruncated },
          }
        },
      }),
      apply_worker_changes: tool({
        description: "Apply the latest exact pending preview owned by this Worker and the active task. The Harness derives and validates every identifier and token.",
        args: {},
        async execute(args, context) {
          args = await checkedModelArgs("apply_worker_changes", args, context.sessionID, true, context) as typeof args
          const agent = context.agent.toLowerCase()
          if (!modeSettings.workerAgents.has(agent)) {
            throw projectGuardError(context.sessionID,
              "Only Worker may apply a previewed implementation change.",
              "Return to Worker and call apply_worker_changes without arguments; the Harness derives the exact pending preview and token.",
            )
          }
          sessionAgents.set(context.sessionID, agent)
          return await withMechanicalDoctorQueue(async () => {
          if (context.abort?.aborted) {
            throw new Error("Worker Apply was aborted while waiting for the project verification queue; no project file was changed.")
          }
          const queuedTerminalRecovery = workerHarnessRecoveryTerminals.get(context.sessionID)
          if (queuedTerminalRecovery) {
            throw new Error([
              "TASK DOCTOR: EXECUTOR RECOVERY REQUIRED",
              `Task: ${queuedTerminalRecovery.taskPath}`,
              "This Worker became terminal while Apply was queued. No project file was changed by this Apply call.",
              "Return BLOCKED now; Executor must delegate a fresh Worker after recovery.",
            ].join("\n"))
          }
          const queuedHarnessRecovery = taskHarnessRecoveryStatus(root)
          if (queuedHarnessRecovery) {
            markWorkerHarnessRecoveryTerminal(context.sessionID, {
              taskPath: queuedHarnessRecovery.taskPath,
              taskHash: queuedHarnessRecovery.taskHash,
            })
            throw new Error([
              "TASK DOCTOR: EXECUTOR RECOVERY REQUIRED",
              `Task: ${queuedHarnessRecovery.taskPath}`,
              `Harness paths: ${queuedHarnessRecovery.paths.map((entry) => entry.path).join(", ")}`,
              "Harness recovery became authoritative while Apply was queued. No project file was changed by this Apply call.",
              "Return BLOCKED now; Executor must recover and delegate a fresh Worker.",
            ].join("\n"))
          }
          const queuedState = activeState(root)
          const queuedHelp = queuedState?.status === "started"
            ? workerHelpForSession(context.sessionID, queuedState.taskPath, queuedState.taskHash)
            : null
          if (queuedHelp || workerHelpTerminalSessions.has(context.sessionID)) {
            throw new Error([
              "WORKER HELP IS TERMINAL",
              queuedHelp ? `Help ID: ${queuedHelp.id}` : null,
              "Worker Help became authoritative while Apply was queued. No project file was changed by this Apply call.",
              "End the Worker response now; Executor must review the persisted handoff.",
            ].filter(Boolean).join("\n"))
          }
          const queuedRequiredHelp = workerHelpRequired.get(context.sessionID)
          if (queuedRequiredHelp) {
            throw new Error([
              "MODEL LOOP STOP",
              `${queuedRequiredHelp.count} equivalent failures made this Worker terminal while Apply was queued.`,
              "No project file was changed by this Apply call.",
              "Call request_executor_help with the active task and then stop.",
            ].join("\n"))
          }
          const queuedActiveState = activeState(root)
          if (queuedActiveState?.status !== "started" || typeof queuedActiveState.taskPath !== "string") {
            throw new Error("No active started task exists for this Worker Apply.")
          }
          const policy = workerChangePolicy(context.sessionID, queuedActiveState.taskPath)
          const selected = selectLatestPendingWorkerChange(policy)
          if (!selected) {
            throw new Error("No pending preview owned by this Worker and exact active task exists. Preview one technically valid operation first.")
          }
          const receipt = applyWorkerChanges(policy, selected.id, selected.previewToken)
          const appliedMutationRevision = ++workerMutationRevision
          for (const [sessionID, evidence] of doctorEvidence) {
            evidence.delete("verify")
            if (evidence.size === 0) doctorEvidence.delete(sessionID)
          }
          workerVerifyRequired.add(context.sessionID)
          workerFindingReads.delete(context.sessionID)
          workerFileReads.delete(context.sessionID)
          let doctorRun: ValidatedMechanicalDoctorRun | null = null
          let doctorObservation: Awaited<ReturnType<typeof observeMechanicalWorkerDoctor>> | null = null
          let mechanicalDoctorError: string | null = null
          try {
            doctorRun = await executeMechanicalDoctorVerify(context.sessionID, {
              taskPath: policy.taskPath,
              taskHash: policy.taskHash,
            }, context.abort)
            doctorObservation = await observeMechanicalWorkerDoctor(
              context.sessionID,
              { taskPath: policy.taskPath, taskHash: policy.taskHash },
              doctorRun,
              "post_apply",
              appliedMutationRevision,
            )
          } catch (error) {
            mechanicalDoctorError = error instanceof Error ? error.message : String(error)
            workerVerifyRequired.add(context.sessionID)
            sessionFeedback.set(context.sessionID, [
              "MECHANICAL POST-APPLY VERIFY DID NOT COMPLETE",
              mechanicalDoctorError,
              `The applied receipt ${receipt.id} remains authoritative; do not apply it again.`,
              "Call verify_worker_task exactly once as the trusted fallback before another inspection or change.",
            ].join("\n"))
            await log("warn", "Mechanical post-apply Doctor verify failed closed", {
              sessionID: context.sessionID,
              task: receipt.taskPath,
              changeID: receipt.id,
              error: mechanicalDoctorError,
            })
          }
          const metadata = {
            changeID: receipt.id,
            task: receipt.taskPath,
            paths: receipt.files.map((file) => file.path),
            mechanicalDoctor: doctorRun !== null,
            mechanicalDoctorStatus: doctorRun?.status ?? "transport_failure",
            mechanicalDoctorRunID: doctorRun?.runID,
            terminal: doctorObservation?.terminal ?? false,
            helpID: doctorObservation?.helpID ?? null,
            recoveryBoostCleared: doctorObservation?.boostCleared ?? false,
          }
          context.metadata({
            title: doctorRun
              ? `Worker change applied and verified ${receipt.id}`
              : `Worker change applied; verify fallback required ${receipt.id}`,
            metadata,
          })
          return {
            title: doctorRun
              ? `Worker change applied and verified ${receipt.id}`
              : `Worker change applied; verify fallback required ${receipt.id}`,
            output: [
              `WORKER CHANGE APPLIED ${receipt.id}`,
              `Task: ${receipt.taskPath}`,
              `Paths: ${receipt.files.map((file) => file.path).join(", ")}`,
              "The applied bytes match the preview exactly.",
              doctorRun?.output,
              doctorObservation?.boostCleared && doctorRun?.status !== "pass" && !doctorObservation?.terminal
                ? "The reviewed recovery hurdle is cleared. End this boosted response now without another tool; the Harness continues this same Worker session once with the base Worker model."
                : doctorObservation?.terminal
                ? "This Doctor result is terminal for Worker. End now with the canonical BLOCKED or HELP_REQUESTED handoff; do not call another tool."
                : doctorRun?.status === "pass"
                  ? `NEXT: return exactly:\nREVIEWABLE\nTask: ${receipt.taskPath}`
                  : doctorObservation?.findingTarget
                    ? `Mechanical Doctor verify named ${doctorObservation.findingTarget}. Read that exact file next and correct all applicable requirements there together.`
                    : doctorRun
                      ? "Mechanical Doctor verify completed. Use its exact finding for one in-scope correction; do not rerun it unchanged."
                      : [
                          `Mechanical Doctor verify could not complete: ${mechanicalDoctorError}`,
                          `Do not apply ${receipt.id} again. Call verify_worker_task exactly once as the trusted fallback.`,
                        ].join("\n"),
            ].filter(Boolean).join("\n\n"),
            metadata,
          }
          })
        },
      }),
      verify_worker_task: tool({
        description: "Run active Worker verification. Takes no arguments. Use only when Guard requests it.",
        args: {},
        async execute(_args, context) {
          _args = await checkedModelArgs("verify_worker_task", _args, context.sessionID, true, context) as typeof _args
          const agent = context.agent.toLowerCase()
          if (!modeSettings.workerAgents.has(agent)) {
            throw projectGuardError(context.sessionID,
              "Only Worker may run the trusted Worker verification tool.",
              "Executor reviews the Worker result; Planner manages task definitions.",
            )
          }
          sessionAgents.set(context.sessionID, agent)
          return await withMechanicalDoctorQueue(async () => {
            if (context.abort?.aborted) {
              throw new Error("Trusted Worker verification was aborted while waiting for the project verification queue.")
            }
            const terminalRecovery = workerHarnessRecoveryTerminals.get(context.sessionID)
            if (terminalRecovery) {
              throw new Error([
                "TASK DOCTOR: EXECUTOR RECOVERY REQUIRED",
                `Task: ${terminalRecovery.taskPath}`,
                "This Worker is terminal. Do not verify or continue; return BLOCKED for Executor.",
              ].join("\n"))
            }
            const harnessRecovery = taskHarnessRecoveryStatus(root)
            if (harnessRecovery) {
              markWorkerHarnessRecoveryTerminal(context.sessionID, {
                taskPath: harnessRecovery.taskPath,
                taskHash: harnessRecovery.taskHash,
              })
              throw new Error([
                "TASK DOCTOR: EXECUTOR RECOVERY REQUIRED",
                `Task: ${harnessRecovery.taskPath}`,
                "Harness recovery is authoritative. No verification was started; return BLOCKED for Executor.",
              ].join("\n"))
            }
            const state = activeState(root)
            if (state?.status !== "started" || typeof state.taskPath !== "string" || typeof state.taskHash !== "string") {
              throw projectGuardError(context.sessionID,
                "There is no exact active started task for trusted Worker verification.",
                state?.status === "passed"
                  ? "Return the REVIEWABLE handoff now; do not verify again."
                  : "Return the lifecycle state to Executor; do not guess a task path.",
              )
            }
            const postApplyRetry = workerVerifyRequired.has(context.sessionID)
            const preflightRetry = !workerPreflightComplete(context.sessionID, state)
            if (!postApplyRetry && !preflightRetry) {
              const findingTarget = workerFindingTargets.get(context.sessionID) ?? null
              const findingAlreadyRead = findingTarget !== null
                && workerFindingReads.get(context.sessionID) === findingTarget
              const metadata = {
                task: state.taskPath,
                mechanicalDoctorStatus: "already_current",
                mechanicalDoctorRunID: null,
                terminal: false,
                helpID: null,
                noOp: true,
              }
              context.metadata({ title: "Worker verification already current", metadata })
              return {
                title: "Worker verification already current",
                output: [
                  "TRUSTED WORKER VERIFY ALREADY CURRENT",
                  `Task: ${state.taskPath}`,
                  "No Doctor command was rerun; the current mechanical evidence already covers this task and mutation revision.",
                  findingTarget && !findingAlreadyRead
                    ? `Read ${findingTarget} next, then correct its current finding through one preview/apply transaction.`
                    : "Continue the current in-scope correction from the evidence already inspected, then use one preview/apply transaction.",
                  "Apply verifies automatically. Do not call verify_worker_task again unless an Apply result explicitly requests the trusted fallback.",
                ].join("\n"),
                metadata,
              }
            }
            const expectedMutationRevision = workerMutationRevision
            const mutableScope = scopeFromTask(root, state.taskPath).paths
            const existingMutableScope = mutableScope.filter((path) => existsSync(resolve(root, path)))
            const preflightOnly = preflightRetry && !postApplyRetry && mutableScope.length > 0
            let run: ValidatedMechanicalDoctorRun
            try {
              run = await executeMechanicalDoctorVerify(context.sessionID, {
                taskPath: state.taskPath,
                taskHash: state.taskHash,
              }, context.abort, preflightOnly)
            } catch (error) {
              workerVerifyRequired.add(context.sessionID)
              const message = error instanceof Error ? error.message : String(error)
              sessionFeedback.set(context.sessionID, [
                "TRUSTED WORKER VERIFY DID NOT COMPLETE",
                message,
                "No Doctor evidence was recorded. Do not run a Bash verify or repeat an applied receipt.",
                "Retry verify_worker_task only after the transport cause changes; otherwise request Executor help.",
              ].join("\n"))
              throw new Error(sessionFeedback.get(context.sessionID))
            }
            const observation = await observeMechanicalWorkerDoctor(
              context.sessionID,
              { taskPath: state.taskPath, taskHash: state.taskHash },
              run,
              preflightOnly ? "initial_preflight" : "post_apply",
              expectedMutationRevision,
            )
            const metadata = {
              task: state.taskPath,
              mechanicalDoctorStatus: run.status,
              mechanicalDoctorRunID: run.runID,
              terminal: observation.terminal,
              helpID: observation.helpID,
            }
            context.metadata({ title: `Worker task verified: ${run.status}`, metadata })
            return {
              title: `Worker task verified: ${run.status}`,
              output: [
                run.output,
                observation.terminal
                  ? "This Doctor result is terminal for Worker. End with the canonical BLOCKED or HELP_REQUESTED handoff now."
                  : run.status === "pass" && preflightOnly
                    ? [
                        `Task: ${state.taskPath}`,
                        "Task remains started. Do not return REVIEWABLE.",
                        existingMutableScope.length > 0
                          ? `Next: read ${existingMutableScope[0]}, then Preview/Apply.`
                          : "Next: Preview/Apply.",
                      ].join("\n")
                  : run.status === "pass"
                    ? `NEXT: return exactly:\nREVIEWABLE\nTask: ${state.taskPath}`
                    : observation.findingTarget
                      ? `Read ${observation.findingTarget} next and correct all applicable requirements there together.`
                      : "Use the exact Doctor finding for one in-scope correction; do not rerun unchanged verification.",
              ].join("\n\n"),
              metadata,
            }
          })
        },
      }),
      discard_worker_changes: tool({
        description: "Discard the latest exact pending preview owned by this Worker and the active task. Takes no arguments and never changes project files.",
        args: {},
        async execute(rawArgs, context) {
          const legacy = await checkedModelArgs("discard_worker_changes", rawArgs, context.sessionID, true, context) as Record<string, unknown>
          const agent = context.agent.toLowerCase()
          if (!modeSettings.workerAgents.has(agent)) {
            throw projectGuardError(context.sessionID,
              "Only Worker may discard its pending implementation preview.",
              "Return to the Worker session that created the preview.",
            )
          }
          sessionAgents.set(context.sessionID, agent)
          const state = activeState(root)
          const taskPath = normalize(root, typeof legacy.task_path === "string" ? legacy.task_path : state?.taskPath ?? "")
          if (state?.status !== "started" || !taskPath || taskPath !== state.taskPath || fileHash(resolve(root, taskPath)) !== state.taskHash) {
            throw projectGuardError(context.sessionID,
              "No exact active started task owns a discardable Worker preview.",
              "Resume the active task lifecycle before discarding a preview.",
            )
          }
          const policy = workerChangePolicy(context.sessionID, taskPath)
          const selected = selectLatestPendingWorkerChange(policy)
          if (!selected) {
            throw new Error("No pending Worker preview belongs to this session and active task revision.")
          }
          const paths = discardWorkerChanges(policy, selected.id)
          context.metadata({ title: `Worker change discarded ${selected.id}`, metadata: { changeID: selected.id, task: policy.taskPath, paths } })
          return {
            title: `Worker change discarded ${selected.id}`,
            output: `WORKER CHANGE DISCARDED ${selected.id}\nNo project file was changed.`,
            metadata: { changeID: selected.id, task: policy.taskPath, paths },
          }
        },
      }),
      } : {}),
      ...(features.plannerRecovery ? {
      revise_active_task: tool({
        description: "Atomically revise, lint, register, and rebind one active task as Planner. Prefer structured additions; the tool preserves canonical Markdown. Use replacement only when the whole task must change.",
        args: {
          replacement: tool.schema.string().min(100).max(100000).optional().describe("Optional complete corrected task Markdown document. Omit for ordinary scope or requirement recovery."),
          title: tool.schema.string().min(3).max(160).optional().describe("Optional corrected task title."),
          outcome: tool.schema.string().min(10).max(1000).optional().describe("Optional corrected observable outcome."),
          add_scope: tool.schema.array(tool.schema.string().min(1)).min(1).max(40).optional().describe("Exact project-relative paths to add to existing Scope."),
          add_requirements: tool.schema.array(tool.schema.string().min(3)).min(1).max(30).optional().describe("Only the requirements needed to resolve this recovery."),
          verify: tool.schema.array(tool.schema.string().min(1)).min(1).max(20).optional().describe("Optional full replacement for executable Verify commands; omit when none is mechanically available."),
        },
        async execute(rawArgs, context) {
          const args = await checkedModelArgs("revise_active_task", rawArgs, context.sessionID, true, context) as {
            task_path?: string
            replacement?: string
            title?: string
            outcome?: string
            add_scope?: string[]
            add_requirements?: string[]
            verify?: string[]
            reason?: string
          }
          const agent = context.agent.toLowerCase()
          if (!modeSettings.plannerAgents.has(agent)) {
            throw projectGuardError(context.sessionID,
              "Only Planner may revise an active task definition.",
              "Executor must call escalate_to_planner. Worker must return a Planner-owned blocker or request Executor help.",
            )
          }
          const state = activeState(root)
          const taskPath = normalize(root, args.task_path ?? state?.taskPath ?? "")
          if (!taskPath || !planningPath.test(taskPath) || state?.status !== "started" || state.taskPath !== taskPath) {
            throw projectGuardError(context.sessionID,
              `${args.task_path ?? "the active state"} is not the exact active started task.`,
              state?.status === "started"
                ? `Revise only ${state.taskPath}.`
                : "Use normal Planner editing, Doctor lint, and Doctor register for a task that has not started.",
            )
          }
          const pending = activePlannerRecoveries.get(context.sessionID)
          if (pending && pending.taskPath !== taskPath) {
            throw projectGuardError(context.sessionID,
              `The Planner recovery request owns ${pending.taskPath}, not ${taskPath}.`,
              `Revise only ${pending.taskPath} and finish that recovery request.`,
            )
          }
          const missingSupersede = pending?.contract.supersedeTasks.filter((path) => !pending.supersededTasks.has(path)) ?? []
          if (missingSupersede.length > 0) {
            throw projectGuardError(context.sessionID,
              `Planner recovery must supersede redundant tasks before revising the active task: ${missingSupersede.join(", ")}.`,
              `Call supersede_registered_task for ${missingSupersede[0]} now. After every required supersede succeeds, call revise_active_task once.`,
            )
          }
          if (!pending?.exactContract && !args.replacement && !args.title && !args.outcome && !args.add_scope?.length && !args.add_requirements?.length && !args.verify?.length) {
            throw projectGuardError(context.sessionID,
              "The active-task revision contains no semantic change.",
              "Provide only the needed structured additions or one complete replacement document.",
            )
          }
          const result = reviseActiveTask({
            taskPath,
            expectedTaskHash: state.taskHash,
            replacement: args.replacement,
            title: args.title,
            outcome: args.outcome,
            addScope: args.add_scope,
            addRequirements: args.add_requirements,
            verify: args.verify,
            reason: args.reason?.trim() || "Apply the exact active Planner recovery while preserving the Doctor lifecycle.",
            plannerSessionID: context.sessionID,
            plannerAgent: agent,
            executorSessionID: pending?.executorSessionID,
            helpID: pending?.helpID,
            recoveryContract: pending && (
              pending.contract.scope.length > 0
              || pending.contract.requirements.length > 0
              || pending.contract.verify.length > 0
            ) ? pending.contract : undefined,
            exactRecoveryContract: pending?.exactContract,
            coveredTasks: pending ? [...pending.supersededTasks] : undefined,
          })
          clearAuthoritativePlannerBlocker(taskPath)
          if (pending) pending.resolved = { taskHash: result.taskHash, output: result.output }
          context.metadata({ title: "Planner revised active task", metadata: { task: taskPath, taskHash: result.taskHash, plannerSessionID: context.sessionID } })
          return {
            title: "Planner revised active task",
            output: [
              `PLANNER TASK REVISED ${taskPath}`,
              result.output,
              `Planner owner: ${context.sessionID}`,
              "The active Doctor baseline was preserved. Stop this Planner turn so the waiting Executor can continue.",
            ].filter(Boolean).join("\n"),
            metadata: { task: taskPath, taskHash: result.taskHash, plannerSessionID: context.sessionID },
          }
        },
      }),
      supersede_registered_task: tool({
        description: "Atomically archive one unchanged, unstarted registered task that is fully covered by the active task. The tool derives the covering task from Doctor state and verifies ownership, coverage, dependencies, hashes, and rollback safety.",
        args: {
          task_path: tool.schema.string().min(1).optional().describe("Omit when the active Planner recovery names one next supersede target."),
        },
        async execute(rawArgs, context) {
          const args = await checkedModelArgs("supersede_registered_task", rawArgs, context.sessionID, true, context) as { task_path?: string; reason?: string }
          const agent = context.agent.toLowerCase()
          if (!modeSettings.plannerAgents.has(agent)) {
            throw projectGuardError(context.sessionID,
              "Only Planner may supersede a redundant registered task.",
              "Return to the Planner session that owns both the active covering task and the unstarted redundant task.",
            )
          }
          const pending = activePlannerRecoveries.get(context.sessionID)
          const nextPendingTarget = pending?.contract.supersedeTasks.find((path) => !pending.supersededTasks.has(path))
          const taskPath = normalize(root, args.task_path ?? nextPendingTarget ?? "")
          if (!taskPath || !planningPath.test(taskPath)) {
            throw projectGuardError(context.sessionID,
              `${args.task_path ?? "the active recovery"} does not identify one exact kanban/todo task path.`,
              "Pass one exact kanban/todo/<name>.md path, or resume the Planner recovery that names the next target.",
            )
          }
          if (pending?.contract.supersedeTasks.length && !pending.contract.supersedeTasks.includes(taskPath)) {
            throw projectGuardError(context.sessionID,
              `${taskPath} is not a supersede target in the active Planner recovery contract.`,
              `Supersede only: ${pending.contract.supersedeTasks.join(", ")}.`,
            )
          }
          if (pending?.supersededTasks.has(taskPath) && taskIsAlreadySuperseded(taskPath, pending.taskPath)) {
            return {
              title: "Planner supersede already complete",
              output: [
                `PLANNER TASK SUPERSEDED ${taskPath}`,
                `The durable supersede receipt already covers ${pending.taskPath}. Do not repeat it. Now call revise_active_task once with the complete recovery contract.`,
              ].join("\n"),
              metadata: { task: taskPath, coveringTask: pending.taskPath, idempotent: true },
            }
          }
          const result = supersedeRegisteredTask({
            taskPath,
            reason: args.reason?.trim() || "The active Planner recovery contract marks this registered task as redundant.",
            plannerSessionID: context.sessionID,
            plannerAgent: agent,
          })
          if (pending) pending.supersededTasks.add(taskPath)
          const remaining = pending?.contract.supersedeTasks.filter((path) => !pending.supersededTasks.has(path)) ?? []
          try {
            context.metadata({ title: "Planner superseded registered task", metadata: {
              task: taskPath,
              archivePath: result.archivePath,
              coveringTask: result.activeTaskPath,
              plannerSessionID: context.sessionID,
            } })
          } catch {
            // Metadata is advisory; the already-validated filesystem transaction remains authoritative.
          }
          return {
            title: "Planner superseded registered task",
            output: [
              `PLANNER TASK SUPERSEDED ${taskPath}`,
              `Archived as: ${result.archivePath}`,
              `Covered by active task: ${result.activeTaskPath}`,
              pending
                ? remaining.length > 0
                  ? `Doctor state and registration were updated atomically. Continue with supersede_registered_task for ${remaining[0]}.`
                  : "Doctor state and registration were updated atomically. Now call revise_active_task once with the complete recovery contract."
                : "Doctor state and registration were updated atomically. Stop this Planner turn so Executor can continue the active task.",
            ].join("\n"),
            metadata: {
              task: taskPath,
              archivePath: result.archivePath,
              coveringTask: result.activeTaskPath,
              plannerSessionID: context.sessionID,
            },
          }
        },
      }),
      escalate_to_planner: tool({
        description: "Resume the exact Planner session that owns a task and request a task-definition correction before or after task start. When a pending frozen Planner-review receipt exists, pass only task_path; the Harness restores and ignores every other field. A first explicit review needs the full evidence and exact contract.",
        args: {
          task_path: tool.schema.string().min(1).describe("The exact owned kanban/todo task path reported by Doctor or Worker."),
          problem: tool.schema.string().min(20).max(1200).optional().describe("Required only for a first recovery: the task-definition blocker that requires Planner ownership."),
          evidence: tool.schema.array(tool.schema.string().min(10).max(700)).min(1).max(8).optional().describe("Required only for a first recovery: exact Doctor, Guard, or Worker evidence."),
          expected_results: tool.schema.array(tool.schema.string().min(10).max(400)).min(1).max(8).optional().describe("Required only for a first recovery: observable properties of a corrected task definition."),
          relevant_files: tool.schema.array(tool.schema.string().min(1)).min(1).max(20).optional().describe("Required only for a first recovery: the task and existing application files the Planner should inspect."),
          required_scope: tool.schema.array(tool.schema.string().min(1)).min(1).max(40).optional().describe("Exact final Scope entries required by recovery. Prefix intended new files with NEW:."),
          required_requirements: tool.schema.array(tool.schema.string().min(3)).min(1).max(30).optional().describe("Exact requirements the corrected task must contain."),
          required_verify: tool.schema.array(tool.schema.string().min(1)).min(1).max(20).optional().describe("Exact executable Verify commands when mechanically available; otherwise omit."),
          supersede_tasks: tool.schema.array(tool.schema.string().min(1)).min(1).max(20).optional().describe("Existing redundant kanban/todo tasks the Planner must supersede before revision."),
          contract_mode: tool.schema.enum(["merge", "replace"]).optional().describe("Use replace only when required_* is the complete final content of Scope, Requirements, and Verify and old duplicates or obsolete entries must be removed."),
        },
        async execute(args, context) {
          args = await checkedModelArgs("escalate_to_planner", args, context.sessionID, true, context) as typeof args
          const agent = context.agent.toLowerCase()
          if (!modeSettings.executorAgents.has(agent)) {
            throw projectGuardError(context.sessionID,
              "Only Executor may return a task to its owning Planner session.",
              "Return the Planner-owned blocker to Executor. Do not start a replacement Planner automatically.",
            )
          }
          const harnessRecovery = features.executorBaselineRecovery ? taskHarnessRecoveryStatus(root) : null
          if (harnessRecovery) {
            throw projectGuardError(context.sessionID,
              `Harness baseline drift is Executor-owned for ${harnessRecovery.taskPath}.`,
              `Inspect ${harnessRecovery.paths.map((entry) => entry.path).join(", ")}, then call recover_harness_baseline. Do not escalate infrastructure drift to Planner.`,
            )
          }
          const taskPath = normalize(root, args.task_path)
          const state = activeState(root)
          const activeRecovery = Boolean(taskPath && state?.status === "started" && state.taskPath === taskPath)
          const prestartRecovery = Boolean(
            taskPath
            && planningPath.test(taskPath)
            && existsSync(resolve(root, taskPath))
            && state?.status !== "started"
            && state?.status !== "passed",
          )
          if (!taskPath || !planningPath.test(taskPath) || (!activeRecovery && !prestartRecovery)) {
            throw projectGuardError(context.sessionID,
              `${args.task_path} is neither the exact active started task nor an existing pre-start Kanban task.`,
              state?.status === "started"
                ? `Escalate only ${state.taskPath}.`
                : state?.status === "passed"
                  ? `Review ${state.taskPath}; do not revise a Doctor-passed task through Planner escalation.`
                  : "Use the exact existing kanban/todo task path named by the Doctor or Worker blocker.",
            )
          }
          const lifecycle = activeRecovery ? "active" : "prestart"
          const escalationTaskHash = activeRecovery ? String(state?.taskHash ?? "") : fileHash(resolve(root, taskPath))
          const authoritativeBlocker = readJson(authoritativePlannerBlockerPath)
          const savedFailure = readJson(lastDoctorFailurePath)
          const pendingHelp = activeRecovery ? pendingWorkerHelp(taskPath, escalationTaskHash) : null
          let userRequest: ExplicitPlannerRecoveryRequest | null = null
          if (activeRecovery && typeof (client as any)?.session?.messages === "function") {
            try {
              userRequest = explicitUserPlannerRecoveryRequest(await loadSessionMessages(context.sessionID), taskPath)
            } catch {
              userRequest = null
            }
          }
          const previousReceipt = explicitPlannerReviewReceipt()
          const pendingExplicitReview = Boolean(
            activeRecovery
            && previousReceipt?.status === "pending"
            && previousReceipt.executorSessionID === context.sessionID
            && previousReceipt.taskPath === taskPath,
          )
          const activePlannerOwned = activeRecovery
            && authoritativeBlocker?.version === 1
            && authoritativeBlocker.owner === "Planner"
            && authoritativeBlocker.taskPath === taskPath
            && authoritativeBlocker.taskHash === escalationTaskHash
          const prestartDoctorOwned = prestartRecovery
            && savedFailure?.taskPath === taskPath
            && (
              ["lint", "register"].includes(String(savedFailure?.gate ?? ""))
              || (savedFailure?.gate === "start" && /PRESTART_CHANGE|TASK_CHANGED_AFTER_REGISTRATION|REGISTRATION_/i.test(String(savedFailure?.output ?? "")))
            )
          if (!activePlannerOwned && !prestartDoctorOwned && !userRequest && !pendingExplicitReview) {
            throw projectGuardError(context.sessionID,
              `The authoritative blocker for ${taskPath} is not Planner-owned.`,
              pendingHelp
                ? `Do not call escalate_to_planner. Call review_worker_help for ${pendingHelp.id}, inspect its task and relevant application files, then follow that tool's reviewed retry or Planner-recovery result.`
                : activeRecovery
                ? `Do not call escalate_to_planner. Delegate one fresh Worker to resume ${taskPath} from Doctor verify. Do not schedule, lint, or start it again.`
                : "Do not run Doctor lint as Executor. Follow the current schedule or canonical recovery action. Escalate only after a recorded Worker planning or pre-start failure explicitly requires task-definition correction.",
            )
          }
          if (userRequest
            && previousReceipt?.status === "complete"
            && previousReceipt.executorSessionID === context.sessionID
            && (
              previousReceipt.userMessageID === userRequest.messageID
              || previousReceipt.completedForMessageID === userRequest.messageID
              || plannerRecoveryContinuation(userRequest)
            )
            && previousReceipt.taskPath === taskPath
            && previousReceipt.taskHash === escalationTaskHash) {
            if (previousReceipt.completedForMessageID !== userRequest.messageID) {
              writeExplicitPlannerReviewReceipt({
                ...previousReceipt,
                completedForMessageID: userRequest.messageID,
              })
            }
            executorPlannerRecoveryRequested.delete(context.sessionID)
            return {
              title: "Owning Planner review already complete",
              output: [
                `PLANNER RECOVERY COMPLETE ${taskPath}`,
                "The hash-bound Planner review receipt already matches this user request and active task. Delegate one fresh Worker now; do not repeat Planner recovery.",
              ].join("\n"),
              metadata: { task: taskPath, taskHash: escalationTaskHash, idempotent: true },
            }
          }
          const submittedProblem = args.problem ?? ""
          const submittedEvidence = args.evidence ?? []
          const submittedExpectedResults = args.expected_results ?? []
          const submittedRelevantFiles = args.relevant_files ?? []
          const frozenContract = pendingExplicitReview ? previousReceipt?.contract ?? null : null
          const useFrozenReceipt = Boolean(
            frozenContract
            && previousReceipt?.problem
            && previousReceipt.evidence
            && previousReceipt.expectedResults
            && previousReceipt.relevantFiles,
          )
          if (!useFrozenReceipt) {
            const missingContext = [
              submittedProblem ? "" : "problem",
              submittedEvidence.length > 0 ? "" : "evidence",
              submittedExpectedResults.length > 0 ? "" : "expected_results",
              submittedRelevantFiles.length > 0 ? "" : "relevant_files",
            ].filter(Boolean)
            if (missingContext.length > 0) {
              throw projectGuardError(context.sessionID,
                `Planner recovery is missing its initial evidence context: ${missingContext.join(", ")}.`,
                "For a first recovery, provide problem, evidence, expected_results, and relevant_files. For a pending recovery, pass only task_path; the complete frozen receipt is restored mechanically.",
              )
            }
          }
          const contractHasItems = (value: PlannerRecoveryContract) => value.scope.length > 0
            || value.requirements.length > 0
            || value.verify.length > 0
            || value.supersedeTasks.length > 0
          const contract: PlannerRecoveryContract = frozenContract ? canonicalPlannerRecoveryContract({
            ...frozenContract,
            verify: portablePlannerVerifyCommands(context.sessionID, frozenContract.verify),
          }) : plannerRecoveryContractFromArgs(context.sessionID, taskPath, args)
          const receiptContractMode = pendingExplicitReview ? previousReceipt?.contractMode : undefined
          const completeContractSupplied = contract.scope.length > 0
            && contract.requirements.length > 0
          const inferredContractMode = !receiptContractMode
            && !args.contract_mode
            && completeContractSupplied
            && /\b(?:complete|full|exact)\s+(?:final\s+)?replace(?:ment)?\s+contract\b|\bcontract_mode\s*[:=]?\s*replace\b/i.test(userRequest?.text ?? "")
            ? "replace"
            : undefined
          const contractMode = receiptContractMode ?? args.contract_mode ?? inferredContractMode ?? "merge"
          if (lifecycle === "prestart" && contractHasItems(contract)) {
            throw projectGuardError(context.sessionID,
              "Structured Planner recovery contracts are supported only for the exact active started task.",
              "For a pre-start Doctor-owned failure, omit required_* and supersede_tasks. The owning Planner must edit, lint, and register the queued task through the normal pre-start recovery path.",
            )
          }
          const explicitReviewIdentity = pendingExplicitReview && previousReceipt ? {
            messageID: previousReceipt.userMessageID,
            requestHash: previousReceipt.userRequestHash,
          } : userRequest ? {
            messageID: userRequest.messageID,
            requestHash: hash(userRequest.text),
          } : null
          if (explicitReviewIdentity) {
            const missing: string[] = [
              !args.contract_mode && !receiptContractMode && !inferredContractMode ? "contract_mode" : "",
              contract.scope.length === 0 ? "required_scope" : "",
              contract.requirements.length === 0 ? "required_requirements" : "",
            ].filter(Boolean)
            if (missing.length > 0) {
              throw projectGuardError(context.sessionID,
                `Explicit user-requested Planner recovery is missing its mechanical acceptance contract: ${missing.join(", ")}.`,
                "Call escalate_to_planner again with contract_mode merge for partial additions or replace for complete final sections, plus exact final Scope and Requirements. Include Verify commands only when they are mechanically available. Put intended new files in required_scope with NEW:.",
              )
            }
          }
          const existingContractFiles = contract.scope
            .filter((entry) => !/^NEW:\s*/i.test(entry))
            .map((entry) => entry.replace(/^NEW:\s*/i, ""))
          const relevantFiles: string[] = useFrozenReceipt && previousReceipt?.relevantFiles
            ? previousReceipt.relevantFiles
            : canonicalPlannerRecoveryFiles(context.sessionID, taskPath, [
                ...submittedRelevantFiles,
                ...existingContractFiles,
              ])
          const recoveryProblem = useFrozenReceipt && previousReceipt?.problem
            ? previousReceipt.problem
            : submittedProblem.replace(/\s+/g, " ").trim()
          const recoveryEvidence = useFrozenReceipt && previousReceipt?.evidence
            ? previousReceipt.evidence
            : submittedEvidence.map((item) => item.replace(/\s+/g, " ").trim())
          const recoveryExpectedResults = useFrozenReceipt && previousReceipt?.expectedResults
            ? previousReceipt.expectedResults
            : submittedExpectedResults.map((item) => item.replace(/\s+/g, " ").trim())
          const protectedFile = relevantFiles.find((path) => isProtected(path, protectedPaths))
          if (protectedFile) {
            throw projectGuardError(context.sessionID,
              `${protectedFile} is an internal workflow file and cannot be Planner recovery evidence.`,
              "Name only the task and relevant application files. Include observed Doctor or Guard output as textual evidence.",
            )
          }
          if (pendingExplicitReview
            && previousReceipt
            && (
              previousReceipt.initialTaskHash !== escalationTaskHash
              || Boolean(userRequest && plannerRecoveryContinuation(userRequest))
            )) {
            const currentContent = readFileSync(resolve(root, taskPath), "utf8")
            const contractGaps = contractMode === "replace"
              ? plannerRecoveryContractExactGaps(currentContent, contract)
              : plannerRecoveryContractGaps(currentContent, contract)
            const registration = readJson(resolve(root, ".task-doctor/registrations", `${basename(taskPath)}.json`))
            const ownership = readPlannerOwnership(root, taskPath)
            const supersedeComplete = contract.supersedeTasks.every((target) => taskIsAlreadySuperseded(target, taskPath))
            if (contractGaps.length === 0
              && registration?.status === "registered"
              && registration.taskHash === escalationTaskHash
              && ownership?.source === "active_revision"
              && ownership.taskHash === escalationTaskHash
              && supersedeComplete) {
              clearPlannerRecoveryState(taskPath)
              clearAuthoritativePlannerBlocker(taskPath)
              terminalExecutorReasons.delete(context.sessionID)
              writeExplicitPlannerReviewReceipt({
                version: 1,
                status: "complete",
                executorSessionID: previousReceipt.executorSessionID,
                userMessageID: previousReceipt.userMessageID,
                userRequestHash: previousReceipt.userRequestHash,
                taskPath,
                initialTaskHash: previousReceipt.initialTaskHash,
                taskHash: escalationTaskHash,
                contractMode,
                completedForMessageID: userRequest?.messageID ?? previousReceipt.userMessageID,
                requestedAt: previousReceipt.requestedAt,
                contract,
                relevantFiles: previousReceipt.relevantFiles,
                problem: previousReceipt.problem,
                evidence: previousReceipt.evidence,
                expectedResults: previousReceipt.expectedResults,
                automaticContinuationAttempts: previousReceipt.automaticContinuationAttempts,
                automaticContinuationAt: previousReceipt.automaticContinuationAt,
                completedAt: new Date().toISOString(),
              })
              executorPlannerRecoveryRequested.delete(context.sessionID)
              context.metadata({ title: "Owning Planner recovery already committed", metadata: { task: taskPath, taskHash: escalationTaskHash, plannerSessionID: ownership.plannerSessionID, idempotent: true } })
              return {
                title: "Owning Planner recovery already committed",
                output: [
                  `PLANNER RECOVERY COMPLETE ${taskPath}`,
                  `Planner session: ${ownership.plannerSessionID}`,
                  "The registered active_revision already matches the frozen recovery contract exactly. The pending receipt was completed without another Planner request.",
                  "Delegate one fresh Worker to resume this active task. Do not lint, register, or start it again.",
                ].join("\n"),
                metadata: { task: taskPath, taskHash: escalationTaskHash, plannerSessionID: ownership.plannerSessionID, idempotent: true },
              }
            }
          }
          if (explicitReviewIdentity) {
            writeExplicitPlannerReviewReceipt({
              version: 1,
              status: "pending",
              executorSessionID: context.sessionID,
              userMessageID: explicitReviewIdentity.messageID,
              userRequestHash: explicitReviewIdentity.requestHash,
              taskPath,
              initialTaskHash: escalationTaskHash,
              taskHash: escalationTaskHash,
              contractMode,
              requestedAt: previousReceipt?.requestedAt ?? new Date().toISOString(),
              contract,
              relevantFiles,
              problem: recoveryProblem,
              evidence: recoveryEvidence,
              expectedResults: recoveryExpectedResults,
              automaticContinuationAttempts: previousReceipt?.automaticContinuationAttempts ?? 0,
              automaticContinuationAt: previousReceipt?.automaticContinuationAt,
            })
          }
          const recovery = await recoverWithOwningPlanner({
            executorSessionID: context.sessionID,
            taskPath,
            lifecycle,
            userRequest: userRequest?.text,
            contract,
            exactContract: contractMode === "replace",
            problem: recoveryProblem,
            evidence: recoveryEvidence,
            expectedResults: recoveryExpectedResults,
            relevantFiles,
          })
          if (recovery.status !== "recovered") {
            const heading = recovery.status === "unavailable" ? "PLANNER UNAVAILABLE" : "PLANNER RECOVERY INCOMPLETE"
            const nextAction = recovery.status === "unavailable"
              ? "Stop now. Tell the user that the owning Planner is unavailable and the user must open a Planner and correct the task manually. Do not delegate another Worker or choose a different Planner session."
              : explicitReviewIdentity
                ? `Stop now. Tell the user to re-prompt this same Executor session. On the next turn, call escalate_to_planner with only task_path=${taskPath}; the pending receipt restores every other field. Do not delegate Worker or ask the user to continue Planner manually.`
                : "Stop now. Tell the user that the owning Planner did not finish recovery and the user must continue that Planner session manually. Do not delegate another Worker or choose a different Planner session."
            const message = [
              heading,
              `Task: ${taskPath}`,
              `Planner session: ${recovery.plannerSessionID ?? "none"}`,
              `Reason: ${recovery.reason}`,
              nextAction,
            ].join("\n")
            const latestState = activeState(root)
            const latestTaskHash = latestState?.taskPath === taskPath && typeof latestState.taskHash === "string"
              ? latestState.taskHash
              : escalationTaskHash
            if (recovery.status === "unavailable" && explicitReviewIdentity) {
              rmSync(explicitPlannerReviewPath, { force: true })
            } else if (explicitReviewIdentity) {
              writeExplicitPlannerReviewReceipt({
                version: 1,
                status: "pending",
                executorSessionID: context.sessionID,
                userMessageID: explicitReviewIdentity.messageID,
                userRequestHash: explicitReviewIdentity.requestHash,
                taskPath,
                initialTaskHash: escalationTaskHash,
                taskHash: latestTaskHash,
                contractMode,
                requestedAt: previousReceipt?.requestedAt ?? new Date().toISOString(),
                contract,
                relevantFiles,
                problem: recoveryProblem,
                evidence: recoveryEvidence,
                expectedResults: recoveryExpectedResults,
                automaticContinuationAttempts: previousReceipt?.automaticContinuationAttempts ?? 0,
                automaticContinuationAt: previousReceipt?.automaticContinuationAt,
                lastError: recovery.reason,
              })
            }
            writePlannerRecoveryState({
              status: recovery.status === "unavailable" ? "unavailable" : "incomplete",
              taskPath,
              taskHash: latestTaskHash,
              plannerSessionID: recovery.plannerSessionID,
              executorSessionID: context.sessionID,
              reason: recovery.reason,
            })
            terminalExecutorReasons.set(context.sessionID, message)
            context.metadata({ title: heading, metadata: { task: taskPath, plannerSessionID: recovery.plannerSessionID, terminal: true } })
            return { title: heading, output: message, metadata: { task: taskPath, plannerSessionID: recovery.plannerSessionID, terminal: true } }
          }
          clearPlannerRecoveryState(taskPath)
          clearAuthoritativePlannerBlocker(taskPath)
          terminalExecutorReasons.delete(context.sessionID)
          executorPlannerRecoveryRequested.delete(context.sessionID)
          if (explicitReviewIdentity) {
            writeExplicitPlannerReviewReceipt({
              version: 1,
              status: "complete",
              executorSessionID: context.sessionID,
              userMessageID: explicitReviewIdentity.messageID,
              userRequestHash: explicitReviewIdentity.requestHash,
              taskPath,
              initialTaskHash: escalationTaskHash,
              taskHash: recovery.taskHash,
              contractMode,
              completedForMessageID: userRequest?.messageID ?? explicitReviewIdentity.messageID,
              requestedAt: previousReceipt?.requestedAt ?? new Date().toISOString(),
              contract,
              relevantFiles,
              problem: recoveryProblem,
              evidence: recoveryEvidence,
              expectedResults: recoveryExpectedResults,
              automaticContinuationAttempts: previousReceipt?.automaticContinuationAttempts ?? 0,
              automaticContinuationAt: previousReceipt?.automaticContinuationAt,
              completedAt: new Date().toISOString(),
            })
          }
          context.metadata({ title: "Owning Planner recovered task", metadata: { task: taskPath, plannerSessionID: recovery.plannerSessionID, taskHash: recovery.taskHash } })
          return {
            title: "Owning Planner recovered task",
            output: [
              `PLANNER RECOVERY COMPLETE ${taskPath}`,
              `Planner session: ${recovery.plannerSessionID}`,
              recovery.output,
              lifecycle === "active"
                ? "Delegate one fresh Worker to resume this active task. Do not lint, register, or start it again."
                : "Run npm run task:doctor:schedule again and follow its READY result. Do not delegate a Worker until Doctor reports READY.",
            ].filter(Boolean).join("\n"),
            metadata: { task: taskPath, plannerSessionID: recovery.plannerSessionID, taskHash: recovery.taskHash },
          }
        },
      }),
      } : {}),
      ...(features.executorBaselineRecovery ? {
      recover_harness_baseline: tool({
        description: "Authorize the exact pending Harness hash transition. Task, paths, and hashes are derived from Doctor state; no model judgment is accepted.",
        args: {},
        async execute(args, context) {
          args = await checkedModelArgs("recover_harness_baseline", args, context.sessionID, true, context) as typeof args
          const agent = context.agent.toLowerCase()
          if (!modeSettings.executorAgents.has(agent)) {
            throw projectGuardError(context.sessionID,
              "Only Executor may recover the Harness baseline.",
              "Worker must return BLOCKED with Required owner: Executor. Planner must not revise the task for infrastructure drift.",
            )
          }
          const pendingRecovery = taskHarnessRecoveryStatus(root)
          if (!pendingRecovery) {
            const state = activeState(root)
            const pendingHelp = state?.status === "started"
              ? pendingWorkerHelp(state.taskPath, state.taskHash)
              : null
            const nextAction = state?.status === "started" && typeof state.taskPath === "string"
              ? pendingHelp
                ? `Review ${pendingHelp.id} with review_worker_help before delegating. Do not call recover_harness_baseline again unless a new Worker Doctor result explicitly reports HARNESS_BASELINE_DRIFT.`
                : `Delegate one fresh Worker to resume ${state.taskPath}. Do not call recover_harness_baseline again unless a new Worker Doctor result explicitly reports HARNESS_BASELINE_DRIFT.`
              : "Follow the authoritative live workflow state. Do not call recover_harness_baseline again unless Doctor explicitly reports a new HARNESS_BASELINE_DRIFT."
            throw new Error([
              "HARNESS RECOVERY NOT PENDING",
              "The previous Harness recovery is already resolved or no recovery has been reported.",
              `Do next: ${nextAction}`,
            ].join("\n"))
          }
          const savedFailure = readJson(lastDoctorFailurePath)
          const recoveryWorkerSessionIDs = new Set<string>()
          for (const [workerSessionID, read] of workerTaskReads) {
            if (read.taskPath === pendingRecovery.taskPath && read.taskHash === pendingRecovery.taskHash) {
              recoveryWorkerSessionIDs.add(workerSessionID)
            }
          }
          if (typeof savedFailure?.sessionID === "string"
            && savedFailure.taskPath === pendingRecovery.taskPath
            && savedFailure.taskHash === pendingRecovery.taskHash
            && /TASK DOCTOR:\s+EXECUTOR RECOVERY REQUIRED|HARNESS_BASELINE_DRIFT/i.test(String(savedFailure.output ?? ""))) {
            recoveryWorkerSessionIDs.add(savedFailure.sessionID)
          }
          for (const workerSessionID of recoveryWorkerSessionIDs) {
            markWorkerHarnessRecoveryTerminal(workerSessionID, {
              taskPath: pendingRecovery.taskPath,
              taskHash: pendingRecovery.taskHash,
            }, typeof savedFailure?.runID === "string" && savedFailure.sessionID === workerSessionID
              ? savedFailure.runID
              : undefined)
          }
          const result = recoverTaskHarness(root, {
            taskPath: pendingRecovery.taskPath,
            paths: pendingRecovery.paths.map((entry) => entry.path),
            reason: "Authorize the exact hash-bound Harness transition already reported by Doctor.",
            executorSessionID: context.sessionID,
          })
          const recoveredState = activeState(root)
          const helpStore = reconcileWorkerHelpLifecycle(recoveredState)
          const reviewIndex = helpStore.requests.findLastIndex((request) => (
            request.taskPath === result.taskPath
            && request.taskHash === recoveredState?.taskHash
            && request.status === "retry_approved"
            && !request.delegatedWorkerSessionID
          ))
          const reReviewHelpID = reviewIndex >= 0 ? helpStore.requests[reviewIndex].id : null
          if (reviewIndex >= 0) {
            const request = helpStore.requests[reviewIndex]
            helpStore.requests[reviewIndex] = {
              ...request,
              status: "pending",
              executorReview: undefined,
              delegatedAt: undefined,
              delegatedWorkerSessionID: undefined,
            }
            writeWorkerHelpStore(helpStore)
            workerHelpTerminalSessions.add(request.workerSessionID)
          }
          const pendingHelp = reReviewHelpID
            ? null
            : pendingWorkerHelp(result.taskPath, activeState(root)?.taskHash)
          if (savedFailure?.taskPath === result.taskPath
            && /HARNESS_BASELINE_DRIFT/i.test(String(savedFailure.output ?? ""))) {
            rmSync(lastDoctorFailurePath, { force: true })
          }
          sessionFeedback.delete(context.sessionID)
          terminalExecutorReasons.delete(context.sessionID)
          context.metadata({ title: `Harness baseline recovered ${result.recoveryID}`, metadata: result })
          return {
            title: `Harness baseline recovered ${result.recoveryID}`,
            output: [
              `EXECUTOR RECOVERY COMPLETE ${result.taskPath}`,
              `Recovery: ${result.recoveryID}`,
              `Authorized Harness paths: ${result.paths.join(", ")}`,
              reReviewHelpID
                ? `Re-review ${reReviewHelpID} with review_worker_help under the recovered Harness before delegating. If the tool requests evidence, read it and call the tool again.`
                : pendingHelp
                  ? `Review ${pendingHelp.id} with review_worker_help under the recovered Harness before delegating. If the tool requests evidence, read it and call the tool again.`
                  : "Follow the authoritative live workflow state now. Review any pending Worker help before delegating; otherwise delegate one fresh Worker to resume the active task.",
              "Do not inspect Worker rule files, lint, register, start, schedule, or include replacement code.",
            ].join("\n"),
            metadata: { ...result, reReviewHelpID, pendingHelpID: pendingHelp?.id ?? null },
          }
        },
      }),
      } : {}),
      recover_project_memory: tool({
        description: "Resolve project-wide MEMORY.md overflow as Executor. Supply only the complete condensed replacement; the Harness derives the recovery reason and records the hash transition.",
        args: {
          replacement: tool.schema.string().min(1).max(100000).describe("The complete replacement content for MEMORY.md, already condensed below settings.maxMemorySize."),
        },
        async execute(args, context) {
          args = await checkedModelArgs("recover_project_memory", args, context.sessionID, true, context) as typeof args
          const agent = context.agent.toLowerCase()
          if (!modeSettings.executorAgents.has(agent)) {
            throw projectGuardError(context.sessionID,
              "Only Executor may recover project memory.",
              "Return EXECUTOR_RECOVERY_REQUIRED to Executor. Worker must not edit MEMORY.md unless the active task explicitly owns it.",
            )
          }
          const recovery = projectMemoryRecoveryStatus(root)
          if (!recovery) {
            throw projectGuardError(context.sessionID,
              "Project memory does not require recovery.",
              "Run task:doctor:schedule and follow its current state instead of rewriting MEMORY.md.",
            )
          }
          const result = recoverProjectMemory(root, {
            replacement: args.replacement,
            reason: "Condensed project memory to the configured technical size limit while preserving the supplied replacement exactly.",
            executorSessionID: context.sessionID,
          })
          context.metadata({ title: `Project memory recovered ${result.recoveryID}`, metadata: result })
          return {
            title: `Project memory recovered ${result.recoveryID}`,
            output: [
              `${result.recoveryID} reduced MEMORY.md from ${result.beforeSize} to ${result.afterSize} bytes (limit ${result.maxSize}).`,
              "The hash transition is authorized for the active task. Run npm run task:doctor:schedule again, then resume the authoritative Executor action.",
            ].join("\n"),
            metadata: result,
          }
        },
      }),
      ...(features.taskMemoryAppend ? {
      append_task_memory: tool({
        description: "Append one durable task-owned fact to MEMORY.md without rewriting history. Worker supplies only the fact; the trusted tool restores the active Doctor baseline, adds the current timestamp, and writes one idempotent append block.",
        args: {
          entry: tool.schema.string().min(1).max(1500).describe("One durable project fact without a timestamp or bullet prefix."),
        },
        async execute(rawArgs, context) {
          const args = await checkedModelArgs("append_task_memory", rawArgs, context.sessionID, true, context) as { task_path?: string; entry: string }
          const agent = context.agent.toLowerCase()
          if (!modeSettings.workerAgents.has(agent)) {
            throw projectGuardError(context.sessionID,
              "Only Worker may append task-owned memory.",
              "Planner may author task memory requirements. Executor may recover over-limit project memory. Delegate the active task to Worker for its declared append.",
            )
          }
          const state = activeState(root)
          const taskPath = normalize(root, args.task_path ?? state?.taskPath ?? "")
          if (state?.status !== "started" || !taskPath || !planningPath.test(taskPath) || taskPath !== state.taskPath) {
            throw projectGuardError(context.sessionID,
              `${args.task_path ?? "the active state"} is not the exact active started task.`,
              "Resume the exact active task and call append_task_memory with only the durable fact.",
            )
          }
          const result = appendTaskMemory(root, {
            taskPath,
            entry: args.entry,
            workerSessionID: context.sessionID,
          })
          context.metadata({ title: result.changed ? "Task memory appended" : "Task memory already appended", metadata: result })
          const nextStep = result.verified
            ? "Task memory was already included in the successful Doctor verification. Return the REVIEWABLE handoff now; do not call this tool or verify again."
            : "Continue with the already inspected Worker preview and call apply_worker_changes. Apply verifies the memory append and project change together; do not run Doctor through Bash or edit MEMORY.md again."
          return {
            title: result.changed ? "Task memory appended" : "Task memory already appended",
            output: [
              `${result.verified ? "TASK MEMORY ALREADY VERIFIED" : "TASK MEMORY APPENDED"} ${result.taskPath}`,
              result.line,
              result.restoredBaseline ? "The original Doctor memory baseline was restored before appending." : "Existing memory history was preserved byte-for-byte.",
              nextStep,
            ].join("\n"),
            metadata: result,
          }
        },
      }),
      } : {}),
      ...(features.workerHelp ? {
      request_executor_help: tool({
        description: "End the current Worker run with a state-derived technical help receipt. Usually call with no arguments; add only a short note when persisted failure evidence is insufficient.",
        args: {
          note: tool.schema.string().optional().describe("Optional short technical context not already present in the stored failure."),
        },
        async execute(rawArgs, context) {
          const supplied: any = await checkedModelArgs("request_executor_help", rawArgs, context.sessionID, true, context)
          const agent = context.agent.toLowerCase()
          if (!modeSettings.workerAgents.has(agent)) {
            throw projectGuardError(context.sessionID,
              "Only Worker may end a run with an Executor help request.",
              "Return to the owning role. Executor reviews help; Planner only writes normal tasks.",
            )
          }

          const state = activeState(root)
          const taskPath = normalize(root, supplied.task_path ?? state?.taskPath ?? "")
          if (state?.status !== "started" || !taskPath || taskPath !== state.taskPath) {
            throw projectGuardError(context.sessionID,
              `${supplied.task_path ?? "the active state"} is not the exact active started task.`,
              state?.status === "started"
                ? `Use ${state.taskPath} in request_executor_help.`
                : "Do not create a help request without an active Worker task. Return a normal BLOCKED handoff.",
            )
          }
          if (!existsSync(resolve(root, taskPath)) || fileHash(resolve(root, taskPath)) !== state.taskHash) {
            throw projectGuardError(context.sessionID,
              "The active task content no longer matches Doctor state.",
              "Request help only for the unchanged active task. Stop and report the invalid lifecycle state.",
            )
          }

          const requiredFailure = workerHelpRequired.get(context.sessionID)
          const savedFailure = readJson(lastDoctorFailurePath)
          const savedFingerprint = savedFailure?.sessionID === context.sessionID
            && savedFailure?.taskPath === taskPath
            && savedFailure?.taskHash === state.taskHash
            ? doctorFailureFingerprint(String(savedFailure.gate ?? "verify"), taskPath, String(savedFailure.output ?? ""))
            : null
          const fingerprint = requiredFailure?.fingerprint ?? savedFingerprint
          const note = typeof supplied.note === "string" ? supplied.note.replace(/\s+/g, " ").trim() : ""
          const inferredCategory = fingerprint
            ? fingerprint.tool.startsWith("task:doctor:") ? "test_failure"
              : (requiredFailure?.count ?? 0) > 1 ? "model_loop"
                : "tool_failure"
            : "unknown"
          const inferredTarget = fingerprint?.target ? normalize(root, fingerprint.target) : null
          const args: {
            task_path: string
            category: string
            problem: string
            attempted_actions: string[]
            evidence: string[]
            relevant_files: string[]
            suggested_next_step: string
          } = {
            task_path: taskPath,
            category: supplied.category ?? inferredCategory,
            problem: supplied.problem ?? fingerprint?.problem ?? (note || "Worker requested Executor review of the current technical workflow state."),
            attempted_actions: Array.isArray(supplied.attempted_actions) && supplied.attempted_actions.length > 0
              ? supplied.attempted_actions
              : ["Reached the persisted Worker failure or help boundary for this task revision."],
            evidence: Array.isArray(supplied.evidence) && supplied.evidence.length > 0
              ? supplied.evidence
              : [fingerprint?.evidence ?? fingerprint?.problem ?? (note || "No additional model-authored evidence; use the exact persisted task and failure state.")],
            relevant_files: Array.isArray(supplied.relevant_files) && supplied.relevant_files.length > 0
              ? supplied.relevant_files
              : inferredTarget ? [inferredTarget] : [],
            suggested_next_step: supplied.suggested_next_step
              ?? "Executor should inspect the persisted technical evidence and choose a fresh Worker retry or owning Planner recovery.",
          }

          const normalizedFiles = [...new Set([taskPath, ...args.relevant_files.map((path) => normalize(root, path))])]
          if (normalizedFiles.some((path) => path === null)) {
            throw projectGuardError(context.sessionID,
              "The help request names a file outside the project.",
              "List only exact project-relative task or application files.",
            )
          }
          const relevantFiles = (normalizedFiles as string[]).filter((path) => !isProtected(path, protectedPaths))

          const store = workerHelpStore(root)
          const retryParent = [...store.requests].reverse().find((entry) => (
            entry.status === "delegated"
            && entry.delegatedWorkerSessionID === context.sessionID
            && entry.taskPath === taskPath
            && entry.taskHash === state.taskHash
            && entry.executorReview?.decision === "retry_worker"
          ))

          const existing = workerHelpForSession(context.sessionID, taskPath, state.taskHash)
          if (existing) {
            const linked = retryParent && !existing.retryOfHelpID
              ? updateWorkerHelp(existing.id, (entry) => ({ ...entry, retryOfHelpID: retryParent.id }))!
              : existing
            const enriched = linked.status === "pending" && linked.category === "repeated-doctor-failure"
              ? updateWorkerHelp(linked.id, (entry) => ({
                  ...entry,
                  category: args.category,
                  problem: args.problem.replace(/\s+/g, " ").trim(),
                  attemptedActions: [...new Set([...entry.attemptedActions, ...args.attempted_actions.map((item) => item.replace(/\s+/g, " ").trim())])].slice(0, 5),
                  evidence: [...new Set([...entry.evidence, ...args.evidence.map((item) => item.replace(/\s+/g, " ").trim())])].slice(-5),
                  relevantFiles: [...new Set([...entry.relevantFiles, ...relevantFiles])].slice(0, 10),
                  suggestedNextStep: args.suggested_next_step.replace(/\s+/g, " ").trim(),
                }))
              : null
            workerHelpTerminalSessions.add(context.sessionID)
            cleanupWorkerChangesForSession(root, context.sessionID)
            context.metadata({
              title: enriched ? `Worker help ${existing.id} enriched` : `Worker help ${existing.id} already requested`,
              metadata: { helpID: existing.id, task: taskPath, terminal: true, duplicate: true, enriched: Boolean(enriched) },
            })
            return {
              title: enriched ? `Worker help ${existing.id} enriched` : `Worker help ${existing.id} already requested`,
              output: enriched
                ? `Worker help ${existing.id} now includes the Worker's concrete diagnosis and files. Stop now; the parent hook will construct the canonical Executor handoff.`
                : `Worker help ${existing.id} is already stored. Stop now; the parent hook will construct the canonical Executor handoff.`,
              metadata: { helpID: existing.id, task: taskPath, terminal: true, duplicate: true, enriched: Boolean(enriched) },
            }
          }
          const pendingLearnings = features.guardLearning
            ? await refreshPendingGuardLearnings(context.sessionID, undefined, context.agent)
            : []
          if (pendingLearnings.length > 0) {
            throw new Error([
              "WORKER HELP NOT RECORDED",
              "Record every pending Guard learning before requesting Executor help:",
              ...pendingLearnings.map((violation) => `- ${violation.id}: ${violation.action}`),
              "Then call request_executor_help once with the same structured evidence.",
            ].join("\n"))
          }

          const persisted = mutateWorkerHelpStore(root, (current) => {
            const concurrentExisting = [...current.requests].reverse().find((entry) => (
              entry.workerSessionID === context.sessionID
              && entry.taskPath === taskPath
              && entry.taskHash === state.taskHash
              && entry.status === "pending"
            ))
            const currentRetryParent = [...current.requests].reverse().find((entry) => (
              entry.status === "delegated"
              && entry.delegatedWorkerSessionID === context.sessionID
              && entry.taskPath === taskPath
              && entry.taskHash === state.taskHash
              && entry.executorReview?.decision === "retry_worker"
            ))
            if (concurrentExisting) {
              const linked = currentRetryParent && !concurrentExisting.retryOfHelpID
                ? { ...concurrentExisting, retryOfHelpID: currentRetryParent.id }
                : concurrentExisting
              const enriched = linked.category === "repeated-doctor-failure"
                ? {
                    ...linked,
                    category: args.category,
                    problem: args.problem.replace(/\s+/g, " ").trim(),
                    attemptedActions: [...new Set([...linked.attemptedActions, ...args.attempted_actions.map((item) => item.replace(/\s+/g, " ").trim())])].slice(0, 5),
                    evidence: [...new Set([...linked.evidence, ...args.evidence.map((item) => item.replace(/\s+/g, " ").trim())])].slice(-5),
                    relevantFiles: [...new Set([...linked.relevantFiles, ...relevantFiles])].slice(0, 10),
                    suggestedNextStep: args.suggested_next_step.replace(/\s+/g, " ").trim(),
                  }
                : linked
              current.requests[current.requests.findIndex((entry) => entry.id === concurrentExisting.id)] = enriched
              return { request: enriched, created: false, enriched: enriched !== linked }
            }
            const request: WorkerHelpRequest = {
              version: 1,
              id: nextWorkerHelpID(current),
              status: "pending",
              taskPath,
              taskHash: state.taskHash,
              workerSessionID: context.sessionID,
              category: args.category,
              problem: args.problem.replace(/\s+/g, " ").trim(),
              attemptedActions: args.attempted_actions.map((item) => item.replace(/\s+/g, " ").trim()),
              evidence: args.evidence.map((item) => item.replace(/\s+/g, " ").trim()),
              relevantFiles,
              suggestedNextStep: args.suggested_next_step.replace(/\s+/g, " ").trim(),
              createdAt: new Date().toISOString(),
              retryOfHelpID: currentRetryParent?.id,
            }
            current.requests.push(request)
            return { request, created: true, enriched: false }
          })
          const request = persisted.request
          workerHelpTerminalSessions.add(context.sessionID)
          workerHelpRequired.delete(context.sessionID)
          doctorFailures.delete(context.sessionID)
          cleanupWorkerChangesForSession(root, context.sessionID)
          const title = persisted.created
            ? `Worker help ${request.id} requested`
            : persisted.enriched
              ? `Worker help ${request.id} enriched`
              : `Worker help ${request.id} already requested`
          context.metadata({ title, metadata: { helpID: request.id, task: taskPath, terminal: true, duplicate: !persisted.created, enriched: persisted.enriched } })
          return {
            title,
            output: persisted.created
              ? `Worker help ${request.id} was stored. Stop now and call no more tools. The parent hook will construct the canonical Executor handoff from the stored data.`
              : `Worker help ${request.id} is already stored. Stop now; the parent hook will construct the canonical Executor handoff.`,
            metadata: { helpID: request.id, task: taskPath, terminal: true, duplicate: !persisted.created, enriched: persisted.enriched },
          }
        },
      }),
      review_worker_help: tool({
        description: "Advance one exact reviewable Worker-help receipt. With no arguments the Harness selects the sole receipt and approves a fresh technical retry; optionally choose Planner recovery.",
        args: {
          help_id: tool.schema.string().regex(/^H\d+$/i).optional().describe("Omit when exactly one receipt is reviewable."),
          decision: tool.schema.enum(["retry_worker", "planner_recovery"]).optional().describe("Defaults to a fresh technical Worker retry."),
        },
        async execute(rawArgs, context) {
          let args = rawArgs as unknown as ReviewWorkerHelpModelArgs
          const agent = context.agent.toLowerCase()
          if (!modeSettings.executorAgents.has(agent)) {
            throw projectGuardError(context.sessionID,
              "Only Executor may review a Worker help request.",
              "Return the terminal HELP_REQUESTED handoff to Executor.",
            )
          }

          {
          args = await checkedModelArgs("review_worker_help", args, context.sessionID, true, context) as unknown as ReviewWorkerHelpModelArgs
          const mechanicalState = activeState(root)
          if (mechanicalState?.status !== "started"
            || typeof mechanicalState.taskPath !== "string"
            || typeof mechanicalState.taskHash !== "string") {
            throw projectGuardError(context.sessionID,
              "There is no exact active started task for Worker-help review.",
              "Do not guess workflow state; wait for one active started task and its persisted help receipt.",
            )
          }
          const selector = mechanicalWorkerHelpReviewSelector(root, args)
          if (!selector.ok) throw new Error(`MECHANICAL WORKER HELP SELECTOR REJECTED\n${selector.reason}`)
          if (selector.taskPath && selector.taskPath !== mechanicalState.taskPath) {
            throw new Error(`MECHANICAL WORKER HELP SELECTOR REJECTED\n${selector.taskPath} is not the exact active task ${mechanicalState.taskPath}.`)
          }
          const reviewable = reconcileWorkerHelpLifecycle(mechanicalState).requests.filter((request) => (
            request.taskPath === mechanicalState.taskPath
            && request.taskHash === mechanicalState.taskHash
            && (request.status === "pending"
              || (request.status === "retry_approved" && !request.delegatedWorkerSessionID))
          ))
          const request = selector.helpID
            ? reviewable.find((entry) => entry.id.toLowerCase() === selector.helpID)
            : reviewable.length === 1 ? reviewable[0] : undefined
          if (!request) {
            throw new Error(selector.helpID
              ? `No reviewable Worker help request ${selector.helpID} exists for the exact active task.`
              : `Expected exactly one reviewable Worker help request, found ${reviewable.length}.`)
          }
          const decision = args.decision === "planner_recovery" ? "planner_recovery" : "retry_worker"
          const reviewedFiles = [...new Set([request.taskPath, ...request.relevantFiles]
            .map((path) => normalize(root, path))
            .filter((path): path is string => Boolean(path) && !isProtected(path!, protectedPaths)))]
          const executorReview: NonNullable<WorkerHelpRequest["executorReview"]> = {
            sessionID: context.sessionID,
            decision,
            rootCause: request.problem.replace(/\s+/g, " ").trim().slice(0, 600),
            retryStrategy: (request.suggestedNextStep || "Delegate one fresh Worker for the exact active task.")
              .replace(/\s+/g, " ").trim().slice(0, 600),
            expectedResults: request.evidence.length > 0
              ? request.evidence.slice(0, 8).map((item) => item.replace(/\s+/g, " ").trim().slice(0, 300))
              : ["The next Worker performs one technically valid in-scope operation and returns the resulting Doctor state."],
            reviewedFiles,
            reviewedAt: new Date().toISOString(),
          }
          if (decision === "retry_worker") {
            updateWorkerHelp(request.id, (entry) => ({ ...entry, status: "retry_approved", executorReview }))
            executorReviewReads.delete(context.sessionID)
            executorHelpReviewPending.delete(context.sessionID)
            context.metadata({ title: `Worker help ${request.id} reviewed`, metadata: { helpID: request.id, task: request.taskPath, decision, mechanical: true } })
            return {
              title: `Worker help ${request.id} reviewed`,
              output: [
                `${request.id} is approved for one fresh Worker retry on ${request.taskPath}.`,
                `Persisted problem: ${executorReview.rootCause}`,
                `Persisted next step: ${executorReview.retryStrategy}`,
                `Delegate a fresh Worker now. Do not resume terminal Worker session ${request.workerSessionID}.`,
              ].join("\n"),
              metadata: { helpID: request.id, task: request.taskPath, decision, mechanical: true },
            }
          }
          const recovery = await recoverWithOwningPlanner({
            executorSessionID: context.sessionID,
            taskPath: request.taskPath,
            problem: request.problem,
            evidence: request.evidence,
            expectedResults: [],
            relevantFiles: reviewedFiles,
            helpID: request.id,
          })
          if (recovery.status !== "recovered") {
            const status = recovery.status === "unavailable" ? "planner_unavailable" : "planner_recovery_incomplete"
            updateWorkerHelp(request.id, (entry) => ({ ...entry, status, executorReview }))
            const output = [
              recovery.status === "unavailable" ? "PLANNER UNAVAILABLE" : "PLANNER RECOVERY INCOMPLETE",
              `Help ID: ${request.id}`,
              `Task: ${request.taskPath}`,
              `Reason: ${recovery.reason}`,
            ].join("\n")
            terminalExecutorReasons.set(context.sessionID, output)
            return { title: recovery.status === "unavailable" ? "Planner unavailable" : "Planner recovery incomplete", output, metadata: { helpID: request.id, task: request.taskPath, terminal: true } }
          }
          updateWorkerHelp(request.id, (entry) => ({ ...entry, status: "task_changed", taskHash: recovery.taskHash, executorReview }))
          executorReviewReads.delete(context.sessionID)
          executorHelpReviewPending.delete(context.sessionID)
          clearPlannerRecoveryState(request.taskPath)
          terminalExecutorReasons.delete(context.sessionID)
          return {
            title: `Owning Planner resolved ${request.id}`,
            output: [recovery.output, `Delegate one fresh Worker for ${request.taskPath}.`].filter(Boolean).join("\n"),
            metadata: { helpID: request.id, task: request.taskPath, decision, taskHash: recovery.taskHash, plannerSessionID: recovery.plannerSessionID, mechanical: true },
          }
          }

        },
      }),
      } : {}),
      ...(features.executorReview ? {
      submit_task_review: tool({
        description: "Complete the exact Doctor-passed task from hash-bound technical evidence. Takes no arguments and accepts no model verdict.",
        args: {},
        async execute(rawArgs, context) {
          await checkedModelArgs("submit_task_review", rawArgs, context.sessionID, true, context)
          const agent = context.agent.toLowerCase()
          if (!modeSettings.executorAgents.has(agent)) {
            throw projectGuardError(context.sessionID,
              "Only Executor may complete a Doctor-passed task.",
              "Return the technically verified Worker result to Executor.",
            )
          }

          const memoryRecovery = projectMemoryRecoveryStatus(root)
          if (memoryRecovery) {
            throw projectGuardError(context.sessionID,
              `Project memory requires Executor recovery: ${memoryRecovery.size} bytes exceeds ${memoryRecovery.maxSize}.`,
              "Read MEMORY.md, preserve durable facts, call recover_project_memory, then retry this zero-argument completion.",
            )
          }

          const state = activeState(root)
          const taskPath = typeof state?.taskPath === "string" ? normalize(root, state.taskPath) : null
          if (state?.status !== "passed" || !taskPath || taskPath !== state.taskPath) {
            throw projectGuardError(context.sessionID,
              "There is no exact Doctor-passed task to complete.",
              state?.status === "passed"
                ? "Stop and report the invalid non-canonical Doctor task path."
                : "Wait for Worker to produce TASK DOCTOR: PASS, then call submit_task_review without arguments.",
            )
          }
          const taskFile = safeCurrentRegularFile(taskPath)
          if (!taskFile || taskFile.hash !== state.taskHash) {
            throw projectGuardError(context.sessionID,
              "The task changed after Doctor start.",
              "Start a fresh Doctor lifecycle for the current task bytes.",
            )
          }

          const report = typeof state.reportPath === "string" ? readJson(resolve(root, state.reportPath)) : null
          if (!hasTechnicalOperationEvidence(report)) {
            throw projectGuardError(context.sessionID,
              "Doctor completion evidence contains neither an in-scope changed path nor a successful Verify command.",
              "Do not complete this no-op task. Return it to Planner so the task requires a technically observable operation.",
            )
          }

          const changedFiles = [...new Set(changedFilesForReview(root, state).map((path) => normalize(root, path)))]
          if (changedFiles.some((path) => path === null)) {
            throw projectGuardError(context.sessionID,
              "Doctor completion evidence contains a file outside the project.",
              "Stop and report the invalid Doctor state.",
            )
          }
          const changedAfterPass = (changedFiles as string[]).find((path) => {
            const current = safeCurrentRegularFile(path)
            return (current?.hash ?? undefined) !== state.verifiedSnapshot?.[path]
          })
          if (changedAfterPass) {
            throw projectGuardError(context.sessionID,
              `${changedAfterPass} changed after Doctor PASS.`,
              "Run a fresh Doctor lifecycle so the current bytes are technically verified.",
            )
          }

          const completeResult = spawnSync("node", ["scripts/task-doctor.mjs", "complete", taskPath], {
            cwd: root,
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
          })
          const completedPrefix = "TASK DOCTOR: COMPLETED "
          const completedPath = completeResult.stdout
            .split(/\r?\n/)
            .find((line) => line.startsWith(completedPrefix))
            ?.slice(completedPrefix.length)
            .trim()
          const expectedCompletedPath = taskPath.replace(/^kanban\/todo\//, "kanban/done/")
          if (completeResult.status !== 0 || completedPath !== expectedCompletedPath) {
            throw new Error([completeResult.stdout, completeResult.stderr].filter(Boolean).join("\n").trim() || "Doctor could not complete the technically verified task.")
          }

          cleanupWorkerChangesForTask(root, taskPath)
          const reviewableWorkerSessionIDs = reviewableWorkerSessions.get(taskPath)
          if (reviewableWorkerSessionIDs) {
            for (const workerSessionID of [...reviewableWorkerSessionIDs]) {
              if (await archiveTerminalWorkerSession(workerSessionID, "technical task completion")) {
                forgetReviewableWorker(taskPath, workerSessionID)
              }
            }
          }
          if (explicitPlannerReviewReceipt()?.taskPath === taskPath) rmSync(explicitPlannerReviewPath, { force: true })
          executorReviewReads.delete(context.sessionID)
          rmSync(lastDoctorFailurePath, { force: true })
          repetitions.delete(context.sessionID)
          const checkpointData = features.contextCheckpoint ? checkpoint(root, completedPath) : null
          if (features.contextCheckpoint) pendingCompact.add(context.sessionID)
          context.metadata({ title: "Technically verified task completed", metadata: { task: taskPath, completedPath } })
          return {
            title: "Technically verified task completed",
            output: [
              completeResult.stdout.trim(),
              features.completionAuditor ? `Completion recorded: ${completedPath}. ${checkpointData?.nextAction ?? "Check the next task."}` : null,
            ].filter(Boolean).join("\n"),
            metadata: { task: taskPath, completedPath },
          }
        },
      }),
      } : {}),
      ...(features.guardLearning ? {
      record_guard_learning: tool({
        description: "Record every pending Workflow Guard lesson for the current role mechanically in one call. Takes no arguments.",
        args: {},
        async execute(rawArgs, context) {
          await checkedModelArgs("record_guard_learning", rawArgs, context.sessionID, true, context)
          const driver = driverForSession(context.sessionID)
          if (driver?.automaticLearning) {
            return {
              title: "Guard learning handled automatically",
              output: "The Ornith model driver stores Guard learnings automatically. Continue with its NEXT_ACTION and do not call record_guard_learning again.",
              metadata: { modelDriver: driver.id, automatic: true },
            }
          }
          await refreshPendingGuardLearnings(context.sessionID)
          const pending = pendingGuardLearningsForAgent(context.sessionID, context.agent)
          const allPending = pendingGuardLearnings.get(context.sessionID)
          const violations = [...pending.values()]
          if (violations.length === 0 || !allPending) {
            throw new Error("No unresolved Guard violation exists in the current turn.")
          }

          const normalizedAgent = context.agent.toLowerCase()
          const resumeOriginalWork = guardLearningPromptedFor.get(context.sessionID)?.startsWith(`${normalizedAgent}:`) ?? false
          const transient: GuardViolation[] = []
          const recorded = violations.flatMap((violation) => {
            const result = recordGuardLearningFile(violation.id, normalizedAgent)
            allPending.delete(`${normalizedAgent}:${violation.id}`)
            if (!result) {
              transient.push(violation)
              return []
            }
            return [{ violation, learning: result.learning }]
          })
          if (pendingGuardLearningsForAgent(context.sessionID, normalizedAgent).size === 0) {
            guardLearningPromptedFor.delete(context.sessionID)
            if (resumeOriginalWork) guardLearningResumePending.set(context.sessionID, normalizedAgent)
          }
          if (allPending.size === 0) {
            pendingGuardLearnings.delete(context.sessionID)
          }
          persistPendingGuardLearnings()
          if (recorded.length === 0 && transient.length === 0) {
            throw new Error("No unresolved Guard violation exists in the current turn.")
          }
          if (recorded.length === 0) {
            const violationIDs = transient.map((violation) => violation.id)
            context.metadata({ title: "Transient Guard recovery acknowledged", metadata: { violationIDs, paths: [] } })
            return {
              title: "Transient Guard recovery acknowledged",
              output: `Acknowledged ${violationIDs.length} transient Guard recovery response${violationIDs.length === 1 ? "" : "s"} (${violationIDs.join(", ")}). No durable rule was written. Continue with the exact current next action.`,
              metadata: { violationID: violationIDs[0], violationIDs, paths: [] },
            }
          }
          const violationIDs = recorded.map(({ violation }) => violation.id)
          const paths = [...new Set(recorded.map(({ learning }) => learning.path))]
          context.metadata({ title: "Guard learnings recorded", metadata: { violationIDs, paths } })
          return {
            title: "Guard learnings recorded",
            output: `Recorded ${violationIDs.length} pending Guard learning${violationIDs.length === 1 ? "" : "s"} (${violationIDs.join(", ")}) in ${paths.join(", ")}. Apply them now, continue the unfinished request in this turn, and do not stop after merely reporting readiness.`,
            metadata: { violationID: violationIDs[0], violationIDs, paths },
          }
        },
      }),
      } : {}),
      ...(features.userPermissionEscalation ? {
      request_command_permission: tool({
        description: "Ask the user to approve one opaque or mutating shell command that the workflow guard cannot verify. Explain why it is needed and declare every affected path. This never expands the active task Scope or permits protected workflow files.",
        args: {
          purpose: tool.schema.string().min(20).describe("A concrete explanation of what the command will do and why the task needs it."),
          command: tool.schema.string().min(1).describe("The complete shell command to execute once after approval."),
          affected_paths: tool.schema.array(tool.schema.string().min(1)).min(1).describe("Every project-relative file or directory the command may create, change, move, or delete."),
        },
        async execute(args, context) {
          args = await checkedModelArgs("request_command_permission", args, context.sessionID, true, context) as typeof args
          const agent = context.agent.toLowerCase()
          if (!modeSettings.workerAgents.has(agent)) {
            throw projectGuardError(context.sessionID,
              "Only Worker may request permission for an exceptional mutating command.",
              "Switch to Worker and execute a registered task through the Doctor lifecycle.",
            )
          }
          if (features.transactionalWorkerChanges) {
            throw projectGuardError(context.sessionID,
              "Arbitrary Worker command exceptions are disabled while transactional Worker changes are enabled.",
              "Use preview_worker_changes and apply_worker_changes for project files. Use the dedicated dependency-install permission tool only for task-declared packages.",
            )
          }

          const state = activeState(root)
          if (state?.status !== "started") {
            throw projectGuardError(context.sessionID,
              "Command permission was requested without a started task.",
              "Start the current registered task through Doctor before requesting an exceptional command.",
            )
          }

          const paths = [...new Set(args.affected_paths.map((path) => normalize(root, path)))]
          if (paths.some((path) => path === null)) {
            throw projectGuardError(context.sessionID,
              "The permission request contains a path outside the project.",
              "Declare only exact project-relative paths inside the active project.",
            )
          }

          const normalizedPaths = paths as string[]
          const protectedPath = normalizedPaths.find((path) => isProtected(path, protectedPaths) || isProtected(path, readOnlyPaths))
            ?? [...protectedPaths, ...readOnlyPaths].find((path) => args.command.includes(path))
          if (protectedPath) {
            throw projectGuardError(context.sessionID,
              `${protectedPath} is protected and cannot be approved through a command exception.`,
              "Do not inspect or mutate protected workflow files. Follow Doctor output.",
            )
          }

          const taskScope = scopeFromTask(root, state.taskPath)
          const commandMkdirPaths = (simpleMkdirTargets(args.command) ?? [])
            .map((path) => normalize(root, path))
            .filter((path): path is string => path !== null)
          const exactMkdirRequest = commandMkdirPaths.length > 0
            && commandMkdirPaths.length === normalizedPaths.length
            && commandMkdirPaths.every((path) => normalizedPaths.includes(path))
          const outsideScope = normalizedPaths.find((path) => (
            !allowed(path, taskScope.paths)
            && !(exactMkdirRequest && allowedNewParentDirectory(path, taskScope.newPaths))
          ))
          if (outsideScope) {
            throw projectGuardError(context.sessionID,
              `${outsideScope} is outside the active task Scope and cannot be approved as a command exception.`,
              "Stop and report TASK_SCOPE_INSUFFICIENT. A corrected task must be linted, registered, and started before implementation continues.",
            )
          }

          await context.ask({
            permission: "workflow_exception",
            patterns: [
              `Purpose: ${args.purpose}`,
              `Command: ${args.command}`,
              `Affected paths: ${normalizedPaths.join(", ")}`,
            ],
            always: [],
            metadata: {
              purpose: args.purpose,
              command: args.command,
              affectedPaths: normalizedPaths,
              task: state.taskPath,
            },
          })

          context.metadata({
            title: "Approved workflow exception",
            metadata: { task: state.taskPath, affectedPaths: normalizedPaths },
          })

          const shell = process.platform === "win32"
            ? { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", args.command] }
            : { command: "/bin/zsh", args: ["-lc", args.command] }
          const result = spawnSync(shell.command, shell.args, {
            cwd: root,
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
            timeout: 120_000,
          })
          const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
          if (result.error || result.status !== 0) {
            const failure = [
              `Approved command failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.status ?? "unknown"}`}.`,
              result.error?.message,
              output,
            ].filter(Boolean).join("\n")
            sessionFeedback.set(context.sessionID, [
              "Failure: approved workflow command failed after user permission.",
              failure,
              "Expected: stop and report the external blocker. Do not run Doctor verify or retry with force until the cause changes.",
            ].join("\n"))
            throw new Error(failure)
          }
          if (sessionFeedback.get(context.sessionID)?.startsWith("Failure: approved workflow command")) sessionFeedback.delete(context.sessionID)
          return {
            title: "Approved workflow exception completed",
            output: output || "Command completed successfully without output.",
            metadata: { task: state.taskPath, affectedPaths: normalizedPaths },
          }
        },
      }),
      } : {}),
      ...(features.taskChangePermission ? {
        request_task_change_permission: tool({
          description: "Ask the user to approve one exact correction to the first Kanban task after Doctor lint rejects its definition. Explain the reason and provide the exact old and new text. The approved replacement is applied once, then the task must be linted and registered again.",
          args: {
            task_path: tool.schema.string().min(1).describe("The exact project-relative kanban/todo task path reported by Doctor."),
            reason: tool.schema.string().min(20).describe("Why the Doctor lint failure requires changing the task definition."),
            old_text: tool.schema.string().min(1).describe("The exact current task text to replace once."),
            new_text: tool.schema.string().min(1).describe("The exact replacement text the user should approve."),
          },
          async execute(args, context) {
            args = await checkedModelArgs("request_task_change_permission", args, context.sessionID, true, context) as typeof args
            const agent = context.agent.toLowerCase()
            if (!modeSettings.workerAgents.has(agent)) {
              throw projectGuardError(context.sessionID,
                "Only Worker may request an exceptional task correction.",
                modeSettings.executorAgents.has(agent)
                  ? `Call escalate_to_planner for ${args.task_path} with the exact Doctor error, expected corrected result, and relevant task files. Do not merely tell the user to contact Planner.`
                  : "Use normal Planner editing, Doctor lint, and Doctor register. Use this permission only when Doctor lint blocks Worker before start.",
              )
            }

            const taskPath = normalize(root, args.task_path)
            const firstTask = todoTasks(root)[0] ? `kanban/todo/${todoTasks(root)[0]}` : null
            if (!taskPath || !planningPath.test(taskPath) || taskPath !== firstTask) {
              throw projectGuardError(context.sessionID,
                `${args.task_path} is not the exact first Kanban task.`,
                `Use the exact current path ${firstTask ?? "kanban/todo/<task>.md"}.`,
              )
            }

            const state = activeState(root)
            if (state?.status === "started" || state?.status === "passed") {
              throw projectGuardError(context.sessionID,
                `${state.taskPath ?? taskPath} is already ${state.status}.`,
                "Do not change a started or passed task. Stop and report that its definition needs Planner correction before a new lifecycle.",
              )
            }

            const failure = readJson(lastDoctorFailurePath)
            if (failure?.gate !== "lint" || failure?.taskPath !== taskPath) {
              throw projectGuardError(context.sessionID,
                `No current Doctor lint failure requires changing ${taskPath}.`,
                `Run npm run task:doctor:lint -- ${taskPath}. Request permission only if that lint output requires a task correction.`,
              )
            }

            const absolutePath = resolve(root, taskPath)
            const content = readFileSync(absolutePath, "utf8")
            const occurrences = content.split(args.old_text).length - 1
            if (occurrences !== 1 || args.old_text === args.new_text) {
              throw projectGuardError(context.sessionID,
                `The proposed old text occurs ${occurrences} times or the replacement is unchanged.`,
                "Read the task again and provide one exact unique old text plus the exact intended replacement.",
              )
            }

            await context.ask({
              permission: "workflow_task_change",
              patterns: [
                `Task: ${taskPath}`,
                `Reason: ${args.reason}`,
                `Replace: ${args.old_text}`,
                `With: ${args.new_text}`,
              ],
              always: [],
              metadata: {
                task: taskPath,
                reason: args.reason,
                oldText: args.old_text,
                newText: args.new_text,
              },
            })

            writeFileSync(absolutePath, content.replace(args.old_text, args.new_text))
            context.metadata({
              title: "Approved task correction",
              metadata: { task: taskPath },
            })
            return {
              title: "Approved task correction applied",
              output: `Updated ${taskPath} with the exact approved replacement. Run npm run task:doctor:lint -- ${taskPath}, then register it again before start.`,
              metadata: { task: taskPath },
            }
          },
        }),
      } : {}),
      ...(features.dependencyInstallPermission ? {
        request_dependency_install_permission: tool({
          description: "Ask the user to approve installing exact npm dependencies required by the active task. Only package names explicitly present in the task are allowed. The tool constructs and executes npm directly without a free-form shell.",
          args: {
            reason: tool.schema.string().min(20).describe("Why these dependencies are required for the active task."),
            workspace: tool.schema.string().min(1).describe("Project-relative workspace containing package.json, for example packages/client."),
            packages: tool.schema.array(tool.schema.string().min(1)).min(1).describe("Exact npm package names or package@version specs to install."),
            dev: tool.schema.boolean().describe("True for devDependencies, false for production dependencies."),
          },
          async execute(args, context) {
            args = await checkedModelArgs("request_dependency_install_permission", args, context.sessionID, true, context) as typeof args
            const agent = context.agent.toLowerCase()
            if (!modeSettings.workerAgents.has(agent)) {
              throw projectGuardError(context.sessionID,
                "Only Worker may request dependency installation.",
                "Switch to Worker and execute a registered task through the Doctor lifecycle.",
              )
            }

            const state = activeState(root)
            if (state?.status !== "started") {
              throw projectGuardError(context.sessionID,
                "Dependency installation was requested without a started task.",
                "Lint, register, and start the exact task before requesting dependency installation.",
              )
            }

            const workspace = normalize(root, args.workspace)
            if (!workspace || workspace === "." || !existsSync(resolve(root, workspace, "package.json"))) {
              throw projectGuardError(context.sessionID,
                `${args.workspace} is not a project workspace with package.json.`,
                "Use the exact project-relative workspace path that owns the dependency.",
              )
            }

            const requested = [...new Set(args.packages)]
            const names = requested.map(packageName)
            if (names.some((name) => name === null)) {
              throw projectGuardError(context.sessionID,
                "The dependency request contains a URL, flag, path, or invalid package spec.",
                "Request only exact npm package names or package@version specs. Do not include shell arguments.",
              )
            }

            const { content, paths: scope } = scopeFromTask(root, state.taskPath)
            const missingFromTask = (names as string[]).find((name) => !content.includes(name))
            if (missingFromTask) {
              throw projectGuardError(context.sessionID,
                `${missingFromTask} is not explicitly named in the active task.`,
                "Do not add inferred peer or helper dependencies. Request only packages explicitly required by the task, or stop for a task correction.",
              )
            }

            const manifest = `${workspace}/package.json`
            const lockfile = packageLockNames.map((name) => `${workspace}/${name}`).find((path) => existsSync(resolve(root, path)))
            const trackedPaths = [manifest, lockfile].filter((path): path is string => Boolean(path))
            const outsideScope = trackedPaths.find((path) => !allowed(path, scope))
            if (outsideScope) {
              throw projectGuardError(context.sessionID,
                `${outsideScope} is not covered by the active task package scope.`,
                "Stop and request a task correction before installing dependencies.",
              )
            }

            const commandArgs = ["install", "--prefix", workspace, args.dev ? "--save-dev" : "--save", ...requested]
            const command = `npm ${commandArgs.join(" ")}`
            await context.ask({
              permission: "workflow_dependency_install",
              patterns: [
                `Task: ${state.taskPath}`,
                `Reason: ${args.reason}`,
                `Command: ${command}`,
                `Tracked changes: ${trackedPaths.join(", ")}`,
                `Generated dependency files: ${workspace}/node_modules`,
              ],
              always: [],
              metadata: {
                task: state.taskPath,
                workspace,
                packages: requested,
                dev: args.dev,
                trackedPaths,
              },
            })

            const npm = process.platform === "win32"
              ? { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", ...commandArgs] }
              : { command: "npm", args: commandArgs }
            const result = spawnSync(npm.command, npm.args, {
              cwd: root,
              encoding: "utf8",
              maxBuffer: 10 * 1024 * 1024,
              timeout: 180_000,
            })
          const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
          if (result.error || result.status !== 0) {
            const failure = [
              `Approved dependency install failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.status ?? "unknown"}`}.`,
              result.error?.message,
              output,
            ].filter(Boolean).join("\n")
            sessionFeedback.set(context.sessionID, [
              "Failure: approved dependency installation failed after user permission.",
              failure,
              "Expected: stop and report the external blocker. Do not run Doctor verify, use force, clean caches, or retry until the cause changes.",
            ].join("\n"))
            throw new Error(failure)
          }

          if (sessionFeedback.get(context.sessionID)?.startsWith("Failure: approved dependency installation")) sessionFeedback.delete(context.sessionID)
          context.metadata({
              title: "Approved dependencies installed",
              metadata: { task: state.taskPath, workspace, packages: requested },
            })
            return {
              title: "Approved dependencies installed",
              output: output || `Installed ${requested.join(", ")} in ${workspace}.`,
              metadata: { task: state.taskPath, workspace, packages: requested, trackedPaths },
            }
          },
        }),
      } : {}),
    },

    "chat.message": async ({ sessionID, agent, model }, output) => {
      if (enabled) scheduleWorkerSessionMaintenance(sessionID)
      rememberSessionIdentity(sessionID, { agent }, model)
      repetitions.delete(sessionID)
      terminalRoleLoopReasons.delete(sessionID)
      await initializeReviewedWorkerRetry(sessionID)
      await initializeStagedHelpDelegation(sessionID)
      if (agent && modeSettings.executorAgents.has(agent.toLowerCase())) {
        executorScheduledNoReady.delete(sessionID)
        terminalExecutorReasons.delete(sessionID)
        executorHelpReReviewRequested.delete(sessionID)
        const messageText = Array.isArray(output?.parts)
          ? output.parts
              .filter((part: any) => part?.type === "text" && part.synthetic !== true)
              .map((part: any) => String(part.text ?? ""))
              .join("\n")
          : ""
        executorPlannerRecoveryRequested.delete(sessionID)
        if (messageText.trim()) {
          const state = activeState(root)
          const currentUserMessage = [{
            info: { id: String((output as any)?.messageID ?? (output as any)?.info?.id ?? hash(messageText)), role: "user" },
            parts: [{ type: "text", text: messageText }],
          }]
          if (state?.status === "started"
            && explicitUserRejectsPlanner(currentUserMessage, state.taskPath)
            && cancelRejectedPendingPlannerRecovery(sessionID, state.taskPath, state.taskHash)) {
            await log("info", "Cancelled an uncommitted Planner recovery after the current user explicitly rejected Planner", {
              sessionID,
              task: state.taskPath,
            })
          }
          const plannerRequest = state?.status === "started"
            ? explicitUserPlannerRecoveryRequest(currentUserMessage, state.taskPath)
            : null
          if (plannerRequest) executorPlannerRecoveryRequested.set(sessionID, {
            taskPath: state!.taskPath,
            taskHash: state!.taskHash,
          })
        }
        const explicitReReview = /review_worker_help/i.test(messageText)
          && /(?:re-?review|review[^\n]{0,120}(?:again|once more)|before any delegation|do not delegate|erneut|nochmals|vor[^\n]{0,80}deleg)/i.test(messageText)
        if (explicitReReview) {
          const state = activeState(root)
          const help = currentWorkerHelp(root, state?.taskPath ?? null, state?.taskHash)
          if (help?.status === "retry_approved" && !help.delegatedWorkerSessionID) {
            executorHelpReReviewRequested.set(sessionID, help.id)
          }
        }
      }
      await refreshSessionTodos(sessionID)
    },

    "experimental.chat.system.transform": async ({ sessionID, model }, output) => {
      if (!enabled || !sessionID) return
      await hydrateSessionIdentity(sessionID, model)
      if (model?.limit?.context) contextLimits.set(sessionID, model.limit.context)
      const agent = sessionAgents.get(sessionID) ?? ""
      if (modeSettings.workerAgents.has(agent)) {
        const familyRules = workerModelFamilySystemBlock(sessionID)
        if (familyRules) output.system.push(familyRules)
      }
      const feedback = sessionFeedback.get(sessionID)
      const driver = driverForSession(sessionID)
      if (driver?.config.structuredState) {
        output.system.push(driver.systemBlock(
          sessionID,
          sessionAgents.get(sessionID) ?? "unknown",
          driverWorkflowState(),
          feedback,
        ))
        coalesceLlamaCppSystemMessages(model, output)
        return
      }
      output.system.push([
        "## Workflow guard",
        "Authoritative live state is appended as the final synthetic user message so the stable prompt prefix remains cacheable.",
        "Treat Doctor failures as blocking. Do not repeat a failed action unchanged.",
      ].join("\n\n"))
      coalesceLlamaCppSystemMessages(model, output)
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      if (!enabled || !Array.isArray(output.messages) || output.messages.length === 0) return
      const baseMessage: any = [...output.messages].reverse().find((message: any) => typeof message?.info?.sessionID === "string")
      const sessionID = baseMessage?.info?.sessionID
      if (!sessionID) return
      await hydrateSessionIdentity(sessionID, baseMessage.info?.model)
      const driver = driverForSession(sessionID)
      if (driver?.config.structuredState) return
      const stateText = volatileWorkflowGuardText(sessionID)
      if (!stateText) return
      const suffix = createHash("sha256").update(`workflow-guard:${sessionID}`).digest("hex").slice(0, 16)
      const messageID = `msg_workflow_guard_${suffix}`
      output.messages.push({
        info: {
          id: messageID,
          sessionID,
          role: "user",
          agent: sessionAgents.get(sessionID) || baseMessage.info?.agent,
          model: baseMessage.info?.model,
          time: { created: Date.now() },
        },
        parts: [{
          id: `prt_workflow_guard_${suffix}`,
          sessionID,
          messageID,
          type: "text",
          text: stateText,
          synthetic: true,
        }],
      } as any)
      workerMechanicalDoctorNotices.delete(sessionID)
    },

    "tool.execute.before": async (input, output) => {
      try {
      await hydrateSessionIdentity(input.sessionID)
      const checkedArgs = await checkedModelArgs(input.tool, output.args, input.sessionID)
      output.args = replaceModelArgsInPlace(output.args, checkedArgs)
      if (input.tool !== "record_guard_learning") guardLearningResumePending.delete(input.sessionID)
      const agent = sessionAgents.get(input.sessionID)
      const plannerMode = Boolean(agent && modeSettings.plannerAgents.has(agent))
      const executorMode = Boolean(agent && modeSettings.executorAgents.has(agent))
      const workerMode = Boolean(agent && modeSettings.workerAgents.has(agent))
      let automaticRequiredTaskRead: ReturnType<typeof automaticWorkerTaskReadCandidate> = null
      const rawCommand = String(output.args?.command ?? "")
      if (plannerMode && input.tool === "bash") {
        const strippedCommand = stripHarmlessOutputSuffix(rawCommand)
        const repairedScript = canonicalUniqueNpmScript(strippedCommand, projectNpmScriptNames(root))
        const repairableCommand = repairedScript ?? strippedCommand
        const packageScripts = canonicalPlannerPackageScriptsCommand(root, repairableCommand)
        const canonical = canonicalPlannerDoctorCommand(repairableCommand)
        if (packageScripts) {
          output.args.command = packageScripts
          output.args.workdir = root
        } else if (canonical) output.args.command = canonical
        else if (plannerAppCommand.test(repairableCommand)) output.args.command = repairableCommand
      }
      if (workerMode && input.tool === "bash") {
        const canonical = canonicalWorkerDoctorCommand(stripProjectCdPrefix(root, rawCommand))
        if (canonical) output.args.command = canonical
        const state = activeState(root)
        const preflightRequired = state?.status === "started"
          && missingWorkerRuleFiles(input.sessionID).length === 0
          && workerTaskWasRead(input.sessionID, state)
          && !workerPreflightComplete(input.sessionID, state)
        if (!features.transactionalWorkerChanges
          && (workerVerifyRequired.has(input.sessionID) || preflightRequired)
          && state?.status === "started") {
          const requiredVerify = `npm run task:doctor:verify -- ${state.taskPath}`
          if (String(output.args?.command ?? "") !== requiredVerify) {
            output.args.command = requiredVerify
            output.args.workdir = root
            await log("warn", "Repaired Worker command to the required post-apply Doctor verify", {
              sessionID: input.sessionID,
              task: state.taskPath,
            })
          }
        }
      }
      if (executorMode && input.tool === "bash") {
        const strippedCommand = stripHarmlessOutputSuffix(rawCommand)
        const repairedScript = canonicalUniqueNpmScript(strippedCommand, projectNpmScriptNames(root))
        const repairableCommand = repairedScript ?? strippedCommand
        if (doctorCommandMention.test(repairableCommand)) {
          output.args.command = "npm run task:doctor:schedule"
          output.args.workdir = root
        }
      }
      if (input.tool === "bash" && isDoctorCommand(String(output.args?.command ?? ""))) {
        output.args.workdir = root
      }
      const normalizedDoctor = input.tool === "bash"
        ? doctorInvocation(String(output.args?.command ?? ""))
        : null
      if (workerMode && normalizedDoctor?.gate === "verify" && !features.transactionalWorkerChanges) {
        output.args.timeout = doctorVerifyTimeoutMs
        const state = activeState(root)
        workerDoctorStartedAt.set(input.sessionID, {
          startedAt: Date.now(),
          mutationRevision: workerMutationRevision,
          taskPath: normalizedDoctor.taskPath,
          taskHash: state?.taskPath === normalizedDoctor.taskPath && typeof state.taskHash === "string"
            ? state.taskHash
            : null,
        })
      }
      const driver = driverForSession(input.sessionID)
      const workflow = driverWorkflowState()
      return await guardErrorContext.run({
        format: (problem, action, success) => projectGuardError(input.sessionID, problem, action, success),
      }, async () => {
      if (!enabled) return
      if (workerMode) {
        const state = activeState(root)
        const clearedBoost = state?.status === "started"
          && typeof state.taskPath === "string"
          && typeof state.taskHash === "string"
          ? clearedRecoveryBoostHelp(input.sessionID, state.taskPath, state.taskHash)
          : null
        if (clearedBoost) {
          throw new Error([
            "WORKER RECOVERY BOOST COMPLETE",
            `Help ID: ${clearedBoost.id}`,
            "The reviewed hurdle is cleared. Do not call another tool in this boosted turn.",
            "End this response now; the Harness continues the same Worker session once with the base Worker model.",
          ].join("\n"))
        }
      }
      const pendingHarnessRecovery = features.executorBaselineRecovery ? taskHarnessRecoveryStatus(root) : null
      const terminalRoleLoopReason = terminalRoleLoopReasons.get(input.sessionID)
      if (terminalRoleLoopReason && input.tool !== "record_guard_learning") {
        throw new Error(`${terminalRoleLoopReason}\nNo further role tool calls are allowed until the user sends a new instruction.`)
      }
      const terminalExecutorReason = terminalExecutorReasons.get(input.sessionID)
      if (executorMode && terminalExecutorReason && input.tool !== "record_guard_learning"
        && !(pendingHarnessRecovery && input.tool === "recover_harness_baseline")) {
        throw new Error(`${terminalExecutorReason}\nNo further Executor tool calls are allowed until the user sends a new instruction.`)
      }
      const terminalHarnessRecovery = workerHarnessRecoveryTerminals.get(input.sessionID)
      if (workerMode && terminalHarnessRecovery) {
        throw new Error([
          "TASK DOCTOR: EXECUTOR RECOVERY REQUIRED",
          `Task: ${terminalHarnessRecovery.taskPath}`,
          `Task hash: ${terminalHarnessRecovery.taskHash}`,
          "This Worker session is terminal because it observed Harness drift.",
          "Do not call another tool or continue after Executor recovery. Return BLOCKED and let Executor delegate a fresh Worker.",
        ].join("\n"))
      }
      if (workerMode && pendingHarnessRecovery) {
        markWorkerHarnessRecoveryTerminal(input.sessionID, {
          taskPath: pendingHarnessRecovery.taskPath,
          taskHash: pendingHarnessRecovery.taskHash,
        })
        const message = [
          "TASK DOCTOR: EXECUTOR RECOVERY REQUIRED",
          `Task: ${pendingHarnessRecovery.taskPath}`,
          `Harness paths: ${pendingHarnessRecovery.paths.map((entry) => entry.path).join(", ")}`,
          "Do not call another tool, restore files, retry verify, or escalate to Planner.",
          "Return BLOCKED with Doctor status started and Required owner: Executor, then stop.",
        ].join("\n")
        sessionFeedback.set(input.sessionID, message)
        throw new Error(message)
      }
      if (features.transactionalWorkerChanges && workerMode && normalizedDoctor?.gate === "verify") {
        throw guardError(
          "Transactional Worker Doctor verify cannot run through Bash because it would bypass the trusted Apply/verify queue.",
          "Call the zero-argument verify_worker_task tool. It selects the exact active task and serializes Doctor with every Worker Apply.",
        )
      }
      if (features.workerHelp && workerMode) {
        const currentState = activeState(root)
        const recordedHelp = workerHelpForSession(input.sessionID, currentState?.taskPath, currentState?.taskHash)
        if ((recordedHelp || workerHelpTerminalSessions.has(input.sessionID))
          && input.tool !== "record_guard_learning"
          && input.tool !== "request_executor_help") {
          throw new Error([
            "WORKER HELP IS TERMINAL",
            recordedHelp ? `Help ID: ${recordedHelp.id}` : null,
            "Do not call another tool or continue implementation.",
            "End the Worker response now. The parent hook constructs the canonical HELP_REQUESTED handoff from stored data.",
          ].filter(Boolean).join("\n"))
        }
        const requiredHelp = workerHelpRequired.get(input.sessionID)
        if (requiredHelp && input.tool !== "record_guard_learning" && input.tool !== "request_executor_help") {
          throw new Error([
            "MODEL LOOP STOP",
            `${requiredHelp.count} semantically equivalent failures occurred for ${requiredHelp.fingerprint.tool} on ${requiredHelp.fingerprint.target}.`,
            `Failure category: ${requiredHelp.fingerprint.category}`,
            `Latest problem: ${requiredHelp.fingerprint.problem}`,
            "Call request_executor_help now with the active task, distinct attempts, exact evidence, relevant files, and a suggested next step. Then stop.",
          ].join("\n"))
        }
      }
      const driverBlock = driver?.beforeTool(input.sessionID, input.tool, output.args, workflow.revision)
      if (driverBlock) throw new Error(driverBlock)
      const paths = targetPaths(root, input.tool, output.args)
      const command = String(output.args?.command ?? "")
      const opaqueInline = input.tool === "bash" && opaqueInlineCommand.test(command)
      const mutation = writeTools.has(input.tool) || (input.tool === "bash" && shellCommandMutates(command))
      const invocation = doctorInvocation(command)
      const plannerWrite = plannerMode && writeTools.has(input.tool) && paths.length > 0 && paths.every((path) => allowed(path, modeSettings.plannerWritablePaths))
      const workerRulesTarget = paths.find((path) => workerRulesPath.test(path))
        ?? command.match(/(?:^|[\s'"/])(WORKER(?:-[A-Za-z0-9._-]+)?\.md)(?=$|[\s'";])/i)?.[1]

      const canonicalWorkerDelegation = executorMode
        && input.tool === "task"
        && workerSubagentType(output.args?.subagent_type)
      if ((plannerMode || executorMode) && workerRulesTarget
        && input.tool !== "recover_harness_baseline"
        && !canonicalWorkerDelegation) {
        throw projectGuardError(input.sessionID,
          `${workerRulesTarget} is Worker-only system context and is opaque to ${plannerMode ? "Planner" : "Executor"}.`,
          "Do not read this file. For Harness recovery, pass its exact Doctor-reported path to recover_harness_baseline; the trusted tool validates hashes without exposing content.",
        )
      }

      const missingRules = workerMode ? missingWorkerRuleFiles(input.sessionID) : []
      const trustedWorkerVerify = input.tool === "verify_worker_task"
      const trustedWorkerPreview = input.tool === "preview_worker_changes"
      const workerControlTool = input.tool === "record_guard_learning" || input.tool === "request_executor_help"
      const requiredRuleRead = workerMode
        && input.tool === "read"
        && paths.length === 1
        && requiredWorkerRuleFiles(input.sessionID).includes(paths[0])
      const startupState = workerMode ? activeState(root) : null
      const activeTaskRead = workerMode
        && input.tool === "read"
        && paths.length === 1
        && startupState?.status === "started"
        && paths[0] === startupState.taskPath
      const inspectionBeforeRules = ["read", "glob", "grep"].includes(input.tool)
        || (input.tool === "bash" && plannerReadOnlyCommand(command))
      const allowedBeforeRules = features.transactionalWorkerChanges ? requiredRuleRead || activeTaskRead : inspectionBeforeRules
      if (workerMode && missingRules.length > 0 && !allowedBeforeRules && !workerControlTool) {
        throw guardError(
          `Worker attempted ${input.tool} before reading required rules in the current context: ${missingRules.join(", ")}.`,
          `Read ${missingRules[0]} with the read tool now. Read each remaining named rule file separately, then continue. Re-read them after every compaction.`,
        )
      }

      const workerState = startupState
      if (features.transactionalWorkerChanges && workerMode && workerState?.status === "started" && missingRules.length === 0) {
        const exactTaskRead = input.tool === "read" && paths.length === 1 && paths[0] === workerState.taskPath
        const auxiliaryRead = input.tool === "read" && paths.length === 1
          && ["AGENTS.md", "MEMORY.md", "CODEX-INBOX.md", ...requiredWorkerRuleFiles(input.sessionID)].includes(paths[0])
        const exactVerify = invocation?.gate === "verify" && invocation.taskPath === workerState.taskPath

        if (!workerTaskWasRead(input.sessionID, workerState) && !exactTaskRead && !auxiliaryRead && !workerControlTool) {
          automaticRequiredTaskRead = input.tool === "read"
            && paths.length === 1
            && output.args?.offset === undefined
            && output.args?.limit === undefined
            ? automaticWorkerTaskReadCandidate(input.sessionID, input.callID, paths[0], workerState)
            : null
          if (!automaticRequiredTaskRead) {
            throw guardError(
              `Worker attempted ${input.tool} before reading the exact active task ${workerState.taskPath}.`,
              `Read ${workerState.taskPath} with the read tool now. The Harness runs the required preflight mechanically before the first implementation read.`,
            )
          }
        }

        const requestedReadPath = input.tool === "read" && paths.length === 1 ? paths[0] : null
        const requestedReadAbsolute = requestedReadPath ? resolve(root, requestedReadPath) : null
        const taskScope = scopeFromTask(root, workerState.taskPath)
        const mechanicalPreflightRead = requestedReadPath
          && output.args?.offset === undefined
          && output.args?.limit === undefined
          && !exactTaskRead
          && !auxiliaryRead
          && !workerControlTool
          && !workerVerifyRequired.has(input.sessionID)
          && !workerPreflightComplete(input.sessionID, workerState)
          && allowed(requestedReadPath, taskScope.paths)
          && !isProtected(requestedReadPath, protectedPaths)
          && requestedReadAbsolute
          && existsSync(requestedReadAbsolute)
          && lstatSync(requestedReadAbsolute).isFile()
          && !lstatSync(requestedReadAbsolute).isSymbolicLink()
        if (mechanicalPreflightRead) {
          try {
            const { run, mutationRevision } = await ensureMechanicalDoctorPreflight(input.sessionID, workerState)
            const observation = await observeMechanicalWorkerDoctor(
              input.sessionID,
              workerState,
              run,
              "initial_preflight",
              mutationRevision,
            )
            if (observation.terminal) {
              throw new Error(sessionFeedback.get(input.sessionID) ?? run.output)
            }
            workerMechanicalDoctorNotices.set(input.sessionID, {
              taskPath: workerState.taskPath,
              taskHash: workerState.taskHash,
              status: run.status,
              output: run.output,
              findingTarget: observation.findingTarget,
              runID: run.runID,
            })
            await log("info", "Mechanically completed missing Worker preflight before implementation read", {
              sessionID: input.sessionID,
              task: workerState.taskPath,
              requestedPath: requestedReadPath,
              findingTarget: observation.findingTarget,
              status: run.status,
              runID: run.runID,
            })
          } catch (error) {
            if (taskHarnessRecoveryStatus(root)
              || workerHarnessRecoveryTerminals.has(input.sessionID)
              || workerHelpTerminalSessions.has(input.sessionID)
              || workerHelpForSession(input.sessionID, workerState.taskPath, workerState.taskHash)) throw error
            const message = error instanceof Error ? error.message : String(error)
            sessionFeedback.set(input.sessionID, [
              "MECHANICAL DOCTOR PREFLIGHT FAILED",
              message,
              `The read of ${requestedReadPath} was not executed and no preflight evidence was cached.`,
              "Retry only after the cause changes; the exact trusted fallback is verify_worker_task.",
            ].join("\n"))
            await log("warn", "Mechanical Worker preflight failed closed", {
              sessionID: input.sessionID,
              task: workerState.taskPath,
              requestedPath: requestedReadPath,
              error: message,
            })
            throw new Error(sessionFeedback.get(input.sessionID))
          }
        }

        if (!workerPreflightComplete(input.sessionID, workerState)
          && !exactTaskRead
          && !auxiliaryRead
          && !workerControlTool
          && !exactVerify
          && !trustedWorkerVerify
          && !trustedWorkerPreview) {
          throw guardError(
            `Worker attempted ${input.tool} before the required Doctor preflight for ${workerState.taskPath}.`,
            "Call verify_worker_task now. Use its exact findings before inspecting any implementation file.",
          )
        }

        if (workerVerifyRequired.has(input.sessionID)
          && !exactVerify
          && !trustedWorkerVerify
          && !workerControlTool
          && !exactTaskRead
          && !auxiliaryRead) {
          throw guardError(
            "Worker attempted another action after applying one project file.",
            "Call verify_worker_task now. Do not inspect or preview another Scope file first.",
          )
        }

        const findingTarget = workerFindingTargets.get(input.sessionID)
        if (findingTarget && workerFindingReads.get(input.sessionID) !== findingTarget) {
          const scope = scopeFromTask(root, workerState.taskPath)
          const readsFindingTarget = input.tool === "read" && paths.length === 1 && paths[0] === findingTarget
          if (readsFindingTarget
            && paths[0] === findingTarget
            && scope.newPaths.includes(findingTarget)
            && !existsSync(resolve(root, findingTarget))) {
            workerFindingReads.set(input.sessionID, findingTarget)
          }
          if (!readsFindingTarget && !exactTaskRead && !auxiliaryRead && !workerControlTool && !exactVerify && !trustedWorkerVerify) {
            throw guardError(
              `${findingTarget} has not been read since the current Doctor failure.`,
              `Read ${findingTarget} first. Then inspect only related in-scope causes and apply one justified file; the trusted Apply tool verifies before another change.`,
            )
          }
        }
      }

      if (features.plannerQuestionEnforcer && plannerMode && plannerQuestionCorrections.has(input.sessionID)) {
        if (input.tool === "question") {
          if (plannerExecutionQuestion(output.args)) {
            throw guardError(
              "Planner attempted to ask whether tasks should be delegated or executed.",
              "Do not ask this decision. Report that the registered tasks are ready for Executor, then stop. Only Executor may delegate Worker.",
            )
          }
          plannerQuestionCorrections.delete(input.sessionID)
        } else if (input.tool === "record_guard_learning") {
          return
        } else {
          throw guardError(
            "The previous Planner response asked unresolved decisions in plain text instead of using the question tool.",
            "Call the question tool now for those decisions. Do not inspect more files, create tasks, or restate the questions as normal text first.",
            "The question tool is shown to the user.",
          )
        }
      }

      const redundantExecutorSchedule = executorMode
        && input.tool === "bash"
        && /^npm\s+run\s+task:doctor:schedule\s*$/.test(command)
        && executorReadyAfterSchedule.has(input.sessionID)
      if (features.repetitionDetector && !redundantExecutorSchedule) {
        const signature = JSON.stringify([input.tool, output.args])
        const previous = repetitions.get(input.sessionID)
        const count = previous?.signature === signature ? previous.count + 1 : 1
        repetitions.set(input.sessionID, { signature, count })
        if (count >= 3) {
          if (features.workerHelp && workerMode) {
            const target = paths[0] ?? (command ? command.replace(/\s+/g, " ").trim().slice(0, 120) : `<${input.tool}>`)
            const latestFailure = [...(loopFailures.get(input.sessionID)?.values() ?? [])]
              .filter((failure) => failure.fingerprint.tool === input.tool && Date.now() - failure.lastAt <= 10 * 60_000)
              .sort((left, right) => right.lastAt - left.lastAt)[0]
            const fingerprint: LoopFailureFingerprint = latestFailure?.fingerprint ?? {
              signature: `exact|${input.tool}|${target}`,
              tool: input.tool,
              target,
              category: "identical-tool-call",
              problem: "The same tool call was attempted three times without a different action.",
            }
            workerHelpRequired.set(input.sessionID, { count, fingerprint })
            sessionFeedback.set(input.sessionID, `MODEL LOOP STOP\nThe same tool call was attempted three times. Latest problem: ${fingerprint.problem}\nCall request_executor_help and end this Worker run.`)
            throw new Error(`MODEL LOOP STOP\nThe same tool call was attempted three times for ${target}. Latest problem: ${fingerprint.problem}\nCall request_executor_help now and then stop.`)
          }
          const reason = [
            "MODEL LOOP STOP",
            "The same tool call was attempted three times without a different action.",
            "Stop this role run. A new user instruction is required before another tool call.",
          ].join("\n")
          terminalRoleLoopReasons.set(input.sessionID, reason)
          sessionFeedback.set(input.sessionID, reason)
          throw new Error(reason)
        }
      }

      if (features.dependencyInstallPermission && workerMode && dependencyInstallCommand.test(command)
        && (input.tool === "bash" || input.tool === "request_command_permission")) {
        throw guardError(
          "Dependency installation requires a dedicated user approval and cannot use bash or the generic command exception.",
          "Use request_dependency_install_permission. State the reason, exact workspace, exact packages, and whether they are dev dependencies. Request only packages explicitly named in the active task, then wait for the user.",
        )
      }

      if (features.transactionalWorkerChanges && workerMode
        && input.tool === "bash"
        && !isDoctorCommand(command)
        && !plannerReadOnlyCommand(command)
        && !workerPortCommand.test(command)) {
        throw guardError(
          "Worker attempted a shell command outside the transactional allowlist.",
          "Use read, glob, grep, or one read-only shell command for inspection. Use Doctor commands for lifecycle verification, npm run app:clear-ports for configured ports, and preview_worker_changes plus apply_worker_changes for project mutations. Arbitrary scripts and interpreters are not supported.",
        )
      }

      if (features.transactionalWorkerChanges && workerMode
        && (writeTools.has(input.tool) || (input.tool === "bash" && mutation))) {
        throw guardError(
          input.tool === "bash"
            ? "Worker attempted a direct mutating shell command."
            : `Worker attempted a direct ${input.tool} mutation.`,
          "Use preview_worker_changes with one flat exact scoped replace, rewrite, create, or delete operation. Inspect its diff, then call apply_worker_changes without arguments. Arbitrary mutation scripts and shell commands are not supported.",
          "WORKER CHANGE APPLIED <change_id>",
        )
      }

      if (features.modeGuard && input.tool === "task" && workerSubagentType(output.args?.subagent_type)) {
        if (!executorMode) {
          throw guardError(
            "A role other than Executor attempted to delegate Worker.",
            "Switch to Executor. Only Executor may spawn or resume Worker for a registered task.",
          )
        }
        const memoryRecovery = projectMemoryRecoveryStatus(root)
        if (memoryRecovery) {
          throw projectGuardError(input.sessionID,
            `Project memory requires Executor recovery: ${memoryRecovery.size} bytes exceeds ${memoryRecovery.maxSize}.`,
            "Do not delegate Worker. Read MEMORY.md, preserve durable facts, call recover_project_memory, then rerun task:doctor:schedule.",
          )
        }
        if (pendingHarnessRecovery) {
          throw projectGuardError(input.sessionID,
            `Harness baseline recovery is required for ${pendingHarnessRecovery.taskPath}.`,
            `Inspect ${pendingHarnessRecovery.paths.map((entry) => entry.path).join(", ")}, then call recover_harness_baseline with exactly those paths before delegating Worker.`,
          )
        }
        const delegated = delegatedTaskPaths(output.args)
        if (delegated.length !== 1) {
          throw guardError(
            "Worker delegation does not name exactly one Kanban task.",
            "Delegate one Worker with one exact kanban/todo/<task>.md path in both description and prompt.",
          )
        }
        const state = activeState(root)
        if (features.workerHelp) reconcileWorkerHelpRevision(state)
        if (features.plannerRecovery && state?.status === "started" && typeof (client as any)?.session?.messages === "function") {
          let explicitRequest: ExplicitPlannerRecoveryRequest | null = null
          let rejectsPlanner = false
          try {
            const messages = await loadSessionMessages(input.sessionID)
            explicitRequest = explicitUserPlannerRecoveryRequest(messages, state.taskPath)
            rejectsPlanner = explicitUserRejectsPlanner(messages, state.taskPath)
          } catch {
            explicitRequest = null
            rejectsPlanner = false
          }
          if (rejectsPlanner
            && cancelRejectedPendingPlannerRecovery(input.sessionID, state.taskPath, state.taskHash)) {
            await log("info", "Self-healed an uncommitted Planner recovery before Worker delegation", {
              sessionID: input.sessionID,
              task: state.taskPath,
            })
          }
          const receipt = explicitPlannerReviewReceipt()
          const recoverySatisfied = receipt?.status === "complete"
            && receipt.executorSessionID === input.sessionID
            && receipt.taskPath === state.taskPath
            && receipt.taskHash === state.taskHash
            && (!explicitRequest
              || receipt.userMessageID === explicitRequest.messageID
              || receipt.completedForMessageID === explicitRequest.messageID)
          const pendingRecovery = receipt?.status === "pending" && receipt.taskPath === state.taskPath
          if ((explicitRequest && !recoverySatisfied) || pendingRecovery) {
            const pendingInAnotherExecutor = pendingRecovery && receipt.executorSessionID !== input.sessionID
            throw projectGuardError(input.sessionID,
              pendingRecovery
                ? `Planner recovery for ${state.taskPath} is still pending from Executor ${receipt.executorSessionID}.`
                : `The current user explicitly requested Planner recovery for ${state.taskPath} before Worker delegation.`,
              pendingInAnotherExecutor
                ? `Stop and tell the user to resume Executor session ${receipt.executorSessionID}. Only that session may call escalate_to_planner and finish the hash-bound review.`
                : pendingRecovery
                  ? `Call escalate_to_planner with only task_path=${state.taskPath}; the pending frozen receipt restores every other field mechanically. Do not schedule or delegate until it returns PLANNER RECOVERY COMPLETE.`
                  : `Call escalate_to_planner for ${state.taskPath} with file-backed evidence and an exact recovery contract now. Do not schedule or delegate until it returns PLANNER RECOVERY COMPLETE.`,
            )
          }
        }
        const plannerRecovery = plannerRecoveryState(root)
        if (plannerRecovery?.version === 1
          && plannerRecovery.taskPath === state?.taskPath
          && plannerRecovery.taskHash === state?.taskHash
          && ["unavailable", "incomplete"].includes(plannerRecovery.status)) {
          throw new Error([
            plannerRecovery.status === "unavailable" ? "PLANNER UNAVAILABLE" : "PLANNER RECOVERY INCOMPLETE",
            `Task: ${plannerRecovery.taskPath}`,
            `Planner session: ${plannerRecovery.plannerSessionID ?? "none"}`,
            `Reason: ${plannerRecovery.reason}`,
            plannerRecovery.status === "unavailable"
              ? "Stop and tell the user to open a Planner and correct the task manually. Do not delegate Worker."
              : "Stop and tell the user to continue the owning Planner session manually. Do not delegate Worker.",
          ].join("\n"))
        }
        let requestedWorkerSession = output.args?.session_id
          ?? output.args?.sessionID
          ?? output.args?.task_id
          ?? output.args?.taskID
        if (state?.status !== "started"
          && state?.status !== "passed"
          && typeof requestedWorkerSession === "string"
          && requestedWorkerSession.length > 0) {
          for (const field of ["session_id", "sessionID", "task_id", "taskID"]) delete output.args[field]
          await log("warn", "Removed a session selector from a fresh READY Worker delegation", {
            sessionID: input.sessionID,
            task: delegated[0],
            staleWorkerSessionID: requestedWorkerSession,
          })
          requestedWorkerSession = undefined
        }
        let latestHelp = features.workerHelp ? latestWorkerHelp(root, delegated[0], state?.taskHash) : null
        if (latestHelp?.status === "delegated"
          && latestHelp.delegatedWorkerSessionID
          && requestedWorkerSession === latestHelp.delegatedWorkerSessionID
          && latestHelp.recoveryBoost?.phase === "base_continuation_started") {
          latestHelp = await reconcileStartedBaseContinuation(latestHelp)
        }
        if (latestHelp?.status === "delegated"
          && latestHelp.delegatedWorkerSessionID
          && requestedWorkerSession === latestHelp.delegatedWorkerSessionID
          && latestHelp.recoveryBoost?.phase === "base_continuation_completed"
          && latestHelp.recoveryBoost.baseContinuationModel
          && !latestHelp.recoveryBoost.baseContinuationDeliveredAt) {
          const recoveredResult = latestHelp.recoveryBoost.baseContinuationResultText
          const recoveredHash = latestHelp.recoveryBoost.baseContinuationResultHash
          if (!recoveredResult || !recoveredHash || hash(recoveredResult) !== recoveredHash) {
            throw projectGuardError(input.sessionID,
              `Worker recovery continuation for ${latestHelp.delegatedWorkerSessionID} completed, but its persisted result evidence is missing or corrupt.`,
              "Do not start another Worker turn. Inspect the bound session transcript and restore only causally verified Base-result evidence.",
            )
          }
          if (claimsReviewableHandoff(recoveredResult)) {
            rememberReviewableWorker(latestHelp.taskPath, latestHelp.delegatedWorkerSessionID)
          }
          recordAuthoritativeWorkerOwner({
            executorSessionID: input.sessionID,
            workerSessionID: latestHelp.delegatedWorkerSessionID,
            taskPath: latestHelp.taskPath,
            taskHash: latestHelp.taskHash,
            resultText: recoveredResult,
          })
          updateWorkerHelp(latestHelp.id, (request) => request.recoveryBoost?.phase === "base_continuation_completed"
            ? {
                ...request,
                recoveryBoost: {
                  ...request.recoveryBoost,
                  baseContinuationDeliveredAt: new Date().toISOString(),
                },
              }
            : request)
          throw new Error([
            "WORKER BASE CONTINUATION RECOVERED",
            `Task: ${latestHelp.taskPath}`,
            `Worker session: ${latestHelp.delegatedWorkerSessionID}`,
            "The Harness recovered and consumed the causally persisted Base result instead of starting another Worker turn:",
            recoveredResult,
            "Review this exact handoff now. A later legitimate task_id resume uses the normal Base Worker path.",
          ].join("\n\n"))
        }
        if (latestHelp?.status === "delegated"
          && latestHelp.delegatedWorkerSessionID
          && requestedWorkerSession === latestHelp.delegatedWorkerSessionID
          && latestHelp.recoveryBoost?.phase === "base_continuation_started") {
          const expectedCallID = latestHelp.recoveryBoost.baseContinuationCallID
          const currentCallID = typeof input.callID === "string" && input.callID.length > 0 ? input.callID : null
          if (!expectedCallID || currentCallID !== expectedCallID) {
            throw projectGuardError(input.sessionID,
              `Worker recovery continuation for ${latestHelp.delegatedWorkerSessionID} is already in flight.`,
              "Do not start or resume another Worker turn. Wait for the bound continuation result; after restart the Harness accepts only its causally marked completed transcript.",
            )
          }
        }
        let mechanicallyStagedHelp: WorkerHelpRequest | null = null
        const activeBoostResume = Boolean(
          latestHelp?.status === "delegated"
          && latestHelp.delegatedWorkerSessionID
          && requestedWorkerSession === latestHelp.delegatedWorkerSessionID
          && latestHelp.recoveryBoost?.phase === "active",
        )
        const activeBoostReview = activeBoostResume && latestHelp?.delegationPriorStatus
          ? { ...latestHelp, status: latestHelp.delegationPriorStatus }
          : null
        if (latestHelp?.status === "delegated" && !latestHelp.delegatedWorkerSessionID) {
          const callID = typeof input.callID === "string" && input.callID.length > 0 ? input.callID : null
          const staged = (pendingHelpDelegations.get(input.sessionID) ?? []).find((entry) => (
            entry.helpID === latestHelp.id
            && entry.source === "mechanical"
            && typeof latestHelp.delegationAttemptNonce === "string"
            && entry.attemptNonce === latestHelp.delegationAttemptNonce
            && (entry.callID === null || entry.callID === callID)
          ))
          if (staged && callID && latestHelp.delegationPriorStatus) {
            const stagedReview = { ...latestHelp, status: latestHelp.delegationPriorStatus }
            const decision = workerDelegationModelDecision(root, stagedReview.status === "retry_approved")
            const expectedAgent = decision.boosted ? WORKER_RECOVERY_BOOST_AGENT : "worker"
            const expectedPrompt = mechanicalDelegationPrompt(
              canonicalWorkerPrompt(root, delegated[0], state, stagedReview),
              latestHelp.delegationAttemptNonce!,
            )
            const exactMechanicalCall = output.args?.description === latestHelp.delegationDescription
              && output.args?.subagent_type === expectedAgent
              && output.args?.prompt === expectedPrompt
            if (exactMechanicalCall) {
              staged.callID = callID
              staged.attemptNonce = null
              mechanicallyStagedHelp = stagedReview
              updateWorkerHelp(latestHelp.id, (request) => {
                if (request.status !== "delegated" || request.delegatedWorkerSessionID) return request
                const { delegationAttemptNonce: _attemptNonce, ...current } = request
                return { ...current, delegationCallID: callID }
              })
            }
          }
        }
        if (latestHelp?.status === "delegated"
          && !mechanicallyStagedHelp
          && (!latestHelp.delegatedWorkerSessionID
            || requestedWorkerSession !== latestHelp.delegatedWorkerSessionID)) {
          throw projectGuardError(input.sessionID,
            latestHelp.delegatedWorkerSessionID
              ? `Worker help ${latestHelp.id} is already delegated to ${latestHelp.delegatedWorkerSessionID}.`
              : `Worker help ${latestHelp.id} already has a Worker delegation in flight.`,
            latestHelp.delegatedWorkerSessionID
              ? `Resume only the bound Worker session ${latestHelp.delegatedWorkerSessionID}; do not start a duplicate Worker.`
              : "Wait for the current task tool to bind its child session. If that tool fails, the Harness restores the reviewed retry automatically; do not start a duplicate Worker.",
          )
        }
        const reviewedHelp = mechanicallyStagedHelp
          ?? activeBoostReview
          ?? (features.workerHelp ? currentWorkerHelp(root, delegated[0], state?.taskHash) : null)
        if (reviewedHelp?.status === "pending") {
          throw projectGuardError(input.sessionID,
            `Worker help ${reviewedHelp.id} has not been reviewed.`,
            `Call review_worker_help for ${reviewedHelp.id}. Inspect ${reviewedHelp.taskPath} and every relevant application file, then choose retry_worker or planner_recovery before delegating another Worker.`,
          )
        }
        if (reviewedHelp?.status === "retry_approved" && executorHelpReReviewRequested.get(input.sessionID) === reviewedHelp.id) {
          throw projectGuardError(input.sessionID,
            `Worker help ${reviewedHelp.id} must be re-reviewed because the current user requested review before delegation.`,
            `Call review_worker_help for ${reviewedHelp.id} now. Do not delegate Worker from the older retry approval.`,
          )
        }
        if (reviewedHelp?.status === "retry_approved" && executorHelpReviewPending.get(input.sessionID) === reviewedHelp.id) {
          throw projectGuardError(input.sessionID,
            `Worker help ${reviewedHelp.id} loaded newer review evidence, but the updated review was not finalized.`,
            `Call review_worker_help for ${reviewedHelp.id} again now. Do not delegate Worker until the tool returns the updated decision and structured guidance.`,
          )
        }
        if (reviewedHelp?.status === "planner_unavailable" || reviewedHelp?.status === "planner_recovery_incomplete") {
          throw new Error([
            reviewedHelp.status === "planner_unavailable" ? "PLANNER UNAVAILABLE" : "PLANNER RECOVERY INCOMPLETE",
            `Task: ${reviewedHelp.taskPath}`,
            `Owning Planner session: ${readPlannerOwnership(root, reviewedHelp.taskPath)?.plannerSessionID ?? "none"}`,
            reviewedHelp.status === "planner_unavailable"
              ? "Stop now. Tell the user to open a Planner and correct the task manually. Do not delegate another Worker."
              : "Stop now. Tell the user to continue the owning Planner session manually. Do not delegate another Worker.",
          ].join("\n"))
        }
        if (!activeBoostResume
          && reviewedHelp
          && (reviewedHelp.status === "retry_approved" || reviewedHelp.status === "task_changed")
          && typeof requestedWorkerSession === "string"
          && requestedWorkerSession.length > 0) {
          for (const field of ["session_id", "sessionID", "task_id", "taskID"]) delete output.args[field]
          await log("warn", "Removed a stale Worker session selector from a fresh reviewed retry", {
            sessionID: input.sessionID,
            helpID: reviewedHelp.id,
            task: reviewedHelp.taskPath,
            staleWorkerSessionID: requestedWorkerSession,
          })
          requestedWorkerSession = undefined
        }
        if (state?.status === "started" || state?.status === "passed") {
          if (delegated[0] !== state.taskPath) {
            throw guardError(
              `${state.taskPath} is active, so ${delegated[0]} cannot be delegated.`,
              `Delegate only ${state.taskPath} as an active-task resume. Do not start another task.`,
            )
          }
          if (state.status === "passed" && features.executorReview) {
            throw guardError(
              `${state.taskPath} passed Doctor and must not be delegated to Worker again.`,
              "Call submit_task_review without arguments to complete the hash-bound Doctor-passed task; do not spawn Worker.",
            )
          }
        } else {
          const schedule = run(root, "npm", ["run", "task:doctor:schedule"])
          const readyPrefix = "TASK DOCTOR: READY "
          const ready = schedule.stdout
            .split(/\r?\n/)
            .filter((line) => line.startsWith(readyPrefix))
            .map((line) => line.slice(readyPrefix.length).trim())
            .filter((path) => normalize(root, path) === path && planningPath.test(path))
          if (!ready.includes(delegated[0])) {
            throw guardError(
              `${delegated[0]} is not READY in the current Doctor schedule.`,
              ready.length > 0
                ? `Delegate only one of these READY tasks: ${ready.join(", ")}.`
                : "Do not spawn a Worker. Report that Doctor has no READY task.",
            )
          }
        }
        const freshReviewedRetry = (reviewedHelp?.status === "retry_approved"
          || reviewedHelp?.delegationPriorStatus === "retry_approved")
          && !(typeof requestedWorkerSession === "string" && requestedWorkerSession)
        const boostRetryDelegation = freshReviewedRetry || activeBoostResume
        const modelDecision = workerDelegationModelDecision(root, boostRetryDelegation)
        const clearedBoostResume = Boolean(
          latestHelp?.status === "delegated"
          && latestHelp.delegatedWorkerSessionID
          && requestedWorkerSession === latestHelp.delegatedWorkerSessionID
          && latestHelp.recoveryBoost?.phase === "cleared",
        )
        let externalBaseContinuationMarker: string | null = latestHelp?.recoveryBoost?.phase === "base_continuation_started"
          && latestHelp.recoveryBoost.baseContinuationCallID === input.callID
          && latestHelp.recoveryBoost.baseContinuationNonce
          ? baseContinuationMarker(latestHelp.recoveryBoost.baseContinuationNonce)
          : null
        if ((clearedBoostResume || (activeBoostResume && !modelDecision.boosted)) && latestHelp) {
          const baseModel = automaticAgentModel(root, "worker", modelDecision.model)
          if (!baseModel) {
            throw new Error("Worker recovery boost ended, but the base Worker model could not be resolved for the bound session resume.")
          }
          const continuationNonce = newMechanicalDelegationNonce()
          startBaseWorkerContinuation(latestHelp.id, baseModel, input.callID, continuationNonce)
          externalBaseContinuationMarker = baseContinuationMarker(continuationNonce)
          if (activeBoostResume && !modelDecision.boosted) {
            await log("warn", "Ended active Worker recovery boost because its hidden alias became unavailable", {
              sessionID: input.sessionID,
              workerSessionID: requestedWorkerSession,
              helpID: latestHelp.id,
              task: latestHelp.taskPath,
              reason: modelDecision.reason,
              model: modelRefString(baseModel),
            })
          }
        }
        delete output.args.model
        output.args.subagent_type = boostRetryDelegation && modelDecision.boosted
          ? WORKER_RECOVERY_BOOST_AGENT
          : "worker"
        await log(modelDecision.invalidBoost ? "warn" : "info", "Selected Worker delegation model", {
          sessionID: input.sessionID,
          task: delegated[0],
          path: "task-tool",
          helpID: boostRetryDelegation ? reviewedHelp?.id ?? latestHelp?.id ?? null : null,
          boosted: modelDecision.boosted,
          lookupAgent: output.args.subagent_type,
          selector: modelDecision.selector,
          reason: modelDecision.reason,
          model: modelDecision.model ? modelRefString(modelDecision.model) : null,
        })
        output.args.description = `${state?.status === "started" ? "Resume" : "Execute"} ${delegated[0]}`
        output.args.prompt = canonicalWorkerPrompt(root, delegated[0], state, reviewedHelp)
        if (externalBaseContinuationMarker) {
          output.args.prompt = `${output.args.prompt}\n\n${externalBaseContinuationMarker}`
        }
        const priorReviewableWorkers = reviewableWorkerSessions.get(delegated[0])
        if (typeof requestedWorkerSession === "string" && requestedWorkerSession) {
          requestedWorkerSessionResumes.set(requestedWorkerSession, Date.now())
        }
        if (priorReviewableWorkers) {
          for (const workerSessionID of [...priorReviewableWorkers]) {
            if (requestedWorkerSession === workerSessionID) continue
            if (await archiveTerminalWorkerSession(workerSessionID, "fresh Worker delegated after review")) {
              forgetReviewableWorker(delegated[0], workerSessionID)
            }
          }
        }
        executorReviewReads.delete(input.sessionID)
        if (!mechanicallyStagedHelp
          && !activeBoostResume
          && reviewedHelp
          && (reviewedHelp.status === "retry_approved" || reviewedHelp.status === "task_changed")) {
          stageHelpDelegation(input.sessionID, reviewedHelp, input.callID, "direct")
          if (reviewedHelp.status === "retry_approved") queueReviewedWorkerRetry(input.sessionID, state, reviewedHelp)
          updateWorkerHelp(reviewedHelp.id, (request) => {
            const { delegatedWorkerSessionID: _staleWorkerSessionID, ...current } = request
            return {
              ...current,
              ...persistedHelpDelegation(
                input.sessionID,
                reviewedHelp,
                input.callID,
                "direct",
                undefined,
                modelDecision.boosted,
              ),
            }
          })
        }
        if (activeBoostResume && typeof requestedWorkerSession === "string") {
          const callID = typeof input.callID === "string" && input.callID.length > 0 ? input.callID : null
          if (!callID) {
            throw projectGuardError(input.sessionID,
              `Active Worker recovery boost resume for ${requestedWorkerSession} has no task-call identity.`,
              "Retry the exact bound task_id once through TaskTool so the Harness can bind its in-flight call mechanically.",
            )
          }
          const inFlight = activeBoostResumeCalls.get(requestedWorkerSession)
          if (inFlight && (inFlight.callID !== callID || inFlight.parentSessionID !== input.sessionID)) {
            throw projectGuardError(input.sessionID,
              `Worker recovery boost resume for ${requestedWorkerSession} is already in flight.`,
              "Wait for the bound boosted turn to finish. Do not start a parallel or duplicate task_id resume.",
            )
          }
          activeBoostResumeCalls.set(requestedWorkerSession, { callID, parentSessionID: input.sessionID })
        }
      }

      if (features.modeGuard) {
        const role = plannerMode ? "planner" : executorMode ? "executor" : workerMode ? "worker" : "unknown"
        const plannerDoctor = input.tool === "bash" && /^npm\s+run\s+task:doctor:(?:next|schedule)\s*$/.test(command)
        const plannerInspection = input.tool === "bash" && plannerReadOnlyCommand(command)
        const planningTaskPath = paths.find((path) => planningPath.test(path))
        const roleState = plannerMode ? activeState(root) : null
        const block = reduceWorkflow({ type: "role.tool", input: {
          role,
          tool: input.tool,
          command,
          writes: writeTools.has(input.tool),
          invocation,
          plannerDoctor,
          plannerInspection,
          plannerOperation: plannerMode && input.tool === "bash" && plannerAppCommand.test(command),
          plannerWrite,
          plannerExecutionQuestion: plannerMode && input.tool === "question" && plannerExecutionQuestion(output.args),
          planningEnforcer: features.planningEnforcer,
          planningTaskPath,
          activeTask: roleState?.taskPath ? { status: roleState.status, taskPath: roleState.taskPath } : null,
          taskChangePermission: features.taskChangePermission,
        } }).value as { problem: string; action: string; success?: string } | null
        if (block) throw guardError(block.problem, block.action, block.success)
      }
      const runningTask = activeState(root)
      const taskPaths = todoTasks(root).map((name) => `kanban/todo/${name}`)
      const lifecycleBlock = reduceWorkflow({ type: "lifecycle.tool", input: {
        role: plannerMode ? "planner" : executorMode ? "executor" : workerMode ? "worker" : "unknown",
        command: input.tool === "bash" ? command : "",
        invocation,
        activeTask: runningTask,
        todoTaskPaths: taskPaths,
        mutation,
        targetPaths: paths,
        taskMemoryAppend: features.taskMemoryAppend,
        modeGuard: features.modeGuard,
        contextCheckpoint: features.contextCheckpoint,
        checkpointPending: pendingCompact.has(input.sessionID) && input.tool !== "record_guard_learning",
        executorReview: features.executorReview,
        doctorCommandMentioned: doctorCommandMention.test(command),
        exactDoctorCommand: isDoctorCommand(command),
      } }).value as { problem: string; action: string; success?: string } | null
      if (lifecycleBlock) throw guardError(lifecycleBlock.problem, lifecycleBlock.action, lifecycleBlock.success)

      const planningWrite = plannerWrite || (paths.length > 0 && paths.every((path) => planningPath.test(path)))
      const lifecycleCommand = isDoctorCommand(command)
      const workerPortOperation = workerMode && input.tool === "bash" && workerPortCommand.test(command)
      const taskGuardExempt = planningWrite || lifecycleCommand || workerPortOperation
      const taskScope = runningTask?.status === "started" ? scopeFromTask(root, runningTask.taskPath) : null
      const mkdirPaths = input.tool === "bash"
        ? (simpleMkdirTargets(command) ?? []).map((path) => normalize(root, path)).filter((path): path is string => path !== null)
        : []
      const outsideScopePath = taskScope
        ? paths.find((path) => !allowed(path, taskScope.paths)
          && !(mkdirPaths.includes(path) && allowedNewParentDirectory(path, taskScope.newPaths)))
        : null
      const newTask = features.planningEnforcer ? isNewTodoWrite(root, paths) : null
      const unfinishedTaskName = newTask ? todoTasks(root).find((name) => !taskRegistrationValid(root, name)) : null
      const operationBlock = reduceWorkflow({ type: "operation.tool", input: {
        tool: input.tool,
        internalFileGuard: features.internalFileGuard,
        protectedTarget: !lifecycleCommand
          ? paths.find((path) => isProtected(path, protectedPaths)) ?? protectedPaths.find((path) => command.includes(path))
          : null,
        readOnlyTarget: paths.find((path) => isProtected(path, readOnlyPaths)) ?? readOnlyPaths.find((path) => command.includes(path)),
        activeTask: runningTask,
        firstTodoTask: taskPaths[0],
        todoDiscipline: features.todoDiscipline,
        todos: Array.isArray(output.args?.todos) ? output.args.todos : [],
        doctorEvidence: [...(doctorEvidence.get(input.sessionID) ?? [])],
        planningEnforcer: features.planningEnforcer,
        newTask,
        unfinishedTask: unfinishedTaskName ? `kanban/todo/${unfinishedTaskName}` : null,
        taskStartGuard: features.taskStartGuard,
        mutation,
        taskGuardExempt,
        firstTaskRegistered: taskPaths[0] ? taskRegistrationValid(root, taskPaths[0].split("/").pop()!) : false,
        outsideScopePath,
        opaqueInlineWithoutPaths: opaqueInline && paths.length === 0,
        pathlessShellMutation: input.tool === "bash" && mutation && paths.length === 0,
        userPermissionEscalation: features.userPermissionEscalation,
        transactionalWorkerChanges: features.transactionalWorkerChanges,
      } }).value as { problem: string; action: string; success?: string } | null
      if (operationBlock) throw guardError(operationBlock.problem, operationBlock.action, operationBlock.success)

      if (!features.taskStartGuard || !mutation || taskGuardExempt) {
        if (automaticRequiredTaskRead) {
          pendingAutomaticWorkerTaskReads.set(input.sessionID, automaticRequiredTaskRead)
          await log("info", "Staged an exact automatic Worker task read for the reviewed first target", {
            sessionID: input.sessionID,
            task: automaticRequiredTaskRead.taskPath,
            taskHash: automaticRequiredTaskRead.taskHash,
            target: automaticRequiredTaskRead.targetPath,
            modelFamily: automaticRequiredTaskRead.modelFamily,
          })
        }
        return
      }
      })
      } finally {
        if (customModelToolNames.has(input.tool)) {
          output.args = compactWorkflowToolArgsInPlace(input.tool, output.args)
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      await hydrateSessionIdentity(input.sessionID)
      const safeArgs = await checkedModelArgs(input.tool, input.args, input.sessionID, false)
      const safeInput = { ...input, args: safeArgs }
      if (!enabled) return
      if (!output) {
        const pendingAutomaticTaskRead = pendingAutomaticWorkerTaskReads.get(input.sessionID)
        const currentCallID = typeof input.callID === "string" && input.callID.length > 0 ? input.callID : null
        if (pendingAutomaticTaskRead
          && (!pendingAutomaticTaskRead.callID || pendingAutomaticTaskRead.callID === currentCallID)) {
          pendingAutomaticWorkerTaskReads.delete(input.sessionID)
        }
        if (input.tool === "task") {
          await restoreStagedHelpDelegations(input.sessionID, "Worker task tool returned no result", input.callID)
        }
        await log("warn", "Ignoring missing tool-after output after restoring staged delegation", {
          sessionID: input.sessionID,
          tool: input.tool,
        })
        return
      }
      const driver = driverForSession(input.sessionID)
      const paths = targetPaths(root, input.tool, safeArgs)
      const command = String(safeArgs.command ?? "")
      const agent = sessionAgents.get(input.sessionID) ?? ""
      const malformedRetry = malformedWorkflowToolRetries.get(input.sessionID)
      if (input.tool === "review_worker_help" && malformedRetry?.target === input.tool) {
        malformedWorkflowToolRetries.delete(input.sessionID)
        if (sessionFeedback.get(input.sessionID) === malformedRetry.feedback) sessionFeedback.delete(input.sessionID)
        terminalExecutorReasons.delete(input.sessionID)
      }
      if (input.tool === "review_worker_help") executorHelpReReviewRequested.delete(input.sessionID)
      const invalidTarget = input.tool === "invalid" && typeof safeArgs.tool === "string"
        ? safeArgs.tool
        : null
      const invalidError = input.tool === "invalid" ? String(safeArgs.error ?? "") : ""
      if (modeSettings.executorAgents.has(agent)
        && invalidTarget === "review_worker_help"
        && invalidError.includes("Invalid input for tool review_worker_help:")) {
        const revision = driverWorkflowState().revision
        const previous = malformedWorkflowToolRetries.get(input.sessionID)
        const retry = previous?.target === invalidTarget && previous.revision === revision
          ? previous
          : { target: invalidTarget, revision, attempts: 0, seenCallIDs: new Set<string>(), feedback: "" }
        if (!retry.seenCallIDs.has(input.callID)) {
          retry.seenCallIDs.add(input.callID)
          retry.attempts += 1
        }
        retry.feedback = retry.attempts <= 1
          ? [
              "Failure: OpenCode rejected an incomplete review_worker_help call.",
              "Retry review_worker_help exactly once now with no surrounding prose.",
              "Omit help_id when one request is pending. Use one short sentence each for root_cause and retry_strategy, 2-4 concise expected_results, and only exact reviewed paths.",
            ].join("\n")
          : [
              "Failure: review_worker_help produced malformed JSON twice for the same workflow state.",
              "Stop now and report this bounded tool-call blocker. Do not delegate Worker or repeat the malformed call until the user sends a new instruction.",
            ].join("\n")
        malformedWorkflowToolRetries.set(input.sessionID, retry)
        sessionFeedback.set(input.sessionID, retry.feedback)
        output.title = retry.attempts <= 1 ? "Retry incomplete Worker help review" : "Worker help review tool blocked"
        output.output = retry.feedback
        output.metadata = {
          ...output.metadata,
          workflowToolRetry: invalidTarget,
          malformedAttempts: retry.attempts,
          bounded: true,
        }
        if (retry.attempts > 1) terminalExecutorReasons.set(input.sessionID, retry.feedback)
        await log("warn", retry.attempts <= 1
          ? "Requesting one compact retry after malformed workflow tool JSON"
          : "Stopping Executor after repeated malformed workflow tool JSON", {
          sessionID: input.sessionID,
          target: invalidTarget,
          attempts: retry.attempts,
          revision,
        })
        return
      }
      if (modeSettings.executorAgents.has(agent)
        && input.tool === "bash"
        && /^npm\s+run\s+task:doctor:schedule\s*$/.test(command)) {
        const ready = String(output.output ?? "").match(/^TASK DOCTOR: READY\s+(kanban\/todo\/[A-Za-z0-9._-]+\.md)$/m)?.[1]
        if (ready) {
          executorReadyAfterSchedule.set(input.sessionID, ready)
          executorScheduledNoReady.delete(input.sessionID)
        } else {
          executorReadyAfterSchedule.delete(input.sessionID)
          executorScheduledNoReady.add(input.sessionID)
        }
        const next = ready
          ? `delegate ${ready} now. Use only that path. Do not inspect or schedule.`
          : "stop because no task is READY."
        output.output = `${String(output.output ?? "").trimEnd()}\n\nNEXT: ${next}`
      }
      const fullFileReadRequest = input.tool === "read"
        && safeArgs.offset === undefined
        && safeArgs.limit === undefined
      const fullFileRead = fullFileReadRequest
        && paths.length === 1
        && completeFileReadOutput(paths[0], output)
      const automaticTaskRead = consumeAutomaticWorkerTaskRead(
        input.sessionID,
        input.callID,
        input.tool,
        paths,
        fullFileRead,
      )
      if (automaticTaskRead) {
        const requestedTargetOutput = String(output.output ?? "")
        output.output = [
          "AUTOMATIC REQUIRED TASK READ",
          `Task: ${automaticTaskRead.taskPath}`,
          `Task hash: ${automaticTaskRead.taskHash}`,
          `Model family: ${automaticTaskRead.modelFamily} (${automaticTaskRead.modelRulesFile})`,
          "The Harness supplied these exact current task bytes before the requested reviewed target in the same tool result:",
          "--- BEGIN EXACT ACTIVE TASK ---",
          automaticTaskRead.taskContent,
          "--- END EXACT ACTIVE TASK ---",
          `REQUESTED REVIEWED TARGET READ ${automaticTaskRead.targetPath}`,
          requestedTargetOutput,
        ].join("\n")
        output.metadata = {
          ...output.metadata,
          automaticRequiredTaskRead: true,
          automaticTaskPath: automaticTaskRead.taskPath,
          automaticTaskHash: automaticTaskRead.taskHash,
          automaticTaskModelFamily: automaticTaskRead.modelFamily,
          requestedTarget: automaticTaskRead.targetPath,
        }
        const state = activeState(root)
        markWorkerTaskRead(input.sessionID, automaticTaskRead.taskPath)
        markWorkerFileRead(input.sessionID, automaticTaskRead.targetPath, state)
        workerFindingReads.set(input.sessionID, automaticTaskRead.targetPath)
        await log("info", "Delivered an exact automatic Worker task read with the reviewed first target", {
          sessionID: input.sessionID,
          task: automaticTaskRead.taskPath,
          taskHash: automaticTaskRead.taskHash,
          target: automaticTaskRead.targetPath,
          modelFamily: automaticTaskRead.modelFamily,
        })
      }
      const activeResumeSessionID = input.tool === "task" && workerSubagentType(safeArgs.subagent_type)
        ? safeArgs.task_id ?? safeArgs.taskID ?? safeArgs.session_id ?? safeArgs.sessionID
        : null
      try {
        await validateWorkerTaskReturn(safeInput, output)
        if (input.tool === "task" && workerSubagentType(safeArgs.subagent_type)) {
          executorReadyAfterSchedule.delete(input.sessionID)
          const terminalWorkerSessionID = workerTaskSessionID(output)
          if (terminalWorkerSessionID) {
            await confirmStagedHelpDelegations(input.sessionID, terminalWorkerSessionID, input.callID)
            requestedWorkerSessionResumes.delete(terminalWorkerSessionID)
            cleanupWorkerChangesForSession(root, terminalWorkerSessionID)
            const taskPath = delegatedTaskPaths(safeArgs)[0]
            const resultText = workerTaskResultText(output.output)
            if (taskPath && claimsReviewableHandoff(resultText)) {
              rememberReviewableWorker(taskPath, terminalWorkerSessionID)
            } else if (/^(?:HELP_REQUESTED|BLOCKED)\s*$/im.test(resultText)
              || output.metadata?.workerReturnCanonicalized === true) {
              if (await archiveTerminalWorkerSession(terminalWorkerSessionID, "terminal blocked or help result") && taskPath) {
                forgetReviewableWorker(taskPath, terminalWorkerSessionID)
              }
            }
          } else {
            await restoreStagedHelpDelegations(input.sessionID, "Worker task completed without a child session ID", input.callID)
          }
        }
      } finally {
        if (typeof activeResumeSessionID === "string") releaseActiveBoostResume(input.callID, activeResumeSessionID)
      }
      if (modeSettings.workerAgents.has(agent)) {
        if (input.tool !== "read" || fullFileRead) {
          for (const path of workerRuleFilesReadByTool(input.sessionID, paths, command)) markWorkerRuleRead(input.sessionID, path)
        }
        const readRequiredRule = fullFileRead && paths.length === 1
          && requiredWorkerRuleFiles(input.sessionID).includes(paths[0])
        if (readRequiredRule) {
          const remainingRules = missingWorkerRuleFiles(input.sessionID)
          const state = activeState(root)
          const next = remainingRules[0]
            ? `read ${remainingRules[0]}`
            : state?.status === "started" && typeof state.taskPath === "string"
              ? `read ${state.taskPath}`
              : "read the exact task from the current prompt"
          output.output = `${String(output.output ?? "").trimEnd()}\n\nNEXT: ${next}. Do not end first.`
        }
        if (fullFileRead) {
          const state = activeState(root)
          for (const path of paths) markWorkerTaskRead(input.sessionID, path)
          for (const path of paths) markWorkerFileRead(input.sessionID, path, state)
          const findingTarget = workerFindingTargets.get(input.sessionID)
          if (findingTarget && paths.includes(findingTarget)) workerFindingReads.set(input.sessionID, findingTarget)
          if (paths.length === 1 && planningPath.test(paths[0])
            && state?.status !== "started" && state?.status !== "passed") {
            output.output = `${String(output.output ?? "").trimEnd()}\n\nNEXT: run the exact Start command from the current prompt. Do not end first.`
          }
        }
      }
      if (modeSettings.executorAgents.has(agent)
        && fullFileRead) {
        const evidence = executorReviewReads.get(input.sessionID) ?? new Map<string, string>()
        for (const path of paths) {
          const absolutePath = resolve(root, path)
          if (existsSync(absolutePath) && statSync(absolutePath).isFile()) {
            evidence.set(path, fileHash(absolutePath))
          }
        }
        executorReviewReads.set(input.sessionID, evidence)
      }

      if (features.todoDiscipline && input.tool === "todowrite" && Array.isArray(safeArgs.todos)) {
        sessionTodos.set(input.sessionID, safeArgs.todos.map((todo: any) => ({ content: String(todo.content ?? ""), status: String(todo.status ?? "pending") })))
      }

      const reportedDoctor = doctorInvocation(command)
      const workerDoctorStart = modeSettings.workerAgents.has(agent) && reportedDoctor?.gate === "verify"
        ? workerDoctorStartedAt.get(input.sessionID)
        : undefined
      const doctorResultState = workerDoctorStart ? activeState(root) : null
      const staleWorkerDoctor = Boolean(
        modeSettings.workerAgents.has(agent)
        && reportedDoctor?.gate === "verify"
        && (!workerDoctorStart
          || workerDoctorStart.taskPath !== reportedDoctor.taskPath
          || workerDoctorStart.mutationRevision !== workerMutationRevision
          || workerDoctorStart.taskHash === null
          || doctorResultState?.taskPath !== workerDoctorStart.taskPath
          || doctorResultState?.taskHash !== workerDoctorStart.taskHash),
      )
      for (const match of (isDoctorCommand(command) ? output.output : "").matchAll(/TASK DOCTOR:\s+(LINT PASS|REGISTERED|STARTED|PASS|COMPLETED)/g)) {
        const gate = ({ "LINT PASS": "lint", REGISTERED: "register", STARTED: "start", PASS: "verify", COMPLETED: "complete" } as Record<string, string>)[match[1]]
        if (gate === "verify" && staleWorkerDoctor) continue
        const evidence = doctorEvidence.get(input.sessionID) ?? new Set<string>()
        evidence.add(gate)
        doctorEvidence.set(input.sessionID, evidence)
      }

      if (features.planningEnforcer) {
        for (const path of paths.filter((value) => /^kanban\/todo\/[^/]+\.md$/.test(value))) {
          const name = path.split("/").pop()!
          const registration = readJson(resolve(root, ".task-doctor/registrations", `${name}.json`))
          const currentHash = hash(readFileSync(resolve(root, path), "utf8"))
          if (!registration || registration.taskHash !== currentHash) {
            const result = run(root, "npm", ["run", "task:doctor:lint", "--", path])
            sessionFeedback.set(input.sessionID, result.status === 0 ? `Doctor lint passed for ${path}. Register the task before implementation.` : result.stderr || result.stdout)
          }
        }
      }

      const failed = /TASK DOCTOR: FAIL|(?:^|\n)(?:Error|FAILED|FAIL):/i.test(output.output) || Number(output.metadata?.exit ?? output.metadata?.exitCode ?? output.metadata?.exit_code ?? 0) !== 0
      const failedDoctor = staleWorkerDoctor ? null : reportedDoctor
      const doctorElapsedMs = workerDoctorStart ? Date.now() - workerDoctorStart.startedAt : 0
      if (reportedDoctor?.gate === "verify" && modeSettings.workerAgents.has(agent)) {
        workerDoctorStartedAt.delete(input.sessionID)
      }
      if (staleWorkerDoctor && reportedDoctor?.gate === "verify") {
        workerDoctorPreflights.delete(input.sessionID)
        workerFindingTargets.delete(input.sessionID)
        workerFindingReads.delete(input.sessionID)
        workerFileReads.delete(input.sessionID)
        workerVerifyRequired.add(input.sessionID)
        const priorEvidence = doctorEvidence.get(input.sessionID)
        priorEvidence?.delete("verify")
        if (priorEvidence?.size === 0) doctorEvidence.delete(input.sessionID)
        const staleMessage = [
          "WORKER DOCTOR RESULT DISCARDED",
          `The bash verify for ${reportedDoctor.taskPath} started before the current task or Worker mutation revision and is not valid evidence.`,
          "No PASS, failure, preflight, finding, or loop evidence was recorded from this result.",
          features.transactionalWorkerChanges
            ? "Call verify_worker_task exactly once against the current revision before another inspection or change."
            : `Run npm run task:doctor:verify -- ${reportedDoctor.taskPath} exactly once against the current revision before another inspection or change.`,
        ].join("\n")
        sessionFeedback.set(input.sessionID, staleMessage)
        output.output = staleMessage
        output.metadata = {
          ...output.metadata,
          workerDoctorEvidenceDiscarded: true,
          workerMutationRevision,
          startedMutationRevision: workerDoctorStart?.mutationRevision ?? null,
        }
        await log("warn", "Discarded stale manual Worker Doctor result", {
          sessionID: input.sessionID,
          task: reportedDoctor.taskPath,
          workerMutationRevision,
          startedMutationRevision: workerDoctorStart?.mutationRevision,
        })
      }
      const workerDoctorReport = modeSettings.workerAgents.has(agent)
        && failedDoctor?.gate === "verify"
        && /TASK DOCTOR:\s+(?:FAIL|PASS|EXECUTOR RECOVERY REQUIRED)/i.test(output.output)
      if (workerDoctorReport) {
        const state = activeState(root)
        if (state?.taskPath === failedDoctor.taskPath) {
          const harnessRecoveryReport = /TASK DOCTOR:\s+EXECUTOR RECOVERY REQUIRED/i.test(output.output)
            || Boolean(taskHarnessRecoveryStatus(root))
          if (harnessRecoveryReport) {
            markWorkerHarnessRecoveryTerminal(input.sessionID, {
              taskPath: state.taskPath,
              taskHash: state.taskHash,
            })
          } else {
            const findingTarget = failed ? firstScopedFailurePath(state.taskPath, output.output) : null
            const findingWasReadAtCurrentHash = findingTarget
              ? workerFileWasFullyRead(input.sessionID, findingTarget, state)
              : false
            workerFileReads.delete(input.sessionID)
            workerDoctorPreflights.set(input.sessionID, {
              taskPath: state.taskPath,
              taskHash: state.taskHash,
              mutationRevision: workerMutationRevision,
            })
            workerVerifyRequired.delete(input.sessionID)
            workerFindingReads.delete(input.sessionID)
            loopFailures.delete(input.sessionID)
            if (findingTarget) {
              workerFindingTargets.set(input.sessionID, findingTarget)
              if (findingWasReadAtCurrentHash) {
                markWorkerFileRead(input.sessionID, findingTarget, state)
                workerFindingReads.set(input.sessionID, findingTarget)
              }
            } else {
              workerFindingTargets.delete(input.sessionID)
            }
          }
        }
      }
      if (failed && failedDoctor) {
        const failureState = activeState(root)
        mkdirSync(dirname(lastDoctorFailurePath), { recursive: true })
        writeFileSync(lastDoctorFailurePath, `${JSON.stringify({
          version: 1,
          sessionID: input.sessionID,
          taskPath: failedDoctor.taskPath,
          ...(failureState?.taskPath === failedDoctor.taskPath && typeof failureState.taskHash === "string"
            ? { taskHash: failureState.taskHash }
            : {}),
          gate: failedDoctor.gate,
          command,
          output: output.output.slice(-3000),
          failedAt: new Date().toISOString(),
        }, null, 2)}\n`)

        const restoreOnlyFailure = features.workerHelp
          && failedDoctor.gate === "verify"
          && modeSettings.workerAgents.has(agent)
          && failureState?.status === "started"
          && failureState.taskPath === failedDoctor.taskPath
          && typeof failureState.taskHash === "string"
          ? canonicalOutsideScopeDoctorFailure(failedDoctor.taskPath, output.output)
          : null
        if (restoreOnlyFailure) {
          const request = await terminalizeOutsideScopeDoctorFailure(
            input.sessionID,
            failureState.taskPath,
            failureState.taskHash,
            restoreOnlyFailure,
          )
          output.metadata = {
            ...output.metadata,
            workerHelpTerminal: true,
            workerHelpID: request.id,
          }
          await log("warn", "Terminalized Worker after one restore-only outside-Scope Doctor failure", {
            sessionID: input.sessionID,
            task: failureState.taskPath,
            taskHash: failureState.taskHash,
            helpID: request.id,
            paths: restoreOnlyFailure.paths,
          })
          return
        }
      }
      const driverFailure = failed && failedDoctor
        ? (() => {
          const violation = driver?.doctorFailureViolation(output.output)
          if (!driver || !violation) return null
          const violationAgent = sessionAgents.get(input.sessionID) ?? ""
          let learned = guardLearning(violation.id, violationAgent)
          let recorded = false
          if (driver.automaticLearning && !learned && knownStableGuardRule(violation.id)) {
            const result = recordGuardLearningFile(violation.id, violationAgent)
            if (result) {
              learned = result.learning
              recorded = result.recorded
            }
          }
          return driver.observeDoctorFailure(
            input.sessionID,
            output.output,
            driverWorkflowState().revision,
            learned ? { status: recorded ? "recorded" : "already", rule: learned.rule } : undefined,
          )
        })()
        : null
      if (features.failureFeedback && failed && !staleWorkerDoctor) {
        const harnessRecoveryFailure = /TASK DOCTOR:\s+EXECUTOR RECOVERY REQUIRED[\s\S]*HARNESS_BASELINE_DRIFT/i.test(output.output)
        const workerLintFailure = failedDoctor?.gate === "lint" && modeSettings.workerAgents.has(sessionAgents.get(input.sessionID) ?? "")
        const expected = workerLintFailure && features.taskChangePermission
          ? `Expected: if the lint finding requires changing the task definition, use request_task_change_permission with the exact reason and replacement. Do not edit the task directly. After approval, rerun lint and register before start.`
          : "Expected: fix the reported cause within Allowed scope."
        const feedback = harnessRecoveryFailure
          ? [
              output.output.slice(-3000),
              "This is terminal for Worker. Return BLOCKED with Doctor status started and Required owner: Executor.",
              "Do not restore Harness files, retry verify, request Planner, or call another tool.",
            ].join("\n")
          : driverFailure
          ?? `Failure:\n${output.output.slice(-3000)}\n${expected}\nRequired rerun: repeat the same Doctor gate only after changing the cause.`
        sessionFeedback.set(input.sessionID, feedback)
        if (harnessRecoveryFailure && modeSettings.workerAgents.has(agent)) {
          await abortWorkerForHarnessRecovery(input.sessionID, failedDoctor?.taskPath ?? "unknown")
        }
      } else if (!staleWorkerDoctor && !failed
        && !/TASK DOCTOR:/.test(output.output)
        && !workerMechanicalDoctorNotices.has(input.sessionID)) {
        sessionFeedback.delete(input.sessionID)
      }
      if (features.workerHelp && modeSettings.workerAgents.has(agent) && failed && failedDoctor?.gate === "verify") {
        const fingerprint = doctorFailureFingerprint(failedDoctor.gate, failedDoctor.taskPath, output.output)
        if (fingerprint) {
          const slowFailure = doctorElapsedMs >= longDoctorFailureMs
          const window = recordFailure({
            history: doctorFailures.get(input.sessionID),
            fingerprint,
            now: Date.now(),
            windowMs: 10 * 60_000,
            threshold: doctorFailureThreshold,
            slow: slowFailure,
          })
          doctorFailures.set(input.sessionID, window.history)
          if (window.terminal) {
            const required = { count: window.count, fingerprint, reason: window.reason! }
            workerHelpRequired.set(input.sessionID, required)
            const state = activeState(root)
            const pendingLearnings = pendingGuardLearningsForAgent(input.sessionID)
            const persistedHelp = state?.status === "started"
              && state.taskPath === failedDoctor.taskPath
              && typeof state.taskHash === "string"
              && pendingLearnings.size === 0
              ? persistRequiredWorkerHelp(input.sessionID, state.taskPath, state.taskHash, required)
              : null
            sessionFeedback.set(input.sessionID, persistedHelp
              ? [
                  "WORKER HELP IS TERMINAL",
                  `Help ID: ${persistedHelp.id}`,
                  "Do not call another tool or continue implementation. End the Worker response now; the parent hook constructs the canonical handoff.",
                ].join("\n")
              : [
                  "MODEL LOOP STOP",
                  `${window.count} equivalent Doctor failures occurred for ${failedDoctor.taskPath} at ${failedDoctor.gate}.`,
                  `Latest problem: ${fingerprint.problem}`,
                  "Record any pending Guard learning, then call request_executor_help and stop.",
                ].join("\n"))
            await log("warn", "Requiring Worker help after unsafe Doctor failure", {
              sessionID: input.sessionID,
              count: window.count,
              threshold: doctorFailureThreshold,
              elapsedMs: doctorElapsedMs,
              longFailureThresholdMs: longDoctorFailureMs,
              reason: required.reason,
              gate: failedDoctor.gate,
              task: failedDoctor.taskPath,
              problem: fingerprint.problem,
              helpID: persistedHelp?.id,
            })
          }
        }
      }
      if (!failed) driver?.toolSucceeded(input.sessionID)

      const successfulDoctor = doctorInvocation(command)
      if (!failed && modeSettings.plannerAgents.has(agent)) {
        const ownershipTasks = new Map<string, "task_write" | "registration">()
        for (const path of paths.filter((value) => planningPath.test(value))) ownershipTasks.set(path, "task_write")
        if (successfulDoctor?.gate === "register") {
          const registeredPath = normalize(root, successfulDoctor.taskPath)
          if (registeredPath && planningPath.test(registeredPath)) ownershipTasks.set(registeredPath, "registration")
        }
        for (const [taskPath, source] of ownershipTasks) {
          if (!existsSync(resolve(root, taskPath))) continue
          const ownership = claimPlannerOwnership(root, {
            taskPath,
            plannerSessionID: input.sessionID,
            plannerAgent: agent,
            source,
          })
          if (source === "registration") clearPlannerRecoveryState(taskPath)
          const recovery = activePlannerRecoveries.get(input.sessionID)
          if (source === "registration" && recovery?.taskPath === taskPath && taskRegistrationValid(root, taskPath.split("/").pop()!)) {
            recovery.resolved = {
              taskHash: ownership.taskHash,
              output: output.output.trim(),
            }
          }
        }
      }
      const savedFailure = readJson(lastDoctorFailurePath)
      if (!failed && successfulDoctor && savedFailure?.gate === successfulDoctor.gate && savedFailure?.taskPath === successfulDoctor.taskPath) {
        rmSync(lastDoctorFailurePath, { force: true })
      }
      if (!failed && successfulDoctor) {
        sessionFeedback.delete(input.sessionID)
        const remainingFailures = clearFailures(doctorFailures.get(input.sessionID), (fingerprint) => (
          fingerprint.tool === `task:doctor:${successfulDoctor.gate}`
            && fingerprint.target === successfulDoctor.taskPath
        ))
        if (remainingFailures.size === 0) doctorFailures.delete(input.sessionID)
        else doctorFailures.set(input.sessionID, remainingFailures)
      }

      const completed = successfulDoctor?.gate === "complete"
        ? output.output.match(/^TASK DOCTOR: COMPLETED\s+(kanban\/done\/[^\s]+)$/m)?.[1]
        : undefined
      if (completed) {
        const completedTaskPath = `kanban/todo/${completed.split("/").pop()}`
        cleanupWorkerChangesForTask(root, completedTaskPath)
        clearAuthoritativePlannerBlocker(completedTaskPath)
        if (explicitPlannerReviewReceipt()?.taskPath === completedTaskPath) rmSync(explicitPlannerReviewPath, { force: true })
        rmSync(lastDoctorFailurePath, { force: true })
        repetitions.delete(input.sessionID)
        doctorFailures.delete(input.sessionID)
        const data = features.contextCheckpoint ? checkpoint(root, completed) : null
        if (features.completionAuditor) {
          const valid = existsSync(resolve(root, completed)) && completed.startsWith("kanban/done/")
          sessionFeedback.set(input.sessionID, valid
            ? `Completion audited: ${completed}. ${data?.nextAction ?? "Check the next task."}`
            : `Completion audit failed: ${completed} is not present under kanban/done.`)
        }
        if (features.contextCheckpoint) pendingCompact.add(input.sessionID)
        if (features.workerHelp) reconcileWorkerHelpLifecycle(activeState(root))
      }
    },

    event: async ({ event }) => {
      if (!enabled) return
      const value = event as any
      const part = value.properties?.part
      const sessionID = value.properties?.sessionID ?? value.properties?.info?.id ?? part?.sessionID
      if (!sessionID) return

      if (value.type === "message.part.updated"
        && part?.type === "tool"
        && part.tool === "task"
        && part.state?.status === "error") {
        const correlationIDs = [...new Set([part?.callID, part?.id]
          .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0))]
        if (correlationIDs.length === 0) {
          releaseActiveBoostResume(undefined, sessionID)
          await restoreStagedHelpDelegations(sessionID, "Worker task tool failed before delegation completed")
        } else {
          for (const callID of correlationIDs) {
            releaseActiveBoostResume(callID)
            if (await restoreStagedHelpDelegations(
              sessionID,
              "Worker task tool failed before delegation completed",
              callID,
            )) break
          }
        }
      }

      if (features.workerHelp && value.type === "session.error") {
        releaseActiveBoostResume(undefined, sessionID)
        await restoreStagedHelpDelegations(sessionID, `parent session error: ${String(value.properties?.error?.name ?? "unknown")}`)
        await hydrateSessionIdentity(sessionID)
        const error = value.properties?.error
        const errorName = String(error?.name ?? "UnknownError")
        if (errorName === "MessageAbortedError") {
          cleanupWorkerChangesForSession(root, sessionID)
          const store = workerHelpStore(root)
          const followUp = [...store.requests].reverse().find((request) => (
            request.workerSessionID === sessionID
            && request.status === "pending"
          ))
          const delegated = [...store.requests].reverse().find((request) => (
            request.status === "delegated"
            && request.delegatedWorkerSessionID === sessionID
            && request.executorReview?.decision === "retry_worker"
          ))
          if (delegated && !followUp) {
            updateWorkerHelp(delegated.id, (request) => restorePersistedHelpDelegation(
              request,
              request.delegationPriorStatus === "task_changed" ? "task_changed" : "retry_approved",
            ))
            await log("info", "Restored reviewed Worker help after an interrupted delegated Worker", {
              sessionID,
              helpID: delegated.id,
              task: delegated.taskPath,
            })
          } else if (delegated && followUp) {
            await log("info", "Kept prior Worker help delegated because the interrupted Worker created a follow-up", {
              sessionID,
              priorHelpID: delegated.id,
              followUpHelpID: followUp.id,
              task: delegated.taskPath,
            })
          }
          return
        }
        const agent = sessionAgents.get(sessionID) ?? ""
        const parentSessionID = subagentParents.get(sessionID)
        const state = activeState(root)
        if (parentSessionID && modeSettings.workerAgents.has(agent)
          && state?.status === "started" && typeof state.taskPath === "string" && typeof state.taskHash === "string") {
          const message = String(error?.data?.message ?? errorName).replace(/\s+/g, " ").trim().slice(0, 600)
          const request = persistInvalidWorkerReturnHelp({
            sessionID,
            taskPath: state.taskPath,
            taskHash: state.taskHash,
            issue: `${errorName}: ${message}`,
            failure: null,
            relevantFiles: [workerFindingTargets.get(sessionID)].filter((path): path is string => Boolean(path)),
          })
          sessionFeedback.set(parentSessionID, [
            "WORKER HELP REVIEW REQUIRED",
            `Help ID: ${request.id}`,
            `Task: ${request.taskPath}`,
            `Worker session ended with ${errorName}.`,
            `Call review_worker_help for ${request.id} before delegating another Worker.`,
          ].join("\n"))
          await log("warn", "Persisted Worker help after terminal session error", {
            sessionID,
            parentSessionID,
            task: state.taskPath,
            helpID: request.id,
            errorName,
          })
        }
        return
      }

      if (features.todoDiscipline && value.type === "todo.updated") {
        const todos = normalizeSessionTodos(value.properties?.todos)
        if (todos) sessionTodos.set(sessionID, todos)
        return
      }

      if (features.workerHelp && value.type === "message.part.updated" && part?.type === "tool"
        && (part.state?.status === "error" || part.state?.status === "completed")) {
        const observationID = `${part.id}:${part.state.status}`
        const observed = observedTerminalToolParts.get(sessionID) ?? new Set<string>()
        if (observed.has(observationID)) return
        observed.add(observationID)
        observedTerminalToolParts.set(sessionID, observed)
        const agent = sessionAgents.get(sessionID) ?? ""
        const workerSession = modeSettings.workerAgents.has(agent) || subagentParents.has(sessionID)
        if (!workerSession) return
        if (part.state.status === "completed") {
          const noChangePreview = part.tool === "preview_worker_changes"
            && part.state.metadata?.noChange === true
          if (noChangePreview) return
          if (part.tool === "preview_worker_changes") {
            const failures = loopFailures.get(sessionID)
            if (failures) {
              const previewPaths = Array.isArray(part.state.metadata?.paths)
                ? [...new Set(part.state.metadata.paths.filter((path: unknown): path is string => typeof path === "string" && path.length > 0))].sort()
                : []
              if (previewPaths.length === 1) {
                const taskTarget = activeState(root)?.taskPath ?? "active-task"
                failures.delete(`no-change-preview|${taskTarget}|${previewPaths[0]}`)
              }
              if (failures.size === 0) loopFailures.delete(sessionID)
            }
          }
          const completed = loopFailureFingerprint(part.tool, part.state.input ?? {}, "completed")
          if (!completed) return
          const failures = loopFailures.get(sessionID)
          if (!failures) return
          for (const [signature, failure] of failures) {
            if (failure.fingerprint.tool === completed.tool && failure.fingerprint.target === completed.target) failures.delete(signature)
          }
          if (failures.size === 0) loopFailures.delete(sessionID)
          return
        }
        if (part.tool === "bash") {
          const invocation = parseDoctorInvocation(String(part.state?.input?.command ?? ""))
          if (invocation && invocation.gate !== "verify") return
        }
        const fingerprint = loopFailureFingerprint(part.tool, part.state.input ?? {}, String(part.state.error ?? ""))
        if (!fingerprint) return
        const window = recordFailure({
          history: loopFailures.get(sessionID),
          fingerprint,
          now: Date.now(),
          windowMs: 10 * 60_000,
          threshold: workerHelpFailureThreshold,
        })
        loopFailures.set(sessionID, window.history)
        if (window.terminal) {
          workerHelpRequired.set(sessionID, { count: window.count, fingerprint })
          const persistedHelp = await terminalizeRepeatedWorkerFailure(sessionID, window.count, fingerprint)
          if (!persistedHelp) {
            sessionFeedback.set(sessionID, [
              "MODEL LOOP STOP",
              `${window.count} semantically equivalent failures occurred for ${fingerprint.tool} on ${fingerprint.target}.`,
              `Failure category: ${fingerprint.category}`,
              "Record pending Guard learnings, then call request_executor_help and end this Worker run.",
            ].join("\n"))
          }
          await log("warn", "Requiring Worker help after repeated semantic tool failures", {
            sessionID,
            count: window.count,
            threshold: workerHelpFailureThreshold,
            tool: fingerprint.tool,
            target: fingerprint.target,
            category: fingerprint.category,
            helpID: persistedHelp?.id,
          })
        }
        return
      }

      const sessionInfo = value.properties?.info
      if (value.type === "session.created" || value.type === "session.updated") {
        rememberSessionIdentity(sessionID, sessionInfo, sessionInfo?.model)
        await hydrateSessionIdentity(sessionID, sessionInfo?.model)
        await initializeReviewedWorkerRetry(sessionID)
        await initializeStagedHelpDelegation(sessionID)
      }
      if (value.type === "session.deleted") {
        releaseActiveBoostResume(undefined, sessionID)
        await restoreStagedHelpDelegations(sessionID, "parent session was deleted")
        cleanupWorkerChangesForSession(root, sessionID)
        requestedWorkerSessionResumes.delete(sessionID)
        for (const [taskPath, workerSessionIDs] of [...reviewableWorkerSessions]) {
          if (workerSessionIDs.has(sessionID)) forgetReviewableWorker(taskPath, sessionID)
        }
        clearWorkerHarnessRecoveryTerminal(sessionID)
        await executeWorkflowEffects(
          reduceWorkflow({ type: "session.deleted", sessionID }).effects,
          { clearSession: (id) => runtimeState.deleteSession(id) },
        )
        return
      }

      if (value.type === "session.compacted") {
        await hydrateSessionIdentity(sessionID, sessionInfo?.model)
        const terminalHarnessRecovery = workerHarnessRecoveryTerminals.get(sessionID)
        pendingCompact.delete(sessionID)
        repetitions.delete(sessionID)
        workerRuleReads.delete(sessionID)
        workerTaskReads.delete(sessionID)
        workerFileReads.delete(sessionID)
        pendingAutomaticWorkerTaskReads.delete(sessionID)
        workerDoctorPreflights.delete(sessionID)
        workerFindingTargets.delete(sessionID)
        workerFindingReads.delete(sessionID)
        const postApplyVerifyStillRequired = workerVerifyRequired.has(sessionID)
        workerMechanicalDoctorNotices.delete(sessionID)
        workerDoctorStartedAt.delete(sessionID)
        executorReviewReads.delete(sessionID)
        const agent = sessionAgents.get(sessionID) ?? ""
        const requiredRules = modeSettings.workerAgents.has(agent) ? requiredWorkerRuleFiles(sessionID) : []
        const previous = sessionFeedback.get(sessionID)
        sessionFeedback.set(sessionID, terminalHarnessRecovery
          ? [
              "TASK DOCTOR: EXECUTOR RECOVERY REQUIRED",
              `Task: ${terminalHarnessRecovery.taskPath}`,
              `Task hash: ${terminalHarnessRecovery.taskHash}`,
              "This Worker session remains terminal after compaction and Executor recovery.",
              "Return BLOCKED now. Do not read rules, inspect files, or call another tool; Executor must delegate a fresh Worker.",
            ].join("\n")
          : [
              `Compaction completed. Re-read AGENTS.md${requiredRules.length > 0 ? `, ${requiredRules.join(", ")}` : ""}, the active task, MEMORY.md, and CODEX-INBOX.md. The authoritative live workflow state below overrides contradictory summary text.`,
              postApplyVerifyStillRequired
                ? "The post-Apply verification fallback remains required. After those reads, call zero-argument verify_worker_task before any implementation inspection or change."
                : null,
              previous?.startsWith("Failure:") ? previous : null,
            ].filter(Boolean).join("\n\n"))
        return
      }
      if (value.type !== "session.idle") return

      const messages = await loadSessionMessages(sessionID)
      await refreshSessionTodos(sessionID)
      const latestAssistant = latestAssistantMessage(messages)
      const latestModelIdentity = [latestAssistant?.info?.providerID, latestAssistant?.info?.modelID]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join("/")
      if (latestModelIdentity) sessionModels.set(sessionID, latestModelIdentity)
      const latestAgent = String(latestAssistant?.info?.agent ?? latestAssistant?.info?.mode ?? sessionAgents.get(sessionID) ?? "").toLowerCase()
      if (latestAgent) sessionAgents.set(sessionID, latestAgent)
      if (!latestAssistantFinished(messages)) {
        pendingCompact.delete(sessionID)
        await log("info", "Suppressing idle automation after interrupted turn", { sessionID })
        return
      }
      if (subagentParents.has(sessionID) && modeSettings.workerAgents.has(latestAgent)) {
        await log("debug", "Deferring Worker subagent return checks to parent task hook", {
          sessionID,
          parentSessionID: subagentParents.get(sessionID),
        })
        return
      }

      if (features.executorBaselineRecovery
        && modeSettings.workerAgents.has(latestAgent)
        && (taskHarnessRecoveryStatus(root) || workerHarnessRecoveryTerminals.has(sessionID))) {
        pendingCompact.delete(sessionID)
        await log("info", "Suppressing Worker idle automation during terminal Harness recovery", { sessionID })
        return
      }

      const driver = driverForSession(sessionID)
      if (features.guardLearning && !driver?.automaticLearning) await refreshPendingGuardLearnings(sessionID, messages)

      const workflow = driverWorkflowState()
      if (driver?.isTerminal(sessionID, workflow.revision)) {
        pendingCompact.delete(sessionID)
        await log("info", "Suppressing idle automation for terminal model-driver state", { sessionID, modelDriver: driver.id })
        return
      }

      if (features.contextCheckpoint && pendingCompact.has(sessionID)) {
        const tokens = activeContextTokens(messages)
        const contextLimit = contextLimits.get(sessionID)
        const usagePercent = contextLimit ? (tokens / contextLimit) * 100 : 0
        pendingCompact.delete(sessionID)
        if (contextLimit && usagePercent >= taskCompactionThresholdPercent) {
          await log("info", "Triggering mandatory post-task compaction", { sessionID, tokens, contextLimit, usagePercent, thresholdPercent: taskCompactionThresholdPercent })
          const providerID = latestAssistant?.info?.providerID
          const modelID = latestAssistant?.info?.modelID
          if (typeof providerID === "string" && providerID && typeof modelID === "string" && modelID) {
            try {
              const response = await (client.session.summarize as any)({
                path: { id: sessionID },
                query: { directory: root },
                body: { providerID, modelID, auto: true },
              })
              if ((response as any)?.error) throw new Error(String((response as any).error?.message ?? (response as any).error))
              return
            } catch (error) {
              await log("warn", "Post-task compaction failed; native reserved-context compaction remains active", {
                sessionID,
                providerID,
                modelID,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          } else {
            await log("warn", "Skipped post-task compaction because the latest assistant model identity is incomplete", {
              sessionID,
              providerID: typeof providerID === "string" ? providerID : null,
              modelID: typeof modelID === "string" ? modelID : null,
            })
          }
        }
        await log("info", "Post-task compaction not required", { sessionID, tokens, contextLimit: contextLimit ?? null, usagePercent, thresholdPercent: taskCompactionThresholdPercent })
      }
      const assistantText = latestAssistantText(messages)
      if (features.plannerQuestionEnforcer && modeSettings.plannerAgents.has(latestAgent)) {
        if (usedQuestionTool(latestAssistant)) {
          plannerQuestionCorrections.delete(sessionID)
        } else {
          const questions = unresolvedPlannerQuestions(assistantText)
          const existingCorrection = plannerQuestionCorrections.get(sessionID)
          if (questions.length > 0 && existingCorrection) {
            plannerQuestionCorrections.delete(sessionID)
            await log("warn", "Planner ignored one question-tool correction; stopping to avoid a loop", { sessionID, messageID: latestAssistant?.info?.id, questions })
            return
          }
          if (questions.length > 0) {
            const violation: GuardViolation = {
              id: guardViolationId(
                "Planner asked unresolved user decisions in normal text.",
                "Use the question tool as the next action and emit no normal text before it.",
              ),
              problem: "Planner asked unresolved user decisions in normal text.",
              action: "Use the question tool as the next action and emit no normal text before it.",
            }
            const driverCorrection = driver ? projectGuardError(sessionID, violation.problem, violation.action).message : undefined
            const needsLearning = features.guardLearning && !driver?.automaticLearning && addPendingGuardLearning(sessionID, violation)
            const signature = String(latestAssistant?.info?.id ?? hash(assistantText))
            plannerQuestionCorrections.set(sessionID, signature)
            await log("info", "Rejecting plain-text Planner questions and requiring the question tool", { sessionID, messageID: latestAssistant?.info?.id, questions })
            await client.session.promptAsync({
              path: { id: sessionID },
              query: { directory: root },
              body: {
                agent: latestAgent,
                model: automaticAgentModel(root, latestAgent, latestAssistant?.info),
                parts: [{ type: "text", text: [
                  driverCorrection ?? "WORKFLOW GUARD REJECTED: Your previous Planner response contains unresolved user decisions written as plain text.",
                  needsLearning ? `First call record_guard_learning once without arguments; it records every pending lesson for this role mechanically.\n${violation.action}` : null,
                  "Then call the question tool for those decisions. Do not inspect more files, create tasks, or restate the questions as normal text before the tool calls.",
                ].filter(Boolean).join("\n") }],
              },
            })
            return
          }
          if (existingCorrection) plannerQuestionCorrections.delete(sessionID)
        }
      }
      if (features.guardLearning && !driver?.automaticLearning) {
        const pendingLearnings = await refreshPendingGuardLearnings(sessionID, messages)
        if (pendingLearnings.length > 0) {
          const signature = `${latestAgent}:${pendingLearnings.map((violation) => violation.id).sort().join(",")}`
          if (guardLearningPromptedFor.get(sessionID) === signature) {
            guardLearningPromptedFor.delete(sessionID)
            await log("warn", "Model ignored one guard-learning correction; stopping to avoid a loop", { sessionID, violationIDs: signature })
            return
          }
          guardLearningPromptedFor.set(sessionID, signature)
          const instructions = pendingLearnings.map((violation) => `${violation.id}: ${violation.action}`).join("\n")
          const recordingInstruction = "Call record_guard_learning once without arguments; it records every pending lesson for this role mechanically."
          await log("info", "Requiring missing guard learnings before turn completion", { sessionID, violationIDs: signature })
          await client.session.promptAsync({
            path: { id: sessionID },
            query: { directory: root },
            body: {
              agent: latestAgent || undefined,
              model: automaticAgentModel(root, latestAgent, latestAssistant?.info),
              parts: [{ type: "text", text: `Before continuing, record every unresolved Workflow Guard lesson from the previous turn. ${recordingInstruction} Do not inspect files or perform other work first.\n${instructions}` }],
            },
          })
          return
        }
      }
      if (guardLearningResumePending.get(sessionID) === latestAgent) {
        guardLearningResumePending.delete(sessionID)
        const roleInstruction = modeSettings.plannerAgents.has(latestAgent)
          ? "Finish the original planning request. Correct the last failed task, then lint and register every newly created task before stopping."
          : modeSettings.executorAgents.has(latestAgent)
            ? "Continue the original Executor workflow from its last failed or pending result."
            : "Continue the original Worker workflow from its last failed or pending result and finish with the required structured handoff."
        await log("info", "Resuming work after required guard learning", { sessionID, agent: latestAgent })
        await client.session.promptAsync({
          path: { id: sessionID },
          query: { directory: root },
          body: {
            agent: latestAgent || undefined,
            model: automaticAgentModel(root, latestAgent, latestAssistant?.info),
            parts: [{ type: "text", text: `The required Guard learning is recorded. Resume the unfinished user request now; do not merely report readiness. ${roleInstruction} Stop only after completion or a real blocker.` }],
          },
        })
        return
      }
      if (features.plannerRecovery && modeSettings.executorAgents.has(latestAgent)) {
        const receipt = explicitPlannerReviewReceipt()
        const attempts = receipt?.automaticContinuationAttempts ?? 0
        const state = activeState(root)
        if (receipt?.status === "pending"
          && receipt.executorSessionID === sessionID
          && receipt.contract
          && state?.status === "started"
          && state.taskPath === receipt.taskPath
          && state.taskHash === receipt.taskHash
          && attempts < 1) {
          const automaticContinuationAt = new Date().toISOString()
          writeExplicitPlannerReviewReceipt({
            ...receipt,
            automaticContinuationAttempts: attempts + 1,
            automaticContinuationAt,
          })
          await log("info", "Continuing pending owning-Planner recovery automatically after Executor idle", {
            sessionID,
            task: receipt.taskPath,
            attempt: attempts + 1,
          })
          const recovery = await recoverWithOwningPlanner({
            executorSessionID: sessionID,
            taskPath: receipt.taskPath,
            lifecycle: "active",
            contract: receipt.contract,
            exactContract: receipt.contractMode === "replace",
            problem: receipt.problem ?? "The persisted exact Planner recovery contract remains incomplete after the Executor stopped.",
            evidence: receipt.evidence?.length
              ? receipt.evidence
              : [receipt.lastError ?? "The owning Planner returned without applying and registering the persisted recovery contract."],
            expectedResults: receipt.expectedResults?.length
              ? receipt.expectedResults
              : ["The active task matches the persisted contract and is registered to the resulting task hash."],
            relevantFiles: receipt.relevantFiles?.length ? receipt.relevantFiles : [receipt.taskPath],
          })
          if (recovery.status === "recovered") {
            clearPlannerRecoveryState(receipt.taskPath)
            clearAuthoritativePlannerBlocker(receipt.taskPath)
            terminalExecutorReasons.delete(sessionID)
            executorPlannerRecoveryRequested.delete(sessionID)
            writeExplicitPlannerReviewReceipt({
              ...receipt,
              status: "complete",
              taskHash: recovery.taskHash,
              completedForMessageID: receipt.completedForMessageID ?? receipt.userMessageID,
              automaticContinuationAttempts: attempts + 1,
              automaticContinuationAt,
              completedAt: new Date().toISOString(),
              lastError: undefined,
            })
            await log("info", "Automatic owning-Planner recovery completed", {
              sessionID,
              task: receipt.taskPath,
              plannerSessionID: recovery.plannerSessionID,
              taskHash: recovery.taskHash,
            })
            await client.session.promptAsync({
              path: { id: sessionID },
              query: { directory: root },
              body: {
                agent: latestAgent,
                model: automaticAgentModel(root, latestAgent, latestAssistant?.info),
                parts: [{ type: "text", text: [
                  `PLANNER RECOVERY COMPLETE ${receipt.taskPath}`,
                  `Owning Planner session ${recovery.plannerSessionID} applied and registered the persisted contract during the trusted automatic continuation.`,
                  `Delegate one fresh Worker to resume ${receipt.taskPath} now. Do not lint, register, start, schedule, or escalate it again.`,
                ].join("\n") }],
              },
            })
          } else {
            const latestState = activeState(root)
            const latestTaskHash = latestState?.taskPath === receipt.taskPath && typeof latestState.taskHash === "string"
              ? latestState.taskHash
              : receipt.taskHash
            writeExplicitPlannerReviewReceipt({
              ...receipt,
              taskHash: latestTaskHash,
              automaticContinuationAttempts: attempts + 1,
              automaticContinuationAt,
              lastError: recovery.reason,
            })
            writePlannerRecoveryState({
              status: recovery.status === "unavailable" ? "unavailable" : "incomplete",
              taskPath: receipt.taskPath,
              taskHash: latestTaskHash,
              plannerSessionID: recovery.plannerSessionID,
              executorSessionID: sessionID,
              reason: recovery.reason,
            })
            terminalExecutorReasons.set(sessionID, [
              recovery.status === "unavailable" ? "PLANNER UNAVAILABLE" : "PLANNER RECOVERY INCOMPLETE",
              `Task: ${receipt.taskPath}`,
              `Planner session: ${recovery.plannerSessionID ?? "none"}`,
              `Reason: ${recovery.reason}`,
              "The single trusted automatic continuation is exhausted. Stop without retrying or delegating a Worker.",
            ].join("\n"))
            await log("warn", "Automatic owning-Planner recovery remained incomplete", {
              sessionID,
              task: receipt.taskPath,
              plannerSessionID: recovery.plannerSessionID,
              reason: recovery.reason,
            })
          }
          return
        }
      }
      const allText = textParts(messages).join("\n")
      if (reportsUserBlocker(assistantText)) {
        await log("info", "Suppressing idle automation after explicit user blocker", { sessionID })
        return
      }
      if (features.workerHelp && modeSettings.executorAgents.has(latestAgent)) {
        const state = activeState(root)
        let help = currentWorkerHelp(root, state?.taskPath ?? null, state?.taskHash)
        const recovery = plannerRecoveryState(root)
        const deterministicRecoveryPending = projectMemoryRecoveryStatus(root)
          || (features.executorBaselineRecovery ? taskHarnessRecoveryStatus(root) : null)
        const freshWorkerRequired = state?.status === "started"
          && help
          && ["retry_approved", "task_changed"].includes(help.status)
          && !help.delegatedWorkerSessionID
          && !deterministicRecoveryPending
          && !executorPlannerRecoveryRequested.has(sessionID)
          && !executorHelpReReviewRequested.has(sessionID)
          && !executorHelpReviewPending.has(sessionID)
          && !terminalExecutorReasons.has(sessionID)
          && !(recovery?.taskPath === state.taskPath
            && recovery.taskHash === state.taskHash
            && ["unavailable", "incomplete"].includes(recovery.status))
        if (freshWorkerRequired) {
          const reviewedHelp = help!
          const delegatedInLatestTurn = latestAssistant?.parts?.some((part: any) => (
            part?.type === "tool"
            && part?.tool === "task"
          ))
          if (!delegatedInLatestTurn) {
            const signature = `executor-delegate:${state.taskHash}:${reviewedHelp.id}`
            if (idlePromptedFor.get(sessionID) === signature) {
              await log("warn", "Executor already received one bounded mechanical Worker delegation", {
                sessionID,
                task: state.taskPath,
                helpID: reviewedHelp.id,
              })
              return
            }
            idlePromptedFor.set(sessionID, signature)
            await log("info", "Mechanically delegating one fresh Worker after prose-only Executor stop", {
              sessionID,
              task: state.taskPath,
              helpID: reviewedHelp.id,
            })
            const modelDecision = workerDelegationModelDecision(root, reviewedHelp.status === "retry_approved")
            await log(modelDecision.invalidBoost ? "warn" : "info", "Selected Worker delegation model", {
              sessionID,
              task: state.taskPath,
              path: "mechanical-idle",
              helpID: reviewedHelp.status === "retry_approved" ? reviewedHelp.id : null,
              boosted: modelDecision.boosted,
              selector: modelDecision.selector,
              reason: modelDecision.reason,
              model: modelDecision.model ? modelRefString(modelDecision.model) : null,
            })
            const delegationNonce = newMechanicalDelegationNonce()
            stageHelpDelegation(sessionID, reviewedHelp, undefined, "mechanical", delegationNonce)
            if (reviewedHelp.status === "retry_approved") queueReviewedWorkerRetry(sessionID, state, reviewedHelp)
            updateWorkerHelp(reviewedHelp.id, (request) => {
              const { delegatedWorkerSessionID: _staleWorkerSessionID, ...current } = request
              return {
                ...current,
                ...persistedHelpDelegation(
                  sessionID,
                  reviewedHelp,
                  undefined,
                  "mechanical",
                  delegationNonce,
                  modelDecision.boosted,
                ),
              }
            })
            executorReviewReads.delete(sessionID)
            try {
              const response: any = await client.session.promptAsync({
                path: { id: sessionID },
                query: { directory: root },
                body: {
                  agent: latestAgent,
                  model: automaticAgentModel(root, latestAgent, latestAssistant?.info),
                  parts: [{
                    type: "subtask",
                    agent: modelDecision.boosted ? WORKER_RECOVERY_BOOST_AGENT : "worker",
                    description: `Resume ${state.taskPath}`,
                    prompt: mechanicalDelegationPrompt(
                      canonicalWorkerPrompt(root, state.taskPath, state, reviewedHelp),
                      delegationNonce,
                    ),
                  }],
                },
              })
              if (response?.error) {
                const message = typeof response.error?.message === "string"
                  ? response.error.message
                  : JSON.stringify(response.error)
                throw new Error(message || "OpenCode rejected the Worker subtask enqueue")
              }
            } catch (error) {
              await restoreStagedHelpDelegations(
                sessionID,
                "mechanical Worker delegation enqueue failed",
                undefined,
                reviewedHelp.id,
              )
              if (idlePromptedFor.get(sessionID) === signature) idlePromptedFor.delete(sessionID)
              await log("warn", "Mechanical Worker delegation enqueue failed and was released for retry", {
                sessionID,
                task: state.taskPath,
                helpID: reviewedHelp.id,
                error: error instanceof Error ? error.message : String(error),
              })
            }
            return
          }
        }
      }
      if (features.plannerCompletionGuard && modeSettings.plannerAgents.has(latestAgent)) {
        const ownedTasks = plannerOwnedTodoTasks(root, sessionID)
        if (ownedTasks.length > 0) {
          plannerEmptyStopRecoveries.delete(sessionID)
          const unregistered = ownedTasks.filter((taskPath) => !taskRegistrationValid(root, taskPath.split("/").pop()!))
          let signature = ""
          let prompt = ""
          if (unregistered.length > 0) {
            signature = `registration:${unregistered.join(",")}:${unregistered.map((taskPath) => fileHash(resolve(root, taskPath))).join(",")}`
            prompt = [
              "PLANNER COMPLETION BLOCKED",
              "You still own task content that is not registered against its current hash:",
              ...unregistered.map((taskPath) => `- ${taskPath}`),
              "Read each named draft once and call register_planner_task with its title, exact files, concrete done facts, and dependencies only when needed. The tool derives canonical metadata and registers atomically.",
              "Do not edit task files or run lint/register separately. Then run npm run task:doctor:schedule once. Do not implement or delegate. Stop only after every task is registered or report a REAL BLOCKER with exact output.",
            ].join("\n")
          } else {
            const schedule = run(root, "node", ["scripts/task-doctor.mjs", "schedule"])
            if (schedule.status !== 0) {
              const output = [schedule.stdout, schedule.stderr].filter(Boolean).join("\n").trim() || `schedule exited with ${schedule.status ?? "a signal"}`
              signature = `schedule:${hash(output)}`
              prompt = [
                "PLANNER COMPLETION BLOCKED",
                "The final Doctor schedule preflight failed:",
                output.slice(-3000),
                "Correct only task definitions owned by this Planner, then lint and register every changed task and run npm run task:doctor:schedule again. Do not implement or delegate. If the failing task belongs to another Planner, report a REAL BLOCKER with its exact path and stop.",
              ].join("\n")
            } else {
              plannerCompletionCorrections.delete(sessionID)
              await log("info", "Planner completion preflight passed", { sessionID, ownedTasks })
            }
          }
          if (prompt) {
            if (plannerCompletionCorrections.get(sessionID) === signature) {
              await log("warn", "Planner ignored one completion-preflight correction; stopping to avoid a loop", { sessionID, signature, ownedTasks })
              return
            }
            plannerCompletionCorrections.set(sessionID, signature)
            await log("info", "Resuming Planner for completion preflight", { sessionID, signature, ownedTasks, unregistered })
            await client.session.promptAsync({
              path: { id: sessionID },
              query: { directory: root },
              body: {
                agent: latestAgent || undefined,
                model: automaticAgentModel(root, latestAgent, latestAssistant?.info),
                parts: [{ type: "text", text: prompt }],
              },
            })
            return
          }
        } else {
          plannerCompletionCorrections.delete(sessionID)
          if (assistantText.trim().length === 0) {
            const attempts = plannerEmptyStopRecoveries.get(sessionID) ?? 0
            if (attempts >= 2) {
              await log("warn", "Planner stopped empty after two automatic recoveries", { sessionID, attempts })
              return
            }
            plannerEmptyStopRecoveries.set(sessionID, attempts + 1)
            await log("info", "Resuming an empty unfinished Planner turn", { sessionID, attempt: attempts + 1 })
            await client.session.promptAsync({
              path: { id: sessionID },
              query: { directory: root },
              body: {
                agent: latestAgent || undefined,
                model: automaticAgentModel(root, latestAgent, latestAssistant?.info),
                parts: [{ type: "text", text: [
                  "PLANNER TURN INCOMPLETE",
                  "Resume without repeating inspection.",
                  "Register needed tasks, schedule once, then stop.",
                  "Otherwise return no-task evidence, one question, or a blocker.",
                  "Never implement or delegate.",
                ].join("\n") }],
              },
            })
            return
          }
          plannerEmptyStopRecoveries.delete(sessionID)
        }
      }
      const runningTask = activeState(root)
      if (features.executorReview && modeSettings.workerAgents.has(latestAgent) && runningTask?.status === "passed") {
        const missing = reviewableHandoffError(assistantText, runningTask.taskPath)
        if (missing) {
          const signature = `reviewable:${runningTask.taskPath}:${missing}`
          if (idlePromptedFor.get(sessionID) === signature) {
            await log("warn", "Worker ignored one REVIEWABLE handoff correction; stopping to avoid a loop", { sessionID, task: runningTask.taskPath, missing })
            return
          }
          idlePromptedFor.set(sessionID, signature)
          await log("info", "Requiring minimal Worker technical handoff", { sessionID, task: runningTask.taskPath, missing })
          await client.session.promptAsync({
            path: { id: sessionID },
            query: { directory: root },
            body: {
              agent: latestAgent || undefined,
              model: automaticAgentModel(root, latestAgent, latestAssistant?.info),
              parts: [{ type: "text", text: `Your task passed Doctor but the technical handoff is missing its ${missing}. Do not call tools or run Doctor complete. Return only:\nREVIEWABLE\nTask: ${runningTask.taskPath}` }],
            },
          })
          return
        }
        await log("info", "Worker returned a reviewable task state", { sessionID, task: runningTask.taskPath })
        return
      }
      if (features.idleReview && modeSettings.workerAgents.has(latestAgent) && runningTask?.status === "started" && batchPattern.test(allText) && !sessionFeedback.get(sessionID)?.startsWith("Failure:")) {
        const signature = `active:${runningTask.taskPath}`
        if (idlePromptedFor.get(sessionID) !== signature) {
          idlePromptedFor.set(sessionID, signature)
          await log("info", "Resuming naturally stopped active task once", { sessionID, task: runningTask.taskPath })
          await client.session.promptAsync({
            path: { id: sessionID },
            query: { directory: root },
            body: { parts: [{ type: "text", text: `You stopped after announcing work but ${runningTask.taskPath} is still started. Do not run Worker Doctor through Bash. Continue from the current mechanical finding and use transactional Apply, which verifies automatically. If the Guard explicitly requires a fallback, call zero-argument verify_worker_task. After TASK DOCTOR: PASS, return the minimal REVIEWABLE handoff and stop so Executor can call zero-argument technical completion.` }] },
          })
          return
        }
      }

      const openInternalTodos = sessionTodos.get(sessionID)?.filter((todo) => todo.status !== "completed") ?? []
      if (features.todoDiscipline && modeSettings.workerAgents.has(latestAgent) && openInternalTodos.length > 0 && batchPattern.test(allText) && !sessionFeedback.get(sessionID)?.startsWith("Failure:")) {
        const signature = `internal:${openInternalTodos.map((todo) => `${todo.status}:${todo.content}`).join("|")}`
        if (idlePromptedFor.get(sessionID) !== signature) {
          idlePromptedFor.set(sessionID, signature)
          await client.session.promptAsync({
            path: { id: sessionID },
            query: { directory: root },
            body: {
              agent: latestAgent || undefined,
              model: automaticAgentModel(root, latestAgent, latestAssistant?.info),
              parts: [{ type: "text", text: "Reconcile the internal todo list with actual tool results. Continue only the current Kanban task. Keep at most five items and exactly one in progress. Stop on a real blocker." }],
            },
          })
          return
        }
      }

      // Executor owns review, completion, and scheduling of the next Worker.
    },
  }
}

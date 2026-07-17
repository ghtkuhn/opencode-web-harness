import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"

export type HarnessDriftEntry = {
  path: string
  beforeHash: string | null
  afterHash: string
}

export type TaskHarnessRecovery = {
  status: "required"
  code: "HARNESS_BASELINE_DRIFT"
  taskPath: string
  taskHash: string
  paths: HarnessDriftEntry[]
  detectedAt: string
}

type HarnessRecoveryInput = {
  taskPath: string
  paths: string[]
  reason: string
  executorSessionID: string
}

function hash(value: Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

function normalize(root: string, path: string) {
  const normalized = relative(root, resolve(root, path)).split("\\").join("/")
  return normalized && normalized !== ".." && !normalized.startsWith("../") ? normalized : null
}

function currentHash(root: string, path: string) {
  const absolutePath = resolve(root, path)
  return existsSync(absolutePath) ? hash(readFileSync(absolutePath)) : null
}

function nextRecoveryID(changes: any[]) {
  const highest = changes.reduce((value, entry) => {
    const number = typeof entry?.recoveryID === "string" ? Number(entry.recoveryID.match(/^H(\d+)$/)?.[1]) : NaN
    return Number.isSafeInteger(number) ? Math.max(value, number) : value
  }, 0)
  return `H${highest + 1}`
}

export function taskHarnessRecoveryStatus(root: string): TaskHarnessRecovery | null {
  const pending = readJson(resolve(root, ".task-doctor/state.json"))?.executorRecovery
  if (pending?.status !== "required" || pending?.code !== "HARNESS_BASELINE_DRIFT") return null
  if (typeof pending.taskPath !== "string" || typeof pending.taskHash !== "string" || !Array.isArray(pending.paths)) return null
  const paths = pending.paths.filter((entry: any) => (
    typeof entry?.path === "string"
    && (entry.beforeHash === null || typeof entry.beforeHash === "string")
    && typeof entry.afterHash === "string"
  )) as HarnessDriftEntry[]
  if (paths.length !== pending.paths.length || paths.length === 0) return null
  return { ...pending, paths }
}

export function recoverTaskHarness(root: string, input: HarnessRecoveryInput) {
  const recovery = taskHarnessRecoveryStatus(root)
  if (!recovery) throw new Error("The active task has no pending Harness baseline recovery.")

  const taskPath = normalize(root, input.taskPath)
  if (taskPath !== recovery.taskPath) {
    throw new Error(`Harness recovery owns ${recovery.taskPath}, not ${input.taskPath}.`)
  }
  const requested = [...new Set(input.paths.map((path) => normalize(root, path)))].sort()
  if (requested.some((path) => path === null)) throw new Error("Harness recovery paths must stay inside the project.")
  const expected = recovery.paths.map((entry) => entry.path).sort()
  if (JSON.stringify(requested) !== JSON.stringify(expected)) {
    throw new Error(`Harness recovery must include exactly: ${expected.join(", ")}.`)
  }
  const reason = input.reason.replace(/\s+/g, " ").trim()
  if (reason.length < 20) throw new Error("Harness recovery needs a concrete reason of at least 20 characters.")

  for (const entry of recovery.paths) {
    const observed = currentHash(root, entry.path)
    if (observed !== entry.afterHash) {
      throw new Error(`${entry.path} changed again after Doctor reported the Harness drift. Inspect it and rerun Doctor verify.`)
    }
  }

  const statePath = resolve(root, ".task-doctor/state.json")
  const state = readJson(statePath)
  if (state?.status !== "started" || state.taskPath !== recovery.taskPath || state.taskHash !== recovery.taskHash) {
    throw new Error("The active Doctor task changed after Harness drift was reported.")
  }

  const authorizationPath = resolve(root, ".task-doctor/authorized-harness-changes.json")
  const stored = readJson(authorizationPath)
  const previousChanges = stored?.version === 1 && Array.isArray(stored.changes) ? stored.changes : []
  const recoveryID = nextRecoveryID(previousChanges)
  const recoveredAt = new Date().toISOString()
  const transitions = recovery.paths.map((entry) => ({
    ...entry,
    recoveryID,
    reason,
    executorSessionID: input.executorSessionID,
    recoveredAt,
  }))

  mkdirSync(dirname(authorizationPath), { recursive: true })
  const authorizationTempPath = `${authorizationPath}.tmp`
  const stateTempPath = `${statePath}.tmp`
  writeFileSync(authorizationTempPath, `${JSON.stringify({
    version: 1,
    changes: [...previousChanges, ...transitions],
    updatedAt: recoveredAt,
  }, null, 2)}\n`)
  writeFileSync(stateTempPath, `${JSON.stringify({
    ...state,
    executorRecovery: {
      ...recovery,
      status: "resolved",
      recoveryID,
      reason,
      resolvedAt: recoveredAt,
      resolvedBySessionID: input.executorSessionID,
    },
  }, null, 2)}\n`)
  renameSync(authorizationTempPath, authorizationPath)
  renameSync(stateTempPath, statePath)

  const plannerRecoveryPath = resolve(root, ".task-doctor/planner-recovery.json")
  const plannerRecovery = readJson(plannerRecoveryPath)
  if (plannerRecovery?.taskPath === recovery.taskPath && plannerRecovery?.taskHash === recovery.taskHash) {
    rmSync(plannerRecoveryPath, { force: true })
  }

  return { recoveryID, taskPath: recovery.taskPath, paths: expected, recoveredAt }
}

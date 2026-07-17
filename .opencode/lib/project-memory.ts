import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

export type ProjectMemoryRecovery = {
  status: "required"
  code: "MEMORY_SIZE_EXCEEDED"
  size: number
  maxSize: number
}

type MemoryRecoveryInput = {
  replacement: string
  reason: string
  executorSessionID: string
}

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

export function parseProjectByteSize(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value !== "string") return null
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb)?$/i)
  if (!match) return null
  const multiplier = { b: 1, kb: 1024, mb: 1024 * 1024 }[(match[2] ?? "b").toLowerCase() as "b" | "kb" | "mb"]
  const bytes = Number(match[1]) * multiplier
  return Number.isSafeInteger(bytes) ? bytes : null
}

function projectMemoryLimit(root: string) {
  const configured = readJson(resolve(root, "project.json"))?.settings?.maxMemorySize
  if (configured === undefined) return null
  const parsed = parseProjectByteSize(configured)
  if (parsed === null) throw new Error(`settings.maxMemorySize is invalid: ${JSON.stringify(configured)}`)
  return parsed
}

export function projectMemoryRecoveryStatus(root: string): ProjectMemoryRecovery | null {
  const maxSize = projectMemoryLimit(root)
  const memoryPath = resolve(root, "MEMORY.md")
  if (maxSize === null || !existsSync(memoryPath)) return null
  const size = readFileSync(memoryPath).length
  if (size > maxSize) return { status: "required", code: "MEMORY_SIZE_EXCEEDED", size, maxSize }

  const state = readJson(resolve(root, ".task-doctor/state.json"))
  const pending = state?.executorRecovery
  return pending?.status === "required" && pending?.code === "MEMORY_SIZE_EXCEEDED"
    ? { status: "required", code: "MEMORY_SIZE_EXCEEDED", size, maxSize }
    : null
}

function nextRecoveryID(changes: any[]) {
  const highest = changes.reduce((value, entry) => {
    const number = typeof entry?.recoveryID === "string" ? Number(entry.recoveryID.match(/^M(\d+)$/)?.[1]) : NaN
    return Number.isSafeInteger(number) ? Math.max(value, number) : value
  }, 0)
  return `M${highest + 1}`
}

export function recoverProjectMemory(root: string, input: MemoryRecoveryInput) {
  const recovery = projectMemoryRecoveryStatus(root)
  if (!recovery) throw new Error("Project memory does not require Executor recovery.")

  const memoryPath = resolve(root, "MEMORY.md")
  const beforeContent = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : ""
  const beforeHash = existsSync(memoryPath) ? hash(readFileSync(memoryPath)) : null
  const replacement = input.replacement.endsWith("\n") ? input.replacement : `${input.replacement}\n`
  const afterSize = Buffer.byteLength(replacement)
  if (!replacement.trim()) throw new Error("Replacement memory must not be empty.")
  if (afterSize > recovery.maxSize) {
    throw new Error(`Replacement MEMORY.md is ${afterSize} bytes; project.json allows ${recovery.maxSize} bytes.`)
  }
  if (beforeContent && afterSize >= Buffer.byteLength(beforeContent)) {
    throw new Error("Replacement MEMORY.md must be smaller than the current over-limit file.")
  }

  const afterHash = hash(replacement)
  const statePath = resolve(root, ".task-doctor/state.json")
  const state = readJson(statePath)
  const authorizationPath = resolve(root, ".task-doctor/authorized-memory-changes.json")
  const stored = readJson(authorizationPath)
  const previousChanges = stored?.version === 1 && Array.isArray(stored.changes) ? stored.changes : []
  const recoveryID = nextRecoveryID(previousChanges)
  const baselineHashes = new Set<string | null>([beforeHash])
  for (const candidate of [state?.memory?.hash, state?.snapshot?.["MEMORY.md"], state?.verifiedSnapshot?.["MEMORY.md"]]) {
    if (typeof candidate === "string") baselineHashes.add(candidate)
  }
  const recoveredAt = new Date().toISOString()
  const transitions = [...baselineHashes]
    .filter((value) => value !== afterHash)
    .map((value) => ({
      path: "MEMORY.md",
      beforeHash: value,
      afterHash,
      recoveryID,
      reason: input.reason.replace(/\s+/g, " ").trim(),
      executorSessionID: input.executorSessionID,
      recoveredAt,
    }))

  mkdirSync(dirname(authorizationPath), { recursive: true })
  const memoryTempPath = `${memoryPath}.executor-recovery.tmp`
  const authorizationTempPath = `${authorizationPath}.tmp`
  writeFileSync(memoryTempPath, replacement)
  writeFileSync(authorizationTempPath, `${JSON.stringify({
    version: 1,
    changes: [...previousChanges, ...transitions],
    updatedAt: recoveredAt,
  }, null, 2)}\n`)
  renameSync(authorizationTempPath, authorizationPath)
  renameSync(memoryTempPath, memoryPath)

  if (state) {
    writeFileSync(statePath, `${JSON.stringify({
      ...state,
      executorRecovery: {
        ...(state.executorRecovery ?? recovery),
        status: "resolved",
        recoveryID,
        resolvedAt: recoveredAt,
        resolvedBySessionID: input.executorSessionID,
      },
    }, null, 2)}\n`)
  }

  return { recoveryID, beforeSize: Buffer.byteLength(beforeContent), afterSize, maxSize: recovery.maxSize, afterHash }
}

import { createHash } from "node:crypto"
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseProjectByteSize } from "./project-memory.ts"

type TaskMemoryAppendInput = {
  taskPath: string
  entry: string
  workerSessionID: string
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

function memoryLimit(root: string) {
  const configured = readJson(resolve(root, "project.json"))?.settings?.maxMemorySize
  if (configured === undefined) return null
  const parsed = parseProjectByteSize(configured)
  if (parsed === null) throw new Error(`settings.maxMemorySize is invalid: ${JSON.stringify(configured)}`)
  return parsed
}

function localTimestamp(now: Date) {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function normalizeEntry(value: string) {
  return value
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}\s*:?\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
}

function appendLine(baseline: string, line: string) {
  const separator = baseline.length === 0 || baseline.endsWith("\n\n")
    ? ""
    : baseline.endsWith("\n") ? "\n" : "\n\n"
  return `${baseline}${separator}${line}\n`
}

export function appendTaskMemory(root: string, input: TaskMemoryAppendInput, now = new Date()) {
  const taskPath = input.taskPath.replace(/^\.\//, "")
  const statePath = resolve(root, ".task-doctor/state.json")
  const state = readJson(statePath)
  if (state?.taskPath !== taskPath) {
    throw new Error(`Task memory append path must match the active task. Requested ${taskPath}; current task is ${state?.taskPath ?? "none"}.`)
  }

  const entry = normalizeEntry(input.entry)
  if (entry.length < 10) throw new Error("Task memory entry must contain at least 10 meaningful characters.")
  if (entry.length > 1500) throw new Error("Task memory entry must not exceed 1500 characters.")

  const memoryPath = resolve(root, "MEMORY.md")
  const currentContent = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : ""
  const currentHash = existsSync(memoryPath) ? hash(readFileSync(memoryPath)) : null
  const previous = state.taskMemoryAppend
  const terminalVerified = state.status === "passed" || state.status === "completed"
  const previousIsCurrent = previous?.taskHash === state.taskHash && previous.afterHash === currentHash
  if (previousIsCurrent && (previous.entry === entry || terminalVerified)) {
    return {
      taskPath,
      entry: previous.entry as string,
      line: previous.line as string,
      timestamp: previous.timestamp as string,
      beforeHash: previous.beforeHash as string | null,
      afterHash: previous.afterHash as string,
      restoredBaseline: Boolean(previous.restoredBaseline),
      changed: false,
      verified: terminalVerified,
      message: terminalVerified
        ? "Task memory was already appended and verified. Return the REVIEWABLE handoff without another memory change."
        : "The same task memory entry was already appended.",
    }
  }
  if (terminalVerified) {
    throw new Error(`Task ${taskPath} has already passed verification. Do not edit MEMORY.md now; return the REVIEWABLE handoff.`)
  }
  if (state.status !== "started") {
    throw new Error(`Task memory append requires a started task; ${taskPath} is currently ${state.status ?? "inactive"}.`)
  }
  if (state.memoryAction !== "append") {
    throw new Error(`Task ${taskPath} declares Memory action ${state.memoryAction ?? "none"}, not append.`)
  }
  const taskFile = resolve(root, taskPath)
  if (!existsSync(taskFile) || hash(readFileSync(taskFile)) !== state.taskHash) {
    throw new Error(`Task ${taskPath} no longer matches the active Doctor state.`)
  }
  if (typeof state.memoryContent !== "string") {
    throw new Error("The active Doctor state has no authoritative MEMORY.md baseline.")
  }

  const timestamp = localTimestamp(now)
  const line = `- ${timestamp}: ${entry}`
  const nextContent = appendLine(state.memoryContent, line)
  const maxSize = memoryLimit(root)
  const nextSize = Buffer.byteLength(nextContent)
  if (maxSize !== null && nextSize > maxSize) {
    throw new Error(`Appended MEMORY.md would be ${nextSize} bytes; project.json allows ${maxSize} bytes.`)
  }

  const afterHash = hash(nextContent)
  const restoredBaseline = currentContent !== state.memoryContent
  const appendedAt = now.toISOString()
  const nextState = {
    ...state,
    taskMemoryAppend: {
      taskPath,
      taskHash: state.taskHash,
      entry,
      line,
      timestamp,
      beforeHash: currentHash,
      afterHash,
      restoredBaseline,
      workerSessionID: input.workerSessionID,
      appendedAt,
    },
  }
  const memoryTemp = `${memoryPath}.task-append.tmp`
  const stateTemp = `${statePath}.task-append.tmp`
  writeFileSync(memoryTemp, nextContent)
  writeFileSync(stateTemp, `${JSON.stringify(nextState, null, 2)}\n`)
  renameSync(memoryTemp, memoryPath)
  renameSync(stateTemp, statePath)

  return {
    taskPath,
    entry,
    line,
    timestamp,
    beforeHash: currentHash,
    afterHash,
    restoredBaseline,
    changed: true,
    verified: false,
  }
}

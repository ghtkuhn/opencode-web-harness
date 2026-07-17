import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"

export type WorkerHarnessRecoveryTerminal = {
  sessionID: string
  taskPath: string
  taskHash: string
  observedAt: string
  runID?: string
}

type WorkerHarnessRecoveryTerminalStore = {
  version: 1
  sessions: WorkerHarnessRecoveryTerminal[]
  updatedAt: string
}

const HASH = /^[a-f0-9]{64}$/
const transactions = new Map<string, { store: WorkerHarnessRecoveryTerminalStore; original: string }>()
let temporarySequence = 0

function storeFiles(root: string) {
  const directory = resolve(root, ".task-doctor")
  return {
    directory,
    primary: resolve(directory, "worker-harness-recovery-terminals.json"),
    backup: resolve(directory, "worker-harness-recovery-terminals.backup.json"),
  }
}

function ensurePrivateDirectory(root: string) {
  const { directory } = storeFiles(root)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("WORKER HARNESS RECOVERY TERMINAL STORE UNSAFE: .task-doctor must be a real directory.")
  }
  return directory
}

function assertSafeFile(path: string) {
  if (!existsSync(path)) return
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`WORKER HARNESS RECOVERY TERMINAL STORE UNSAFE: ${path} must be a regular file.`)
  }
}

function validEntry(value: unknown): value is WorkerHarnessRecoveryTerminal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry.sessionID === "string" && entry.sessionID.length > 0 && entry.sessionID.length <= 300
    && typeof entry.taskPath === "string" && /^kanban\/todo\/[^/]+\.md$/.test(entry.taskPath)
    && typeof entry.taskHash === "string" && HASH.test(entry.taskHash)
    && typeof entry.observedAt === "string" && Number.isFinite(Date.parse(entry.observedAt))
    && (entry.runID === undefined || (typeof entry.runID === "string" && entry.runID.length > 0 && entry.runID.length <= 300))
}

function validStore(value: unknown): value is WorkerHarnessRecoveryTerminalStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const store = value as Record<string, unknown>
  if (store.version !== 1 || !Array.isArray(store.sessions) || typeof store.updatedAt !== "string") return false
  const ids = new Set<string>()
  for (const entry of store.sessions) {
    if (!validEntry(entry) || ids.has(entry.sessionID)) return false
    ids.add(entry.sessionID)
  }
  return true
}

function parseStoreFile(path: string) {
  assertSafeFile(path)
  if (!existsSync(path)) return { status: "missing" as const }
  const text = readFileSync(path, "utf8")
  try {
    const store = JSON.parse(text)
    return validStore(store)
      ? { status: "valid" as const, store, text }
      : { status: "invalid" as const }
  } catch {
    return { status: "invalid" as const }
  }
}

function fsyncDirectory(directory: string) {
  const descriptor = openSync(directory, fsConstants.O_RDONLY)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function atomicWrite(root: string, destination: string, text: string) {
  const directory = ensurePrivateDirectory(root)
  assertSafeFile(destination)
  const temporary = resolve(directory, `.worker-harness-recovery-terminals.${process.pid}.${++temporarySequence}.tmp`)
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
    fsyncDirectory(directory)
  } catch (error) {
    if (!closed) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }
}

function serialize(store: WorkerHarnessRecoveryTerminalStore) {
  return `${JSON.stringify({
    version: 1,
    sessions: store.sessions,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`
}

function publish(root: string, store: WorkerHarnessRecoveryTerminalStore) {
  const { primary, backup } = storeFiles(root)
  const text = serialize(store)
  // The loader treats a valid primary as authoritative. Publish it first so a
  // crash between the two atomic renames can only leave a stale backup, which
  // durableStore repairs from the new primary. Publishing backup first could
  // lose a newly-recorded terminal receipt after restart.
  atomicWrite(root, primary, text)
  atomicWrite(root, backup, text)
}

function durableStore(root: string): WorkerHarnessRecoveryTerminalStore {
  const { primary, backup } = storeFiles(root)
  ensurePrivateDirectory(root)
  const main = parseStoreFile(primary)
  const recovery = parseStoreFile(backup)
  if (main.status === "valid") {
    if (recovery.status !== "valid" || recovery.text !== main.text) atomicWrite(root, backup, main.text)
    return main.store
  }
  if (recovery.status === "valid") {
    atomicWrite(root, primary, recovery.text)
    return recovery.store
  }
  if (main.status === "missing" && recovery.status === "missing") {
    return { version: 1, sessions: [], updatedAt: new Date(0).toISOString() }
  }
  throw new Error("WORKER HARNESS RECOVERY TERMINAL STORE CORRUPT: neither primary nor backup is valid.")
}

function mutate<T>(root: string, mutation: (store: WorkerHarnessRecoveryTerminalStore) => T): T {
  const key = storeFiles(root).primary
  const active = transactions.get(key)
  if (active) return mutation(active.store)
  const store = durableStore(root)
  const transaction = { store, original: JSON.stringify(store) }
  transactions.set(key, transaction)
  try {
    const result = mutation(store)
    if (JSON.stringify(store) !== transaction.original) publish(root, store)
    return result
  } finally {
    transactions.delete(key)
  }
}

export function loadWorkerHarnessRecoveryTerminals(root: string) {
  return durableStore(root).sessions.map((entry) => ({ ...entry }))
}

export function rememberWorkerHarnessRecoveryTerminal(
  root: string,
  input: Omit<WorkerHarnessRecoveryTerminal, "observedAt"> & { observedAt?: string },
) {
  if (!validEntry({ ...input, observedAt: input.observedAt ?? new Date().toISOString() })) {
    throw new Error("Invalid Worker Harness recovery terminal receipt.")
  }
  return mutate(root, (store) => {
    const existing = store.sessions.find((entry) => entry.sessionID === input.sessionID)
    if (existing) return { entry: { ...existing }, created: false }
    const entry: WorkerHarnessRecoveryTerminal = {
      sessionID: input.sessionID,
      taskPath: input.taskPath,
      taskHash: input.taskHash,
      observedAt: input.observedAt ?? new Date().toISOString(),
      ...(input.runID ? { runID: input.runID } : {}),
    }
    store.sessions.push(entry)
    return { entry: { ...entry }, created: true }
  })
}

export function forgetWorkerHarnessRecoveryTerminal(root: string, sessionID: string) {
  return mutate(root, (store) => {
    const before = store.sessions.length
    store.sessions = store.sessions.filter((entry) => entry.sessionID !== sessionID)
    return store.sessions.length !== before
  })
}

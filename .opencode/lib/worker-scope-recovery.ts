import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { execFileSync } from "node:child_process"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"

export type WorkerScopeRecoveryState = {
  taskPath: string
  startedAt: string
  head?: string | null
  snapshot: Record<string, string>
}

export type WorkerScopeRecoveryReceiptFile = {
  path: string
  beforeHash: string | null
  afterHash: string | null
  beforeMode?: number | null
  afterMode?: number | null
  /** Legacy v1 alias for beforeMode. */
  mode?: number | null
}

export type WorkerScopeRecoveryReceipt = {
  version: number
  id: string
  status: string
  taskPath: string
  appliedAt?: string
  files: WorkerScopeRecoveryReceiptFile[]
}

export type WorkerScopeRecoveryPlanEntry = {
  path: string
  baselineHash: string | null
  currentHash: string | null
  baselineContent: Buffer | null
  baselineMode: number | null
  currentMode: number | null
  source: "blob" | "git" | "delete"
  receiptIDs: string[]
}

export type WorkerScopeRecoveryPlan = {
  root: string
  taskPath: string
  startedAt: string
  nextScope: string[]
  entries: WorkerScopeRecoveryPlanEntry[]
}

export type AppliedWorkerScopeRecovery = {
  paths: string[]
  rollback(): void
  finalize(): void
}

export type WorkerScopeRecoveryPlanInput = {
  root: string
  state: WorkerScopeRecoveryState
  currentSnapshot: Record<string, string>
  nextScope: string[]
  previousScope?: string[]
  candidatePaths?: string[]
  ignoredPaths?: string[]
  receipts?: WorkerScopeRecoveryReceipt[]
  readBaselineBlob?: (hash: string) => Buffer | null
}

type ReceiptEdge = {
  id: string
  beforeHash: string | null
  afterHash: string | null
  appliedAt: number
  beforeMode: number | null
  afterMode: number | null
}

type PreparedEntry = {
  entry: WorkerScopeRecoveryPlanEntry
  target: string
  temporary: string | null
  temporaryIdentity: string | null
  backup: string | null
  backupLinked: boolean
  targetRemoved: boolean
  targetInstalled: boolean
  bindings: DirectoryBinding[]
}

type DirectoryBinding = {
  path: string
  descriptor: number
  identity: string
}

type FileObservation = {
  hash: string
  mode: number
  identity: string
}

/** @internal Deterministic scheduling seam for filesystem race regression tests. */
export type WorkerScopeRecoveryTestHooks = {
  afterEntryPrepared?(entry: WorkerScopeRecoveryPlanEntry, index: number): void
  beforeFinalizeBackupCleanup?(entry: WorkerScopeRecoveryPlanEntry, index: number): void
}

const HASH = /^[a-f0-9]{64}$/
const GIT_HEAD = /^[a-f0-9]{7,64}$/
const MISSING = "\u0000missing"

function digest(value: Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

function hashKey(value: string | null) {
  return value ?? MISSING
}

function normalizeHash(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== "string" || !HASH.test(value)) return undefined
  return value
}

function normalizeMode(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0o777
    ? value
    : null
}

function exactRelativePath(rawPath: string) {
  const path = rawPath.replace(/^\.\//, "")
  if (!path || isAbsolute(path) || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error(`Worker Scope recovery requires an exact project-relative path: ${rawPath}`)
  }
  if (path.endsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Worker Scope recovery rejects directory, empty, and dot-segment paths: ${rawPath}`)
  }
  if (/[*?\[\]{}]/.test(path)) throw new Error(`Worker Scope recovery does not accept glob paths: ${rawPath}`)
  return path
}

function scopePath(rawPath: string) {
  const withoutMarker = rawPath.replace(/^NEW:\s*/i, "").replace(/^`|`$/g, "").replace(/^\.\//, "").replace(/\/$/, "")
  if (!withoutMarker || isAbsolute(withoutMarker) || withoutMarker.includes("\\") || /[\u0000-\u001f\u007f]/.test(withoutMarker)) {
    throw new Error(`Worker Scope recovery received an invalid Scope entry: ${rawPath}`)
  }
  if (withoutMarker.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Worker Scope recovery received a dot-segment Scope entry: ${rawPath}`)
  }
  if (/[*?\[\]{}]/.test(withoutMarker)) throw new Error(`Worker Scope recovery does not accept Scope globs: ${rawPath}`)
  return withoutMarker
}

function allowed(path: string, scope: string[]) {
  return scope.some((entry) => path === entry || path.startsWith(`${entry}/`))
}

function inside(root: string, path: string) {
  const value = relative(root, path)
  return value === "" || (!value.startsWith("..") && !isAbsolute(value))
}

function assertSafePath(root: string, path: string, allowMissingTarget: boolean) {
  const realRoot = realpathSync(root)
  const parts = path.split("/")
  let current = resolve(root)
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index])
    if (!inside(resolve(root), current)) throw new Error(`Worker Scope recovery path escapes the project: ${path}`)
    if (!existsSync(current)) {
      if (index < parts.length - 1 || !allowMissingTarget) {
        throw new Error(`Worker Scope recovery path is missing: ${path}`)
      }
      continue
    }
    const info = lstatSync(current)
    if (info.isSymbolicLink()) throw new Error(`Worker Scope recovery rejects symlinks and symlink ancestors: ${path}`)
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(`Worker Scope recovery path has a non-directory ancestor: ${path}`)
    }
    if (index === parts.length - 1 && !info.isFile()) {
      throw new Error(`Worker Scope recovery accepts regular files only: ${path}`)
    }
    if (!inside(realRoot, realpathSync(current))) throw new Error(`Worker Scope recovery path resolves outside the project: ${path}`)
  }
}

function currentFile(root: string, path: string) {
  const absolute = resolve(root, path)
  assertSafePath(root, path, true)
  if (!existsSync(absolute)) return { hash: null, mode: null }
  const info = lstatSync(absolute)
  return { hash: digest(readFileSync(absolute)), mode: info.mode & 0o777 }
}

export function readWorkerScopeRecoveryReceipts(root: string): WorkerScopeRecoveryReceipt[] {
  const directory = resolve(root, ".task-doctor/worker-change-receipts")
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((name) => /^C-[a-f0-9]+\.json$/.test(name)).flatMap((name) => {
    try {
      const receipt = JSON.parse(readFileSync(resolve(directory, name), "utf8"))
      return [receipt as WorkerScopeRecoveryReceipt]
    } catch {
      return []
    }
  })
}

function receiptEdges(receipts: WorkerScopeRecoveryReceipt[], taskPath: string, startedAt: number, path: string) {
  return receipts.flatMap((receipt): ReceiptEdge[] => {
    const appliedAt = Date.parse(String(receipt.appliedAt ?? ""))
    if (receipt.status !== "applied" || receipt.taskPath !== taskPath || !Number.isFinite(appliedAt) || appliedAt < startedAt) return []
    if (typeof receipt.id !== "string" || !Array.isArray(receipt.files)) return []
    return receipt.files.flatMap((file) => {
      if (!file || file.path !== path) return []
      const beforeHash = normalizeHash(file.beforeHash)
      const afterHash = normalizeHash(file.afterHash)
      if (beforeHash === undefined || afterHash === undefined || beforeHash === afterHash) return []
      const beforeMode = file.beforeMode !== undefined ? file.beforeMode : file.mode
      return [{
        id: receipt.id,
        beforeHash,
        afterHash,
        appliedAt,
        beforeMode: normalizeMode(beforeMode),
        afterMode: normalizeMode(file.afterMode),
      }]
    })
  }).sort((left, right) => left.appliedAt - right.appliedAt || left.id.localeCompare(right.id))
}

function shortestReceiptChain(edges: ReceiptEdge[], baselineHash: string | null, currentHash: string | null, startedAt: number) {
  if (baselineHash === currentHash) return []
  const queue: Array<{ hash: string | null; lastAt: number; chain: ReceiptEdge[] }> = [{ hash: baselineHash, lastAt: startedAt, chain: [] }]
  const best = new Map<string, number>([[`${hashKey(baselineHash)}@${startedAt}`, 0]])
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const edge of edges) {
      if (edge.beforeHash !== current.hash || edge.appliedAt < current.lastAt || current.chain.some((entry) => entry.id === edge.id)) continue
      const chain = [...current.chain, edge]
      if (edge.afterHash === currentHash) return chain
      const key = `${hashKey(edge.afterHash)}@${edge.appliedAt}`
      if ((best.get(key) ?? Number.MAX_SAFE_INTEGER) <= chain.length) continue
      best.set(key, chain.length)
      queue.push({ hash: edge.afterHash, lastAt: edge.appliedAt, chain })
    }
  }
  return null
}

function assertReceiptModeProvenance(chain: ReceiptEdge[], currentMode: number | null, path: string) {
  let expectedMode = chain[0]?.beforeMode ?? null
  for (const edge of chain) {
    if (expectedMode !== null && edge.beforeMode !== null && edge.beforeMode !== expectedMode) {
      throw new Error(`Worker Scope recovery receipt mode chain is inconsistent for ${path}`)
    }
    expectedMode = edge.afterMode
  }
  const recordedCurrentMode = chain.at(-1)?.afterMode ?? null
  if (recordedCurrentMode !== null && recordedCurrentMode !== currentMode) {
    throw new Error(`Worker Scope recovery current mode is not proven by the receipt chain for ${path}`)
  }
}

function gitBaseline(root: string, head: string | null | undefined, path: string, expectedHash: string) {
  if (!head || !GIT_HEAD.test(head)) return null
  try {
    const content = execFileSync("git", ["show", `${head}:${path}`], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 12 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (digest(content) !== expectedHash) return null
    const tree = execFileSync("git", ["ls-tree", "-z", head, "--", path], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8")
    const modeText = tree.match(/^(100644|100755)\s/)?.[1]
    if (!modeText) return null
    return { content, mode: modeText === "100755" ? 0o755 : 0o644 }
  } catch {
    return null
  }
}

function baselineMaterial(input: WorkerScopeRecoveryPlanInput, path: string, baselineHash: string, chain: ReceiptEdge[]) {
  const blob = input.readBaselineBlob?.(baselineHash) ?? null
  if (blob !== null) {
    if (!Buffer.isBuffer(blob) || digest(blob) !== baselineHash) {
      throw new Error(`Worker Scope recovery baseline blob failed its SHA-256 check: ${path}`)
    }
    const receiptMode = chain[0]?.beforeMode ?? null
    if (receiptMode !== null) return { content: Buffer.from(blob), mode: receiptMode, source: "blob" as const }

    // Legacy receipts did not persist mode provenance. Exact bytes may still come from the
    // immutable blob, but only the recorded Git tree is allowed to supply the missing mode.
    const git = gitBaseline(resolve(input.root), input.state.head, path, baselineHash)
    if (git) return { content: Buffer.from(blob), mode: git.mode, source: "blob" as const }
    throw new Error(`Worker Scope recovery has no trusted baseline mode for ${path}`)
  }
  const git = gitBaseline(resolve(input.root), input.state.head, path, baselineHash)
  if (!git) throw new Error(`Worker Scope recovery cannot materialize the exact baseline bytes for ${path}`)
  return { ...git, source: "git" as const }
}

export function planWorkerScopeRecovery(input: WorkerScopeRecoveryPlanInput): WorkerScopeRecoveryPlan {
  const root = realpathSync(resolve(input.root))
  const taskPath = exactRelativePath(input.state.taskPath)
  const startedAt = Date.parse(input.state.startedAt)
  if (!Number.isFinite(startedAt)) throw new Error("Worker Scope recovery requires a valid Doctor startedAt timestamp.")
  const nextScope = [...new Set(input.nextScope.map(scopePath))]
  const previousScope = input.previousScope?.map(scopePath)
  if (input.candidatePaths === undefined && previousScope === undefined) {
    throw new Error("Worker Scope recovery requires previousScope or exact candidatePaths.")
  }
  const ignored = new Set([taskPath, ...(input.ignoredPaths ?? []).map(exactRelativePath)])
  const receipts = input.receipts ?? readWorkerScopeRecoveryReceipts(root)
  const eligibleReceiptPaths = receipts.flatMap((receipt) => {
    const appliedAt = Date.parse(String(receipt.appliedAt ?? ""))
    if (receipt.status !== "applied" || receipt.taskPath !== taskPath || !Number.isFinite(appliedAt) || appliedAt < startedAt) return []
    return Array.isArray(receipt.files)
      ? receipt.files.flatMap((file) => typeof file?.path === "string" ? [file.path] : [])
      : []
  })
  const availablePaths = new Set([
    ...Object.keys(input.state.snapshot),
    ...Object.keys(input.currentSnapshot),
    ...eligibleReceiptPaths,
  ])
  const selectedPaths = input.candidatePaths !== undefined
    ? [...new Set(input.candidatePaths.map(exactRelativePath))]
    : [...availablePaths].map(exactRelativePath).filter((path) => allowed(path, previousScope!))
  const entries: WorkerScopeRecoveryPlanEntry[] = []

  for (const path of selectedPaths.sort()) {
    if (ignored.has(path) || allowed(path, nextScope)) continue
    const baselineHash = Object.prototype.hasOwnProperty.call(input.state.snapshot, path)
      ? normalizeHash(input.state.snapshot[path])
      : null
    const currentHash = Object.prototype.hasOwnProperty.call(input.currentSnapshot, path)
      ? normalizeHash(input.currentSnapshot[path])
      : null
    if (baselineHash === undefined || currentHash === undefined) {
      throw new Error(`Worker Scope recovery snapshot contains an invalid SHA-256 hash: ${path}`)
    }
    if (baselineHash === currentHash) continue

    const observed = currentFile(root, path)
    if (observed.hash !== currentHash) {
      throw new Error(`Worker Scope recovery current snapshot is stale for ${path}`)
    }
    const edges = receiptEdges(receipts, taskPath, startedAt, path)
    const chain = shortestReceiptChain(edges, baselineHash, currentHash, startedAt)
    if (!chain) {
      throw new Error(`Worker Scope recovery refuses unproven current bytes outside the next Scope: ${path}`)
    }
    assertReceiptModeProvenance(chain, observed.mode, path)

    if (baselineHash === null) {
      entries.push({
        path,
        baselineHash,
        currentHash,
        baselineContent: null,
        baselineMode: null,
        currentMode: observed.mode,
        source: "delete",
        receiptIDs: chain.map((edge) => edge.id),
      })
      continue
    }
    const material = baselineMaterial(input, path, baselineHash, chain)
    entries.push({
      path,
      baselineHash,
      currentHash,
      baselineContent: material.content,
      baselineMode: material.mode,
      currentMode: observed.mode,
      source: material.source,
      receiptIDs: chain.map((edge) => edge.id),
    })
  }

  return { root, taskPath, startedAt: input.state.startedAt, nextScope, entries }
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : ""
}

type FileStat = NonNullable<ReturnType<typeof lstatSync>>

function identity(info: FileStat) {
  return `${info.dev}:${info.ino}`
}

function fingerprint(info: FileStat) {
  return `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}

function openDirectoryBinding(path: string): DirectoryBinding {
  const before = lstatSync(path)
  if (before.isSymbolicLink() || !before.isDirectory() || realpathSync(path) !== path) {
    throw new Error(`Worker Scope recovery requires a canonical symlink-free directory: ${path}`)
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor)
    const after = lstatSync(path)
    if (!opened.isDirectory() || after.isSymbolicLink() || !after.isDirectory()
      || identity(before) !== identity(opened) || identity(opened) !== identity(after)) {
      throw new Error(`Worker Scope recovery directory changed while being bound: ${path}`)
    }
    return { path, descriptor, identity: identity(opened) }
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}

function verifyBindings(bindings: DirectoryBinding[]) {
  for (const binding of bindings) {
    const opened = fstatSync(binding.descriptor)
    const current = lstatSync(binding.path)
    if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
      || identity(opened) !== binding.identity || identity(current) !== binding.identity
      || realpathSync(binding.path) !== binding.path) {
      throw new Error(`Worker Scope recovery directory binding changed: ${binding.path}`)
    }
  }
}

function closeBindings(bindings: Iterable<DirectoryBinding>) {
  for (const binding of bindings) {
    try { closeSync(binding.descriptor) } catch { /* transaction no longer uses it */ }
  }
}

function bindDirectories(root: string, paths: string[]) {
  const result = new Map<string, DirectoryBinding>()
  const bind = (path: string) => {
    if (!result.has(path)) result.set(path, openDirectoryBinding(path))
  }
  try {
    bind(root)
    for (const path of paths) {
      const parent = dirname(resolve(root, path))
      if (!inside(root, parent)) throw new Error(`Worker Scope recovery parent escapes the project: ${path}`)
      let current = root
      const suffix = relative(root, parent)
      for (const part of suffix ? suffix.split(/[\\/]/) : []) {
        current = resolve(current, part)
        bind(current)
      }
    }
    return result
  } catch (error) {
    closeBindings(result.values())
    throw error
  }
}

function targetBindings(root: string, target: string, all: Map<string, DirectoryBinding>) {
  const result: DirectoryBinding[] = []
  let current = dirname(target)
  while (true) {
    const binding = all.get(current)
    if (!binding) throw new Error(`Worker Scope recovery lacks a parent binding: ${target}`)
    result.unshift(binding)
    if (current === root) return result
    current = dirname(current)
  }
}

function lstatOrMissing(path: string) {
  try { return lstatSync(path) } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw error
  }
}

function observeFile(item: PreparedEntry, path: string): FileObservation | null {
  verifyBindings(item.bindings)
  const before = lstatOrMissing(path)
  if (before === null) {
    verifyBindings(item.bindings)
    return null
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Worker Scope recovery rejects a non-regular file: ${item.entry.path}`)
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const openedBefore = fstatSync(descriptor)
    if (!openedBefore.isFile() || identity(openedBefore) !== identity(before)) {
      throw new Error(`Worker Scope recovery file changed while opening: ${item.entry.path}`)
    }
    const content = readFileSync(descriptor)
    const openedAfter = fstatSync(descriptor)
    const after = lstatOrMissing(path)
    if (after === null || after.isSymbolicLink() || !after.isFile()
      || fingerprint(openedBefore) !== fingerprint(openedAfter)
      || fingerprint(openedAfter) !== fingerprint(after)) {
      throw new Error(`Worker Scope recovery file changed while reading: ${item.entry.path}`)
    }
    verifyBindings(item.bindings)
    return { hash: digest(content), mode: openedAfter.mode & 0o777, identity: identity(openedAfter) }
  } finally {
    closeSync(descriptor)
  }
}

function assertFile(item: PreparedEntry, path: string, hash: string | null, mode: number | null, message: string) {
  const observed = observeFile(item, path)
  if (hash === null ? observed !== null || mode !== null : observed === null || observed.hash !== hash || observed.mode !== mode) {
    throw new Error(message)
  }
  return observed
}

function artifactPath(target: string, suffix: "tmp" | "bak") {
  return resolve(dirname(target), `.${basename(target)}.scope-recovery.${randomBytes(16).toString("hex")}.${suffix}`)
}

function createTemporary(item: PreparedEntry) {
  const { baselineContent, baselineHash, baselineMode } = item.entry
  if (baselineContent === null || baselineHash === null || baselineMode === null) return
  item.temporary = artifactPath(item.target, "tmp")
  verifyBindings(item.bindings)
  const descriptor = openSync(item.temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, baselineMode)
  try {
    writeFileSync(descriptor, baselineContent)
    fchmodSync(descriptor, baselineMode)
    fsyncSync(descriptor)
    item.temporaryIdentity = identity(fstatSync(descriptor))
  } finally {
    closeSync(descriptor)
  }
  // Node exposes no openat/renameat; retained ancestor FDs plus this immediate
  // recheck are the strongest portable parent binding available here.
  verifyBindings(item.bindings)
  const observed = assertFile(item, item.temporary, baselineHash, baselineMode, `Worker Scope recovery temporary file failed validation: ${item.entry.path}`)
  if (observed?.identity !== item.temporaryIdentity) throw new Error(`Worker Scope recovery temporary file was replaced: ${item.entry.path}`)
}

function unlinkExpected(item: PreparedEntry, path: string, hash: string, mode: number, expectedIdentity: string | null, label: string) {
  const observed = assertFile(item, path, hash, mode, `Worker Scope recovery refuses to remove changed ${label}: ${item.entry.path}`)
  if (!observed || (expectedIdentity !== null && observed.identity !== expectedIdentity)) {
    throw new Error(`Worker Scope recovery refuses to remove replaced ${label}: ${item.entry.path}`)
  }
  verifyBindings(item.bindings)
  unlinkSync(path)
  verifyBindings(item.bindings)
}

function cleanupTemporary(item: PreparedEntry) {
  if (!item.temporary) return
  unlinkExpected(item, item.temporary, item.entry.baselineHash!, item.entry.baselineMode!, item.temporaryIdentity, "temporary file")
  item.temporary = null
  item.temporaryIdentity = null
}

function detachTarget(item: PreparedEntry) {
  const { currentHash, currentMode } = item.entry
  if (currentHash === null || currentMode === null || item.backup === null) return
  const before = assertFile(item, item.target, currentHash, currentMode, `Worker Scope recovery target changed immediately before recovery: ${item.entry.path}`)!
  assertFile(item, item.backup, null, null, `Worker Scope recovery backup path exists: ${item.entry.path}`)
  verifyBindings(item.bindings)
  linkSync(item.target, item.backup) // exclusive destination: never overwrites
  item.backupLinked = true
  const backup = assertFile(item, item.backup, currentHash, currentMode, `Worker Scope recovery backup failed validation: ${item.entry.path}`)!
  const immediate = assertFile(item, item.target, currentHash, currentMode, `Worker Scope recovery target changed immediately before removal: ${item.entry.path}`)!
  if (before.identity !== backup.identity || immediate.identity !== backup.identity) throw new Error(`Worker Scope recovery target inode changed: ${item.entry.path}`)
  verifyBindings(item.bindings)
  // The backup hard link preserves in-place writes. Node cannot combine the last
  // inode check and unlink; cooperative writers must not replace in this tiny gap.
  unlinkSync(item.target)
  item.targetRemoved = true
  verifyBindings(item.bindings)
  assertFile(item, item.target, null, null, `Worker Scope recovery target reappeared during removal: ${item.entry.path}`)
  assertFile(item, item.backup, currentHash, currentMode, `Worker Scope recovery backup changed during removal: ${item.entry.path}`)
}

function installBaseline(item: PreparedEntry) {
  if (!item.temporary) return
  const temp = assertFile(item, item.temporary, item.entry.baselineHash, item.entry.baselineMode, `Worker Scope recovery temporary file changed before install: ${item.entry.path}`)!
  if (temp.identity !== item.temporaryIdentity) throw new Error(`Worker Scope recovery temporary inode changed: ${item.entry.path}`)
  assertFile(item, item.target, null, null, `Worker Scope recovery target reappeared before install: ${item.entry.path}`)
  verifyBindings(item.bindings)
  linkSync(item.temporary, item.target) // fail-if-exists publication
  item.targetInstalled = true
  const installed = assertFile(item, item.target, item.entry.baselineHash, item.entry.baselineMode, `Worker Scope recovery installed target failed validation: ${item.entry.path}`)!
  if (installed.identity !== temp.identity) throw new Error(`Worker Scope recovery installed the wrong inode: ${item.entry.path}`)
  cleanupTemporary(item)
}

function restorePrepared(prepared: PreparedEntry[]) {
  for (const item of [...prepared].reverse()) {
    if (item.targetInstalled) {
      unlinkExpected(item, item.target, item.entry.baselineHash!, item.entry.baselineMode!, null, "restored target")
      item.targetInstalled = false
    }
    if (item.targetRemoved && item.backupLinked && item.backup) {
      const backup = observeFile(item, item.backup)
      if (!backup) throw new Error(`Worker Scope recovery rollback backup is missing: ${item.entry.path}`)
      assertFile(item, item.target, null, null, `Worker Scope recovery cannot overwrite a concurrent target: ${item.entry.path}`)
      verifyBindings(item.bindings)
      linkSync(item.backup, item.target)
      const restored = observeFile(item, item.target)
      if (!restored || restored.identity !== backup.identity || restored.hash !== backup.hash || restored.mode !== backup.mode) {
        throw new Error(`Worker Scope recovery rollback target failed validation: ${item.entry.path}`)
      }
      unlinkExpected(item, item.backup, backup.hash, backup.mode, backup.identity, "backup")
      item.backupLinked = false
      item.targetRemoved = false
    } else if (item.backupLinked && item.backup) {
      const backup = observeFile(item, item.backup)
      const target = observeFile(item, item.target)
      if (!backup || !target || backup.identity !== target.identity) throw new Error(`Worker Scope recovery cannot safely remove backup link: ${item.entry.path}`)
      unlinkExpected(item, item.backup, backup.hash, backup.mode, backup.identity, "backup")
      item.backupLinked = false
    }
    cleanupTemporary(item)
  }
}

function assertPreparedCanFinalize(prepared: PreparedEntry[]) {
  for (const item of prepared) {
    const { baselineHash, baselineMode, currentHash, currentMode } = item.entry
    if (item.temporary !== null || item.temporaryIdentity !== null) {
      throw new Error(`Worker Scope recovery refuses incomplete temporary cleanup: ${item.entry.path}`)
    }
    if (item.targetInstalled !== (baselineHash !== null)) {
      throw new Error(`Worker Scope recovery refuses incomplete target install: ${item.entry.path}`)
    }
    assertFile(item, item.target, baselineHash, baselineMode, `Worker Scope recovery restored target changed before finalize: ${item.entry.path}`)

    if (currentHash === null) {
      if (currentMode !== null || item.backup !== null || item.backupLinked || item.targetRemoved) {
        throw new Error(`Worker Scope recovery refuses unexpected backup state: ${item.entry.path}`)
      }
      continue
    }
    if (currentMode === null || item.backup === null || !item.backupLinked || !item.targetRemoved) {
      throw new Error(`Worker Scope recovery refuses incomplete finalize: ${item.entry.path}`)
    }
    assertFile(item, item.backup, currentHash, currentMode, `Worker Scope recovery backup changed before finalize: ${item.entry.path}`)
  }
}

function cleanupFinalizedBackups(prepared: PreparedEntry[], testHooks?: WorkerScopeRecoveryTestHooks) {
  for (const [index, item] of prepared.entries()) {
    if (!item.backupLinked || !item.backup || item.entry.currentHash === null || item.entry.currentMode === null) continue
    try {
      testHooks?.beforeFinalizeBackupCleanup?.(item.entry, index)
      unlinkExpected(item, item.backup, item.entry.currentHash, item.entry.currentMode, null, "backup")
      item.backupLinked = false
      item.targetRemoved = false
    } catch {
      // The restored baseline is already committed. A cleanup failure may leave a
      // hidden backup artifact, but must never make callers roll back a partially
      // discarded transaction and risk losing the original file.
    }
  }
}

export function applyWorkerScopeRecoveryPlan(
  plan: WorkerScopeRecoveryPlan,
  testHooks?: WorkerScopeRecoveryTestHooks,
): AppliedWorkerScopeRecovery {
  const requestedRoot = resolve(plan.root)
  const root = realpathSync(requestedRoot)
  if (root !== requestedRoot) throw new Error("Worker Scope recovery requires a canonical symlink-free project root.")
  const entries = plan.entries.map((entry) => ({ ...entry, path: exactRelativePath(entry.path) }))
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error("Worker Scope recovery refuses duplicate transaction targets.")
  }
  const allBindings = bindDirectories(root, entries.map((entry) => entry.path))
  const prepared: PreparedEntry[] = entries.map((entry) => {
    const target = resolve(root, entry.path)
    return {
      entry,
      target,
      temporary: null,
      temporaryIdentity: null,
      backup: entry.currentHash === null ? null : artifactPath(target, "bak"),
      backupLinked: false,
      targetRemoved: false,
      targetInstalled: false,
      bindings: targetBindings(root, target, allBindings),
    }
  })

  try {
    for (const item of prepared) {
      const { entry } = item
      if (entry.baselineContent !== null && digest(entry.baselineContent) !== entry.baselineHash) {
        throw new Error(`Worker Scope recovery plan contains invalid baseline bytes: ${entry.path}`)
      }
      if (entry.baselineContent !== null && entry.baselineMode === null) {
        throw new Error(`Worker Scope recovery plan contains no baseline mode: ${entry.path}`)
      }
      assertFile(item, item.target, entry.currentHash, entry.currentMode, `Worker Scope recovery target changed after planning: ${entry.path}`)
    }

    for (const [index, item] of prepared.entries()) {
      createTemporary(item)
      testHooks?.afterEntryPrepared?.(item.entry, index)
    }

    // An edit during multi-file preparation aborts before the first target is removed.
    for (const item of prepared) {
      assertFile(item, item.target, item.entry.currentHash, item.entry.currentMode, `Worker Scope recovery target changed during transaction preparation: ${item.entry.path}`)
    }
    for (const item of prepared) {
      detachTarget(item)
      installBaseline(item)
    }
  } catch (error) {
    try {
      restorePrepared(prepared)
    } catch (rollbackError) {
      closeBindings(allBindings.values())
      throw new AggregateError([error, rollbackError], "Worker Scope recovery failed and could not cleanly restore its transaction.")
    }
    closeBindings(allBindings.values())
    throw error
  }

  let active = true
  return {
    paths: entries.map((entry) => entry.path),
    rollback() {
      if (!active) throw new Error("Worker Scope recovery transaction is already finalized or rolled back.")
      for (const item of prepared) {
        assertFile(item, item.target, item.entry.baselineHash, item.entry.baselineMode, `Worker Scope recovery cannot roll back because the restored target changed: ${item.entry.path}`)
      }
      restorePrepared(prepared)
      active = false
      closeBindings(allBindings.values())
    },
    finalize() {
      if (!active) throw new Error("Worker Scope recovery transaction is already finalized or rolled back.")
      // Validation is read-only, so any failure still leaves every rollback backup
      // intact. Once it succeeds, commit before best-effort artifact cleanup: backup
      // deletion cannot be made atomic across multiple files.
      assertPreparedCanFinalize(prepared)
      active = false
      cleanupFinalizedBackups(prepared, testHooks)
      closeBindings(allBindings.values())
    },
  }
}

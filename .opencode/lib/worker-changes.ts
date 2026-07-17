import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path"

export type WorkerChangeOperation =
  | { kind: "replace"; path: string; oldText: string; newText: string; expectedOccurrences: number }
  | { kind: "rewrite"; path: string; content: string }
  | { kind: "create"; path: string; content: string }
  | { kind: "delete"; path: string }

export type WorkerChangePolicy = {
  root: string
  sessionID: string
  taskPath: string
  taskHash: string
  scope: string[]
  newScope: string[]
  protectedPaths: string[]
  readOnlyPaths: string[]
}

export type WorkerChangePreviewFile = {
  path: string
  before: string | null
  after: string | null
}

type StoredChangeFile = {
  path: string
  before: string | null
  after: string | null
  beforeHash: string | null
  afterHash: string | null
  /** Legacy v1 name for beforeMode. Keep reading/writing it while previews may survive a restart. */
  mode?: number | null
  beforeMode?: number | null
  afterMode?: number | null
}

type StoredChangeSet = {
  version: 1
  id: string
  previewToken: string
  status: "previewed"
  sessionID: string
  taskPath: string
  taskHash: string
  purpose: string
  files: StoredChangeFile[]
  previewComplete: boolean
  createdAt: string
}

export type WorkerChangeReceipt = {
  version: 1
  id: string
  status: "applied" | "discarded" | "cleaned"
  sessionID: string
  taskPath: string
  taskHash: string
  purpose: string
  files: Array<{
    path: string
    beforeHash: string | null
    afterHash: string | null
    beforeMode?: number | null
    afterMode?: number | null
  }>
  finishedAt: string
  appliedAt?: string
  reason?: string
}

export type PendingWorkerChangeSelection = {
  id: string
  previewToken: string
  taskPath: string
  taskHash: string
  paths: string[]
  createdAt: string
}

const MAX_OPERATIONS = 100
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 10 * 1024 * 1024
const MAX_DIFF_BYTES = 40 * 1024
const CHANGE_ID = /^C-[a-f0-9]{6}$/
const BASELINE_HASH = /^[a-f0-9]{64}$/

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

function changeDirectory(root: string) {
  return resolve(realpathSync(resolve(root)), ".task-doctor/worker-change-sets")
}

function receiptDirectory(root: string) {
  return resolve(realpathSync(resolve(root)), ".task-doctor/worker-change-receipts")
}

function baselineDirectory(root: string) {
  return resolve(realpathSync(resolve(root)), ".task-doctor/worker-change-baselines")
}

function secureProjectDirectory(root: string, path: string, create: boolean) {
  const realRoot = realpathSync(resolve(root))
  const target = resolve(path)
  if (!inside(realRoot, target)) throw new Error(`Worker change storage directory escapes the project: ${target}`)
  const parts = relative(realRoot, target).split("/").filter(Boolean)
  let current = realRoot
  for (const part of parts) {
    current = resolve(current, part)
    if (!existsSync(current)) {
      if (!create) return null
      mkdirSync(current, { mode: 0o700 })
    }
    const info = lstatSync(current)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Worker change storage rejects symlink and non-directory components: ${relative(realRoot, current)}`)
    }
    const realCurrent = realpathSync(current)
    if (!inside(realRoot, realCurrent)) {
      throw new Error(`Worker change storage directory resolves outside the project: ${relative(realRoot, current)}`)
    }
  }
  return target
}

function ensurePrivateDirectory(root: string, path: string) {
  const directory = secureProjectDirectory(root, path, true)!
  try {
    chmodSync(directory, 0o700)
  } catch {
    // Some filesystems do not expose POSIX permissions.
  }
  // Re-walk every component after creation/chmod so a replaced directory is never trusted.
  secureProjectDirectory(root, directory, false)
  return directory
}

function baselinePath(root: string, hash: string) {
  if (!BASELINE_HASH.test(hash)) throw new Error(`Invalid Worker change baseline hash: ${hash}`)
  return resolve(baselineDirectory(root), `${hash}.blob`)
}

export function readWorkerChangeBaseline(root: string, hash: string) {
  const directory = baselineDirectory(root)
  if (secureProjectDirectory(root, directory, false) === null) return null
  const path = baselinePath(root, hash)
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Worker change baseline blob is not a regular file: ${hash}`)
  }
  const realRoot = realpathSync(resolve(root))
  if (!inside(realRoot, realpathSync(path))) {
    throw new Error(`Worker change baseline blob resolves outside the project: ${hash}`)
  }
  const bytes = readFileSync(path)
  if (digest(bytes) !== hash) throw new Error(`Worker change baseline blob is corrupt: ${hash}`)
  return bytes
}

export function persistWorkerChangeBaseline(root: string, content: string) {
  const bytes = Buffer.from(content, "utf8")
  const hash = digest(bytes)
  const directory = baselineDirectory(root)
  const path = baselinePath(root, hash)
  const publicPath = resolve(root, ".task-doctor/worker-change-baselines", `${hash}.blob`)
  ensurePrivateDirectory(root, directory)

  if (readWorkerChangeBaseline(root, hash) !== null) return { hash, path: publicPath }

  const temporary = resolve(directory, `.${hash}.${randomBytes(4).toString("hex")}.tmp`)
  try {
    // Revalidate immediately before the temporary write and immutable publication.
    ensurePrivateDirectory(root, directory)
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" })
    const temporaryInfo = lstatSync(temporary)
    if (temporaryInfo.isSymbolicLink() || !temporaryInfo.isFile() || !inside(realpathSync(resolve(root)), realpathSync(temporary))) {
      throw new Error(`Worker change baseline temporary file is unsafe: ${hash}`)
    }
    try {
      // A hard-link publishes the fully-written temporary file without replacing an existing blob.
      ensurePrivateDirectory(root, directory)
      linkSync(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (readWorkerChangeBaseline(root, hash) === null) {
        throw new Error(`Worker change baseline blob disappeared during immutable publication: ${hash}`)
      }
    }
  } finally {
    rmSync(temporary, { force: true })
  }

  if (readWorkerChangeBaseline(root, hash) === null) {
    throw new Error(`Worker change baseline blob was not published: ${hash}`)
  }
  return { hash, path: publicPath }
}

function changePath(root: string, id: string) {
  if (!CHANGE_ID.test(id)) throw new Error(`Invalid Worker change ID: ${id}`)
  return resolve(changeDirectory(root), `${id}.json`)
}

function readChangeSet(root: string, id: string): StoredChangeSet {
  const path = changePath(root, id)
  if (!existsSync(path)) throw new Error(`Worker change ${id} does not exist or has already been cleaned up.`)
  const value = JSON.parse(readFileSync(path, "utf8")) as StoredChangeSet
  if (value.version !== 1 || value.id !== id || value.status !== "previewed" || !Array.isArray(value.files)) {
    throw new Error(`Worker change ${id} is invalid.`)
  }
  return value
}

function storedMode(value: unknown, label: string) {
  if (value === null) return null
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0o777) {
    throw new Error(`Worker change contains an invalid ${label}.`)
  }
  return value
}

function storedBeforeMode(file: StoredChangeFile) {
  if (file.before === null) return null
  const raw = file.beforeMode !== undefined ? file.beforeMode : file.mode
  if (raw === undefined || raw === null) {
    throw new Error(`Worker change contains no trusted before mode: ${file.path}`)
  }
  return storedMode(raw, `before mode for ${file.path}`)!
}

function storedAfterMode(file: StoredChangeFile) {
  if (file.after === null) return null
  if (file.afterMode !== undefined) {
    if (file.afterMode === null) throw new Error(`Worker change contains no after mode for ${file.path}.`)
    return storedMode(file.afterMode, `after mode for ${file.path}`)!
  }
  return file.before === null ? 0o644 : storedBeforeMode(file)
}

function writeChangeSet(root: string, value: StoredChangeSet) {
  const directory = changeDirectory(root)
  ensurePrivateDirectory(root, directory)
  writeFileSync(changePath(root, value.id), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" })
}

function writeReceipt(root: string, value: StoredChangeSet, status: WorkerChangeReceipt["status"], reason?: string) {
  const finishedAt = new Date().toISOString()
  const receipt: WorkerChangeReceipt = {
    version: 1,
    id: value.id,
    status,
    sessionID: value.sessionID,
    taskPath: value.taskPath,
    taskHash: value.taskHash,
    purpose: value.purpose,
    files: value.files.map((file) => ({
      path: file.path,
      beforeHash: file.beforeHash,
      afterHash: file.afterHash,
      beforeMode: storedBeforeMode(file),
      afterMode: storedAfterMode(file),
    })),
    finishedAt,
    ...(status === "applied" ? { appliedAt: finishedAt } : {}),
    ...(reason ? { reason } : {}),
  }
  ensurePrivateDirectory(root, receiptDirectory(root))
  writeFileSync(resolve(receiptDirectory(root), `${value.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  return receipt
}

function allowed(path: string, scope: string[]) {
  return scope.some((entry) => path === entry || path.startsWith(`${entry}/`))
}

function inside(root: string, path: string) {
  const result = relative(root, path)
  return result === "" || (!result.startsWith("..") && !isAbsolute(result))
}

function exactRelativePath(path: string) {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0")) {
    throw new Error(`Worker changes require an exact project-relative path: ${path}`)
  }
  if (path.endsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Worker changes reject directory, empty, and dot-segment paths: ${path}`)
  }
  if (/[*?\[\]{}]/.test(path)) throw new Error(`Worker changes do not accept glob paths: ${path}`)
  return path.replace(/^\.\//, "")
}

function protectedBy(path: string, protectedPaths: string[]) {
  return protectedPaths.some((entry) => path === entry || path.startsWith(`${entry}/`))
}

function assertSafeFilesystemPath(root: string, path: string, allowMissing: boolean) {
  const realRoot = realpathSync(root)
  const parts = path.split("/")
  let current = resolve(root)
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index])
    if (!inside(resolve(root), current)) throw new Error(`Worker change path escapes the project: ${path}`)
    if (!existsSync(current)) {
      if (!allowMissing) throw new Error(`Worker change target does not exist: ${path}`)
      continue
    }
    const info = lstatSync(current)
    if (info.isSymbolicLink()) throw new Error(`Worker changes reject symlinks and symlink ancestors: ${path}`)
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(`Worker change path has a non-directory ancestor: ${path}`)
    }
    const realCurrent = realpathSync(current)
    if (!inside(realRoot, realCurrent)) throw new Error(`Worker change path resolves outside the project: ${path}`)
  }
  if (existsSync(current) && !lstatSync(current).isFile()) {
    throw new Error(`Worker changes accept regular files only: ${path}`)
  }
}

function validateTarget(policy: WorkerChangePolicy, rawPath: string, allowMissing: boolean) {
  const path = exactRelativePath(rawPath)
  if (!allowed(path, policy.scope)) throw new Error(`Worker change target is outside the active task Scope: ${path}`)
  if (protectedBy(path, policy.protectedPaths) || protectedBy(path, policy.readOnlyPaths)) {
    throw new Error(`Worker change target is protected or read-only: ${path}`)
  }
  assertSafeFilesystemPath(policy.root, path, allowMissing)
  return path
}

function checkedContent(content: string, path: string) {
  if (content.includes("\0")) throw new Error(`Worker changes reject binary content: ${path}`)
  const bytes = Buffer.byteLength(content)
  if (bytes > MAX_FILE_BYTES) throw new Error(`Worker change content exceeds ${MAX_FILE_BYTES} bytes: ${path}`)
  return content
}

function repairSerializedMultilineContent(content: string) {
  const separators: number[] = []
  let quote: "'" | '"' | "`" | null = null
  let regex = false
  let regexCharacterClass = false
  let escaped = false
  let canStartRegex = true
  const regexPrefixKeywords = new Set(["await", "case", "delete", "in", "instanceof", "of", "return", "throw", "typeof", "void", "yield"])
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === quote) {
        quote = null
        canStartRegex = false
      }
      continue
    }
    if (regex) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === "[") regexCharacterClass = true
      else if (character === "]") regexCharacterClass = false
      else if (character === "/" && !regexCharacterClass) {
        regex = false
        canStartRegex = false
      }
      continue
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character
      continue
    }
    if (/[A-Za-z_$]/.test(character)) {
      const match = content.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0] ?? character
      canStartRegex = regexPrefixKeywords.has(match)
      index += match.length - 1
      continue
    }
    if (/[0-9]/.test(character)) {
      const match = content.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/)?.[0] ?? character
      canStartRegex = false
      index += match.length - 1
      continue
    }
    if (character === "/" && content[index + 1] !== "/" && content[index + 1] !== "*" && canStartRegex) {
      regex = true
      regexCharacterClass = false
      escaped = false
      continue
    }
    if (character === "\\" && content[index + 1] === "n") {
      let precedingBackslashes = 0
      for (let cursor = index - 1; cursor >= 0 && content[cursor] === "\\"; cursor -= 1) precedingBackslashes += 1
      if (precedingBackslashes % 2 === 0) {
        separators.push(index)
        index += 1
        canStartRegex = true
        continue
      }
    }
    if (!/\s/.test(character)) {
      canStartRegex = /[([{=,:;!?&|+\-*%^~<>]/.test(character)
    }
  }

  // Repeated structural separators are strong evidence that a multiline payload was serialized twice.
  if (separators.length < 2 || !separators.some((index) => (
    content.slice(0, index).trim().length > 0 && content.slice(index + 2).trim().length > 0
  ))) return content

  let repaired = ""
  let offset = 0
  for (const index of separators) {
    repaired += `${content.slice(offset, index)}\n`
    offset = index + 2
  }
  return repaired + content.slice(offset)
}

function readText(path: string) {
  const bytes = readFileSync(path)
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`Worker change target exceeds ${MAX_FILE_BYTES} bytes: ${path}`)
  if (bytes.includes(0)) throw new Error(`Worker changes reject binary files: ${path}`)
  const content = bytes.toString("utf8")
  if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error(`Worker changes require UTF-8 text files: ${path}`)
  return content
}

function occurrences(content: string, needle: string) {
  let count = 0
  let offset = 0
  while (true) {
    const index = content.indexOf(needle, offset)
    if (index === -1) return count
    count += 1
    offset = index + needle.length
  }
}

const MAX_ANCHOR_SOURCE_BYTES = 64 * 1024
const MAX_ANCHOR_BYTES = 4 * 1024
const MAX_ANCHOR_LINES = 64

function lineAlignedOccurrences(content: string, needle: string) {
  let count = 0
  let offset = 0
  while (true) {
    const index = content.indexOf(needle, offset)
    if (index === -1) return count
    const end = index + needle.length
    const startsOnLine = index === 0 || content[index - 1] === "\n"
    const endsOnLine = needle.endsWith("\n")
      || end === content.length
      || content[end] === "\n"
      || (content[end] === "\r" && content[end + 1] === "\n")
    if (startsOnLine && endsOnLine) {
      count += 1
      if (count > 1) return count
    }
    offset = index + 1
  }
}

function uniqueCurrentLineAnchor(content: string, oldText: string) {
  if (!oldText || Buffer.byteLength(oldText) > MAX_ANCHOR_SOURCE_BYTES) return null
  const lines = oldText.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? []
  let best: string | null = null
  let bestBytes = 0
  let tied = false
  const seen = new Set<string>()
  for (let start = 0; start < lines.length; start += 1) {
    let candidate = ""
    for (let end = start; end < lines.length && end < start + MAX_ANCHOR_LINES; end += 1) {
      candidate += lines[end]
      const bytes = Buffer.byteLength(candidate)
      if (bytes > MAX_ANCHOR_BYTES) break
      if (!candidate.trim() || seen.has(candidate)) continue
      seen.add(candidate)
      if (lineAlignedOccurrences(content, candidate) !== 1) continue
      if (bytes > bestBytes) {
        best = candidate
        bestBytes = bytes
        tied = false
      } else if (bytes === bestBytes && candidate !== best) tied = true
    }
  }
  return best !== null && !tied ? best : null
}

function minimalSharedBoundaryRepair(content: string, oldText: string, newText: string, expectedOccurrences: number) {
  const maximum = Math.min(8, oldText.length - 1, newText.length - 1)
  const safeBoundary = (value: string) => value.length > 0 && /^[^\p{L}\p{N}_]+$/u.test(value)
  for (let length = 1; length <= maximum; length += 1) {
    const candidates: Array<{ oldText: string; newText: string; boundary: "prefix" | "suffix"; length: number }> = []
    if (oldText.slice(0, length) === newText.slice(0, length) && safeBoundary(oldText.slice(0, length))) {
      const candidateOld = oldText.slice(length)
      const candidateNew = newText.slice(length)
      if (candidateOld !== candidateNew && occurrences(content, candidateOld) === expectedOccurrences) {
        candidates.push({ oldText: candidateOld, newText: candidateNew, boundary: "prefix", length })
      }
    }
    if (oldText.slice(-length) === newText.slice(-length) && safeBoundary(oldText.slice(-length))) {
      const candidateOld = oldText.slice(0, -length)
      const candidateNew = newText.slice(0, -length)
      if (candidateOld !== candidateNew && occurrences(content, candidateOld) === expectedOccurrences) {
        candidates.push({ oldText: candidateOld, newText: candidateNew, boundary: "suffix", length })
      }
    }
    if (candidates.length === 1) return candidates[0]
    if (candidates.length > 1) return null
  }
  return null
}

function minimalSharedLineIndentRepair(content: string, oldText: string, newText: string, expectedOccurrences: number) {
  if (expectedOccurrences !== 1 || !oldText.includes("\n") || !newText.includes("\n")) return null
  if (/\r(?!\n)/.test(oldText) || /\r(?!\n)/.test(newText)) return null
  const endOfLines = (value: string) => [...value.matchAll(/\r?\n/g)].map((match) => match[0])
  const oldEndOfLines = endOfLines(oldText)
  const newEndOfLines = endOfLines(newText)
  if (JSON.stringify(oldEndOfLines) !== JSON.stringify(newEndOfLines)) return null
  if (new Set(oldEndOfLines).size > 1 || new Set(newEndOfLines).size > 1) return null
  const oldLines = oldText.split(/\r?\n/)
  const newLines = newText.split(/\r?\n/)
  if (oldLines.length !== newLines.length) return null
  let contentLines = 0
  const repairedOldLines: string[] = []
  const repairedNewLines: string[] = []
  for (let index = 0; index < oldLines.length; index += 1) {
    const oldLine = oldLines[index]
    const newLine = newLines[index]
    const oldBlank = /^[ \t]*$/.test(oldLine)
    const newBlank = /^[ \t]*$/.test(newLine)
    if (oldBlank || newBlank) {
      if (oldLine !== newLine) return null
      repairedOldLines.push(oldLine)
      repairedNewLines.push(newLine)
      continue
    }
    const oldIndent = /^[ \t]*/.exec(oldLine)?.[0] ?? ""
    const newIndent = /^[ \t]*/.exec(newLine)?.[0] ?? ""
    if (!oldIndent.startsWith(" ") || oldIndent.includes("\t") || oldIndent !== newIndent) return null
    repairedOldLines.push(oldLine.slice(1))
    repairedNewLines.push(newLine.slice(1))
    contentLines += 1
  }
  if (contentLines === 0) return null
  const joinLines = (lines: string[]) => lines
    .map((line, index) => index < oldEndOfLines.length ? line + oldEndOfLines[index] : line)
    .join("")
  const candidateOld = joinLines(repairedOldLines)
  const candidateNew = joinLines(repairedNewLines)
  if (candidateOld === candidateNew || occurrences(content, candidateOld) !== 1) return null
  const matchIndex = content.indexOf(candidateOld)
  const matchEnd = matchIndex + candidateOld.length
  const startsAtLineBoundary = matchIndex === 0 || content[matchIndex - 1] === "\n"
  const endsAtLineBoundary = candidateOld.endsWith("\n")
    || matchEnd === content.length
    || content[matchEnd] === "\n"
    || content.slice(matchEnd, matchEnd + 2) === "\r\n"
  return startsAtLineBoundary && endsAtLineBoundary
    ? { oldText: candidateOld, newText: candidateNew, length: 1 }
    : null
}

function lineParts(content: string | null) {
  if (content === null || content === "") return []
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function hunkCount(value: number) {
  return value === 1 ? "1" : String(value)
}

function fileDiff(file: StoredChangeFile) {
  const before = lineParts(file.before)
  const after = lineParts(file.after)
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) suffix += 1

  const oldStartIndex = Math.max(0, prefix - 3)
  const newStartIndex = Math.max(0, prefix - 3)
  const oldEnd = Math.min(before.length, before.length - suffix + 3)
  const newEnd = Math.min(after.length, after.length - suffix + 3)
  const oldChangedEnd = before.length - suffix
  const newChangedEnd = after.length - suffix
  const lines = [
    `--- ${file.before === null ? "/dev/null" : `a/${file.path}`}`,
    `+++ ${file.after === null ? "/dev/null" : `b/${file.path}`}`,
    `@@ -${oldStartIndex + 1},${hunkCount(oldEnd - oldStartIndex)} +${newStartIndex + 1},${hunkCount(newEnd - newStartIndex)} @@`,
  ]
  for (let index = oldStartIndex; index < prefix; index += 1) lines.push(` ${before[index].replace(/\n$/, "")}`)
  for (let index = prefix; index < oldChangedEnd; index += 1) lines.push(`-${before[index].replace(/\n$/, "")}`)
  for (let index = prefix; index < newChangedEnd; index += 1) lines.push(`+${after[index].replace(/\n$/, "")}`)
  const trailing = before.slice(oldChangedEnd, oldEnd)
  for (const line of trailing) lines.push(` ${line.replace(/\n$/, "")}`)
  return `${lines.join("\n")}\n`
}

function boundedDiff(files: StoredChangeFile[]) {
  const complete = files.map(fileDiff).join("\n")
  if (Buffer.byteLength(complete) <= MAX_DIFF_BYTES) return { diff: complete, truncated: false }
  return {
    diff: `${Buffer.from(complete).subarray(0, MAX_DIFF_BYTES).toString("utf8")}\n... DIFF TRUNCATED ...\n`,
    truncated: true,
  }
}

const MODULE_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])
const MODULE_RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".d.ts"]
const PARSE_CHECKED_SOURCE_EXTENSIONS = MODULE_SOURCE_EXTENSIONS
const MAX_REPORTED_SYNTAX_DIAGNOSTICS = 3
type TypeScriptAPI = typeof import("typescript")
let cachedTypeScriptAPI: TypeScriptAPI | undefined

function typeScriptAPI(root: string, path: string) {
  if (cachedTypeScriptAPI) return cachedTypeScriptAPI
  const bases = [...new Set([
    resolve(root, ".opencode"),
    resolve(root),
    resolve(process.cwd(), ".opencode"),
    resolve(process.cwd()),
  ])]
  for (const base of bases) {
    try {
      const candidate = createRequire(resolve(base, "package.json"))("typescript") as Partial<TypeScriptAPI>
      if (
        typeof candidate.createProgram === "function"
        && typeof candidate.createSourceFile === "function"
        && typeof candidate.flattenDiagnosticMessageText === "function"
        && candidate.DiagnosticCategory
        && candidate.JsxEmit
        && candidate.ScriptKind
        && candidate.ScriptTarget
      ) {
        cachedTypeScriptAPI = candidate as TypeScriptAPI
        return cachedTypeScriptAPI
      }
    } catch {
      // Try the next project-local resolution base before failing this source preview closed.
    }
  }
  throw new Error(
    `WORKER CHANGE SYNTAX CHECK UNAVAILABLE for ${path}: the Harness-local TypeScript parser could not be loaded. Restore Harness dependencies before previewing JavaScript or TypeScript module changes. No preview was stored.`,
  )
}

function sourceScriptKind(api: TypeScriptAPI, path: string) {
  const extension = extname(path).toLowerCase()
  return extension === ".tsx"
    ? api.ScriptKind.TSX
    : extension === ".jsx"
      ? api.ScriptKind.JSX
      : extension === ".js" || extension === ".mjs" || extension === ".cjs"
        ? api.ScriptKind.JS
        : api.ScriptKind.TS
}

function sourceSyntaxDiagnostics(api: TypeScriptAPI, path: string, content: string) {
  const options: import("typescript").CompilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: api.JsxEmit.Preserve,
    noEmit: true,
    noLib: true,
    noResolve: true,
    target: api.ScriptTarget.Latest,
  }
  const sourceFile = api.createSourceFile(path, content, api.ScriptTarget.Latest, true, sourceScriptKind(api, path))
  const host: import("typescript").CompilerHost = {
    fileExists: (fileName) => fileName === path,
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "lib.d.ts",
    getNewLine: () => "\n",
    getSourceFile: (fileName) => fileName === path ? sourceFile : undefined,
    readFile: (fileName) => fileName === path ? content : undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {
      throw new Error("Worker source syntax validation must never emit files.")
    },
  }
  const program = api.createProgram([path], options, host)
  return program.getSyntacticDiagnostics(sourceFile)
    .filter((diagnostic) => diagnostic.category === api.DiagnosticCategory.Error)
    .map((diagnostic) => {
      const start = Math.max(0, Math.min(diagnostic.start ?? 0, content.length))
      const position = sourceFile.getLineAndCharacterOfPosition(start)
      const flattened = api.flattenDiagnosticMessageText(diagnostic.messageText, " ").replace(/\s+/g, " ").trim()
      const message = flattened.length <= 240 ? flattened : `${flattened.slice(0, 237)}...`
      return {
        path,
        start,
        code: diagnostic.code,
        message,
        formatted: `${path}:${position.line + 1}:${position.character + 1} TS${diagnostic.code}: ${message}`,
      }
    })
}

function sameSyntaxDiagnosticsIgnoringPositions(
  left: readonly ReturnType<typeof sourceSyntaxDiagnostics>[number][],
  right: readonly ReturnType<typeof sourceSyntaxDiagnostics>[number][],
) {
  const semanticKeys = (diagnostics: readonly ReturnType<typeof sourceSyntaxDiagnostics>[number][]) => (
    diagnostics.map((diagnostic) => `${diagnostic.path}\0${diagnostic.code}\0${diagnostic.message}`).sort()
  )
  const leftKeys = semanticKeys(left)
  const rightKeys = semanticKeys(right)
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
}

function assertValidSourceSyntax(root: string, files: readonly StoredChangeFile[]) {
  const sources = files.filter((file) => (
    file.after !== null && PARSE_CHECKED_SOURCE_EXTENSIONS.has(extname(file.path).toLowerCase())
  ))
  if (sources.length === 0) return
  const api = typeScriptAPI(root, sources[0].path)
  const unique = new Map<string, ReturnType<typeof sourceSyntaxDiagnostics>[number]>()
  const finalDiagnosticsByPath = new Map<string, ReturnType<typeof sourceSyntaxDiagnostics>>()
  for (const file of sources) {
    const fileDiagnostics = sourceSyntaxDiagnostics(api, file.path, file.after!)
    if (fileDiagnostics.length > 0) finalDiagnosticsByPath.set(file.path, fileDiagnostics)
    for (const diagnostic of fileDiagnostics) {
      if (!unique.has(diagnostic.formatted)) unique.set(diagnostic.formatted, diagnostic)
    }
  }
  const diagnostics = [...unique.values()].sort((left, right) => (
    left.path < right.path
      ? -1
      : left.path > right.path
        ? 1
        : left.start - right.start || left.code - right.code || (left.formatted < right.formatted ? -1 : 1)
  ))
  if (diagnostics.length === 0) return
  const unchangedInvalidBaselinePaths: string[] = []
  const partiallyRepairedInvalidBaselinePaths: string[] = []
  const introducedSyntaxErrorPaths: string[] = []
  for (const file of sources) {
    const finalDiagnostics = finalDiagnosticsByPath.get(file.path)
    if (!finalDiagnostics) continue
    const baselineDiagnostics = file.before === null ? [] : sourceSyntaxDiagnostics(api, file.path, file.before)
    if (baselineDiagnostics.length === 0) {
      introducedSyntaxErrorPaths.push(file.path)
    } else if (sameSyntaxDiagnosticsIgnoringPositions(baselineDiagnostics, finalDiagnostics)) {
      unchangedInvalidBaselinePaths.push(file.path)
    } else {
      partiallyRepairedInvalidBaselinePaths.push(file.path)
    }
  }
  unchangedInvalidBaselinePaths.sort()
  partiallyRepairedInvalidBaselinePaths.sort()
  introducedSyntaxErrorPaths.sort()
  const first = diagnostics.slice(0, MAX_REPORTED_SYNTAX_DIAGNOSTICS)
  const omitted = diagnostics.length - first.length
  throw new Error([
    "Worker source syntax validation failed before preview storage:",
    ...first.map((diagnostic) => `- ${diagnostic.formatted}`),
    ...(omitted > 0 ? [`- ${omitted} additional syntax diagnostic${omitted === 1 ? "" : "s"} omitted.`] : []),
    ...unchangedInvalidBaselinePaths.map((path) => (
      `- ALREADY INVALID BASELINE (UNCHANGED): ${path} already had syntax errors before this preview, and this operation set left the same syntax diagnostics unchanged even if their source positions moved. Submit an operation set whose aggregated final file is syntactically valid; partial previews cannot be stored.`
    )),
    ...partiallyRepairedInvalidBaselinePaths.map((path) => (
      `- ALREADY INVALID BASELINE (PARTIAL REPAIR): ${path} already had syntax errors before this preview. This operation set changed the diagnostics but its aggregated final content is still syntactically invalid. Submit an operation set whose aggregated final file is syntactically valid; partial previews cannot be stored.`
    )),
    ...introducedSyntaxErrorPaths.map((path) => (
      `- PREVIEW INTRODUCED SYNTAX ERRORS: ${path} was syntactically valid or did not exist before this preview. Correct the preview so its aggregated final content is fully syntactically valid; this preview cannot be stored.`
    )),
  ].join("\n"))
}

function assertValidJsonSyntax(current: ReadonlyMap<string, string | null>, paths: ReadonlySet<string>) {
  for (const path of [...paths].sort()) {
    const content = current.get(path)
    if (content === undefined || content === null) continue
    try {
      JSON.parse(content)
    } catch (error) {
      const detail = error instanceof Error ? error.message.replace(/\s+/g, " ").trim() : "invalid JSON"
      throw new Error(`Worker JSON syntax validation failed before preview storage: ${path}: ${detail}. No preview was stored.`)
    }
  }
}

function relativeModuleSpecifiers(api: TypeScriptAPI, path: string, content: string) {
  const source = api.createSourceFile(path, content, api.ScriptTarget.Latest, true, sourceScriptKind(api, path))
  const specifiers: string[] = []
  const add = (node: import("typescript").Expression | undefined) => {
    if (node && api.isStringLiteralLike(node) && /^\.\.?\//.test(node.text)) specifiers.push(node.text)
  }
  const visit = (node: import("typescript").Node) => {
    if (api.isImportDeclaration(node) || api.isExportDeclaration(node)) add(node.moduleSpecifier)
    else if (api.isImportEqualsDeclaration(node)
      && api.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression)
    else if (api.isCallExpression(node) && node.arguments.length === 1) {
      const dynamicImport = node.expression.kind === api.SyntaxKind.ImportKeyword
      const commonJsRequire = api.isIdentifier(node.expression) && node.expression.text === "require"
      if (dynamicImport || commonJsRequire) add(node.arguments[0])
    }
    api.forEachChild(node, visit)
  }
  visit(source)
  return [...new Set(specifiers)]
}

function moduleCandidates(path: string) {
  const extension = extname(path)
  const candidates = [path]
  if (!extension) {
    candidates.push(...MODULE_RESOLUTION_EXTENSIONS.map((suffix) => `${path}${suffix}`))
    candidates.push(...MODULE_RESOLUTION_EXTENSIONS.map((suffix) => `${path}/index${suffix}`))
    candidates.push(`${path}/package.json`)
  } else if (extension === ".js") {
    candidates.push(`${path.slice(0, -3)}.ts`, `${path.slice(0, -3)}.tsx`)
  } else if (extension === ".mjs") candidates.push(`${path.slice(0, -4)}.mts`)
  else if (extension === ".cjs") candidates.push(`${path.slice(0, -4)}.cts`)
  return [...new Set(candidates)]
}

function virtualRegularFile(policy: WorkerChangePolicy, current: Map<string, string | null>, path: string) {
  if (current.has(path)) return current.get(path) !== null
  const absolute = resolve(policy.root, path)
  if (!inside(resolve(policy.root), absolute) || !existsSync(absolute)) return false
  try {
    assertSafeFilesystemPath(policy.root, path, false)
    return statSync(absolute).isFile()
  } catch {
    return false
  }
}

function assertResolvedRelativeImports(policy: WorkerChangePolicy, current: Map<string, string | null>, file: StoredChangeFile) {
  if (!file.after || !MODULE_SOURCE_EXTENSIONS.has(extname(file.path))) return
  const api = typeScriptAPI(policy.root, file.path)
  for (const rawSpecifier of relativeModuleSpecifiers(api, file.path, file.after)) {
    const specifier = rawSpecifier.split(/[?#]/, 1)[0]
    const absoluteTarget = resolve(policy.root, dirname(file.path), specifier)
    if (!inside(resolve(policy.root), absoluteTarget)) {
      throw new Error(`Worker change introduces a relative import outside the project in ${file.path}: ${rawSpecifier}. Use an existing project module or package import.`)
    }
    const target = relative(resolve(policy.root), absoluteTarget).split("\\").join("/")
    if (moduleCandidates(target).some((candidate) => virtualRegularFile(policy, current, candidate))) continue
    throw new Error(`Worker change introduces an unresolved relative import in ${file.path}: ${rawSpecifier}. Read the existing in-scope files and project APIs, then preview a path that resolves within the project.`)
  }
}

function newChangeID(root: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `C-${randomBytes(3).toString("hex")}`
    if (!existsSync(changePath(root, id)) && !existsSync(resolve(receiptDirectory(root), `${id}.json`))) return id
  }
  throw new Error("Could not allocate a unique Worker change ID.")
}

function repairedJsonMemberDelimiter(path: string, value: string, oldText: string, newText: string) {
  if (extname(path).toLowerCase() !== ".json" || !/,\s*$/.test(oldText) || /,\s*$/.test(newText)) return null
  try {
    JSON.parse(value)
  } catch {
    return null
  }
  const withoutDelimiter = value.split(oldText).join(newText)
  try {
    JSON.parse(withoutDelimiter)
    return null
  } catch {
    // Preserve only the one existing member delimiter when that alone restores valid JSON.
  }
  const trailingWhitespace = /\s*$/.exec(newText)?.[0] ?? ""
  const repairedNewText = `${newText.slice(0, newText.length - trailingWhitespace.length)},${trailingWhitespace}`
  try {
    JSON.parse(value.split(oldText).join(repairedNewText))
    return repairedNewText
  } catch {
    return null
  }
}

function technicalPurpose(purpose: string, operations: readonly WorkerChangeOperation[]) {
  const provided = typeof purpose === "string" ? purpose.trim() : ""
  if (provided) return provided
  const paths = [...new Set(operations.map((operation) => operation.path))]
  if (operations.length === 1) return `Worker ${operations[0].kind} operation for ${operations[0].path}`
  return `Worker change set: ${operations.length} operations across ${paths.length} path${paths.length === 1 ? "" : "s"}`
}

export function previewWorkerChanges(
  policy: WorkerChangePolicy,
  purpose: string,
  operations: WorkerChangeOperation[],
  validateFiles?: (files: readonly WorkerChangePreviewFile[]) => void,
) {
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > MAX_OPERATIONS) {
    throw new Error(`Worker change preview requires 1-${MAX_OPERATIONS} operations.`)
  }
  const storedPurpose = technicalPurpose(purpose, operations)

  const initial = new Map<string, { content: string | null; mode: number | null }>()
  const current = new Map<string, string | null>()
  const inputRepairs: string[] = []
  const jsonValidationPaths = new Set<string>()
  const target = (rawPath: string, allowMissing = false) => {
    const path = validateTarget(policy, rawPath, allowMissing)
    if (!initial.has(path)) {
      const absolute = resolve(policy.root, path)
      const present = existsSync(absolute)
      initial.set(path, {
        content: present ? readText(absolute) : null,
        mode: present ? statSync(absolute).mode & 0o777 : null,
      })
      current.set(path, initial.get(path)!.content)
    }
    return path
  }
  const operationContent = (kind: "create" | "rewrite", path: string, content: string) => {
    const repaired = repairSerializedMultilineContent(content)
    if (repaired !== content) {
      inputRepairs.push(`${path}: expanded structural literal backslash-n separators in ${kind} content`)
    }
    return checkedContent(repaired, path)
  }

  for (const operation of operations) {
    if (operation.kind === "create") {
      const path = target(operation.path, true)
      if (!allowed(path, policy.newScope)) throw new Error(`Worker create target is not declared NEW in task Scope: ${path}`)
      if (initial.get(path)!.content !== null) throw new Error(`Worker create target already exists: ${path}`)
      if (extname(path).toLowerCase() === ".json") jsonValidationPaths.add(path)
      current.set(path, operationContent(operation.kind, path, operation.content))
      continue
    }

    const path = target(operation.path)
    const value = current.get(path)
    if (value === undefined) throw new Error(`Worker change could not load its target state: ${path}`)
    if (operation.kind === "delete") {
      if (value === null) throw new Error(`Worker delete target does not exist: ${path}`)
      current.set(path, null)
      continue
    }
    if (value === null) throw new Error(`Worker ${operation.kind} target does not exist: ${path}`)
    if (operation.kind === "rewrite") {
      if (extname(path).toLowerCase() === ".json") jsonValidationPaths.add(path)
      current.set(path, operationContent(operation.kind, path, operation.content))
      continue
    }
    if (!operation.oldText) throw new Error(`Worker replace old_text must not be empty: ${path}`)
    let oldText = operation.oldText
    let newText = operation.newText
    if (oldText === newText) {
      throw new Error(`Worker replace would not change bytes because old_text and new_text are identical: ${path}`)
    }
    if (!Number.isInteger(operation.expectedOccurrences) || operation.expectedOccurrences < 1) {
      throw new Error(`Worker replace expected_occurrences must be a positive integer: ${path}`)
    }
    let count = occurrences(value, oldText)
    if (count !== operation.expectedOccurrences && oldText.includes("\\n")) {
      const expandedOldText = oldText.replaceAll("\\n", "\n")
      const expandedCount = occurrences(value, expandedOldText)
      if (expandedCount === operation.expectedOccurrences) {
        oldText = expandedOldText
        newText = newText.replaceAll("\\n", "\n")
        count = expandedCount
        inputRepairs.push(`${path}: expanded literal backslash-n separators after exact baseline match`)
      }
    }
    if (count === 0) {
      const repair = minimalSharedBoundaryRepair(value, oldText, newText, operation.expectedOccurrences)
      if (repair) {
        oldText = repair.oldText
        newText = repair.newText
        count = operation.expectedOccurrences
        inputRepairs.push(`${path}: trimmed ${repair.length} shared ${repair.boundary} character${repair.length === 1 ? "" : "s"} after exact baseline match`)
      }
    }
    if (count === 0) {
      const repair = minimalSharedLineIndentRepair(value, oldText, newText, operation.expectedOccurrences)
      if (repair) {
        oldText = repair.oldText
        newText = repair.newText
        count = operation.expectedOccurrences
        inputRepairs.push(`${path}: trimmed ${repair.length} shared leading indentation character${repair.length === 1 ? "" : "s"} from every non-blank replace line after exact baseline match`)
      }
    }
    if (count !== operation.expectedOccurrences) {
      const anchor = count === 0 ? uniqueCurrentLineAnchor(value, oldText) : null
      const recovery = anchor === null
        ? ""
        : `; unique current anchor: ${JSON.stringify(anchor)}; retry replace with exact current bytes or rewrite with complete content`
      throw new Error(`Worker replace expected ${operation.expectedOccurrences} occurrences but found ${count}: ${path}${recovery}`)
    }
    if (oldText === newText) {
      throw new Error(`Worker replace would not change bytes after input normalization: ${path}`)
    }
    const delimiterRepair = count === 1 && operation.expectedOccurrences === 1
      ? repairedJsonMemberDelimiter(path, value, oldText, newText)
      : null
    if (delimiterRepair !== null) {
      newText = delimiterRepair
      inputRepairs.push(`${path}: preserved one existing JSON member delimiter after exact parse validation`)
    }
    current.set(path, checkedContent(value.split(oldText).join(newText), path))
  }

  const files = [...initial.entries()].map(([path, before]) => {
    const after = current.get(path) ?? null
    return {
      path,
      before: before.content,
      after,
      beforeHash: before.content === null ? null : digest(before.content),
      afterHash: after === null ? null : digest(after),
      beforeMode: before.mode,
      afterMode: after === null ? null : before.mode ?? 0o644,
      // Keep the original field for already-deployed readers of StoredChangeSet v1.
      mode: before.mode,
    } satisfies StoredChangeFile
  }).filter((file) => file.before !== file.after)
  if (files.length === 0) throw new Error("Worker change preview produced no changes.")
  assertValidJsonSyntax(current, jsonValidationPaths)
  assertValidSourceSyntax(policy.root, files)
  for (const file of files) {
    assertResolvedRelativeImports(policy, current, file)
  }
  validateFiles?.(files.map(({ path, before, after }) => ({ path, before, after })))
  const totalBytes = files.reduce((total, file) => total + Buffer.byteLength(file.before ?? "") + Buffer.byteLength(file.after ?? ""), 0)
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Worker change set exceeds ${MAX_TOTAL_BYTES} bytes.`)

  const preview = boundedDiff(files)
  const value: StoredChangeSet = {
    version: 1,
    id: newChangeID(policy.root),
    previewToken: `P-${randomBytes(4).toString("hex")}`,
    status: "previewed",
    sessionID: policy.sessionID,
    taskPath: policy.taskPath,
    taskHash: policy.taskHash,
    purpose: storedPurpose,
    files,
    previewComplete: !preview.truncated,
    createdAt: new Date().toISOString(),
  }
  writeChangeSet(policy.root, value)
  return {
    id: value.id,
    previewToken: value.previewToken,
    taskPath: value.taskPath,
    paths: files.map((file) => file.path),
    diff: preview.diff,
    diffTruncated: preview.truncated,
    inputRepairs,
  }
}

function assertOwnedChangeSet(policy: WorkerChangePolicy, value: StoredChangeSet, previewToken?: string) {
  if (value.sessionID !== policy.sessionID) throw new Error(`Worker change ${value.id} belongs to another Worker session.`)
  if (value.taskPath !== policy.taskPath || value.taskHash !== policy.taskHash) {
    throw new Error(`Worker change ${value.id} belongs to a different task revision.`)
  }
  if (previewToken !== undefined && value.previewToken !== previewToken) {
    throw new Error(`Worker change ${value.id} requires the exact preview token returned by preview_worker_changes.`)
  }
}

function ensureParentDirectories(root: string, path: string, created: string[]) {
  const rootAbsolute = resolve(root)
  const segments = dirname(path).split("/").filter((part) => part && part !== ".")
  let current = rootAbsolute
  for (const segment of segments) {
    current = resolve(current, segment)
    if (existsSync(current)) continue
    mkdirSync(current, { mode: 0o755 })
    created.push(current)
  }
}

export function applyWorkerChanges(
  policy: WorkerChangePolicy,
  id: string,
  previewToken: string,
  testOptions: { failAfterCommits?: number } = {},
): WorkerChangeReceipt {
  const value = readChangeSet(policy.root, id)
  assertOwnedChangeSet(policy, value, previewToken)
  if (!value.previewComplete) {
    throw new Error(`Worker change ${id} has a truncated preview. Discard it and split the operations before applying.`)
  }

  for (const file of value.files) {
    const path = validateTarget(policy, file.path, file.before === null)
    if (file.before === null && !allowed(path, policy.newScope)) {
      throw new Error(`Worker create target is no longer declared NEW in task Scope: ${path}`)
    }
    const absolute = resolve(policy.root, path)
    if (file.before === null) {
      if (existsSync(absolute)) throw new Error(`Worker change baseline drift: ${path} now exists.`)
    } else {
      if (!existsSync(absolute)) throw new Error(`Worker change baseline drift: ${path} was removed.`)
      if (digest(readText(absolute)) !== file.beforeHash) throw new Error(`Worker change baseline drift: ${path} changed after preview.`)
      if ((statSync(absolute).mode & 0o777) !== storedBeforeMode(file)) {
        throw new Error(`Worker change baseline drift: ${path} mode changed after preview.`)
      }
    }
  }

  // Persist every recoverable baseline before creating directories, temporary files, or backups
  // alongside project files. Receipts intentionally remain hash-only.
  for (const file of value.files) {
    if (file.before === null) continue
    const baseline = persistWorkerChangeBaseline(policy.root, file.before)
    if (baseline.hash !== file.beforeHash) throw new Error(`Worker change ${id} has an invalid stored baseline: ${file.path}`)
  }

  const createdDirectories: string[] = []
  const prepared: Array<{
    file: StoredChangeFile
    target: string
    temporary: string | null
    backup: string | null
    backupMoved: boolean
    targetWritten: boolean
  }> = []

  try {
    for (const file of value.files) {
      const target = resolve(policy.root, file.path)
      let temporary: string | null = null
      if (file.after !== null) {
        ensureParentDirectories(policy.root, file.path, createdDirectories)
        temporary = resolve(dirname(target), `.${basename(target)}.${value.id}.${randomBytes(3).toString("hex")}.tmp`)
        const afterMode = storedAfterMode(file)!
        writeFileSync(temporary, file.after, { mode: afterMode, flag: "wx" })
        chmodSync(temporary, afterMode)
      }
      const backup = file.before === null
        ? null
        : resolve(dirname(target), `.${basename(target)}.${value.id}.${randomBytes(3).toString("hex")}.bak`)
      prepared.push({ file, target, temporary, backup, backupMoved: false, targetWritten: false })
    }

    let committed = 0
    for (const item of prepared) {
      if (item.backup) {
        renameSync(item.target, item.backup)
        item.backupMoved = true
      }
      if (item.temporary) {
        renameSync(item.temporary, item.target)
        item.targetWritten = true
      }
      committed += 1
      if (testOptions.failAfterCommits === committed) throw new Error("Injected Worker change apply failure.")
    }

    for (const item of prepared) {
      if (item.backup) rmSync(item.backup, { force: true })
    }
  } catch (error) {
    for (const item of [...prepared].reverse()) {
      if (item.targetWritten && existsSync(item.target)) rmSync(item.target, { force: true })
      if (item.backupMoved && item.backup && existsSync(item.backup)) renameSync(item.backup, item.target)
      if (item.temporary && existsSync(item.temporary)) rmSync(item.temporary, { force: true })
      if (item.backup && existsSync(item.backup)) rmSync(item.backup, { force: true })
    }
    for (const directory of [...createdDirectories].reverse()) {
      try {
        rmdirSync(directory)
      } catch {
        // Preserve a non-empty directory restored or populated by another operation.
      }
    }
    throw error
  }

  const receipt = writeReceipt(policy.root, value, "applied")
  rmSync(changePath(policy.root, value.id), { force: true })
  return receipt
}

export function discardWorkerChanges(policy: WorkerChangePolicy, id: string) {
  const value = readChangeSet(policy.root, id)
  assertOwnedChangeSet(policy, value)
  writeReceipt(policy.root, value, "discarded", "Worker explicitly discarded the preview.")
  rmSync(changePath(policy.root, value.id), { force: true })
  return value.files.map((file) => file.path)
}

function storedChangeSets(root: string) {
  const directory = changeDirectory(root)
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((name) => /^C-[a-f0-9]{6}\.json$/.test(name)).flatMap((name) => {
    try {
      return [JSON.parse(readFileSync(resolve(directory, name), "utf8")) as StoredChangeSet]
    } catch {
      return []
    }
  })
}

export function selectLatestPendingWorkerChange(
  policy: Pick<WorkerChangePolicy, "root" | "sessionID" | "taskPath" | "taskHash">,
): PendingWorkerChangeSelection | null {
  const candidates = storedChangeSets(policy.root).flatMap((stored) => {
    if (!CHANGE_ID.test(String(stored?.id ?? ""))) return []
    let value: StoredChangeSet
    try {
      value = readChangeSet(policy.root, stored.id)
    } catch {
      return []
    }
    if (value.sessionID !== policy.sessionID
      || value.taskPath !== policy.taskPath
      || value.taskHash !== policy.taskHash
      || !/^P-[a-f0-9]{8}$/.test(value.previewToken)
      || typeof value.createdAt !== "string"
      || !Number.isFinite(Date.parse(value.createdAt))
      || value.files.some((file) => typeof file?.path !== "string")) return []
    return [value]
  }).sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
  ))
  const selected = candidates[0]
  return selected ? {
    id: selected.id,
    previewToken: selected.previewToken,
    taskPath: selected.taskPath,
    taskHash: selected.taskHash,
    paths: selected.files.map((file) => file.path),
    createdAt: selected.createdAt,
  } : null
}

export function cleanupWorkerChangesForSession(root: string, sessionID: string) {
  const removed: string[] = []
  for (const value of storedChangeSets(root)) {
    if (value.sessionID !== sessionID) continue
    writeReceipt(root, value, "cleaned", "Worker session ended or was deleted.")
    rmSync(changePath(root, value.id), { force: true })
    removed.push(value.id)
  }
  return removed
}

export function cleanupWorkerChangesForTask(root: string, taskPath: string) {
  const removed: string[] = []
  for (const value of storedChangeSets(root)) {
    if (value.taskPath !== taskPath) continue
    writeReceipt(root, value, "cleaned", "Task completed.")
    rmSync(changePath(root, value.id), { force: true })
    removed.push(value.id)
  }
  return removed
}

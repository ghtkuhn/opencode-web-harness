#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { basename, dirname, isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const MANIFEST_PATH = "harness-manifest.json"
const DEFAULT_REPOSITORY = "ghtkuhn/opencode-web-harness"
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 12 * 1024 * 1024
const exactManagedPaths = new Set(["AGENTS.md", "kanban/TASK.md", MANIFEST_PATH])
const managedPrefixes = ["scripts/", ".opencode/"]

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`)
  }
}

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing at ${path}.`)
  return parseJson(readFileSync(path, "utf8"), label)
}

function jsonIndent(content) {
  return content.match(/\n([ \t]+)"/)?.[1] ?? "  "
}

function formatJson(value, original = "") {
  return Buffer.from(`${JSON.stringify(value, null, jsonIndent(original))}\n`)
}

function assertRepository(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`Invalid harness repository: ${String(value)}.`)
  }
  return value
}

function assertManagedPath(path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\")) {
    throw new Error(`Invalid managed harness path: ${String(path)}.`)
  }
  const segments = path.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Managed harness path contains an unsafe segment: ${path}.`)
  }
  if (path === ".git" || path.startsWith(".git/") || path.includes("/node_modules/")) {
    throw new Error(`Managed harness path is forbidden: ${path}.`)
  }
  if (!exactManagedPaths.has(path) && !managedPrefixes.some((prefix) => path.startsWith(prefix))) {
    throw new Error(`Managed harness path is outside the allowed harness surface: ${path}.`)
  }
  return path
}

function validateManifest(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) {
    throw new Error(`${label} must use harness manifest schemaVersion 1.`)
  }
  const repository = assertRepository(value.repository ?? DEFAULT_REPOSITORY)
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error(`${label} must declare at least one managed file.`)
  }
  const files = [...new Set(value.files.map(assertManagedPath))]
  const packageScripts = value.packageScripts ?? {}
  if (!packageScripts || typeof packageScripts !== "object" || Array.isArray(packageScripts)
    || Object.entries(packageScripts).some(([name, command]) => !name || typeof command !== "string" || !command.trim())) {
    throw new Error(`${label} contains invalid packageScripts.`)
  }
  const projectConfig = value.projectConfig ?? {}
  if (!projectConfig || typeof projectConfig !== "object" || Array.isArray(projectConfig)) {
    throw new Error(`${label} contains invalid projectConfig.`)
  }
  const protectedAgentPaths = projectConfig.protectedAgentPaths ?? []
  if (!Array.isArray(protectedAgentPaths)
    || protectedAgentPaths.some((path) => typeof path !== "string" || !path.trim() || isAbsolute(path) || path.includes(".."))) {
    throw new Error(`${label} contains invalid protectedAgentPaths.`)
  }
  const workflowGuard = projectConfig.workflowGuard ?? {}
  if (!workflowGuard || typeof workflowGuard !== "object" || Array.isArray(workflowGuard)
    || Object.entries(workflowGuard).some(([name, enabled]) => !/^[A-Za-z][A-Za-z0-9]*$/.test(name) || typeof enabled !== "boolean")) {
    throw new Error(`${label} contains invalid workflowGuard defaults.`)
  }
  return {
    schemaVersion: 1,
    repository,
    files,
    packageScripts: Object.fromEntries(Object.entries(packageScripts).map(([name, command]) => [name, command.trim()])),
    projectConfig: {
      protectedAgentPaths: [...new Set(protectedAgentPaths)],
      workflowGuard: { ...workflowGuard },
    },
  }
}

function assertNoSymlink(root, relativePath) {
  let current = root
  for (const segment of relativePath.split("/")) {
    current = resolve(current, segment)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Harness update refuses to traverse symlink ${relativePath}.`)
    }
  }
}

function encodedPath(path) {
  return path.split("/").map(encodeURIComponent).join("/")
}

function requestHeaders(accept) {
  const headers = {
    Accept: accept,
    "User-Agent": "opencode-web-harness-updater",
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return headers
}

async function fetchBuffer(fetchImpl, url, { accept, maxBytes, allowNotFound = false }) {
  let response
  try {
    response = await fetchImpl(url, {
      headers: requestHeaders(accept),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new Error(`Could not download ${url}: ${error.message}`)
  }
  if (allowNotFound && response.status === 404) return null
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500).trim()
    throw new Error(`Download failed (${response.status} ${response.statusText}) for ${url}${detail ? `: ${detail}` : ""}`)
  }
  const declaredSize = Number(response.headers.get("content-length") ?? 0)
  if (declaredSize > maxBytes) throw new Error(`Download exceeds the ${maxBytes}-byte limit: ${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > maxBytes) throw new Error(`Download exceeds the ${maxBytes}-byte limit: ${url}`)
  return buffer
}

function mergePackageScripts(root, localManifest, remoteManifest, writes) {
  const relativePath = "package.json"
  const path = resolve(root, relativePath)
  assertNoSymlink(root, relativePath)
  const original = existsSync(path) ? readFileSync(path, "utf8") : "{}\n"
  const value = parseJson(original, relativePath)
  const scripts = { ...(value.scripts ?? {}) }
  for (const [name, command] of Object.entries(localManifest.packageScripts)) {
    if (!(name in remoteManifest.packageScripts) && scripts[name] === command) delete scripts[name]
  }
  value.scripts = { ...scripts, ...remoteManifest.packageScripts }
  writes.set(relativePath, formatJson(value, original))
}

function mergeProjectConfig(root, manifest, repository, writes) {
  const relativePath = "project.json"
  const path = resolve(root, relativePath)
  assertNoSymlink(root, relativePath)
  const original = existsSync(path) ? readFileSync(path, "utf8") : "{}\n"
  const value = parseJson(original, relativePath)
  value.settings ??= {}
  value.settings.harnessUpdate = {
    ...(value.settings.harnessUpdate ?? {}),
    repository: value.settings.harnessUpdate?.repository ?? repository,
  }
  value.settings.opencode ??= {}
  const existing = Array.isArray(value.settings.opencode.protectedAgentPaths)
    ? value.settings.opencode.protectedAgentPaths
    : []
  value.settings.opencode.protectedAgentPaths = [
    ...new Set([...existing, ...manifest.projectConfig.protectedAgentPaths]),
  ]
  const existingWorkflowGuard = value.settings.opencode.workflowGuard ?? {}
  if (!existingWorkflowGuard || typeof existingWorkflowGuard !== "object" || Array.isArray(existingWorkflowGuard)) {
    throw new Error("project.json settings.opencode.workflowGuard must be an object.")
  }
  value.settings.opencode.workflowGuard = {
    ...manifest.projectConfig.workflowGuard,
    ...existingWorkflowGuard,
  }
  writes.set(relativePath, formatJson(value, original))
}

function dependencyInstallRequest(root) {
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["ci", "--ignore-scripts"],
    cwd: resolve(root, ".opencode"),
  }
}

function outputText(value) {
  return typeof value === "string" || Buffer.isBuffer(value) ? String(value).trim() : ""
}

function defaultDependencyInstaller({ command, args, cwd }) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: "pipe",
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = [outputText(result.stderr), outputText(result.stdout)].filter(Boolean).join("\n")
    const outcome = result.signal ? `terminated by ${result.signal}` : `exited with status ${String(result.status)}`
    throw new Error(`npm ci --ignore-scripts ${outcome}${detail ? `: ${detail}` : ""}`)
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function restoreSnapshots(root, snapshots) {
  const errors = []
  for (const [relativePath, snapshot] of [...snapshots.entries()].reverse()) {
    try {
      if (snapshot.content === null) rmSync(resolve(root, relativePath), { force: true })
      else atomicWrite(root, relativePath, snapshot.content, snapshot.mode)
    } catch (error) {
      errors.push(`${relativePath}: ${errorMessage(error)}`)
    }
  }
  return errors
}

function atomicWrite(root, relativePath, content, mode) {
  assertNoSymlink(root, relativePath)
  const target = resolve(root, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  const temporary = resolve(dirname(target), `.${basename(target)}.harness-update-${process.pid}-${Date.now()}`)
  try {
    writeFileSync(temporary, content)
    renameSync(temporary, target)
    if (mode !== null) chmodSync(target, mode)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function currentMode(path) {
  return existsSync(path) ? lstatSync(path).mode : null
}

function relativeRuntimePath(root, absolutePath) {
  return absolutePath.slice(root.length + 1).split("\\").join("/")
}

export async function runHarnessUpdate(options = {}) {
  if (typeof (options.fetchImpl ?? globalThis.fetch) !== "function") {
    throw new Error("This command requires a Node.js version with built-in fetch support.")
  }
  const root = resolve(options.root ?? process.cwd())
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const log = options.log ?? console.log
  const installDependencies = options.installDependencies ?? defaultDependencyInstaller
  const check = options.check === true
  const localManifestPath = resolve(root, MANIFEST_PATH)
  const localManifestText = readFileSync(localManifestPath, "utf8")
  const localManifest = validateManifest(parseJson(localManifestText, "Local harness manifest"), "Local harness manifest")
  const project = readJson(resolve(root, "project.json"), "project.json")
  const repository = assertRepository(
    options.repository
      ?? project.settings?.harnessUpdate?.repository
      ?? localManifest.repository
      ?? DEFAULT_REPOSITORY,
  )
  const releaseApiUrl = options.releaseApiUrl ?? `https://api.github.com/repos/${repository}/releases/latest`
  const rawBaseUrl = (options.rawBaseUrl ?? `https://raw.githubusercontent.com/${repository}`).replace(/\/$/, "")

  const releaseBuffer = await fetchBuffer(fetchImpl, releaseApiUrl, {
    accept: "application/vnd.github+json",
    maxBytes: MAX_MANIFEST_BYTES,
  })
  const release = parseJson(releaseBuffer.toString("utf8"), "Latest GitHub release response")
  if (typeof release.tag_name !== "string" || !release.tag_name.trim()) {
    throw new Error("Latest GitHub release response does not contain tag_name.")
  }
  const tag = release.tag_name.trim()
  const releaseRoot = `${rawBaseUrl}/${encodeURIComponent(tag)}`
  const remoteManifestBuffer = await fetchBuffer(fetchImpl, `${releaseRoot}/${MANIFEST_PATH}`, {
    accept: "text/plain",
    maxBytes: MAX_MANIFEST_BYTES,
    allowNotFound: true,
  })
  const compatibilityMode = remoteManifestBuffer === null
  const remoteManifest = compatibilityMode
    ? localManifest
    : validateManifest(parseJson(remoteManifestBuffer.toString("utf8"), `Harness manifest from ${tag}`), `Harness manifest from ${tag}`)
  if (remoteManifest.repository !== repository) {
    throw new Error(`Release manifest repository ${remoteManifest.repository} does not match configured repository ${repository}.`)
  }

  const writes = new Map()
  let totalBytes = 0
  for (const relativePath of remoteManifest.files) {
    if (relativePath === MANIFEST_PATH) {
      if (remoteManifestBuffer) writes.set(relativePath, remoteManifestBuffer)
      continue
    }
    const content = await fetchBuffer(fetchImpl, `${releaseRoot}/${encodedPath(relativePath)}`, {
      accept: "application/octet-stream",
      maxBytes: MAX_FILE_BYTES,
      allowNotFound: compatibilityMode,
    })
    if (content === null) {
      log(`HARNESS UPDATE: compatibility skip ${relativePath} (not present in ${tag})`)
      continue
    }
    totalBytes += content.length
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Harness release exceeds the ${MAX_TOTAL_BYTES}-byte total limit.`)
    writes.set(relativePath, content)
  }

  mergePackageScripts(root, localManifest, remoteManifest, writes)
  mergeProjectConfig(root, remoteManifest, repository, writes)

  const removals = compatibilityMode
    ? []
    : localManifest.files.filter((path) => !remoteManifest.files.includes(path) && existsSync(resolve(root, path)))
  const changedWrites = [...writes.entries()].filter(([relativePath, content]) => {
    assertNoSymlink(root, relativePath)
    const target = resolve(root, relativePath)
    return !existsSync(target) || !readFileSync(target).equals(content)
  })
  const changedPaths = [...changedWrites.map(([path]) => path), ...removals]
  const dependenciesChanged = changedPaths.some((path) =>
    path === ".opencode/package.json" || path === ".opencode/package-lock.json")

  if (check) {
    log(`HARNESS UPDATE CHECK: ${tag}; ${changedWrites.length} file(s) would update, ${removals.length} would be removed.`)
    return { tag, check: true, compatibilityMode, updated: changedWrites.map(([path]) => path), removed: removals }
  }

  if (changedPaths.length === 0) {
    log(`HARNESS UPDATE: already current at ${tag}.`)
    return { tag, check: false, compatibilityMode, updated: [], removed: [], backupPath: null }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupRoot = resolve(root, ".runtime/harness-update-backups", `${stamp}-${tag.replace(/[^A-Za-z0-9_.-]/g, "_")}`)
  assertNoSymlink(root, ".runtime")
  mkdirSync(backupRoot, { recursive: true })
  const snapshots = new Map()
  for (const relativePath of changedPaths) {
    assertNoSymlink(root, relativePath)
    const target = resolve(root, relativePath)
    const snapshot = existsSync(target)
      ? { content: readFileSync(target), mode: currentMode(target) }
      : { content: null, mode: null }
    snapshots.set(relativePath, snapshot)
    if (snapshot.content) {
      const backup = resolve(backupRoot, "files", relativePath)
      mkdirSync(dirname(backup), { recursive: true })
      writeFileSync(backup, snapshot.content)
    }
  }
  writeFileSync(resolve(backupRoot, "backup.json"), `${JSON.stringify({
    schemaVersion: 1,
    tag,
    createdAt: new Date().toISOString(),
    files: [...snapshots.entries()].map(([path, snapshot]) => ({ path, existed: snapshot.content !== null })),
  }, null, 2)}\n`)

  const dependencyRequest = dependencyInstallRequest(root)
  const hadPreviousDependencyLock = existsSync(resolve(root, ".opencode/package.json"))
    && existsSync(resolve(root, ".opencode/package-lock.json"))
  const stateRelativePath = ".runtime/harness-update.json"
  const statePath = resolve(root, stateRelativePath)
  assertNoSymlink(root, stateRelativePath)
  const stateSnapshot = existsSync(statePath)
    ? { content: readFileSync(statePath), mode: currentMode(statePath) }
    : { content: null, mode: null }
  let dependencyInstallStarted = false

  try {
    for (const relativePath of removals) rmSync(resolve(root, relativePath), { force: true })
    for (const [relativePath, content] of changedWrites) {
      atomicWrite(root, relativePath, content, snapshots.get(relativePath)?.mode ?? null)
    }
    if (dependenciesChanged) {
      dependencyInstallStarted = true
      await installDependencies(dependencyRequest)
    }

    atomicWrite(root, stateRelativePath, Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      repository,
      tag,
      releaseUrl: typeof release.html_url === "string" ? release.html_url : null,
      compatibilityMode,
      updatedAt: new Date().toISOString(),
      updated: changedWrites.map(([path]) => path),
      removed: removals,
      backupPath: relativeRuntimePath(root, backupRoot),
    }, null, 2)}\n`), stateSnapshot.mode)
  } catch (error) {
    const rollbackErrors = restoreSnapshots(root, snapshots)
    try {
      if (stateSnapshot.content === null) rmSync(statePath, { force: true })
      else atomicWrite(root, stateRelativePath, stateSnapshot.content, stateSnapshot.mode)
    } catch (rollbackError) {
      rollbackErrors.push(`${stateRelativePath}: ${errorMessage(rollbackError)}`)
    }
    if (dependencyInstallStarted && hadPreviousDependencyLock) {
      try {
        await installDependencies(dependencyRequest)
      } catch (rollbackError) {
        rollbackErrors.push(`dependencies: ${errorMessage(rollbackError)}`)
      }
    }
    throw new Error(`Harness update failed and was rolled back: ${errorMessage(error)}${rollbackErrors.length ? `; rollback errors: ${rollbackErrors.join("; ")}` : ""}`)
  }
  log(`HARNESS UPDATE: applied ${tag}; updated ${changedWrites.length}, removed ${removals.length}.`)
  log(`HARNESS UPDATE: backup ${relativeRuntimePath(root, backupRoot)}.`)
  log("HARNESS UPDATE: restart OpenCode before continuing work.")
  return {
    tag,
    check: false,
    compatibilityMode,
    updated: changedWrites.map(([path]) => path),
    removed: removals,
    backupPath: relativeRuntimePath(root, backupRoot),
  }
}

function usage() {
  return [
    "Usage: node scripts/update-harness.mjs [--check]",
    "",
    "Downloads the latest GitHub release declared by harness-manifest.json.",
    "No Git installation or Git repository is required.",
  ].join("\n")
}

const mainPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ""
if (mainPath === import.meta.url) {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage())
  } else if (args.some((arg) => arg !== "--check")) {
    console.error(usage())
    process.exitCode = 2
  } else {
    runHarnessUpdate({ check: args.includes("--check") }).catch((error) => {
      console.error(`HARNESS UPDATE: FAIL\n${error.message}`)
      process.exitCode = 1
    })
  }
}

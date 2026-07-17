import assert from "node:assert/strict"
import { createServer } from "node:http"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { runHarnessUpdate } from "./update-harness.mjs"

const templateRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function reusableHarnessFiles(root) {
  const files = []
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(child.slice(root.length + 1).split("\\").join("/"))
    }
  }
  for (const relativePath of [".opencode/agents", ".opencode/lib", ".opencode/plugins", ".opencode/tests"]) {
    visit(join(root, relativePath))
  }
  return files.sort()
}

async function fixtureServer(files) {
  const server = createServer((request, response) => {
    if (request.url === "/release") {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ tag_name: "v2.0.0", html_url: "https://example.test/releases/v2.0.0" }))
      return
    }
    const content = files.get(request.url)
    if (content === undefined) {
      response.statusCode = 404
      response.end("not found")
      return
    }
    response.end(content)
  })
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
  }
}

test("template manifest contains only existing Harness-owned files", () => {
  const manifest = json(join(templateRoot, "harness-manifest.json"))
  const project = json(join(templateRoot, "project.json"))
  assert.equal(manifest.repository, "ghtkuhn/opencode-web-harness")
  assert.equal(project.settings.harnessUpdate.repository, manifest.repository)
  for (const path of manifest.files) assert.equal(existsSync(join(templateRoot, path)), true, path)
  assert.deepEqual(
    reusableHarnessFiles(templateRoot).filter((path) => !manifest.files.includes(path)),
    [],
    "all reusable OpenCode files must be listed in harness-manifest.json",
  )
  for (const projectOwnedPath of [
    "project.json",
    "package.json",
    "README.md",
    "MEMORY.md",
    "CUSTOM.md",
    "WORKER.md",
  ]) {
    assert.equal(manifest.files.includes(projectOwnedPath), false, projectOwnedPath)
  }
})

test("default repository requests the new release source with the new User-Agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-update-default-repository-"))
  const repository = "ghtkuhn/opencode-web-harness"
  const remoteManifest = {
    schemaVersion: 1,
    repository,
    files: ["harness-manifest.json"],
  }
  const calls = []
  try {
    write(join(root, "harness-manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      files: ["harness-manifest.json"],
    }, null, 2)}\n`)
    write(join(root, "project.json"), "{}\n")

    await runHarnessUpdate({
      root,
      check: true,
      log() {},
      async fetchImpl(url, options) {
        calls.push({ url: String(url), headers: { ...options.headers } })
        if (String(url) === `https://api.github.com/repos/${repository}/releases/latest`) {
          return new Response(JSON.stringify({
            tag_name: "v2.0.0",
            html_url: `https://github.com/${repository}/releases/tag/v2.0.0`,
          }))
        }
        if (String(url) === `https://raw.githubusercontent.com/${repository}/v2.0.0/harness-manifest.json`) {
          return new Response(`${JSON.stringify(remoteManifest, null, 2)}\n`)
        }
        throw new Error(`Unexpected URL: ${String(url)}`)
      },
    })

    assert.deepEqual(calls.map((call) => call.url), [
      `https://api.github.com/repos/${repository}/releases/latest`,
      `https://raw.githubusercontent.com/${repository}/v2.0.0/harness-manifest.json`,
    ])
    for (const call of calls) {
      assert.equal(call.headers["User-Agent"], "opencode-web-harness-updater")
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("rejects non-boolean workflowGuard defaults in the manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-update-invalid-manifest-"))
  try {
    write(join(root, "harness-manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      repository: "owner/repository",
      files: ["harness-manifest.json"],
      projectConfig: { workflowGuard: { modeGuard: "yes" } },
    }, null, 2)}\n`)
    write(join(root, "project.json"), "{}\n")
    await assert.rejects(
      () => runHarnessUpdate({ root, fetchImpl() {} }),
      { message: "Local harness manifest contains invalid workflowGuard defaults." },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("B1 updates a non-Git project, installs dependencies, and preserves explicit settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-update-"))
  const oldOpenCodePackage = `${JSON.stringify({ name: "harness", version: "1.0.0" }, null, 2)}\n`
  const oldOpenCodeLock = `${JSON.stringify({ name: "harness", version: "1.0.0", lockfileVersion: 3, packages: {} }, null, 2)}\n`
  const newOpenCodePackage = `${JSON.stringify({ name: "harness", version: "2.0.0" }, null, 2)}\n`
  const newOpenCodeLock = `${JSON.stringify({ name: "harness", version: "2.0.0", lockfileVersion: 3, packages: {} }, null, 2)}\n`
  const localManifest = {
    schemaVersion: 1,
    repository: "owner/repository",
    files: [
      "harness-manifest.json",
      "AGENTS.md",
      "scripts/obsolete.mjs",
      ".opencode/package.json",
      ".opencode/package-lock.json",
    ],
    packageScripts: { "harness:update": "old command" },
    projectConfig: {
      protectedAgentPaths: ["scripts/old-updater.mjs"],
      workflowGuard: { modeGuard: true },
    },
  }
  const remoteManifest = {
    schemaVersion: 1,
    repository: "owner/repository",
    files: [
      "harness-manifest.json",
      "AGENTS.md",
      "scripts/update-harness.mjs",
      ".opencode/package.json",
      ".opencode/package-lock.json",
    ],
    packageScripts: { "harness:update": "node scripts/update-harness.mjs" },
    projectConfig: {
      protectedAgentPaths: ["scripts/update-harness.mjs", "harness-manifest.json"],
      workflowGuard: { modeGuard: true, taskStartGuard: true },
    },
  }
  const remoteManifestText = `${JSON.stringify(remoteManifest, null, 2)}\n`
  const files = new Map([
    ["/raw/v2.0.0/harness-manifest.json", remoteManifestText],
    ["/raw/v2.0.0/AGENTS.md", "# Updated harness rules\n"],
    ["/raw/v2.0.0/scripts/update-harness.mjs", "export const updated = true\n"],
    ["/raw/v2.0.0/.opencode/package.json", newOpenCodePackage],
    ["/raw/v2.0.0/.opencode/package-lock.json", newOpenCodeLock],
  ])
  const server = await fixtureServer(files)
  try {
    write(join(root, "harness-manifest.json"), `${JSON.stringify(localManifest, null, 2)}\n`)
    write(join(root, "AGENTS.md"), "# Old harness rules\n")
    write(join(root, "scripts/obsolete.mjs"), "obsolete\n")
    write(join(root, ".opencode/package.json"), oldOpenCodePackage)
    write(join(root, ".opencode/package-lock.json"), oldOpenCodeLock)
    write(join(root, "package.json"), `${JSON.stringify({ scripts: { custom: "keep-me" } }, null, 2)}\n`)
    write(join(root, "project.json"), `${JSON.stringify({
      name: "Custom App",
      settings: {
        appRuntime: { backendPort: 7777 },
        opencode: {
          protectedAgentPaths: ["custom-protected.txt"],
          workflowGuard: { modeGuard: false, projectOnlyGuard: true },
        },
      },
    }, null, 4)}\n`)
    write(join(root, "code/custom.txt"), "project-owned\n")

    const installCalls = []
    const installDependencies = (request) => {
      installCalls.push({ ...request, args: [...request.args] })
      write(join(request.cwd, "node_modules/install-state.txt"), `${json(join(request.cwd, "package-lock.json")).version}\n`)
    }
    const updateOptions = {
      root,
      repository: "owner/repository",
      releaseApiUrl: `${server.baseUrl}/release`,
      rawBaseUrl: `${server.baseUrl}/raw`,
      installDependencies,
      log() {},
    }
    const checkResult = await runHarnessUpdate({ ...updateOptions, check: true })
    assert.equal(checkResult.check, true)
    assert.equal(installCalls.length, 0)
    assert.equal(readFileSync(join(root, ".opencode/package-lock.json"), "utf8"), oldOpenCodeLock)

    const result = await runHarnessUpdate({
      ...updateOptions,
    })

    assert.equal(result.tag, "v2.0.0")
    assert.equal(result.compatibilityMode, false)
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "# Updated harness rules\n")
    assert.equal(readFileSync(join(root, "scripts/update-harness.mjs"), "utf8"), "export const updated = true\n")
    assert.equal(readFileSync(join(root, ".opencode/package.json"), "utf8"), newOpenCodePackage)
    assert.equal(readFileSync(join(root, ".opencode/package-lock.json"), "utf8"), newOpenCodeLock)
    assert.equal(readFileSync(join(root, ".opencode/node_modules/install-state.txt"), "utf8"), "2.0.0\n")
    assert.equal(installCalls.length, 1)
    assert.deepEqual(installCalls[0], {
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["ci", "--ignore-scripts"],
      cwd: join(root, ".opencode"),
    })
    assert.equal(readFileSync(join(root, "code/custom.txt"), "utf8"), "project-owned\n")
    assert.equal(json(join(root, "package.json")).scripts.custom, "keep-me")
    assert.equal(json(join(root, "package.json")).scripts["harness:update"], "node scripts/update-harness.mjs")
    assert.equal(json(join(root, "project.json")).settings.appRuntime.backendPort, 7777)
    assert.deepEqual(json(join(root, "project.json")).settings.opencode.protectedAgentPaths, [
      "custom-protected.txt",
      "scripts/update-harness.mjs",
      "harness-manifest.json",
    ])
    assert.deepEqual(json(join(root, "project.json")).settings.opencode.workflowGuard, {
      modeGuard: false,
      taskStartGuard: true,
      projectOnlyGuard: true,
    })
    assert.equal(json(join(root, ".runtime/harness-update.json")).tag, "v2.0.0")
    assert.ok(result.backupPath)
    assert.equal(readFileSync(join(root, result.backupPath, "files/AGENTS.md"), "utf8"), "# Old harness rules\n")
    assert.equal(existsSync(join(root, "scripts/obsolete.mjs")), false)
  } finally {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("B2 restores managed files and old dependencies when dependency installation fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-update-rollback-"))
  const oldOpenCodePackage = `${JSON.stringify({ name: "harness", version: "1.0.0" }, null, 2)}\n`
  const oldOpenCodeLock = `${JSON.stringify({ name: "harness", version: "1.0.0", lockfileVersion: 3, packages: {} }, null, 2)}\n`
  const newOpenCodePackage = `${JSON.stringify({ name: "harness", version: "2.0.0" }, null, 2)}\n`
  const newOpenCodeLock = `${JSON.stringify({ name: "harness", version: "2.0.0", lockfileVersion: 3, packages: {} }, null, 2)}\n`
  const localManifest = {
    schemaVersion: 1,
    repository: "owner/repository",
    files: ["harness-manifest.json", "AGENTS.md", ".opencode/package.json", ".opencode/package-lock.json"],
    packageScripts: { "harness:update": "old command" },
    projectConfig: {
      protectedAgentPaths: ["scripts/old-updater.mjs"],
      workflowGuard: { modeGuard: false },
    },
  }
  const remoteManifest = {
    schemaVersion: 1,
    repository: "owner/repository",
    files: ["harness-manifest.json", "AGENTS.md", ".opencode/package.json", ".opencode/package-lock.json"],
    packageScripts: { "harness:update": "node scripts/update-harness.mjs" },
    projectConfig: {
      protectedAgentPaths: ["scripts/update-harness.mjs"],
      workflowGuard: { modeGuard: true, taskStartGuard: true },
    },
  }
  const localManifestText = `${JSON.stringify(localManifest, null, 2)}\n`
  const remoteManifestText = `${JSON.stringify(remoteManifest, null, 2)}\n`
  const oldRootPackage = `${JSON.stringify({ scripts: { custom: "keep-me", "harness:update": "old command" } }, null, 2)}\n`
  const oldProject = `${JSON.stringify({
    name: "Custom App",
    settings: {
      appRuntime: { backendPort: 7777 },
      opencode: {
        protectedAgentPaths: ["custom-protected.txt"],
        workflowGuard: { modeGuard: false, projectOnlyGuard: true },
      },
    },
  }, null, 4)}\n`
  const files = new Map([
    ["/raw/v2.0.0/harness-manifest.json", remoteManifestText],
    ["/raw/v2.0.0/AGENTS.md", "# Updated harness rules\n"],
    ["/raw/v2.0.0/.opencode/package.json", newOpenCodePackage],
    ["/raw/v2.0.0/.opencode/package-lock.json", newOpenCodeLock],
  ])
  const server = await fixtureServer(files)
  try {
    write(join(root, "harness-manifest.json"), localManifestText)
    write(join(root, "AGENTS.md"), "# Old harness rules\n")
    write(join(root, ".opencode/package.json"), oldOpenCodePackage)
    write(join(root, ".opencode/package-lock.json"), oldOpenCodeLock)
    write(join(root, ".opencode/node_modules/install-state.txt"), "1.0.0\n")
    write(join(root, "package.json"), oldRootPackage)
    write(join(root, "project.json"), oldProject)

    const installCalls = []
    const installDependencies = (request) => {
      installCalls.push({ ...request, args: [...request.args] })
      const installedVersion = json(join(request.cwd, "package-lock.json")).version
      write(join(request.cwd, "node_modules/install-state.txt"), `${installedVersion}\n`)
      if (installedVersion === "2.0.0") throw new Error("simulated dependency installation failure")
    }

    await assert.rejects(
      () => runHarnessUpdate({
        root,
        repository: "owner/repository",
        releaseApiUrl: `${server.baseUrl}/release`,
        rawBaseUrl: `${server.baseUrl}/raw`,
        installDependencies,
        log() {},
      }),
      (error) => {
        assert.equal(
          error.message,
          "Harness update failed and was rolled back: simulated dependency installation failure",
        )
        return true
      },
    )

    assert.equal(installCalls.length, 2)
    for (const call of installCalls) {
      assert.deepEqual(call, {
        command: process.platform === "win32" ? "npm.cmd" : "npm",
        args: ["ci", "--ignore-scripts"],
        cwd: join(root, ".opencode"),
      })
    }
    assert.equal(readFileSync(join(root, "harness-manifest.json"), "utf8"), localManifestText)
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "# Old harness rules\n")
    assert.equal(readFileSync(join(root, ".opencode/package.json"), "utf8"), oldOpenCodePackage)
    assert.equal(readFileSync(join(root, ".opencode/package-lock.json"), "utf8"), oldOpenCodeLock)
    assert.equal(readFileSync(join(root, ".opencode/node_modules/install-state.txt"), "utf8"), "1.0.0\n")
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), oldRootPackage)
    assert.equal(readFileSync(join(root, "project.json"), "utf8"), oldProject)
    assert.equal(existsSync(join(root, ".runtime/harness-update.json")), false)
  } finally {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

import assert from "node:assert/strict"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

const sourceDoctor = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/task-doctor.mjs")

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function task(
  title: string,
  scope: string,
  dependency = "none",
  options: { context?: string[]; behavior?: string; legacyContract?: string; verify?: string } = {},
) {
  return `---
title: ${title}
---

## Outcome

The scoped source remains syntactically valid.

## Scope

- ${scope}
${options.context?.length ? `
## Context

${options.context.map((path) => `- ${path}`).join("\n")}
` : ""}

## Requirements

- Preserve valid JavaScript syntax in the scoped source.
${options.behavior ? `
## Behavior

- ${options.behavior}
` : ""}
${options.legacyContract ? `
## Contract ownership

Contract: ${options.legacyContract}
` : ""}

## Scheduling

Parallel: denied
Depends on: ${dependency}
Resources: source

## Memory

Action: none
Reason: No durable project fact changes.

## Verify

- ${options.verify ?? "npm run typecheck"}
`
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, ["scripts/task-doctor.mjs", ...args], { cwd: root, encoding: "utf8" })
}

function prepareProject(root: string, packageJson: object = {}) {
  write(join(root, "package.json"), JSON.stringify(packageJson))
  write(join(root, "project.json"), "{}")
  write(join(root, "AGENTS.md"), "# Rules\n")
  write(join(root, "MEMORY.md"), "# Memory\n")
  mkdirSync(join(root, "scripts"), { recursive: true })
  copyFileSync(sourceDoctor, join(root, "scripts/task-doctor.mjs"))
}

test("pre-start accepts registered peer tasks and assigns Harness drift to Executor", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-prestart-"))
  try {
    write(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "node --check src/a.js && node --check src/b.js" } }))
    write(join(root, "project.json"), JSON.stringify({ settings: { opencode: { workflowGuard: { executorBaselineRecovery: true } } } }))
    write(join(root, "AGENTS.md"), "# Initial rules\n")
    write(join(root, "MEMORY.md"), "# Memory\n")
    write(join(root, "src/a.js"), "export const a = 1\n")
    write(join(root, "src/b.js"), "export const b = 1\n")
    write(join(root, "kanban/todo/01-task.md"), task("First task", "src/a.js"))
    mkdirSync(join(root, "scripts"), { recursive: true })
    copyFileSync(sourceDoctor, join(root, "scripts/task-doctor.mjs"))

    assert.equal(run(root, "lint", "kanban/todo/01-task.md").status, 0)
    assert.equal(run(root, "register", "kanban/todo/01-task.md").status, 0)
    write(join(root, "kanban/todo/02-task.md"), task("Second task", "src/b.js", "01-task.md"))
    assert.equal(run(root, "lint", "kanban/todo/02-task.md").status, 0)
    assert.equal(run(root, "register", "kanban/todo/02-task.md").status, 0)
    write(join(root, "AGENTS.md"), "# Updated rules\n")

    const result = run(root, "start", "kanban/todo/01-task.md")
    assert.equal(result.status, 1)
    assert.match(`${result.stdout}\n${result.stderr}`, /TASK DOCTOR: EXECUTOR RECOVERY REQUIRED/)
    assert.match(`${result.stdout}\n${result.stderr}`, /HARNESS_BASELINE_DRIFT: AGENTS\.md/)
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /02-task\.md/)
    const state = JSON.parse(readFileSync(join(root, ".task-doctor/state.json"), "utf8"))
    assert.equal(state.status, "started")
    assert.deepEqual(state.executorRecovery.paths.map((entry: any) => entry.path), ["AGENTS.md"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Executor recovery paths come from project configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-configured-recovery-"))
  try {
    write(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "node --check src/a.js" } }))
    write(join(root, "project.json"), JSON.stringify({ settings: { opencode: {
      executorRecoveryPaths: ["tooling/recovery"],
      workflowGuard: { executorBaselineRecovery: true },
    } } }))
    write(join(root, "AGENTS.md"), "# Rules\n")
    write(join(root, "MEMORY.md"), "# Memory\n")
    write(join(root, "src/a.js"), "export const a = 1\n")
    write(join(root, "tooling/recovery/runner.mjs"), "export const version = 1\n")
    const taskPath = "kanban/todo/01-task.md"
    write(join(root, taskPath), task("Configured recovery", "src/a.js"))
    mkdirSync(join(root, "scripts"), { recursive: true })
    copyFileSync(sourceDoctor, join(root, "scripts/task-doctor.mjs"))

    assert.equal(run(root, "lint", taskPath).status, 0)
    assert.equal(run(root, "register", taskPath).status, 0)
    write(join(root, "tooling/recovery/runner.mjs"), "export const version = 2\n")

    const result = run(root, "start", taskPath)
    assert.equal(result.status, 1)
    assert.match(`${result.stdout}\n${result.stderr}`, /TASK DOCTOR: EXECUTOR RECOVERY REQUIRED/)
    assert.match(`${result.stdout}\n${result.stderr}`, /HARNESS_BASELINE_DRIFT: tooling\/recovery\/runner\.mjs/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("operational .runtime contents are ignored without project-specific ignore configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-runtime-ignore-"))
  try {
    prepareProject(root, { scripts: { typecheck: "node --check src/a.js" } })
    write(join(root, "src/a.js"), "export const a = 1\n")
    const taskPath = "kanban/todo/01-task.md"
    write(join(root, taskPath), task("Runtime-neutral task", "src/a.js"))

    assert.equal(run(root, "lint", taskPath).status, 0)
    assert.equal(run(root, "register", taskPath).status, 0)
    write(join(root, ".runtime/process.pid"), "123\n")

    const result = run(root, "start", taskPath)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /TASK DOCTOR: STARTED/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Context accepts only existing project-local regular non-symlink files outside Scope", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-context-"))
  try {
    write(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "node --check src/a.js" } }))
    write(join(root, "project.json"), "{}")
    write(join(root, "AGENTS.md"), "# Rules\n")
    write(join(root, "MEMORY.md"), "# Memory\n")
    write(join(root, "src/a.js"), "export const a = 1\n")
    write(join(root, "src/context.js"), "export const context = 1\n")
    mkdirSync(join(root, "src/context-directory"), { recursive: true })
    symlinkSync("context.js", join(root, "src/context-link.js"))
    mkdirSync(join(root, "scripts"), { recursive: true })
    copyFileSync(sourceDoctor, join(root, "scripts/task-doctor.mjs"))

    const cases = [
      { name: "01-valid.md", context: "src/context.js", status: 0, pattern: /TASK DOCTOR: LINT PASS/ },
      { name: "02-missing.md", context: "src/missing.js", status: 1, pattern: /CONTEXT_PATH_INVALID: src\/missing\.js; path does not exist/ },
      { name: "03-directory.md", context: "src/context-directory", status: 1, pattern: /CONTEXT_PATH_INVALID: src\/context-directory; path must be a regular file/ },
      { name: "04-symlink.md", context: "src/context-link.js", status: 1, pattern: /CONTEXT_PATH_INVALID: src\/context-link\.js; path must not contain a symbolic link/ },
      { name: "05-scoped.md", context: "src/a.js", status: 1, pattern: /CONTEXT_PATH_IN_SCOPE: src\/a\.js/ },
      { name: "06-outside.md", context: "../outside.js", status: 1, pattern: /CONTEXT_PATH_INVALID: \.\.\/outside\.js; path must not contain dot segments/ },
    ]
    for (const item of cases) {
      const path = `kanban/todo/${item.name}`
      write(join(root, path), task(item.name, "src/a.js", "none", { context: [item.context] }))
      const result = run(root, "lint", path)
      assert.equal(result.status, item.status, `${item.name}: ${result.stderr}`)
      assert.match(`${result.stdout}\n${result.stderr}`, item.pattern)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("legacy Behavior metadata is ignored by technical verification", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-behavior-"))
  try {
    write(join(root, "package.json"), JSON.stringify({
      scripts: { "test:unit": "node -e \"console.log('- B7 skipped reporter')\"" },
    }))
    write(join(root, "project.json"), JSON.stringify({ settings: { taskDoctor: {} } }))
    write(join(root, "AGENTS.md"), "# Rules\n")
    write(join(root, "MEMORY.md"), "# Memory\n")
    write(join(root, "src/a.js"), "export const a = 1\n")
    const taskPath = "kanban/todo/01-task.md"
    write(join(root, taskPath), task("Behavior diagnostic", "src/a.js", "none", {
      behavior: "B7 Navigation remains available: client",
      verify: "npm run test:unit",
    }))
    mkdirSync(join(root, "scripts"), { recursive: true })
    copyFileSync(sourceDoctor, join(root, "scripts/task-doctor.mjs"))

    assert.equal(run(root, "lint", taskPath).status, 0)
    assert.equal(run(root, "register", taskPath).status, 0)
    assert.equal(run(root, "start", taskPath).status, 0)
    const verified = run(root, "verify", taskPath)
    assert.equal(verified.status, 0, verified.stderr)
    assert.match(verified.stdout, /TASK DOCTOR: PASS/)
    assert.doesNotMatch(`${verified.stdout}\n${verified.stderr}`, /BEHAVIOR_EVIDENCE_MISSING|BEHAVIOR_REQUIRED_ACTION/)

    const report = JSON.parse(readFileSync(join(root, ".task-doctor/reports/01-task.md.json"), "utf8"))
    assert.equal("behaviorTests" in report, false)
    assert.equal("contractOwnership" in report, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("task paths are decoded correctly when the project path contains spaces", () => {
  const parent = mkdtempSync(join(tmpdir(), "doctor-root-"))
  const root = join(parent, "project with spaces")
  try {
    prepareProject(root)
    write(join(root, "src/a.js"), "export const a = 1\n")
    const taskPath = "kanban/todo/01-task.md"
    write(join(root, taskPath), task("Space-safe root", "src/a.js", "none", { verify: "" }))

    const result = run(root, "lint", taskPath)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /TASK DOCTOR: LINT PASS/)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test("zero Verify commands are a valid technical task contract", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-empty-verify-"))
  try {
    prepareProject(root)
    write(join(root, "src/a.js"), "export const a = 1\n")
    const taskPath = "kanban/todo/01-task.md"
    write(join(root, taskPath), task("No artificial oracle", "src/a.js", "none", { verify: "" }))

    assert.equal(run(root, "lint", taskPath).status, 0)
    assert.equal(run(root, "register", taskPath).status, 0)
    assert.equal(run(root, "start", taskPath).status, 0)
    const verified = run(root, "verify", taskPath)
    assert.equal(verified.status, 0, verified.stderr)
    const report = JSON.parse(readFileSync(join(root, ".task-doctor/reports/01-task.md.json"), "utf8"))
    assert.deepEqual(report.commands, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("contract labels do not impose project-specific path direction", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-neutral-contract-"))
  try {
    prepareProject(root, {
      scripts: { typecheck: "node --check modules/producer.js && node --check modules/consumer.js" },
    })
    write(join(root, "modules/producer.js"), "export const producer = 1\n")
    write(join(root, "modules/consumer.js"), "export const consumer = 1\n")
    const taskPath = "kanban/todo/01-task.md"
    write(join(root, taskPath), task(
      "Project-neutral mixed scope",
      "modules/producer.js\n- modules/consumer.js",
      "none",
      { legacyContract: "backend-contract" },
    ))

    const result = run(root, "lint", taskPath)
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /CONTRACT_DIRECTION/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("task files and every task-path ancestor must be regular non-symlink entries", () => {
  const finalLinkRoot = mkdtempSync(join(tmpdir(), "doctor-task-link-"))
  const ancestorLinkRoot = mkdtempSync(join(tmpdir(), "doctor-task-ancestor-link-"))
  try {
    prepareProject(finalLinkRoot)
    write(join(finalLinkRoot, "src/a.js"), "export const a = 1\n")
    write(join(finalLinkRoot, "real-task.md"), task("Linked task", "src/a.js", "none", { verify: "" }))
    mkdirSync(join(finalLinkRoot, "kanban/todo"), { recursive: true })
    symlinkSync("../../real-task.md", join(finalLinkRoot, "kanban/todo/01-task.md"))
    const finalLink = run(finalLinkRoot, "lint", "kanban/todo/01-task.md")
    assert.equal(finalLink.status, 1)
    assert.match(`${finalLink.stdout}\n${finalLink.stderr}`, /TASK_FILE_INVALID: .*path must not contain a symbolic link/)

    prepareProject(ancestorLinkRoot)
    write(join(ancestorLinkRoot, "src/a.js"), "export const a = 1\n")
    write(join(ancestorLinkRoot, "actual-todo/01-task.md"), task("Linked ancestor", "src/a.js", "none", { verify: "" }))
    mkdirSync(join(ancestorLinkRoot, "kanban"), { recursive: true })
    symlinkSync("../actual-todo", join(ancestorLinkRoot, "kanban/todo"))
    const ancestorLink = run(ancestorLinkRoot, "lint", "kanban/todo/01-task.md")
    assert.equal(ancestorLink.status, 1)
    assert.match(`${ancestorLink.stdout}\n${ancestorLink.stderr}`, /TASK_FILE_INVALID: .*path must not contain a symbolic link/)
  } finally {
    rmSync(finalLinkRoot, { recursive: true, force: true })
    rmSync(ancestorLinkRoot, { recursive: true, force: true })
  }
})

test("Verify restores task-scope mutations and fails with a technical diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-verify-transaction-"))
  try {
    prepareProject(root)
    write(join(root, "src/a.js"), "export const a = 1\n")
    write(join(root, "mutate.mjs"), [
      "import { mkdirSync, writeFileSync } from 'node:fs'",
      "mkdirSync(new URL('./src/generated/', import.meta.url), { recursive: true })",
      "writeFileSync(new URL('./src/a.js', import.meta.url), 'export const a = 3\\n')",
      "writeFileSync(new URL('./src/generated/new.js', import.meta.url), 'export const generated = true\\n')",
      "",
    ].join("\n"))
    const taskPath = "kanban/todo/01-task.md"
    write(join(root, taskPath), task("Transactional Verify", "src", "none", { verify: "node mutate.mjs" }))

    assert.equal(run(root, "lint", taskPath).status, 0)
    assert.equal(run(root, "register", taskPath).status, 0)
    assert.equal(run(root, "start", taskPath).status, 0)
    write(join(root, "src/a.js"), "export const a = 2\n")

    const verified = run(root, "verify", taskPath)
    assert.equal(verified.status, 1)
    assert.match(`${verified.stdout}\n${verified.stderr}`, /VERIFY_MUTATED_TASK_FILE: src\/a\.js/)
    assert.match(`${verified.stdout}\n${verified.stderr}`, /VERIFY_MUTATED_TASK_FILE: src\/generated\/new\.js/)
    assert.equal(readFileSync(join(root, "src/a.js"), "utf8"), "export const a = 2\n")
    assert.equal(existsSync(join(root, "src/generated/new.js")), false)
    assert.equal(existsSync(join(root, "src/generated")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

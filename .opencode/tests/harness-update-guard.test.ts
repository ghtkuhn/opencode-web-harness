import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { WorkflowGuard } from "../plugins/workflow-guard.ts"

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harness-update-language-"))
  write(join(root, "project.json"), JSON.stringify({ settings: { opencode: {} } }))
  write(join(root, "scripts/task-doctor.mjs"), "")
  write(join(root, "kanban/TASK.md"), "# Task template\n")
  return root
}

async function plugin(root: string) {
  return WorkflowGuard({ directory: root, worktree: root, client: {} } as any)
}

async function userMessage(hooks: Awaited<ReturnType<typeof plugin>>, sessionID: string, agent: string, text: string) {
  await hooks["chat.message"]!({ sessionID, agent } as any, {
    message: {},
    parts: [{ type: "text", text }],
  } as any)
}

function before(hooks: Awaited<ReturnType<typeof plugin>>, sessionID: string, command: string) {
  return hooks["tool.execute.before"]!({ sessionID, tool: "bash" } as any, { args: { command } })
}

test("natural-language update wording neither prioritizes nor authorizes a Harness mutation", async () => {
  const root = fixture()
  try {
    const hooks = await plugin(root)

    await userMessage(hooks, "planner", "planner", "update den Harness")
    await assert.doesNotReject(() => before(hooks, "planner", "ls"))
    await assert.rejects(
      () => before(hooks, "planner", "npm run harness:update"),
      /outside the read-only and fixed app-operation allowlist/,
    )

    await userMessage(hooks, "executor", "executor", "update das Template")
    await assert.doesNotReject(() => before(hooks, "executor", "npm run task:doctor:schedule"))
    await assert.rejects(
      () => before(hooks, "executor", "npm run harness:update"),
      /outside the read-only allowlist/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Harness updates remain an explicit project CLI", () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url))
  const projectRoot = resolve(testDirectory, "../..")
  const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"))
  assert.equal(packageJson.scripts?.["harness:update"], "node scripts/update-harness.mjs")
})

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { WorkflowGuard } from "../plugins/workflow-guard.ts"

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function digest(content: string) {
  return createHash("sha256").update(content).digest("hex")
}

function fixture(taskPath = "kanban/todo/01-task.md") {
  const root = mkdtempSync(join(tmpdir(), "executor-review-evidence-"))
  const sourcePath = "src/a.ts"
  const taskContent = "# Task\n\n## Scope\n- `src/a.ts`\n\n## Requirement\nUpdate the value.\n"
  const sourceBefore = "export const value = 1\n"
  const sourceAfter = "export const value = 2\n"
  const reportPath = ".task-doctor/reports/01-task.json"

  write(join(root, "project.json"), JSON.stringify({
    settings: { opencode: { workflowGuard: { executorReview: true } } },
  }))
  write(join(root, "kanban/TASK.md"), "# Template\n")
  write(join(root, taskPath), taskContent)
  write(join(root, sourcePath), sourceAfter)
  write(join(root, reportPath), `${JSON.stringify({ changedFiles: [sourcePath] }, null, 2)}\n`)
  write(join(root, ".task-doctor/state.json"), `${JSON.stringify({
    version: 4,
    status: "passed",
    taskPath,
    taskHash: digest(taskContent),
    snapshot: { [sourcePath]: digest(sourceBefore) },
    verifiedSnapshot: { [sourcePath]: digest(sourceAfter) },
    verifiedSnapshotHash: digest(sourceAfter),
    reportPath,
  }, null, 2)}\n`)
  write(join(root, "scripts/task-doctor.mjs"), [
    'import { mkdirSync, renameSync } from "node:fs"',
    'import { dirname } from "node:path"',
    'const [, , command, taskPath] = process.argv',
    'if (command !== "complete" || !taskPath?.startsWith("kanban/todo/")) process.exit(1)',
    'const donePath = taskPath.replace("kanban/todo/", "kanban/done/")',
    'mkdirSync(dirname(donePath), { recursive: true })',
    'renameSync(taskPath, donePath)',
    'console.log(`TASK DOCTOR: COMPLETED ${donePath}`)',
    "",
  ].join("\n"))

  return { root, taskPath, sourcePath }
}

test("zero-argument technical completion does not require model read evidence", async () => {
  const data = fixture()
  try {
    const sessionID = "executor"
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID, agent: "executor" } as any, {} as any)
    const context = { agent: "executor", sessionID, metadata() {} } as any
    const result = await hooks.tool!.submit_task_review.execute({}, context)
    assert.match(result.output, /TASK DOCTOR: COMPLETED kanban\/done\/01-task\.md/)
    assert.equal(existsSync(join(data.root, ".task-doctor/reviews/01-task.md.json")), false)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("zero-argument technical completion preserves a canonical task path containing spaces", async () => {
  const data = fixture("kanban/todo/01 task with spaces.md")
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result = await hooks.tool!.submit_task_review.execute(
      {}, { agent: "executor", sessionID: "executor-spaces", metadata() {} } as any,
    )
    assert.equal(result.metadata.completedPath, "kanban/done/01 task with spaces.md")
    assert.match(result.output, /TASK DOCTOR: COMPLETED kanban\/done\/01 task with spaces\.md/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("legacy review prose cannot reopen or quality-gate a Doctor-passed task", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const context = { agent: "executor", sessionID: "executor", metadata() {} } as any
    const result = await hooks.tool!.submit_task_review.execute({
      verdict: "changes_required",
      findings: ["A model dislikes the implementation."],
    }, context)
    assert.match(result.output, /TASK DOCTOR: COMPLETED kanban\/done\/01-task\.md/)
    assert.equal(existsSync(join(data.root, ".task-doctor/reviews/01-task.md.json")), false)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("legacy persisted review metadata is irrelevant to technical completion", async () => {
  const data = fixture()
  try {
    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    write(join(data.root, ".task-doctor/reviews/01-task.md.json"), `${JSON.stringify({
      version: 1,
      taskPath: data.taskPath,
      taskHash: state.taskHash,
      rounds: [{ verdict: "approved", verifiedSnapshotHash: state.verifiedSnapshotHash }],
    }, null, 2)}\n`)
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result = await hooks.tool!.submit_task_review.execute(
      {}, { agent: "executor", sessionID: "executor-recovery", metadata() {} } as any,
    )
    assert.match(result.output, /TASK DOCTOR: COMPLETED kanban\/done\/01-task\.md/)
    assert.equal(result.metadata.completedPath, "kanban/done/01-task.md")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("post-task compaction uses the latest model body and OpenCode token total", async () => {
  const data = fixture()
  try {
    const sessionID = "executor-compaction"
    const summarizeCalls: any[] = []
    const client = {
      session: {
        messages: async () => ({ data: [{
          info: {
            id: "assistant-finished",
            role: "assistant",
            agent: "executor",
            providerID: "llamacpp-local",
            modelID: "qwen3.5-9b-q4-reasoning",
            time: { completed: Date.now() },
            finish: "stop",
            // The native total is authoritative even when the legacy component sum is below threshold.
            tokens: { total: 80, input: 10, output: 5, cache: { read: 5, write: 0 } },
          },
          parts: [{ type: "text", text: "Review complete." }],
        }] }),
        summarize: async (input: any) => {
          summarizeCalls.push(input)
          return { data: true }
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID, agent: "executor" } as any, {} as any)
    await hooks["experimental.chat.system.transform"]!({
      sessionID,
      model: {
        providerID: "llamacpp-local",
        modelID: "qwen3.5-9b-q4-reasoning",
        limit: { context: 100 },
      },
    } as any, { system: [] } as any)

    const read = async (path: string) => {
      const args = { filePath: join(data.root, path) }
      await hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, { args } as any)
      await hooks["tool.execute.after"]!({ sessionID, tool: "read", args } as any, {
        output: readFileSync(join(data.root, path), "utf8"),
      } as any)
    }
    await read(data.taskPath)
    await read(data.sourcePath)
    await hooks.tool!.submit_task_review.execute(
      {},
      { agent: "executor", sessionID, metadata() {} } as any,
    )

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } } as any)
    assert.deepEqual(summarizeCalls, [{
      path: { id: sessionID },
      query: { directory: data.root },
      body: {
        providerID: "llamacpp-local",
        modelID: "qwen3.5-9b-q4-reasoning",
        auto: true,
      },
    }])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

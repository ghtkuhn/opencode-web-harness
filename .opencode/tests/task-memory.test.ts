import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { appendTaskMemory } from "../lib/task-memory.ts"
import { WorkflowGuard } from "../plugins/workflow-guard.ts"

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function digest(content: string) {
  return createHash("sha256").update(content).digest("hex")
}

function fixture(maxMemorySize = "15kb") {
  const root = mkdtempSync(join(tmpdir(), "task-memory-"))
  const taskPath = "kanban/todo/01-memory.md"
  const taskContent = "# Task\n\n## Memory\n\nAction: append\nReason: Record one durable fact.\n"
  const baseline = "# MEMORY.md\n\n## Existing\n- Durable history.\n\"\"\"\n"
  write(join(root, "project.json"), JSON.stringify({
    settings: {
      maxMemorySize,
      opencode: {
        workflowGuard: { taskMemoryAppend: true },
      },
    },
  }))
  write(join(root, "kanban/TASK.md"), "# Template\n")
  write(join(root, "scripts/task-doctor.mjs"), "")
  write(join(root, "WORKER.md"), "# Worker rules\n")
  write(join(root, taskPath), taskContent)
  write(join(root, "MEMORY.md"), "# MEMORY.md\n\nWorker rewrote existing history.\n")
  write(join(root, ".task-doctor/state.json"), JSON.stringify({
    version: 4,
    status: "started",
    taskPath,
    taskHash: digest(taskContent),
    memoryAction: "append",
    memoryContent: baseline,
    memory: { exists: true, hash: digest(baseline), size: Buffer.byteLength(baseline) },
    snapshot: { "MEMORY.md": digest(baseline) },
  }))
  return { root, taskPath, baseline }
}

test("task memory append restores the exact baseline and adds one timestamped fact", () => {
  const data = fixture()
  try {
    const result = appendTaskMemory(data.root, {
      taskPath: data.taskPath,
      entry: "- 2020-01-01 00:00: The application root provides the shared i18n context.",
      workerSessionID: "worker",
    }, new Date(2026, 6, 14, 22, 45))

    const expected = `${data.baseline}\n- 2026-07-14 22:45: The application root provides the shared i18n context.\n`
    assert.equal(readFileSync(join(data.root, "MEMORY.md"), "utf8"), expected)
    assert.equal(result.restoredBaseline, true)
    assert.equal(result.changed, true)

    const repeated = appendTaskMemory(data.root, {
      taskPath: data.taskPath,
      entry: "The application root provides the shared i18n context.",
      workerSessionID: "worker",
    }, new Date(2026, 6, 14, 22, 50))
    assert.equal(repeated.changed, false)
    assert.equal(readFileSync(join(data.root, "MEMORY.md"), "utf8"), expected)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("task memory append is idempotent after Doctor PASS", () => {
  const data = fixture()
  try {
    const first = appendTaskMemory(data.root, {
      taskPath: data.taskPath,
      entry: "The application root provides the shared locale context.",
      workerSessionID: "worker",
    }, new Date(2026, 6, 14, 20, 15))
    const statePath = join(data.root, ".task-doctor/state.json")
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    writeFileSync(statePath, `${JSON.stringify({ ...state, status: "passed" }, null, 2)}\n`)

    const late = appendTaskMemory(data.root, {
      taskPath: data.taskPath,
      entry: "A redundant late request with different wording.",
      workerSessionID: "worker",
    })

    assert.equal(late.changed, false)
    assert.equal(late.verified, true)
    assert.equal(late.entry, first.entry)
    assert.match(late.message, /already appended and verified/)
    assert.equal(
      readFileSync(join(data.root, "MEMORY.md"), "utf8"),
      `${data.baseline}\n- 2026-07-14 20:15: The application root provides the shared locale context.\n`,
    )

    writeFileSync(statePath, `${JSON.stringify({ ...state, status: "completed" }, null, 2)}\n`)
    const completed = appendTaskMemory(data.root, {
      taskPath: data.taskPath,
      entry: "Another redundant request after completion.",
      workerSessionID: "worker",
    })
    assert.equal(completed.changed, false)
    assert.equal(completed.verified, true)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("task memory append rejects content that would exceed the project limit", () => {
  const data = fixture("60b")
  try {
    assert.throws(() => appendTaskMemory(data.root, {
      taskPath: data.taskPath,
      entry: "This durable entry cannot fit inside the configured project memory limit.",
      workerSessionID: "worker",
    }, new Date(2026, 6, 14, 22, 45)), /project\.json allows 60 bytes/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Worker is redirected from direct append edits to the structured memory tool", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "worker", agent: "worker" } as any, {} as any)
    await hooks["tool.execute.after"]!({
      sessionID: "worker",
      tool: "read",
      args: { filePath: join(data.root, "WORKER.md") },
    } as any, { title: "read", output: "", metadata: { truncated: false } })
    await assert.rejects(hooks["tool.execute.before"]!({ sessionID: "worker", tool: "edit" } as any, {
      args: {
        filePath: join(data.root, "MEMORY.md"),
        oldString: "Durable history.",
        newString: "Changed history.",
      },
    }), /append_task_memory/)

    const result = await hooks.tool!.append_task_memory.execute({
      entry: "The application root provides the shared i18n context through I18nProvider.",
    }, { agent: "worker", sessionID: "worker", metadata() {} } as any)
    assert.deepEqual(Object.keys((hooks.tool!.append_task_memory as any).args), ["entry"])
    assert.match(result.output, /TASK MEMORY APPENDED kanban\/todo\/01-memory\.md/)
    assert.match(result.output, /original Doctor memory baseline was restored/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

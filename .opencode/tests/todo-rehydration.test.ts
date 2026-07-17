import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { WorkflowGuard } from "../plugins/workflow-guard.ts"

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

test("todo discipline rehydrates OpenCode todos after plugin restart and before idle evaluation", async () => {
  const root = mkdtempSync(join(tmpdir(), "todo-rehydration-"))
  try {
    write(join(root, "project.json"), JSON.stringify({
      settings: { opencode: { workflowGuard: { todoDiscipline: true } } },
    }))
    write(join(root, "kanban/TASK.md"), "# Template\n")
    write(join(root, "scripts/task-doctor.mjs"), "")

    let todoReads = 0
    const prompts: any[] = []
    const client = {
      session: {
        async todo() {
          todoReads += 1
          return { data: [{ id: "todo-1", content: "Finish the current task", status: "in_progress", priority: "high" }] }
        },
        async messages() {
          return { data: [
            { info: { role: "user" }, parts: [{ type: "text", text: "Complete all tasks" }] },
            {
              info: { role: "assistant", agent: "worker", finish: "stop", time: { completed: Date.now() } },
              parts: [{ type: "text", text: "Done." }],
            },
          ] }
        },
        async promptAsync(input: any) {
          prompts.push(input)
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: root, worktree: root, client } as any)

    await hooks["chat.message"]!({ sessionID: "worker", agent: "worker" } as any, {} as any)
    assert.equal(todoReads, 1)

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "worker" } } } as any)
    assert.equal(todoReads, 2)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0].body.parts[0].text, /Reconcile the internal todo list/)
    assert.equal(prompts[0].body.agent, "worker")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("todo discipline never resumes Planner as a Worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "todo-planner-role-"))
  try {
    write(join(root, "project.json"), JSON.stringify({
      settings: { opencode: { workflowGuard: { todoDiscipline: true } } },
    }))
    write(join(root, "kanban/TASK.md"), "# Template\n")
    write(join(root, "scripts/task-doctor.mjs"), "")
    const prompts: any[] = []
    const client = {
      session: {
        async todo() {
          return { data: [{ id: "todo-1", content: "Plan all tasks", status: "in_progress", priority: "high" }] }
        },
        async messages() {
          return { data: [
            { info: { role: "user" }, parts: [{ type: "text", text: "Plan all tasks" }] },
            { info: { role: "assistant", agent: "planner", finish: "stop", time: { completed: Date.now() } }, parts: [{ type: "text", text: "Planning complete." }] },
          ] }
        },
        async promptAsync(input: any) {
          prompts.push(input)
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: root, worktree: root, client } as any)
    await hooks["chat.message"]!({ sessionID: "planner", agent: "planner" } as any, {} as any)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "planner" } } } as any)
    assert.equal(prompts.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("todo discipline never resumes Executor as a Worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "todo-executor-role-"))
  try {
    write(join(root, "project.json"), JSON.stringify({
      settings: { opencode: { workflowGuard: { todoDiscipline: true } } },
    }))
    write(join(root, "kanban/TASK.md"), "# Template\n")
    write(join(root, "scripts/task-doctor.mjs"), "")
    const prompts: any[] = []
    const client = {
      session: {
        async todo() {
          return { data: [{ id: "todo-1", content: "Review the current task", status: "in_progress", priority: "high" }] }
        },
        async messages() {
          return { data: [
            { info: { role: "user" }, parts: [{ type: "text", text: "Execute all tasks" }] },
            { info: { role: "assistant", agent: "executor", finish: "stop", time: { completed: Date.now() } }, parts: [{ type: "text", text: "Review complete." }] },
          ] }
        },
        async promptAsync(input: any) {
          prompts.push(input)
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: root, worktree: root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "executor" } } } as any)
    assert.equal(prompts.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

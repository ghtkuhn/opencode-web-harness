import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { claimPlannerOwnership } from "../lib/planner-ownership.ts"
import { WorkflowGuard } from "../plugins/workflow-guard.ts"

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function digest(content: string) {
  return createHash("sha256").update(content).digest("hex")
}

function fixture(scheduleExitCode = 0) {
  const root = mkdtempSync(join(tmpdir(), "planner-completion-"))
  const taskPath = "kanban/todo/01-task.md"
  const taskContent = "# Task\n"
  write(join(root, "project.json"), JSON.stringify({
    settings: {
      opencode: {
        workflowGuard: {
          plannerCompletionGuard: true,
          plannerQuestionEnforcer: false,
          guardLearning: false,
          contextCheckpoint: false,
          executorReview: false,
          idleReview: false,
          todoDiscipline: false,
        },
      },
    },
  }))
  write(join(root, "kanban/TASK.md"), "# Task template\n")
  write(join(root, taskPath), taskContent)
  write(join(root, "scripts/task-doctor.mjs"), scheduleExitCode === 0
    ? "console.log('TASK DOCTOR: READY kanban/todo/01-task.md')\n"
    : "console.error('TASK DOCTOR: FAIL\\n- TASK_FORMAT: kanban/todo/01-task.md: invalid schedule')\nprocess.exit(1)\n")
  claimPlannerOwnership(root, {
    taskPath,
    plannerSessionID: "planner",
    plannerAgent: "planner",
    source: "task_write",
  })
  return { root, taskPath, taskContent }
}

function finishedPlannerMessages(text = "Planning is complete.") {
  return [{
    info: {
      id: "assistant",
      role: "assistant",
      agent: "planner",
      time: { completed: 1 },
      finish: "stop",
    },
    parts: text ? [{ type: "text", text }] : [],
  }]
}

async function idlePlanner(root: string, messages = finishedPlannerMessages(), idleCount = 1) {
  const prompts: string[] = []
  const client = {
    session: {
      messages: async () => ({ data: messages }),
      promptAsync: async ({ body }: any) => {
        prompts.push(body.parts[0].text)
        return { data: {} }
      },
    },
  }
  const hooks = await WorkflowGuard({ directory: root, worktree: root, client } as any)
  await hooks["chat.message"]!({ sessionID: "planner", agent: "planner" } as any, {} as any)
  for (let index = 0; index < idleCount; index += 1) {
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "planner" } } } as any)
  }
  return prompts
}

test("Planner completion guard resumes an empty unfinished turn at most twice", async () => {
  const data = fixture()
  try {
    rmSync(join(data.root, data.taskPath), { force: true })
    const prompts = await idlePlanner(data.root, finishedPlannerMessages(""), 3)
    assert.equal(prompts.length, 2)
    assert.match(prompts[0], /PLANNER TURN INCOMPLETE/)
    assert.match(prompts[0], /Reuse evidence already read/)
    assert.match(prompts[0], /register_planner_task for each minimal task/)
    assert.match(prompts[0], /Do not stop silently/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Planner completion guard resumes tasks not registered against their current content", async () => {
  const data = fixture()
  try {
    const prompts = await idlePlanner(data.root)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0], /PLANNER COMPLETION BLOCKED/)
    assert.match(prompts[0], /register_planner_task/)
    assert.match(prompts[0], /Do not edit task files or run lint\/register separately/)
    assert.match(prompts[0], /task:doctor:schedule/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Planner completion guard surfaces a failing final schedule preflight", async () => {
  const data = fixture(1)
  try {
    write(join(data.root, ".task-doctor/registrations/01-task.md.json"), JSON.stringify({
      status: "registered",
      taskHash: digest(data.taskContent),
    }))
    const prompts = await idlePlanner(data.root)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0], /final Doctor schedule preflight failed/i)
    assert.match(prompts[0], /TASK_FORMAT: kanban\/todo\/01-task\.md/)
    assert.match(prompts[0], /REAL BLOCKER/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Planner completion guard allows a registered plan with a valid schedule", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/registrations/01-task.md.json"), JSON.stringify({
      status: "registered",
      taskHash: digest(data.taskContent),
    }))
    const prompts = await idlePlanner(data.root)
    assert.deepEqual(prompts, [])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

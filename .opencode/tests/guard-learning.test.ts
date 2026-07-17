import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { knownStableGuardRule, learnedGuardRuleFromSources, stableGuardRule, stableGuardViolationId } from "../lib/guard-learning.ts"
import { WorkflowGuard } from "../plugins/workflow-guard.ts"

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function fixture(root: string, extraWorkflowGuard: Record<string, boolean> = {}) {
  write(join(root, "project.json"), JSON.stringify({ settings: { opencode: { workflowGuard: {
    guardLearning: true,
    plannerQuestionEnforcer: false,
    plannerCompletionGuard: false,
    todoDiscipline: false,
    idleReview: false,
    contextCheckpoint: false,
    ...extraWorkflowGuard,
  } } } }))
  write(join(root, "CUSTOM.md"), "# Shared agent rules\n")
  write(join(root, "WORKER.md"), "# Worker rules\n")
  write(join(root, "kanban/TASK.md"), "# Task contract\n")
  write(join(root, "scripts/task-doctor.mjs"), "")
}

function guardError(id: string, problem: string, action: string) {
  return [
    "WORKFLOW GUARD BLOCKED",
    `Guard learning ID: ${id}`,
    `Problem: ${problem}`,
    `Do next: ${action}`,
  ].join("\n")
}

test("uses one stable ID for task-specific Doctor command messages", () => {
  const first = stableGuardViolationId(
    "A Doctor command was combined, piped, redirected, or filtered, so its lifecycle and authoritative output could be altered.",
    "Run it alone for kanban/todo/01-first.md.",
  )
  const second = stableGuardViolationId(
    "A Doctor command was combined, piped, redirected, or filtered, so its lifecycle and authoritative output could be altered.",
    "Run it alone for kanban/todo/99-other.md.",
  )
  assert.equal(first, "726d21")
  assert.equal(second, first)
})

test("fallback IDs ignore changing recovery actions", () => {
  assert.equal(
    stableGuardViolationId("A future stable problem.", "Do action one."),
    stableGuardViolationId("A future stable problem.", "Do action two."),
  )
})

test("dynamic package names use one semantic ID", () => {
  assert.equal(
    stableGuardViolationId("left-pad is not explicitly named in the active task."),
    stableGuardViolationId("workbox-precaching is not explicitly named in the active task."),
  )
})

test("returns only catalogued durable rules", () => {
  assert.match(stableGuardRule("726d21", "fallback"), /Doctor command alone/)
  assert.match(knownStableGuardRule("581467") ?? "", /one exact current Kanban task/)

  const id = stableGuardViolationId(
    "A one-off task condition failed for src/example.ts.",
    "Rewrite src/example.ts with a task-specific workaround.",
  )
  assert.equal(knownStableGuardRule(id), null)
  const transient = stableGuardRule(id, "Rewrite src/example.ts with a task-specific workaround.")
  assert.match(transient, /without storing task-specific details/)
  assert.doesNotMatch(transient, /src\/example\.ts|workaround/)
})

test("project-specific frontend and Contract messages are not stable Harness rules", () => {
  const ownership = stableGuardViolationId("The active task edits frontend code but declares Contract: none.")
  const dependency = stableGuardViolationId("The frontend task has no fully completed dependency set.")
  assert.equal(knownStableGuardRule(ownership), null)
  assert.equal(knownStableGuardRule(dependency), null)
})

test("records a known stable Executor rule automatically without another model turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "guard-learning-known-"))
  try {
    fixture(root)
    const problem = "Worker delegation does not name exactly one Kanban task."
    const action = "Delegate one Worker with one exact kanban/todo/<task>.md path in both description and prompt."
    const id = stableGuardViolationId(problem, action)
    const messages = [{ info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "Continue." }] }, {
      info: { id: "a1", role: "assistant", parentID: "u1", agent: "executor", time: { completed: 1 }, finish: "stop" },
      parts: [{ type: "tool", tool: "task", state: { status: "error", error: guardError(id, problem, action) } }],
    }]
    const prompts: unknown[] = []
    const hooks = await WorkflowGuard({ directory: root, worktree: root, client: { session: {
      messages: async () => ({ data: messages }),
      promptAsync: async (input: unknown) => prompts.push(input),
    } } } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "executor" } } } as any)

    assert.equal(prompts.length, 0)
    const custom = readFileSync(join(root, "CUSTOM.md"), "utf8")
    assert.match(custom, /\[581467\][^\n]*one exact current Kanban task/)
    assert.doesNotMatch(custom, /kanban\/todo/)
    assert.equal(existsSync(join(root, ".task-doctor/pending-guard-learnings.json")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("records a known stable Worker rule in WORKER.md", async () => {
  const root = mkdtempSync(join(tmpdir(), "guard-learning-worker-"))
  try {
    fixture(root)
    const problem = "Worker preview contains 2 project files: src/a.ts, src/b.ts."
    const action = "Preview exactly one project file. Split the operations into sequential previews."
    const messages = [{ info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "Work." }] }, {
      info: { id: "a1", role: "assistant", parentID: "u1", agent: "worker", time: { completed: 1 }, finish: "stop" },
      parts: [{ type: "tool", tool: "preview_worker_changes", state: {
        status: "error",
        error: guardError("stale1", problem, action),
      } }],
    }]
    const hooks = await WorkflowGuard({ directory: root, worktree: root, client: { session: {
      messages: async () => ({ data: messages }),
      promptAsync: async () => ({ data: {} }),
    } } } as any)
    await hooks["chat.message"]!({ sessionID: "worker", agent: "worker" } as any, {} as any)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "worker" } } } as any)

    assert.match(readFileSync(join(root, "WORKER.md"), "utf8"), /\[f260c1\][^\n]*exactly one project file/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reconciles a persisted known rule during startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "guard-learning-startup-known-"))
  try {
    fixture(root)
    const queuePath = join(root, ".task-doctor/pending-guard-learnings.json")
    write(queuePath, JSON.stringify({ version: 1, sessions: { executor: [{
      id: "581467",
      problem: "Worker delegation does not name exactly one Kanban task.",
      action: "Delegate one Worker with one exact task path.",
      agent: "executor",
    }] } }))

    await WorkflowGuard({ directory: root, worktree: root, client: {} } as any)

    assert.match(readFileSync(join(root, "CUSTOM.md"), "utf8"), /\[581467\][^\n]*one exact current Kanban task/)
    assert.equal(existsSync(queuePath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("drops unknown persisted rules instead of turning them into policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "guard-learning-startup-transient-"))
  try {
    fixture(root)
    const problem = "A one-off task condition failed for src/example.ts."
    const action = "Rewrite src/example.ts with a task-specific workaround."
    const id = stableGuardViolationId(problem, action)
    assert.equal(knownStableGuardRule(id), null)
    const queuePath = join(root, ".task-doctor/pending-guard-learnings.json")
    write(queuePath, JSON.stringify({ version: 1, sessions: { planner: [{ id, problem, action, agent: "planner" }] } }))

    await WorkflowGuard({ directory: root, worktree: root, client: {} } as any)

    assert.equal(readFileSync(join(root, "CUSTOM.md"), "utf8"), "# Shared agent rules\n")
    assert.equal(existsSync(queuePath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("acknowledges an unknown current violation without writing a durable rule", async () => {
  const root = mkdtempSync(join(tmpdir(), "guard-learning-current-transient-"))
  try {
    fixture(root)
    const problem = "A one-off task condition failed for src/example.ts."
    const action = "Rewrite src/example.ts with a task-specific workaround."
    const id = stableGuardViolationId(problem, action)
    const messages = [{ info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "Continue." }] }, {
      info: { id: "a1", role: "assistant", parentID: "u1", agent: "planner", time: { completed: 1 }, finish: "stop" },
      parts: [{ type: "tool", tool: "read", state: { status: "error", error: guardError(id, problem, action) } }],
    }]
    const prompts: unknown[] = []
    const hooks = await WorkflowGuard({ directory: root, worktree: root, client: { session: {
      messages: async () => ({ data: messages }),
      promptAsync: async (input: unknown) => prompts.push(input),
    } } } as any)
    await hooks["chat.message"]!({ sessionID: "planner", agent: "planner" } as any, {} as any)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "planner" } } } as any)

    assert.equal(prompts.length, 1)
    assert.match(JSON.stringify(prompts[0]), /record_guard_learning/)
    const result = await hooks.tool!.record_guard_learning.execute(
      {},
      { agent: "planner", sessionID: "planner", metadata() {} } as any,
    )
    assert.match(result.output, /No durable rule was written/)
    assert.equal(readFileSync(join(root, "CUSTOM.md"), "utf8"), "# Shared agent rules\n")
    assert.equal(existsSync(join(root, ".task-doctor/pending-guard-learnings.json")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("maps core lifecycle variants to stable generic rules", () => {
  assert.equal(stableGuardViolationId(
    "kanban/todo/01-task.md is not the exact active started task.",
    "Start the registered task before previewing implementation changes.",
  ), "c84c34")
  assert.equal(stableGuardViolationId(
    "Worker claimed REVIEWABLE before Doctor PASS for kanban/todo/01-first.md.",
    "Continue the active task until Doctor passes.",
  ), stableGuardViolationId(
    "Worker claimed REVIEWABLE before Doctor PASS for kanban/todo/99-other.md.",
    "Use another task-specific action.",
  ))
  assert.equal(stableGuardViolationId(
    "Worker attempted read before reading required rules in the current context: WORKER-GEMMA4.md.",
    "Read WORKER-GEMMA4.md now.",
  ), "44cd0c")
})

test("finds only canonical known IDs and their aliases in role rule files", () => {
  const sources = [{
    path: "WORKER.md",
    content: [
      "- [726d21] Run Doctor alone.",
      "- [5c9976] Verify after Apply and fully read every preview target.",
      "<!-- guard-learning-aliases: 3d25e9=726d21, bbbf8d=5c9976 -->",
      "- [abcdef] Rewrite src/example.ts with a task-specific workaround.",
    ].join("\n"),
  }]
  assert.equal(learnedGuardRuleFromSources("726d21", sources)?.rule, stableGuardRule("726d21", ""))
  assert.deepEqual(learnedGuardRuleFromSources("3d25e9", sources), {
    id: "3d25e9",
    canonicalID: "726d21",
    path: "WORKER.md",
    rule: stableGuardRule("726d21", ""),
  })
  assert.deepEqual(learnedGuardRuleFromSources("bbbf8d", sources), {
    id: "bbbf8d",
    canonicalID: "5c9976",
    path: "WORKER.md",
    rule: stableGuardRule("5c9976", ""),
  })
  assert.equal(learnedGuardRuleFromSources("abcdef", sources), null)
})

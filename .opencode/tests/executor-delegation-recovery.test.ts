import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import {
  resolveWorkerRecoveryBoost,
  setWorkerRecoveryBoostAgentAvailable,
  WORKER_RECOVERY_BOOST_AGENT,
} from "../lib/worker-recovery-boost.ts"
import { WorkflowGuard } from "../plugins/workflow-guard.ts"

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function updateOpenCodeSettings(root: string, update: (settings: Record<string, any>) => void) {
  const path = join(root, "project.json")
  const project = JSON.parse(readFileSync(path, "utf8"))
  update(project.settings.opencode)
  write(path, JSON.stringify(project))
  setWorkerRecoveryBoostAgentAvailable(root, Boolean(resolveWorkerRecoveryBoost(project.settings.opencode).model))
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "executor-delegation-recovery-"))
  const taskPath = "kanban/todo/01-task.md"
  const taskContent = [
    "# Task",
    "",
    "## Scope",
    "- `src/a.ts`",
    "",
    "## Requirements",
    "- Update the current source behavior.",
    "",
    "## Verify",
    "- npm test",
    "",
  ].join("\n")
  const taskHash = createHash("sha256").update(taskContent).digest("hex")
  write(join(root, "project.json"), JSON.stringify({
    settings: { opencode: {
      workflowGuard: { workerHelp: true },
      agentModels: {
        executor: "llamacpp-local/qwen3.5-9b-q4-reasoning",
        worker: "llamacpp-local/qwen3.5-9b-q4",
      },
    } },
  }))
  write(join(root, "kanban/TASK.md"), "# Template\n")
  write(join(root, "scripts/task-doctor.mjs"), "")
  write(join(root, taskPath), taskContent)
  write(join(root, "src/a.ts"), "export const value = 1\n")
  write(join(root, ".task-doctor/state.json"), JSON.stringify({
    version: 4,
    status: "started",
    taskPath,
    taskHash,
    snapshot: { "src/a.ts": "before" },
  }))
  write(join(root, ".task-doctor/worker-help.json"), JSON.stringify({
    version: 1,
    requests: [{
      version: 1,
      id: "H1",
      status: "retry_approved",
      taskPath,
      taskHash,
      workerSessionID: "worker-terminal",
      category: "tool_failure",
      problem: "The prior Worker used stale replacement evidence.",
      attemptedActions: ["Read the current source and attempted one stale replacement."],
      evidence: ["Worker replace expected 1 occurrences but found 0: src/a.ts"],
      relevantFiles: [taskPath, "src/a.ts"],
      suggestedNextStep: "Delegate one fresh Worker with current file evidence.",
      createdAt: "2026-07-16T10:00:00.000Z",
      executorReview: {
        sessionID: "executor",
        decision: "retry_worker",
        rootCause: "The replacement evidence was stale.",
        retryStrategy: "Read current bytes and retry one exact change.",
        expectedResults: ["The current replacement previews and verifies."],
        reviewedFiles: [taskPath, "src/a.ts"],
        reviewedAt: "2026-07-16T10:01:00.000Z",
      },
    }],
    updatedAt: "2026-07-16T10:01:00.000Z",
  }))
  return { root, taskPath, taskHash }
}

function mutateHelpStore(root: string, update: (requests: any[]) => void) {
  const path = join(root, ".task-doctor/worker-help.json")
  const store = JSON.parse(readFileSync(path, "utf8"))
  update(store.requests)
  write(path, JSON.stringify(store))
}

function assistant(parts: any[]) {
  return {
    info: {
      id: "assistant-prose-only",
      role: "assistant",
      agent: "executor",
      finish: "stop",
      providerID: "llamacpp-local",
      modelID: "qwen3.5-9b-q4-reasoning",
      time: { completed: Date.now() },
    },
    parts,
  }
}

function workerAssistant(
  id: string,
  text: string,
  modelID = "qwen3.5-9b-q4",
  parentID?: string,
  completed = Date.now(),
) {
  return {
    info: {
      id,
      ...(parentID ? { parentID } : {}),
      role: "assistant",
      agent: "worker",
      finish: "stop",
      providerID: "llamacpp-local",
      modelID,
      time: { created: completed - 1, completed },
    },
    parts: [{ type: "text", text }],
  }
}

function workerUser(id: string, text: string) {
  return { info: { id, role: "user", time: { created: Date.now() } }, parts: [{ type: "text", text }] }
}

function blockedWorkerHandoff(taskPath: string, failure = "The remaining in-scope work needs another reviewed correction.") {
  return [
    "BLOCKED",
    `Task: ${taskPath}`,
    "Doctor status: started",
    `Failure: ${failure}`,
    "Required owner: Executor",
  ].join("\n")
}

function reviewableWorkerHandoff(taskPath: string) {
  return [
    "REVIEWABLE",
    `Task: ${taskPath}`,
    "Outcome: The task implementation is complete.",
    "Changed files:",
    "- src/a.ts",
    "Verification:",
    "- TASK DOCTOR: PASS",
    "Risks and assumptions:",
    "- None.",
  ].join("\n")
}

function taskResult(workerSessionID: string, text: string) {
  return `<task id="${workerSessionID}" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>`
}

function persistOrphanedDelegation(root: string, taskPath: string, delegatedAt: string) {
  mutateHelpStore(root, (requests) => {
    requests[0] = {
      ...requests[0],
      status: "delegated",
      delegatedAt,
      delegatedWorkerSessionID: undefined,
      delegationPriorStatus: "retry_approved",
      delegationParentSessionID: "executor",
      delegationDescription: `Resume ${taskPath}`,
      delegationCallID: "persisted-call-a",
      delegationSource: "direct",
    }
  })
}

test("restart restores an orphaned delegation when exact session discovery proves no child exists", async () => {
  const data = fixture()
  try {
    const delegatedAtMs = Date.now() - 1_000
    persistOrphanedDelegation(data.root, data.taskPath, new Date(delegatedAtMs).toISOString())
    const prompts: any[] = []
    const client = { session: {
      list: async () => ({ data: [
        {
          id: "old-matching-worker",
          parentID: "executor",
          directory: data.root,
          agent: "worker",
          title: `Resume ${data.taskPath} (@worker subagent)`,
          time: { created: delegatedAtMs - 1 },
        },
        {
          id: "unrelated-worker",
          parentID: "executor",
          directory: data.root,
          agent: "worker",
          title: "Resume kanban/todo/99-other.md (@worker subagent)",
          time: { created: delegatedAtMs + 1 },
        },
      ] }),
      messages: async () => ({ data: [assistant([{ type: "text", text: "Delegate the retry." }])] }),
      promptAsync: async (input: any) => prompts.push(input),
    } }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    let help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "retry_approved")
    assert.equal(help.delegatedAt, undefined)

    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "executor" } } } as any)
    assert.equal(prompts.length, 1)
    help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "delegated")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("restart binds one exact Worker child and permits only an explicit resume of that session", async () => {
  const data = fixture()
  try {
    const delegatedAtMs = Date.now() - 1_000
    persistOrphanedDelegation(data.root, data.taskPath, new Date(delegatedAtMs).toISOString())
    const child = {
      id: "recovered-worker-child",
      parentID: "executor",
      directory: data.root,
      agent: "worker",
      title: `Resume ${data.taskPath} (@worker subagent)`,
      time: { created: delegatedAtMs + 1 },
    }
    const logs: any[] = []
    const hooks = await WorkflowGuard({
      directory: data.root,
      worktree: data.root,
      client: {
        app: { log: async (input: any) => logs.push(input) },
        session: { list: async () => ({ data: [child] }) },
      },
    } as any)
    const help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "delegated")
    if (!help.delegatedWorkerSessionID) throw new Error(JSON.stringify({ logs, help, child }))
    assert.equal(help.delegatedWorkerSessionID, child.id, JSON.stringify(logs))
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)

    const fresh = { description: `Resume ${data.taskPath}`, prompt: `Resume ${data.taskPath}`, subagent_type: "worker" }
    await assert.rejects(
      hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "fresh-call" } as any, { args: fresh } as any),
      /already delegated to recovered-worker-child/,
    )
    const resumed = {
      description: `Resume ${data.taskPath}`,
      prompt: `Resume ${data.taskPath}`,
      subagent_type: "worker",
      task_id: child.id,
    }
    await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "resume-call" } as any, { args: resumed } as any)
    assert.equal(resumed.subagent_type, "worker")
    assert.equal(resumed.task_id, child.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("restart keeps an ambiguous orphaned delegation fail-closed instead of duplicating a Worker", async () => {
  const data = fixture()
  try {
    const delegatedAtMs = Date.now() - 1_000
    persistOrphanedDelegation(data.root, data.taskPath, new Date(delegatedAtMs).toISOString())
    const logs: any[] = []
    const sessions = ["worker-a", "worker-b"].map((id, index) => ({
      id,
      parentID: "executor",
      directory: data.root,
      agent: "worker",
      title: `Resume ${data.taskPath} (@worker subagent)`,
      time: { created: delegatedAtMs + index + 1 },
    }))
    const hooks = await WorkflowGuard({
      directory: data.root,
      worktree: data.root,
      client: {
        app: { log: async (input: any) => logs.push(input) },
        session: { list: async () => ({ data: sessions }) },
      },
    } as any)
    const help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "delegated")
    assert.equal(help.delegatedWorkerSessionID, undefined)
    assert.equal(logs.some((entry) => entry.body?.message === "Kept orphaned Worker help delegated because child-session matching was ambiguous"), true)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const args = { description: `Resume ${data.taskPath}`, prompt: `Resume ${data.taskPath}`, subagent_type: "worker" }
    await assert.rejects(
      hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "duplicate-call" } as any, { args } as any),
      /already has a Worker delegation in flight/,
    )
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("restart treats a matching partial child without an ID as ambiguous instead of restoring a duplicate retry", async () => {
  const data = fixture()
  try {
    const delegatedAtMs = Date.now() - 1_000
    persistOrphanedDelegation(data.root, data.taskPath, new Date(delegatedAtMs).toISOString())
    const logs: any[] = []
    const hooks = await WorkflowGuard({
      directory: data.root,
      worktree: data.root,
      client: {
        app: { log: async (input: any) => logs.push(input) },
        session: { list: async () => ({ data: [{
          parentID: "executor",
          directory: data.root,
          agent: "worker",
          title: `Resume ${data.taskPath} (@worker subagent)`,
          time: { created: delegatedAtMs + 1 },
        }] }) },
      },
    } as any)
    const help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "delegated")
    assert.equal(help.delegatedWorkerSessionID, undefined)
    assert.equal(logs.some((entry) => entry.body?.message === "Kept orphaned Worker help delegated because child-session matching was ambiguous"), true)

    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const args = { description: `Resume ${data.taskPath}`, prompt: `Resume ${data.taskPath}`, subagent_type: "worker" }
    await assert.rejects(
      hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "duplicate-call" } as any, { args } as any),
      /already has a Worker delegation in flight/,
    )
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("prose-only Executor delegation schedules exactly one fresh Worker subtask", async () => {
  const data = fixture()
  try {
    const prompts: any[] = []
    const messages = [
      { info: { id: "user", role: "user" }, parts: [{ type: "text", text: `Continue ${data.taskPath}.` }] },
      assistant([{ type: "text", text: `Next step: delegate one fresh Worker for ${data.taskPath}.` }]),
    ]
    const client = {
      session: {
        messages: async () => ({ data: messages }),
        promptAsync: async (input: any) => prompts.push(input),
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "executor" } } } as any)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].body.agent, "executor")
    assert.deepEqual(prompts[0].body.model, {
      providerID: "llamacpp-local",
      modelID: "qwen3.5-9b-q4-reasoning",
    })
    const subtask = prompts[0].body.parts[0]
    assert.equal(subtask.type, "subtask")
    assert.equal(subtask.agent, "worker")
    assert.equal(subtask.description, `Resume ${data.taskPath}`)
    assert.match(subtask.prompt, new RegExp(`ACTIVE TASK RESUME[\\s\\S]*Task: ${data.taskPath.replaceAll("/", "\\/")}`))
    assert.match(subtask.prompt, /REVIEWED WORKER HELP H1/)
    assert.equal(subtask.model, undefined)
    assert.equal(subtask.command, undefined)
    assert.equal(subtask.session_id, undefined)
    assert.equal(subtask.task_id, undefined)

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "executor" } } } as any)
    assert.equal(prompts.length, 1)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Worker recovery boost resolves aliases and explicit refs while invalid config falls back to Worker", async () => {
  const base = { providerID: "llamacpp-local", modelID: "qwen3.5-9b-q4" }
  const executor = { providerID: "llamacpp-local", modelID: "qwen3.5-9b-q4-reasoning" }
  const planner = { providerID: "planner-provider", modelID: "planner-model" }
  const cases: Array<{
    name: string
    config?: Record<string, unknown>
    expected: { providerID: string; modelID: string }
    invalid?: boolean
    aliasAvailable?: boolean
  }> = [
    { name: "absent", expected: base },
    { name: "disabled", config: { enabled: false, model: "executor" }, expected: base },
    { name: "enabled default", config: { enabled: true }, expected: executor },
    { name: "executor alias", config: { enabled: true, model: "executor" }, expected: executor },
    { name: "planner alias", config: { enabled: true, model: "planner" }, expected: planner },
    { name: "explicit string", config: { enabled: true, model: "boost-provider/boost-model" }, expected: { providerID: "boost-provider", modelID: "boost-model" } },
    { name: "explicit object", config: { enabled: true, model: { providerID: "object-provider", modelID: "object-model" } }, expected: { providerID: "object-provider", modelID: "object-model" } },
    { name: "invalid", config: { enabled: true, model: "unqualified-model" }, expected: base, invalid: true },
    { name: "alias unavailable", config: { enabled: true, model: "executor" }, expected: base, invalid: true, aliasAvailable: false },
  ]

  for (const entry of cases) {
    const data = fixture()
    try {
      updateOpenCodeSettings(data.root, (settings) => {
        settings.agentModels.planner = `${planner.providerID}/${planner.modelID}`
        if (entry.config) settings.workerRecoveryBoost = entry.config
        else delete settings.workerRecoveryBoost
      })
      if (entry.aliasAvailable === false) setWorkerRecoveryBoostAgentAvailable(data.root, false)
      const logs: any[] = []
      const hooks = await WorkflowGuard({
        directory: data.root,
        worktree: data.root,
        client: { app: { log: async (input: any) => logs.push(input) } },
      } as any)
      await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
      const args: any = {
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
      }
      await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task" } as any, { args } as any)
      assert.equal(args.model, undefined, `${entry.name}: TaskTool has no model argument`)
      const boosted = Boolean(entry.config?.enabled) && !entry.invalid
      assert.equal(args.subagent_type,
        boosted ? "worker-recovery-boost" : "worker",
        entry.name,
      )
      const decision = logs.find((value) => value.body?.message === "Selected Worker delegation model")
      assert.ok(decision, `${entry.name}: decision log missing`)
      assert.equal(decision.body.level, entry.invalid ? "warn" : "info", entry.name)
      assert.equal(decision.body.extra.path, "task-tool", entry.name)
      assert.equal(decision.body.extra.boosted, boosted, entry.name)
      assert.equal(decision.body.extra.model, `${entry.expected.providerID}/${entry.expected.modelID}`, entry.name)
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  }
})

test("enabled Worker recovery boost keeps ordinary work on Base and turns stale selectors into fresh reviewed retries", async () => {
  const cases = [
    { name: "normal delegation", freshRetry: false, resume: {} },
    { name: "stale legacy session_id", freshRetry: true, resume: { session_id: "terminal-worker-session" } },
    { name: "stale native task_id", freshRetry: true, resume: { task_id: "terminal-worker-session" } },
  ]

  for (const entry of cases) {
    const data = fixture()
    try {
      updateOpenCodeSettings(data.root, (settings) => {
        settings.workerRecoveryBoost = { enabled: true, model: "executor" }
      })
      if (!entry.freshRetry) {
        mutateHelpStore(data.root, (requests) => { requests[0].status = "resolved" })
      }
      const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
      await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
      const args: any = {
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
        ...entry.resume,
      }
      await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task" } as any, { args } as any)
      assert.equal(args.subagent_type, entry.freshRetry ? WORKER_RECOVERY_BOOST_AGENT : "worker", entry.name)
      assert.equal(args.model, undefined, entry.name)
      if (entry.freshRetry) {
        assert.equal(args.session_id, undefined, entry.name)
        assert.equal(args.task_id, undefined, entry.name)
      }
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  }
})

test("a fresh reviewed retry drops a stale ancestor session selector and binds only a new Worker", async () => {
  const data = fixture()
  try {
    updateOpenCodeSettings(data.root, (settings) => {
      settings.workerRecoveryBoost = { enabled: true, model: "executor" }
    })
    mutateHelpStore(data.root, (requests) => {
      const parent = requests[0]
      requests[0] = {
        ...parent,
        status: "delegated",
        delegatedAt: "2026-07-16T10:02:00.000Z",
        delegatedWorkerSessionID: "worker-stale-ancestor",
      }
      requests.push({
        ...structuredClone(parent),
        id: "H2",
        status: "retry_approved",
        workerSessionID: "worker-current-terminal",
        retryOfHelpID: "H1",
        createdAt: "2026-07-16T10:03:00.000Z",
      })
    })

    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const args: any = {
      description: `Resume ${data.taskPath}`,
      prompt: `Resume ${data.taskPath}`,
      subagent_type: "worker",
      task_id: "worker-stale-ancestor",
    }
    await hooks["tool.execute.before"]!({
      sessionID: "executor",
      tool: "task",
      callID: "fresh-followup-call",
    } as any, { args } as any)

    assert.equal(args.task_id, undefined)
    assert.equal(args.subagent_type, WORKER_RECOVERY_BOOST_AGENT)
    let requests = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests
    const parent = requests.find((request: any) => request.id === "H1")
    let followup = requests.find((request: any) => request.id === "H2")
    assert.equal(parent.delegatedWorkerSessionID, "worker-stale-ancestor")
    assert.equal(followup.status, "delegated")
    assert.equal(followup.delegatedWorkerSessionID, undefined)

    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: {
        id: "worker-fresh-followup",
        parentID: "executor",
        agent: WORKER_RECOVERY_BOOST_AGENT,
        model: { providerID: "llamacpp-local", modelID: "qwen3.5-9b-q4-reasoning" },
      } },
    } } as any)
    requests = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests
    followup = requests.find((request: any) => request.id === "H2")
    assert.equal(followup.delegatedWorkerSessionID, "worker-fresh-followup")
    assert.equal(requests.find((request: any) => request.id === "H1").delegatedWorkerSessionID, "worker-stale-ancestor")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("aborting a bound boosted Worker fully restores the reviewed retry and the next disabled retry is base Worker", async () => {
  const data = fixture()
  try {
    updateOpenCodeSettings(data.root, (settings) => {
      settings.workerRecoveryBoost = { enabled: true, model: "executor" }
    })
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const boostedArgs: any = {
      description: `Resume ${data.taskPath}`,
      prompt: `Resume ${data.taskPath}`,
      subagent_type: "worker",
    }
    await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "boosted-call" } as any, { args: boostedArgs } as any)
    assert.equal(boostedArgs.subagent_type, WORKER_RECOVERY_BOOST_AGENT)
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: {
        id: "worker-boosted-aborted",
        parentID: "executor",
        agent: WORKER_RECOVERY_BOOST_AGENT,
        model: { providerID: "llamacpp-local", modelID: "qwen3.5-9b-q4-reasoning" },
      } },
    } } as any)

    let help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "delegated")
    assert.equal(help.delegatedWorkerSessionID, "worker-boosted-aborted")
    assert.equal(help.recoveryBoost?.phase, "active")

    await hooks.event!({ event: {
      type: "session.error",
      properties: {
        sessionID: "worker-boosted-aborted",
        error: { name: "MessageAbortedError" },
      },
    } } as any)
    help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "retry_approved")
    for (const field of [
      "delegatedAt",
      "delegatedWorkerSessionID",
      "delegationPriorStatus",
      "delegationParentSessionID",
      "delegationDescription",
      "delegationCallID",
      "delegationSource",
      "delegationAttemptNonce",
      "recoveryBoost",
    ]) assert.equal(help[field], undefined, field)

    updateOpenCodeSettings(data.root, (settings) => {
      settings.workerRecoveryBoost = { enabled: false, model: "executor" }
    })
    const restarted = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await restarted["chat.message"]!({ sessionID: "executor-2", agent: "executor" } as any, {} as any)
    const baseArgs: any = {
      description: `Resume ${data.taskPath}`,
      prompt: `Resume ${data.taskPath}`,
      subagent_type: WORKER_RECOVERY_BOOST_AGENT,
    }
    await restarted["tool.execute.before"]!({ sessionID: "executor-2", tool: "task", callID: "base-call" } as any, { args: baseArgs } as any)
    assert.equal(baseArgs.subagent_type, "worker")
    assert.equal(baseArgs.model, undefined)
    help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "delegated")
    assert.equal(help.recoveryBoost, undefined)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("an active boosted session resumes through the hidden alias while a cleared resume is Base and call-bound exactly once", async (t) => {
  await t.test("active resume keeps the exact alias, blocks a parallel call, and releases on task error", async () => {
    const data = fixture()
    try {
      updateOpenCodeSettings(data.root, (settings) => {
        settings.workerRecoveryBoost = { enabled: true, model: "executor" }
      })
      mutateHelpStore(data.root, (requests) => {
        requests[0] = {
          ...requests[0],
          status: "delegated",
          delegatedAt: new Date().toISOString(),
          delegatedWorkerSessionID: "worker-boost-active",
          delegationPriorStatus: "retry_approved",
          recoveryBoost: {
            phase: "active",
            hurdleTarget: "src/a.ts",
            hurdleFingerprint: "help|active",
            activatedAt: new Date().toISOString(),
          },
        }
      })
      const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
      await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
      const args: any = {
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
        task_id: "worker-boost-active",
      }
      await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "active-call" } as any, { args } as any)
      assert.equal(args.task_id, "worker-boost-active")
      assert.equal(args.subagent_type, WORKER_RECOVERY_BOOST_AGENT)
      assert.equal(args.model, undefined)
      assert.match(args.prompt, /REVIEWED WORKER HELP H1/)
      const help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(help.recoveryBoost.phase, "active")

      await assert.rejects(
        hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "active-call-b" } as any, {
          args: { ...args },
        } as any),
        /already in flight/,
      )
      await hooks.event!({ event: {
        type: "message.part.updated",
        properties: {
          sessionID: "executor",
          part: { type: "tool", tool: "task", callID: "active-call", state: { status: "error" } },
        },
      } } as any)
      const retry = { ...args }
      await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "active-call-c" } as any, { args: retry } as any)
      assert.equal(retry.subagent_type, WORKER_RECOVERY_BOOST_AGENT)
      assert.equal(retry.task_id, "worker-boost-active")
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  })

  await t.test("cleared resume binds one Base call and blocks a parallel call", async () => {
    const data = fixture()
    try {
      updateOpenCodeSettings(data.root, (settings) => {
        settings.workerRecoveryBoost = { enabled: true, model: "executor" }
      })
      mutateHelpStore(data.root, (requests) => {
        requests[0] = {
          ...requests[0],
          status: "delegated",
          delegatedAt: new Date().toISOString(),
          delegatedWorkerSessionID: "worker-boost-cleared",
          delegationPriorStatus: "retry_approved",
          recoveryBoost: {
            phase: "cleared",
            hurdleTarget: "src/a.ts",
            hurdleFingerprint: "help|cleared",
            activatedAt: new Date().toISOString(),
            clearedAt: new Date().toISOString(),
          },
        }
      })
      const baseText = blockedWorkerHandoff(data.taskPath)
      const client = { session: {
        messages: async (input: any) => ({ data: input?.path?.id === "executor"
          ? [assistant([{ type: "text", text: "Resume the cleared Worker." }])]
          : [workerAssistant("base-a", baseText)] }),
      } }
      const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
      await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
      const args: any = {
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: WORKER_RECOVERY_BOOST_AGENT,
        task_id: "worker-boost-cleared",
      }
      await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "base-call-a" } as any, { args } as any)
      assert.equal(args.task_id, "worker-boost-cleared")
      assert.equal(args.subagent_type, "worker")
      let help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(help.recoveryBoost.phase, "base_continuation_started")
      assert.equal(help.recoveryBoost.baseContinuationCallID, "base-call-a")
      assert.equal(help.recoveryBoost.baseContinuationModel, "llamacpp-local/qwen3.5-9b-q4")

      const parallel = { ...args }
      await assert.rejects(
        hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "base-call-b" } as any, { args: parallel } as any),
        /already in flight/,
      )

      const output: any = {
        title: "Worker result",
        output: taskResult("worker-boost-cleared", baseText),
        metadata: { sessionId: "worker-boost-cleared" },
      }
      await hooks["tool.execute.after"]!({ sessionID: "executor", tool: "task", callID: "base-call-a", args } as any, output)
      help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(help.recoveryBoost.phase, "base_continuation_completed")
      assert.equal(typeof help.recoveryBoost.baseContinuationDeliveredAt, "string")
      assert.equal(output.metadata.workerBaseContinuation, true)
      assert.match(output.output, /The remaining in-scope work needs another reviewed correction/)

      const laterResume = { ...args, prompt: `Resume ${data.taskPath}` }
      await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "later-base-call" } as any, { args: laterResume } as any)
      assert.equal(laterResume.subagent_type, "worker")
      assert.equal(laterResume.task_id, "worker-boost-cleared")
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  })

  await t.test("a PASS-cleared boost without a Base turn never blocks a later legitimate Base resume", async () => {
    const data = fixture()
    try {
      updateOpenCodeSettings(data.root, (settings) => {
        settings.workerRecoveryBoost = { enabled: true, model: "executor" }
      })
      mutateHelpStore(data.root, (requests) => {
        requests[0] = {
          ...requests[0],
          status: "delegated",
          delegatedAt: new Date().toISOString(),
          delegatedWorkerSessionID: "worker-pass-cleared",
          recoveryBoost: {
            phase: "base_continuation_completed",
            activatedAt: new Date().toISOString(),
            clearedAt: new Date().toISOString(),
            baseContinuationCompletedAt: new Date().toISOString(),
          },
        }
      })
      const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
      await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
      const args: any = {
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: WORKER_RECOVERY_BOOST_AGENT,
        task_id: "worker-pass-cleared",
      }
      await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "post-review-base" } as any, { args } as any)
      assert.equal(args.subagent_type, "worker")
      assert.equal(args.task_id, "worker-pass-cleared")
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  })
})

test("a cleared boost auto-continues exactly once in the same session with a causally marked Base turn", async () => {
  const data = fixture()
  try {
    updateOpenCodeSettings(data.root, (settings) => {
      settings.workerRecoveryBoost = { enabled: true, model: "executor" }
    })
    mutateHelpStore(data.root, (requests) => {
      requests[0] = {
        ...requests[0],
        status: "delegated",
        delegatedAt: new Date().toISOString(),
        delegatedWorkerSessionID: "worker-auto-base",
        delegationPriorStatus: "retry_approved",
        recoveryBoost: {
          phase: "cleared",
          hurdleTarget: "src/a.ts",
          hurdleFingerprint: "help|cleared",
          activatedAt: new Date().toISOString(),
          clearedAt: new Date().toISOString(),
        },
      }
    })
    const boostText = blockedWorkerHandoff(data.taskPath, "Boost turn stopped after clearing the reviewed hurdle.")
    const baseText = blockedWorkerHandoff(data.taskPath, "Base turn continued the remaining task exactly once.")
    let transcript: any[] = [workerAssistant("boost-result", boostText, "qwen3.5-9b-q4-reasoning")]
    const prompts: any[] = []
    const client = { session: {
      messages: async () => ({ data: transcript }),
      prompt: async (input: any) => {
        prompts.push(input)
        const promptText = input.body.parts[0].text
        transcript = [
          ...transcript,
          workerUser(input.body.messageID, promptText),
          workerAssistant("base-result", baseText, "qwen3.5-9b-q4", input.body.messageID, Date.now() + 10),
        ]
        return { data: {} }
      },
    } }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    const args = {
      description: `Resume ${data.taskPath}`,
      prompt: `ACTIVE TASK RESUME\nTask: ${data.taskPath}`,
      subagent_type: WORKER_RECOVERY_BOOST_AGENT,
    }
    const output: any = {
      title: "Worker result",
      output: taskResult("worker-auto-base", boostText),
      metadata: { sessionId: "worker-auto-base" },
    }
    await hooks["tool.execute.after"]!({ sessionID: "executor", tool: "task", callID: "boost-return", args } as any, output)

    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].path.id, "worker-auto-base")
    assert.equal(prompts[0].body.agent, "worker")
    assert.match(prompts[0].body.messageID, /^msg_[a-f0-9]{26}$/)
    assert.deepEqual(prompts[0].body.model, { providerID: "llamacpp-local", modelID: "qwen3.5-9b-q4" })
    assert.match(prompts[0].body.parts[0].text, /harness-base-continuation:[a-f0-9]{32}/)
    assert.match(output.output, /Base turn continued the remaining task exactly once/)
    assert.doesNotMatch(output.output, /Boost turn stopped/)
    const help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.recoveryBoost.phase, "base_continuation_completed")
    assert.match(help.recoveryBoost.baseContinuationNonce, /^[a-f0-9]{32}$/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("an internally persisted idle Base marker without an Assistant is reopened before returning", async () => {
  const data = fixture()
  try {
    updateOpenCodeSettings(data.root, (settings) => {
      settings.workerRecoveryBoost = { enabled: true, model: "executor" }
    })
    mutateHelpStore(data.root, (requests) => {
      requests[0] = {
        ...requests[0],
        status: "delegated",
        delegatedAt: new Date().toISOString(),
        delegatedWorkerSessionID: "worker-idle-internal-base",
        delegationPriorStatus: "retry_approved",
        recoveryBoost: {
          phase: "cleared",
          hurdleTarget: "src/a.ts",
          hurdleFingerprint: "help|cleared",
          activatedAt: new Date().toISOString(),
          clearedAt: new Date().toISOString(),
        },
      }
    })
    const boostText = blockedWorkerHandoff(data.taskPath, "Boost turn stopped after clearing the reviewed hurdle.")
    let transcript: any[] = [workerAssistant("boost-idle-result", boostText, "qwen3.5-9b-q4-reasoning")]
    const client = { session: {
      messages: async () => ({ data: transcript }),
      prompt: async (input: any) => {
        transcript = [
          ...transcript,
          workerUser(input.body.messageID, input.body.parts[0].text),
        ]
        return { data: {} }
      },
      status: async () => ({ data: { "worker-idle-internal-base": { type: "idle" } } }),
    } }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    const args = {
      description: `Resume ${data.taskPath}`,
      prompt: `ACTIVE TASK RESUME\nTask: ${data.taskPath}`,
      subagent_type: WORKER_RECOVERY_BOOST_AGENT,
    }
    const output: any = {
      title: "Worker result",
      output: taskResult("worker-idle-internal-base", boostText),
      metadata: { sessionId: "worker-idle-internal-base" },
    }
    await assert.rejects(
      hooks["tool.execute.after"]!({ sessionID: "executor", tool: "task", callID: "idle-internal-return", args } as any, output),
      /WORKER BASE CONTINUATION RETRY REQUIRED[\s\S]*task_id=worker-idle-internal-base/,
    )
    const help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.recoveryBoost.phase, "cleared")
    assert.equal(help.recoveryBoost.baseContinuationMessageID, undefined)
    assert.equal(help.recoveryBoost.baseContinuationNonce, undefined)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("restart rehydrates only a causally linked Base transcript, including after Doctor PASS", async (t) => {
  await t.test("completed marked Base assistant rehydrates without another prompt", async () => {
    const data = fixture()
    try {
      const statePath = join(data.root, ".task-doctor/state.json")
      const state = JSON.parse(readFileSync(statePath, "utf8"))
      state.status = "passed"
      write(statePath, JSON.stringify(state))
      const nonce = "a".repeat(32)
      mutateHelpStore(data.root, (requests) => {
        requests[0] = {
          ...requests[0],
          status: "delegated",
          delegatedAt: new Date().toISOString(),
          delegatedWorkerSessionID: "worker-restart-base",
          delegationPriorStatus: "retry_approved",
          recoveryBoost: {
            phase: "base_continuation_started",
            hurdleTarget: "src/a.ts",
            hurdleFingerprint: "help|cleared",
            activatedAt: new Date().toISOString(),
            clearedAt: new Date().toISOString(),
            baseContinuationStartedAt: new Date().toISOString(),
            baseContinuationModel: "llamacpp-local/qwen3.5-9b-q4",
            baseContinuationNonce: nonce,
          },
        }
      })
      const baseText = reviewableWorkerHandoff(data.taskPath)
      const transcript = [
        workerUser("marked-user", `Continue.\n<!-- harness-base-continuation:${nonce} -->`),
        workerAssistant("marked-base", baseText, "qwen3.5-9b-q4", "marked-user", Date.now() + 10),
        workerAssistant("unrelated-later", "Unrelated later assistant.", "qwen3.5-9b-q4", "another-user", Date.now() + 20),
      ]
      const prompts: any[] = []
      const client = { session: {
        messages: async () => ({ data: transcript }),
        prompt: async (input: any) => prompts.push(input),
      } }
      const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
      let help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(help.recoveryBoost.phase, "base_continuation_completed")
      const args = {
        description: `Resume ${data.taskPath}`,
        prompt: `ACTIVE TASK RESUME\nTask: ${data.taskPath}`,
        subagent_type: WORKER_RECOVERY_BOOST_AGENT,
      }
      const output: any = {
        title: "Worker result",
        output: taskResult("worker-restart-base", "Old boosted result"),
        metadata: { sessionId: "worker-restart-base" },
      }
      await hooks["tool.execute.after"]!({ sessionID: "executor", tool: "task", callID: "old-boost-return", args } as any, output)
      assert.equal(prompts.length, 0)
      assert.match(output.output, /The task implementation is complete/)
      assert.doesNotMatch(output.output, /Unrelated later assistant/)
      assert.equal(output.metadata.workerBaseContinuationRehydrated, true)
      help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(help.recoveryBoost.phase, "base_continuation_completed")
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  })

  await t.test("a marked but unfinished Base turn stays fail-closed and is never prompted twice", async () => {
    const data = fixture()
    try {
      const nonce = "b".repeat(32)
      mutateHelpStore(data.root, (requests) => {
        requests[0] = {
          ...requests[0],
          status: "delegated",
          delegatedAt: new Date().toISOString(),
          delegatedWorkerSessionID: "worker-pending-base",
          delegationPriorStatus: "retry_approved",
          recoveryBoost: {
            phase: "base_continuation_started",
            activatedAt: new Date().toISOString(),
            baseContinuationStartedAt: new Date().toISOString(),
            baseContinuationModel: "llamacpp-local/qwen3.5-9b-q4",
            baseContinuationNonce: nonce,
          },
        }
      })
      const transcript = [workerUser("pending-user", `Continue.\n<!-- harness-base-continuation:${nonce} -->`)]
      const prompts: any[] = []
      const client = { session: {
        messages: async () => ({ data: transcript }),
        status: async () => ({ data: { "worker-pending-base": { type: "busy" } } }),
        prompt: async (input: any) => prompts.push(input),
      } }
      const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
      const args = {
        description: `Resume ${data.taskPath}`,
        prompt: `ACTIVE TASK RESUME\nTask: ${data.taskPath}`,
        subagent_type: WORKER_RECOVERY_BOOST_AGENT,
      }
      const output: any = {
        title: "Worker result",
        output: taskResult("worker-pending-base", "Old boosted result"),
        metadata: { sessionId: "worker-pending-base" },
      }
      await assert.rejects(
        hooks["tool.execute.after"]!({ sessionID: "executor", tool: "task", callID: "old-boost-return", args } as any, output),
        /causally marked user turn is still pending/,
      )
      assert.equal(prompts.length, 0)
      const help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(help.recoveryBoost.phase, "base_continuation_started")
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  })

  await t.test("an exact idle marked Base turn without an Assistant reopens one same-session retry", async () => {
    const data = fixture()
    try {
      const oldNonce = "9".repeat(32)
      const oldMessageID = `msg_${"9".repeat(26)}`
      mutateHelpStore(data.root, (requests) => {
        requests[0] = {
          ...requests[0],
          status: "delegated",
          delegatedAt: new Date().toISOString(),
          delegatedWorkerSessionID: "worker-idle-pending-base",
          delegationPriorStatus: "retry_approved",
          recoveryBoost: {
            phase: "base_continuation_started",
            activatedAt: new Date().toISOString(),
            clearedAt: new Date().toISOString(),
            baseContinuationStartedAt: new Date().toISOString(),
            baseContinuationModel: "llamacpp-local/qwen3.5-9b-q4",
            baseContinuationNonce: oldNonce,
            baseContinuationMessageID: oldMessageID,
          },
        }
      })
      const childTranscript = [
        workerUser(oldMessageID, `Continue.\n<!-- harness-base-continuation:${oldNonce} -->`),
      ]
      const client = { session: {
        messages: async (input: any) => ({ data: input?.path?.id === "executor"
          ? [assistant([{ type: "text", text: "Resume the mechanically reopened Base continuation." }])]
          : childTranscript }),
        status: async () => ({ data: { "worker-idle-pending-base": { type: "idle" } } }),
      } }
      const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
      let help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(help.recoveryBoost.phase, "cleared")
      assert.equal(help.recoveryBoost.baseContinuationMessageID, undefined)
      assert.equal(help.recoveryBoost.baseContinuationNonce, undefined)

      await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
      const args: any = {
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
        task_id: "worker-idle-pending-base",
      }
      await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "replacement-idle-base" } as any, { args } as any)
      assert.equal(args.subagent_type, "worker")
      assert.equal(args.task_id, "worker-idle-pending-base")
      assert.match(args.prompt, /harness-base-continuation:[a-f0-9]{32}/)
      help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(help.recoveryBoost.phase, "base_continuation_started")
      assert.equal(help.recoveryBoost.baseContinuationCallID, "replacement-idle-base")
      assert.notEqual(help.recoveryBoost.baseContinuationNonce, oldNonce)
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  })

  await t.test("an undelivered completed result is emitted once before later normal Base resumes", async () => {
    const data = fixture()
    try {
      const statePath = join(data.root, ".task-doctor/state.json")
      const state = JSON.parse(readFileSync(statePath, "utf8"))
      state.status = "passed"
      write(statePath, JSON.stringify(state))
      const nonce = "c".repeat(32)
      mutateHelpStore(data.root, (requests) => {
        requests[0] = {
          ...requests[0],
          status: "delegated",
          delegatedAt: new Date().toISOString(),
          delegatedWorkerSessionID: "worker-undelivered-base",
          delegationPriorStatus: "retry_approved",
          recoveryBoost: {
            phase: "base_continuation_started",
            activatedAt: new Date().toISOString(),
            clearedAt: new Date().toISOString(),
            baseContinuationStartedAt: new Date().toISOString(),
            baseContinuationModel: "llamacpp-local/qwen3.5-9b-q4",
            baseContinuationNonce: nonce,
          },
        }
      })
      const resultText = reviewableWorkerHandoff(data.taskPath)
      const childTranscript = [
        workerUser("recovered-user", `Continue.\n<!-- harness-base-continuation:${nonce} -->`),
        workerAssistant("recovered-assistant", resultText, "qwen3.5-9b-q4", "recovered-user", Date.now() + 10),
      ]
      const client = { session: {
        messages: async (input: any) => ({ data: input?.path?.id === "executor"
          ? [assistant([{ type: "text", text: "Review the recovered Worker." }])]
          : childTranscript }),
      } }
      const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
      await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
      const resume = () => ({
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
        task_id: "worker-undelivered-base",
      })
      await assert.rejects(
        hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "consume-result" } as any, { args: resume() } as any),
        /WORKER BASE CONTINUATION RECOVERED[\s\S]*The task implementation is complete/,
      )
      let help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(typeof help.recoveryBoost.baseContinuationDeliveredAt, "string")

      state.status = "started"
      write(statePath, JSON.stringify(state))
      const later = resume()
      await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "later-normal-base" } as any, { args: later } as any)
      assert.equal(later.subagent_type, "worker")
      assert.equal(later.task_id, "worker-undelivered-base")
      help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(typeof help.recoveryBoost.baseContinuationDeliveredAt, "string")
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  })

  await t.test("an internal unsent Base message is restored only after exact 404, complete transcript, and idle proof", async () => {
    const data = fixture()
    try {
      const oldNonce = "f".repeat(32)
      const oldMessageID = `msg_${"f".repeat(26)}`
      mutateHelpStore(data.root, (requests) => {
        requests[0] = {
          ...requests[0],
          status: "delegated",
          delegatedAt: new Date().toISOString(),
          delegatedWorkerSessionID: "worker-internal-unsent",
          delegationPriorStatus: "retry_approved",
          recoveryBoost: {
            phase: "base_continuation_started",
            activatedAt: new Date().toISOString(),
            clearedAt: new Date().toISOString(),
            baseContinuationStartedAt: new Date().toISOString(),
            baseContinuationModel: "llamacpp-local/qwen3.5-9b-q4",
            baseContinuationNonce: oldNonce,
            baseContinuationMessageID: oldMessageID,
          },
        }
      })
      const client = { session: {
        messages: async (input: any) => ({ data: input?.path?.id === "executor"
          ? [assistant([{ type: "text", text: "Resume the proven-unsent Base continuation." }])]
          : [workerAssistant("boost-only", blockedWorkerHandoff(data.taskPath), "qwen3.5-9b-q4-reasoning")] }),
        message: async (input: any) => {
          assert.equal(input.path.id, "worker-internal-unsent")
          assert.equal(input.path.messageID, oldMessageID)
          return { error: { name: "NotFoundError", data: {} }, response: { status: 404 } }
        },
        status: async () => ({ data: { "worker-internal-unsent": { type: "idle" } } }),
      } }
      const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
      let help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(help.recoveryBoost.phase, "cleared")
      assert.equal(help.recoveryBoost.baseContinuationMessageID, undefined)
      assert.equal(help.recoveryBoost.baseContinuationNonce, undefined)

      await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
      const args: any = {
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
        task_id: "worker-internal-unsent",
      }
      await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "replacement-after-internal-crash" } as any, { args } as any)
      assert.equal(args.subagent_type, "worker")
      assert.match(args.prompt, /harness-base-continuation:[a-f0-9]{32}/)
      help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(help.recoveryBoost.phase, "base_continuation_started")
      assert.equal(help.recoveryBoost.baseContinuationCallID, "replacement-after-internal-crash")
      assert.notEqual(help.recoveryBoost.baseContinuationNonce, oldNonce)
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  })

  await t.test("an idle marker-free external Before crash restores cleared and starts one new call", async () => {
    const data = fixture()
    try {
      const oldNonce = "d".repeat(32)
      mutateHelpStore(data.root, (requests) => {
        requests[0] = {
          ...requests[0],
          status: "delegated",
          delegatedAt: new Date().toISOString(),
          delegatedWorkerSessionID: "worker-external-before-crash",
          delegationPriorStatus: "retry_approved",
          recoveryBoost: {
            phase: "base_continuation_started",
            activatedAt: new Date().toISOString(),
            clearedAt: new Date().toISOString(),
            baseContinuationStartedAt: new Date().toISOString(),
            baseContinuationModel: "llamacpp-local/qwen3.5-9b-q4",
            baseContinuationCallID: "lost-before-call",
            baseContinuationNonce: oldNonce,
          },
        }
      })
      const client = { session: {
        messages: async (input: any) => ({ data: input?.path?.id === "executor"
          ? [assistant([{ type: "text", text: "Resume the safely restored Base call." }])]
          : [workerAssistant("boost-only", blockedWorkerHandoff(data.taskPath), "qwen3.5-9b-q4-reasoning")] }),
        status: async () => ({ data: { "worker-external-before-crash": { type: "idle" } } }),
      } }
      const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
      let help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(help.recoveryBoost.phase, "cleared")
      assert.equal(help.recoveryBoost.baseContinuationCallID, undefined)
      await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
      const args: any = {
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
        task_id: "worker-external-before-crash",
      }
      await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "replacement-base-call" } as any, { args } as any)
      assert.equal(args.subagent_type, "worker")
      assert.match(args.prompt, /harness-base-continuation:[a-f0-9]{32}/)
      help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(help.recoveryBoost.phase, "base_continuation_started")
      assert.equal(help.recoveryBoost.baseContinuationCallID, "replacement-base-call")
      assert.notEqual(help.recoveryBoost.baseContinuationNonce, oldNonce)
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  })

  await t.test("an exact-limit marker-free transcript stays fail-closed because v1 cannot prove it is complete", async () => {
    const data = fixture()
    try {
      const oldNonce = "e".repeat(32)
      mutateHelpStore(data.root, (requests) => {
        requests[0] = {
          ...requests[0],
          status: "delegated",
          delegatedAt: new Date().toISOString(),
          delegatedWorkerSessionID: "worker-truncated-before-crash",
          delegationPriorStatus: "retry_approved",
          recoveryBoost: {
            phase: "base_continuation_started",
            activatedAt: new Date().toISOString(),
            clearedAt: new Date().toISOString(),
            baseContinuationStartedAt: new Date().toISOString(),
            baseContinuationModel: "llamacpp-local/qwen3.5-9b-q4",
            baseContinuationCallID: "lost-before-call",
            baseContinuationNonce: oldNonce,
          },
        }
      })
      const exactLimitTranscript = Array.from({ length: 200 }, (_, index) => (
        workerAssistant(
          `old-assistant-${index}`,
          blockedWorkerHandoff(data.taskPath),
          "qwen3.5-9b-q4-reasoning",
        )
      ))
      const client = { session: {
        messages: async (input: any) => ({ data: input?.path?.id === "executor"
          ? [assistant([{ type: "text", text: "Do not duplicate an inconclusive Base call." }])]
          : exactLimitTranscript }),
        status: async () => ({ data: { "worker-truncated-before-crash": { type: "idle" } } }),
      } }
      const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
      let help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(help.recoveryBoost.phase, "base_continuation_started")
      await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
      const args: any = {
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
        task_id: "worker-truncated-before-crash",
      }
      await assert.rejects(
        hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "unsafe-replacement" } as any, { args } as any),
        /already in flight/,
      )
      help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
      assert.equal(help.recoveryBoost.phase, "base_continuation_started")
      assert.equal(help.recoveryBoost.baseContinuationCallID, "lost-before-call")
      assert.equal(help.recoveryBoost.baseContinuationNonce, oldNonce)
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  })
})

test("a stale-hash cleared boost is ignored and cannot trigger a Base continuation", async () => {
  const data = fixture()
  try {
    mutateHelpStore(data.root, (requests) => {
      requests[0] = {
        ...requests[0],
        taskHash: "f".repeat(64),
        status: "delegated",
        delegatedAt: new Date().toISOString(),
        delegatedWorkerSessionID: "worker-stale-boost",
        recoveryBoost: {
          phase: "cleared",
          activatedAt: new Date().toISOString(),
          clearedAt: new Date().toISOString(),
        },
      }
    })
    const text = blockedWorkerHandoff(data.taskPath)
    const prompts: any[] = []
    const client = { session: {
      messages: async () => ({ data: [workerAssistant("stale-result", text)] }),
      prompt: async (input: any) => prompts.push(input),
    } }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    const args = {
      description: `Resume ${data.taskPath}`,
      prompt: `ACTIVE TASK RESUME\nTask: ${data.taskPath}`,
      subagent_type: WORKER_RECOVERY_BOOST_AGENT,
    }
    const output: any = {
      title: "Worker result",
      output: taskResult("worker-stale-boost", text),
      metadata: { sessionId: "worker-stale-boost" },
    }
    await hooks["tool.execute.after"]!({ sessionID: "executor", tool: "task", callID: "stale-return", args } as any, output)
    assert.equal(prompts.length, 0)
    assert.equal(output.metadata.workerBaseContinuation, undefined)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("a second fresh TaskTool retry is blocked while the first Worker delegation is still in flight", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const delegation = () => ({
      description: `Resume ${data.taskPath}`,
      prompt: `Resume ${data.taskPath}`,
      subagent_type: "worker",
    })

    await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "call-a" } as any, { args: delegation() } as any)
    let help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "delegated")
    assert.equal(help.delegatedWorkerSessionID, undefined)

    await assert.rejects(
      hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "call-b" } as any, { args: delegation() } as any),
      /already has a Worker delegation in flight/,
    )
    help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "delegated")
    assert.equal(help.delegatedWorkerSessionID, undefined)

    await hooks.event!({ event: {
      type: "message.part.updated",
      properties: {
        sessionID: "executor",
        part: { type: "tool", tool: "task", callID: "call-b", state: { status: "error" } },
      },
    } } as any)
    help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "delegated")

    await hooks.event!({ event: {
      type: "message.part.updated",
      properties: {
        sessionID: "executor",
        part: { type: "tool", tool: "task", callID: "call-a", state: { status: "error" } },
      },
    } } as any)
    help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "retry_approved")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("an H41-like reviewed syntax retry receives the recovery boost during mechanical idle delegation", async () => {
  const data = fixture()
  try {
    updateOpenCodeSettings(data.root, (settings) => {
      settings.workerRecoveryBoost = { enabled: true, model: "executor" }
    })
    mutateHelpStore(data.root, (requests) => {
      requests[0] = {
        ...requests[0],
        id: "H41",
        category: "syntax",
        problem: "Worker source syntax validation failed before preview storage: JSX element div has no corresponding closing tag.",
        evidence: ["2 equivalent syntax failures occurred for preview_worker_changes on src/a.ts."],
        executorReview: {
          ...requests[0].executorReview,
          rootCause: "The reviewed target remains syntactically incomplete after the base Worker retry.",
          retryStrategy: "Delegate one fresh Worker to repair the complete current target without changing task scope.",
        },
      }
    })
    const prompts: any[] = []
    const logs: any[] = []
    const client = {
      app: { log: async (input: any) => logs.push(input) },
      session: {
        messages: async () => ({ data: [assistant([{ type: "text", text: "Delegate the reviewed retry." }])] }),
        promptAsync: async (input: any) => prompts.push(input),
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "executor" } } } as any)

    assert.equal(prompts.length, 1)
    const subtask = prompts[0].body.parts[0]
    assert.equal(subtask.agent, WORKER_RECOVERY_BOOST_AGENT)
    assert.match(subtask.prompt, /REVIEWED WORKER HELP H41/)
    assert.equal(subtask.model, undefined)
    const decision = logs.find((value) => value.body?.message === "Selected Worker delegation model")
    assert.equal(decision?.body?.level, "info")
    assert.equal(decision?.body?.extra?.path, "mechanical-idle")
    assert.equal(decision?.body?.extra?.helpID, "H41")
    assert.equal(decision?.body?.extra?.boosted, true)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("mechanical idle delegation claims its nonce once and rejects an identical unmarked parallel TaskTool call", async () => {
  const data = fixture()
  try {
    updateOpenCodeSettings(data.root, (settings) => {
      settings.workerRecoveryBoost = { enabled: true, model: "executor" }
    })
    const messages = [assistant([{ type: "text", text: "Delegate the reviewed retry." }])]
    let hooks: any
    let claimedArgs: any = null
    const client = { session: {
      messages: async () => ({ data: messages }),
      promptAsync: async (input: any) => {
        const subtask = input.body.parts[0]
        assert.match(subtask.prompt, /<!-- harness-worker-delegation:[a-f0-9]{32} -->$/)
        const visiblePrompt = subtask.prompt.replace(/\n\n<!-- harness-worker-delegation:[a-f0-9]{32} -->$/, "")
        const impostor = {
          description: subtask.description,
          prompt: visiblePrompt,
          subagent_type: subtask.agent,
        }
        await assert.rejects(
          hooks["tool.execute.before"]({ sessionID: "executor", tool: "task", callID: "parallel-call-b" }, { args: impostor }),
          /already has a Worker delegation in flight/,
        )
        const actual = {
          description: subtask.description,
          prompt: subtask.prompt,
          subagent_type: subtask.agent,
        }
        await hooks["tool.execute.before"](
          { sessionID: "executor", tool: "task", callID: "synthetic-part-a" },
          { args: actual },
        )
        claimedArgs = actual
      },
    } }
    hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]({ sessionID: "executor", agent: "executor" }, {})
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "executor" } } })

    assert.equal(claimedArgs.subagent_type, WORKER_RECOVERY_BOOST_AGENT)
    assert.doesNotMatch(claimedArgs.prompt, /harness-worker-delegation/)
    let help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "delegated")
    assert.equal(help.delegationCallID, "synthetic-part-a")
    assert.equal(help.delegationAttemptNonce, undefined)

    await hooks.event({ event: {
      type: "message.part.updated",
      properties: {
        sessionID: "executor",
        part: {
          id: "parallel-call-b",
          callID: "different-ai-call-b",
          type: "tool",
          tool: "task",
          state: { status: "error" },
        },
      },
    } })
    help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "delegated")

    await hooks.event({ event: {
      type: "message.part.updated",
      properties: {
        sessionID: "executor",
        part: {
          id: "synthetic-part-a",
          callID: "different-ai-call-a",
          type: "tool",
          tool: "task",
          state: { status: "error" },
        },
      },
    } })
    help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "retry_approved")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("review_worker_help needs no arguments and persists only receipt-derived technical guidance", async () => {
  const data = fixture()
  try {
    mutateHelpStore(data.root, (requests) => {
      requests[0].status = "pending"
      delete requests[0].executorReview
    })
    const metadata: any[] = []
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result: any = await hooks.tool!.review_worker_help.execute({} as any, {
      agent: "executor",
      sessionID: "executor",
      metadata(value: any) { metadata.push(value) },
    } as any)

    assert.equal(result.title, "Worker help H1 reviewed")
    assert.equal(result.metadata.mechanical, true)
    assert.equal(result.metadata.decision, "retry_worker")
    assert.equal(metadata.at(-1)?.metadata?.helpID, "H1")

    const help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "retry_approved")
    assert.equal(help.executorReview.sessionID, "executor")
    assert.equal(help.executorReview.decision, "retry_worker")
    assert.equal(help.executorReview.rootCause, help.problem)
    assert.equal(help.executorReview.retryStrategy, help.suggestedNextStep)
    assert.deepEqual(help.executorReview.expectedResults, help.evidence)
    assert.deepEqual(help.executorReview.reviewedFiles, [data.taskPath, "src/a.ts"])
    assert.deepEqual(Object.keys(help.executorReview).sort(), [
      "decision",
      "expectedResults",
      "retryStrategy",
      "reviewedAt",
      "reviewedFiles",
      "rootCause",
      "sessionID",
    ])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("startup preserves a generic reviewed retry without quality-specific canonical rewriting", async () => {
  const data = fixture()
  try {
    mutateHelpStore(data.root, (requests) => {
      requests[0].executorReview = {
        sessionID: "executor",
        decision: "retry_worker",
        rootCause: "The recorded operation failed against stale technical input.",
        retryStrategy: "Delegate one fresh Worker to perform a technically valid in-scope operation.",
        expectedResults: ["The operation returns its next mechanical state."],
        reviewedFiles: [data.taskPath, "src/a.ts"],
        reviewedAt: "2026-07-16T10:01:00.000Z",
      }
    })
    const before = structuredClone(JSON.parse(
      readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"),
    ).requests[0].executorReview)

    await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)

    const after = JSON.parse(readFileSync(
      join(data.root, ".task-doctor/worker-help.json"),
      "utf8",
    )).requests[0].executorReview
    assert.deepEqual(after, before)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("minimal Worker-help selectors fail closed for wrong, stale, delegated, and terminal receipts", async (t) => {
  const cases: Array<{
    name: string
    mutate: (request: any) => void
    args: Record<string, unknown>
    expected: RegExp
  }> = [
    {
      name: "wrong help id",
      mutate(request) {
        request.status = "pending"
        delete request.executorReview
      },
      args: { help_id: "H999" },
      expected: /No reviewable Worker help request H999 exists/i,
    },
    {
      name: "stale task hash",
      mutate(request) {
        request.status = "pending"
        request.taskHash = "0".repeat(64)
        delete request.executorReview
      },
      args: { help_id: "H1" },
      expected: /No reviewable Worker help request H1 exists/i,
    },
    {
      name: "delegated receipt",
      mutate(request) {
        request.status = "delegated"
        request.delegatedAt = "2026-07-16T10:02:00.000Z"
        request.delegatedWorkerSessionID = "worker-bound"
      },
      args: { help_id: "H1" },
      expected: /No reviewable Worker help request H1 exists/i,
    },
    {
      name: "terminal receipt",
      mutate(request) {
        request.status = "resolved"
        request.closedAt = "2026-07-16T10:02:00.000Z"
        request.closureReason = "task_completed"
      },
      args: { help_id: "H1", decision: "retry_worker" },
      expected: /No reviewable Worker help request H1 exists/i,
    },
  ]

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const data = fixture()
      try {
        mutateHelpStore(data.root, (requests) => entry.mutate(requests[0]))
        const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
        const storePath = join(data.root, ".task-doctor/worker-help.json")
        const before = JSON.parse(readFileSync(storePath, "utf8")).requests[0]

        await assert.rejects(
          hooks.tool!.review_worker_help.execute(entry.args as any, {
            agent: "executor",
            sessionID: "executor",
            metadata() {},
          } as any),
          entry.expected,
        )

        const after = JSON.parse(readFileSync(storePath, "utf8")).requests[0]
        assert.deepEqual(after, before)
      } finally {
        rmSync(data.root, { recursive: true, force: true })
      }
    })
  }
})

test("an Executor turn that already called task is never corrected as prose-only", async () => {
  const data = fixture()
  try {
    const prompts: any[] = []
    const client = {
      session: {
        messages: async () => ({ data: [assistant([
          { type: "text", text: "Delegating now." },
          { type: "tool", tool: "task", state: { status: "running" } },
        ])] }),
        promptAsync: async (input: any) => prompts.push(input),
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "executor" } } } as any)
    assert.equal(prompts.length, 0)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("a rejected mechanical subtask enqueue is released for the next idle retry", async () => {
  const data = fixture()
  try {
    const prompts: any[] = []
    const client = {
      session: {
        messages: async () => ({ data: [assistant([{ type: "text", text: "Delegate one fresh Worker." }])] }),
        promptAsync: async (input: any) => {
          prompts.push(input)
          return prompts.length === 1 ? { error: { message: "busy/rejected" } } : { data: null }
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "executor" } } } as any)
    assert.equal(prompts.length, 1)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "executor" } } } as any)
    assert.equal(prompts.length, 2)
    const attempt = (part: any) => part.prompt.match(/harness-worker-delegation:([a-f0-9]{32})/)?.[1]
    const visible = (part: any) => ({
      ...part,
      prompt: part.prompt.replace(/\n\n<!-- harness-worker-delegation:[a-f0-9]{32} -->$/, ""),
    })
    assert.deepEqual(visible(prompts[1].body.parts[0]), visible(prompts[0].body.parts[0]))
    assert.notEqual(attempt(prompts[1].body.parts[0]), attempt(prompts[0].body.parts[0]))
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("an incomplete Planner recovery remains authoritative over prose-only delegation correction", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/planner-recovery.json"), JSON.stringify({
      version: 1,
      status: "incomplete",
      taskPath: data.taskPath,
      taskHash: data.taskHash,
      plannerSessionID: "planner",
      executorSessionID: "executor",
      reason: "A committed recovery still needs finalization.",
      updatedAt: "2026-07-16T10:02:00.000Z",
    }))
    const prompts: any[] = []
    const client = {
      session: {
        messages: async () => ({ data: [assistant([{ type: "text", text: "Delegate one fresh Worker." }])] }),
        promptAsync: async (input: any) => prompts.push(input),
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "executor" } } } as any)
    assert.equal(prompts.length, 0)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("an explicit current Planner request remains authoritative over mechanical delegation", async () => {
  const data = fixture()
  try {
    const prompts: any[] = []
    const client = {
      session: {
        messages: async () => ({ data: [assistant([{ type: "text", text: "Delegate one fresh Worker." }])] }),
        promptAsync: async (input: any) => prompts.push(input),
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {
      messageID: "user-planner-request",
      parts: [{ type: "text", text: `Use the owning Planner to revise ${data.taskPath} before delegating Worker.` }],
    } as any)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "executor" } } } as any)
    assert.equal(prompts.length, 0)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("a real user blocker remains authoritative over mechanical delegation", async () => {
  const data = fixture()
  try {
    const prompts: any[] = []
    const client = {
      session: {
        messages: async () => ({ data: [assistant([{ type: "text", text: "REAL BLOCKER: user decision required before Worker delegation." }])] }),
        promptAsync: async (input: any) => prompts.push(input),
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "executor" } } } as any)
    assert.equal(prompts.length, 0)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("a missing task-tool result restores a staged Worker help delegation", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const args = {
      description: `Resume ${data.taskPath}`,
      prompt: `Resume ${data.taskPath}`,
      subagent_type: "worker",
    }
    await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task" } as any, { args } as any)
    let help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "delegated")
    await assert.doesNotReject(() => hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args,
    } as any, undefined as any))
    help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "retry_approved")
    assert.equal(help.delegatedWorkerSessionID, undefined)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { WorkflowGuard } from "../plugins/workflow-guard.ts"
import { claimPlannerOwnership } from "../lib/planner-ownership.ts"

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "worker-help-"))
  const taskPath = "kanban/todo/01-task.md"
  const taskContent = "# Task\n\n## Scope\n- `src/a.ts`\n\n## Requirement\nOld requirement. Keep the task contract explicit, observable, deterministic, and complete enough for an independent Worker.\n"
  write(join(root, "project.json"), JSON.stringify({ settings: { opencode: { workflowGuard: { workerHelp: true } } } }))
  write(join(root, "WORKER.md"), "# Worker rules\n")
  write(join(root, "kanban/TASK.md"), "# Template\n")
  write(join(root, taskPath), taskContent)
  write(join(root, "src/a.ts"), "export const value = 1\n")
  write(join(root, "scripts/task-doctor.mjs"), `
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
const [gate, taskPath] = process.argv.slice(2);
const root = process.cwd();
const content = readFileSync(resolve(root, taskPath), "utf8");
if (content.includes("INVALID")) process.exit(1);
const name = taskPath.split("/").pop();
const hash = createHash("sha256").update(content).digest("hex");
const lintPath = resolve(root, ".task-doctor/lints", name + ".json");
const registrationPath = resolve(root, ".task-doctor/registrations", name + ".json");
if (gate === "lint") {
  mkdirSync(dirname(lintPath), { recursive: true });
  writeFileSync(lintPath, JSON.stringify({ status: "linted", finalTaskHash: hash, lintedAt: "now" }));
  console.log("TASK DOCTOR: LINT PASS " + taskPath);
} else if (gate === "register") {
  mkdirSync(dirname(registrationPath), { recursive: true });
  writeFileSync(registrationPath, JSON.stringify({
    status: "registered", taskPath, taskHash: hash, lint: { lintedAt: "now", finalTaskHash: hash },
    registeredAt: "now", memoryAction: "none", memoryReason: "none", contractOwnership: "not-applicable", risk: { required: false }
  }));
  console.log("TASK DOCTOR: REGISTERED " + taskPath);
}
`)
  const state = {
    version: 4,
    status: "started",
    taskPath,
    taskHash: digest(taskContent),
    snapshot: { "src/a.ts": "before" },
    memoryAction: "none",
    memoryReason: "none",
    contractOwnership: "not-applicable",
    risk: { required: false },
  }
  write(join(root, ".task-doctor/state.json"), `${JSON.stringify(state, null, 2)}\n`)
  write(join(root, ".task-doctor/worker-help.json"), `${JSON.stringify({
    version: 1,
    updatedAt: "now",
    requests: [{
      version: 1,
      id: "H1",
      status: "pending",
      taskPath,
      taskHash: state.taskHash,
      workerSessionID: "worker-old",
      category: "model_loop",
      problem: "Repeated edits failed on the same source file.",
      attemptedActions: ["Re-read and narrowed the edit."],
      evidence: ["Three equivalent edit errors."],
      relevantFiles: [taskPath, "src/a.ts"],
      suggestedNextStep: "Clarify the requirement and start a fresh Worker.",
      createdAt: "now",
    }],
  }, null, 2)}\n`)
  return { root, taskPath, taskContent, state }
}

async function initializeWorkerDoctorLifecycle(
  hooks: Awaited<ReturnType<typeof WorkflowGuard>>,
  root: string,
  taskPath: string,
  sessionID: string,
) {
  await hooks["chat.message"]!({ sessionID, agent: "worker" } as any, {} as any)
  for (const path of ["WORKER.md", taskPath]) {
    const absolutePath = join(root, path)
    const args = { filePath: absolutePath }
    await hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, { args } as any)
    await hooks["tool.execute.after"]!({ sessionID, tool: "read", args } as any, {
      title: "read",
      output: readFileSync(absolutePath, "utf8"),
      metadata: { truncated: false },
    } as any)
  }
}

function executorReviewTool(hooks: Awaited<ReturnType<typeof WorkflowGuard>>) {
  const execute = hooks.tool!.review_worker_help.execute
  return async (args: any, context: any) => {
    await hooks["chat.message"]!({ sessionID: context.sessionID, agent: "executor" } as any, {} as any)
    return execute(args, context)
  }
}

async function reviewTool(root: string) {
  const hooks = await WorkflowGuard({ directory: root, worktree: root, client: {} } as any)
  return executorReviewTool(hooks)
}

async function recoveryReviewTool(root: string, taskPath: string, replacement?: string) {
  claimPlannerOwnership(root, {
    taskPath,
    plannerSessionID: "planner-original",
    plannerAgent: "planner",
    source: "registration",
  })
  let hooks: Awaited<ReturnType<typeof WorkflowGuard>>
  const client = {
    session: {
      get: async ({ path }: any) => ({ data: { id: path.id, directory: root, title: "Planner", projectID: "test", version: "1", time: { created: 1, updated: 1 } } }),
      messages: async () => ({ data: [] }),
      prompt: async ({ path }: any) => {
        assert.equal(path.id, "planner-original")
        await hooks.tool!.revise_active_task.execute({
          task_path: taskPath,
          ...(replacement === undefined ? {} : { replacement }),
          reason: "Correct the task definition while preserving the active Doctor baseline.",
        }, { agent: "planner", sessionID: "planner-original", metadata() {} } as any)
        return { data: { info: {}, parts: [] } }
      },
    },
  }
  hooks = await WorkflowGuard({ directory: root, worktree: root, client } as any)
  return executorReviewTool(hooks)
}

test("owning Planner task correction preserves the original Doctor snapshot", async () => {
  const data = fixture()
  try {
    const replacement = data.taskContent.replace("Old requirement.", "Clarified requirement.")
    const execute = await recoveryReviewTool(data.root, data.taskPath, replacement)
    await execute({ decision: "planner_recovery" }, { agent: "executor", sessionID: "executor", metadata() {} } as any)

    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    const help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.match(readFileSync(join(data.root, data.taskPath), "utf8"), /Clarified requirement/)
    assert.deepEqual(state.snapshot, data.state.snapshot)
    assert.equal(state.status, "started")
    assert.equal(state.taskHash, digest(readFileSync(join(data.root, data.taskPath), "utf8")))
    assert.equal(help.status, "task_changed")
    assert.equal(help.taskHash, state.taskHash)
    assert.equal(help.executorReview.rootCause, "Repeated edits failed on the same source file.")
    assert.equal(help.executorReview.retryStrategy, "Clarify the requirement and start a fresh Worker.")
    assert.deepEqual(help.executorReview.expectedResults, ["Three equivalent edit errors."])
    assert.deepEqual(help.executorReview.reviewedFiles, [data.taskPath, "src/a.ts"])
    assert.equal("workerInstructions" in help.executorReview, false)
    assert.equal(help.executorReview.decision, "planner_recovery")
    const ownership = JSON.parse(readFileSync(join(data.root, ".task-doctor/planner-owners/01-task.md.json"), "utf8"))
    assert.equal(ownership.plannerSessionID, "planner-original")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Executor retry defaults mechanically and preserves persisted Worker guidance", async () => {
  const data = fixture()
  try {
    const execute = await reviewTool(data.root)
    const result = await execute({}, { agent: "executor", sessionID: "executor", metadata() {} } as any)

    const help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "retry_approved")
    assert.equal(help.executorReview.decision, "retry_worker")
    assert.equal(help.executorReview.rootCause, "Repeated edits failed on the same source file.")
    assert.equal(help.executorReview.retryStrategy, "Clarify the requirement and start a fresh Worker.")
    assert.deepEqual(help.executorReview.expectedResults, ["Three equivalent edit errors."])
    assert.deepEqual(help.executorReview.reviewedFiles, [data.taskPath, "src/a.ts"])
    assert.equal("workerInstructions" in help.executorReview, false)
    assert.match(result.output, /Persisted problem: Repeated edits failed on the same source file\./)
    assert.match(result.output, /Persisted next step: Clarify the requirement and start a fresh Worker\./)
    assert.equal(result.metadata.mechanical, true)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Executor help review exposes flat optional arguments and advances in one call", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const sessionID = "executor"
    const context = { agent: "executor", sessionID, metadata() {} } as any
    const shape = (hooks.tool!.review_worker_help as any).args
    assert.deepEqual(Object.keys(shape).sort(), ["decision", "help_id"])
    await hooks["chat.message"]!({ sessionID, agent: "executor" } as any, {} as any)

    const args = {}
    const result = await hooks.tool!.review_worker_help.execute(args, context)
    assert.match(result.output, /approved for one fresh Worker retry/)
    assert.deepEqual(Object.keys(args), [])
    const help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "retry_approved")
    assert.equal(help.executorReview.rootCause, help.problem)
    assert.equal(help.executorReview.retryStrategy, help.suggestedNextStep)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Worker cannot advance an Executor-owned help receipt", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await assert.rejects(
      () => hooks.tool!.review_worker_help.execute({}, {
        agent: "worker",
        sessionID: "worker-old",
        metadata() {},
      } as any),
      /Only Executor may review a Worker help request/,
    )
    const help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "pending")
    assert.equal(help.executorReview, undefined)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("malformed Worker help review JSON gets one compact retry before a bounded stop", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const sessionID = "executor-malformed-review"
    await hooks["chat.message"]!({ sessionID, agent: "executor" } as any, {} as any)
    const invalidArgs = {
      tool: "review_worker_help",
      error: `Invalid input for tool review_worker_help: JSON parsing failed: ${"raw-fragment ".repeat(300)}`,
    }
    const first = { title: "invalid", output: invalidArgs.error, metadata: {} as any }
    await hooks["tool.execute.after"]!({ sessionID, tool: "invalid", callID: "call-1", args: invalidArgs } as any, first)
    assert.match(first.output, /Retry review_worker_help exactly once now/)
    assert.doesNotMatch(first.output, /raw-fragment/)
    assert.equal(first.metadata.malformedAttempts, 1)
    assert.ok(first.output.length < 700)

    const transformed = { messages: [{
      info: { id: "msg-user", sessionID, role: "user", agent: "executor", time: { created: 1 } },
      parts: [{ id: "prt-user", sessionID, messageID: "msg-user", type: "text", text: "Continue." }],
    }] as any[] }
    await hooks["experimental.chat.messages.transform"]!({} as any, transformed as any)
    assert.match(transformed.messages.at(-1).parts[0].text, /Failure: OpenCode rejected an incomplete review_worker_help call/)

    const duplicate = { title: "invalid", output: invalidArgs.error, metadata: {} as any }
    await hooks["tool.execute.after"]!({ sessionID, tool: "invalid", callID: "call-1", args: invalidArgs } as any, duplicate)
    assert.equal(duplicate.metadata.malformedAttempts, 1)

    const second = { title: "invalid", output: invalidArgs.error, metadata: {} as any }
    await hooks["tool.execute.after"]!({ sessionID, tool: "invalid", callID: "call-2", args: invalidArgs } as any, second)
    assert.match(second.output, /malformed JSON twice/)
    assert.match(second.output, /Do not delegate Worker/)
    assert.equal(second.metadata.malformedAttempts, 2)
    assert.doesNotMatch(second.output, /raw-fragment/)

    await hooks.event!({ event: { type: "session.deleted", properties: { info: { id: sessionID } } } } as any)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("an interrupted delegated Worker restores its reviewed retry for a fresh Worker", async () => {
  const data = fixture()
  try {
    const store = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    store.requests[0] = {
      ...store.requests[0],
      status: "delegated",
      delegatedAt: "now",
      delegatedWorkerSessionID: "worker-interrupted",
      executorReview: {
        sessionID: "executor",
        decision: "retry_worker",
        rootCause: "The previous Worker stopped before applying the reviewed correction.",
        retryStrategy: "Delegate one fresh Worker against the same reviewed evidence.",
        expectedResults: ["The fresh Worker completes the reviewed task and Doctor verify passes."],
        reviewedFiles: [data.taskPath, "src/a.ts"],
        reviewedAt: "now",
      },
    }
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify(store, null, 2)}\n`)

    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "worker-interrupted", agent: "worker" } as any, {} as any)
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "worker-interrupted", parentID: "executor", agent: "worker" } },
    } } as any)
    await hooks.event!({ event: {
      type: "session.error",
      properties: {
        sessionID: "worker-interrupted",
        error: { name: "MessageAbortedError", data: { message: "stopped by user" } },
      },
    } } as any)

    const restored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(restored.status, "retry_approved")
    assert.equal("delegatedAt" in restored, false)
    assert.equal("delegatedWorkerSessionID" in restored, false)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("an explicit current re-review request overrides an older un-delegated retry approval", async () => {
  const data = fixture()
  try {
    const store = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    store.requests[0] = {
      ...store.requests[0],
      status: "retry_approved",
      executorReview: {
        sessionID: "executor-old",
        decision: "retry_worker",
        rootCause: "The previous Worker used stale source text.",
        retryStrategy: "Start a fresh Worker from current source.",
        expectedResults: ["The current implementation passes Doctor verification."],
        reviewedFiles: [data.taskPath, "src/a.ts"],
        reviewedAt: new Date().toISOString(),
      },
    }
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify(store, null, 2)}\n`)
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const sessionID = "executor-rereview"
    await hooks["chat.message"]!({ sessionID, agent: "executor" } as any, {
      parts: [{ type: "text", text: "Before any delegation, re-review H1 with review_worker_help. Do not delegate from the old retry approval." }],
    } as any)

    const transformed = { messages: [{
      info: { id: "msg-user", sessionID, role: "user", agent: "executor", time: { created: 1 } },
      parts: [{ id: "prt-user", sessionID, messageID: "msg-user", type: "text", text: "Continue." }],
    }] as any[] }
    await hooks["experimental.chat.messages.transform"]!({} as any, transformed as any)
    const liveStateText = transformed.messages.at(-1).parts[0].text
    assert.match(liveStateText, /Next action: Executor must re-review Worker help H1/)
    assert.match(liveStateText, /current user explicitly requested review before delegation/)
    assert.doesNotMatch(liveStateText, /Next action: Executor must delegate one fresh Worker/)

    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "task", callID: "delegate" } as any, {
      args: {
        subagent_type: "worker",
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
      },
    } as any), /must be re-reviewed[\s\S]*Call review_worker_help for H1 now/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("an interrupted Worker with a pending follow-up keeps the prior review delegated", async () => {
  const data = fixture()
  try {
    const store = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    const prior = {
      ...store.requests[0],
      status: "delegated",
      delegatedAt: "now",
      delegatedWorkerSessionID: "worker-follow-up",
      executorReview: {
        sessionID: "executor",
        decision: "retry_worker",
        rootCause: "The prior attempt needed one reviewed retry.",
        retryStrategy: "Delegate one fresh Worker against the reviewed evidence.",
        expectedResults: ["The reviewed task passes Doctor verification."],
        reviewedFiles: [data.taskPath, "src/a.ts"],
        reviewedAt: "now",
      },
    }
    store.requests = [prior, {
      ...store.requests[0],
      id: "H2",
      status: "pending",
      workerSessionID: "worker-follow-up",
      createdAt: "later",
    }]
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify(store, null, 2)}\n`)

    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "worker-follow-up", agent: "worker" } as any, {} as any)
    await hooks.event!({ event: {
      type: "session.error",
      properties: {
        sessionID: "worker-follow-up",
        error: { name: "MessageAbortedError", data: { message: "stopped after requesting help" } },
      },
    } } as any)

    const requests = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests
    assert.equal(requests[0].status, "delegated")
    assert.equal(requests[0].delegatedWorkerSessionID, "worker-follow-up")
    assert.equal(requests[1].status, "pending")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Executor Planner escalation redirects to the exact pending Worker help review", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await assert.rejects(() => hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: "The Executor incorrectly classified the current Worker blocker as Planner-owned.",
      evidence: ["Worker returned a pending structured help request for the active task."],
      expected_results: ["The pending Worker help receives its mandatory Executor review."],
      relevant_files: [data.taskPath, "src/a.ts"],
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any), /Call review_worker_help for H1/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Executor review rejects a receipt from the superseded task hash", async () => {
  const data = fixture()
  try {
    const revisedTaskContent = data.taskContent.replace("Old requirement.", "Clarified requirement.")
    const revisedTaskHash = digest(revisedTaskContent)
    write(join(data.root, data.taskPath), revisedTaskContent)
    write(join(data.root, ".task-doctor/state.json"), `${JSON.stringify({
      ...data.state,
      taskHash: revisedTaskHash,
      taskRevision: {
        helpID: "H1",
        previousTaskHash: data.state.taskHash,
        revisedTaskHash,
        plannerSessionID: "planner-original",
        plannerAgent: "planner",
        executorSessionID: "executor",
        reason: "The owning Planner clarified the active contract.",
        revisedAt: new Date().toISOString(),
      },
    }, null, 2)}\n`)

    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const context = { agent: "executor", sessionID: "executor", metadata() {} } as any
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    await assert.rejects(
      () => hooks.tool!.review_worker_help.execute({ help_id: "H1" }, context),
      /No reviewable Worker help request h1 exists for the exact active task/,
    )

    const updated = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(updated.status, "pending")
    assert.equal(updated.taskHash, data.state.taskHash)
    assert.equal(updated.executorReview, undefined)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("fresh Executor delegation repairs a late incomplete status after the same help revision completed", async () => {
  const data = fixture()
  try {
    const revisedTaskContent = data.taskContent.replace("Old requirement.", "Clarified requirement.")
    const revisedTaskHash = digest(revisedTaskContent)
    write(join(data.root, data.taskPath), revisedTaskContent)
    write(join(data.root, ".task-doctor/state.json"), `${JSON.stringify({
      ...data.state,
      taskHash: revisedTaskHash,
      taskRevision: {
        helpID: "H1",
        previousTaskHash: data.state.taskHash,
        revisedTaskHash,
        plannerSessionID: "planner-original",
        plannerAgent: "planner",
        executorSessionID: "executor-old",
        reason: "The owning Planner clarified the active contract.",
        revisedAt: new Date().toISOString(),
      },
    }, null, 2)}\n`)
    const store = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    store.requests[0] = {
      ...store.requests[0],
      status: "planner_recovery_incomplete",
      taskHash: revisedTaskHash,
      executorReview: {
        sessionID: "executor-old",
        decision: "planner_recovery",
        rootCause: "The old task wording required a Planner correction.",
        retryStrategy: "Return this task to Planner instead of implementing it.",
        expectedResults: ["Planner changes the obsolete task."],
        reviewedFiles: [data.taskPath, "src/a.ts"],
        reviewedAt: new Date().toISOString(),
      },
    }
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify(store, null, 2)}\n`)
    write(join(data.root, ".task-doctor/planner-recovery.json"), `${JSON.stringify({
      version: 1,
      status: "incomplete",
      taskPath: data.taskPath,
      taskHash: data.state.taskHash,
      plannerSessionID: "planner-original",
      executorSessionID: "executor-old",
      reason: "A stopped review reported late.",
      helpID: "H1",
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`)

    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "executor-fresh", agent: "executor" } as any, {} as any)
    const delegation = {
      args: {
        subagent_type: "worker",
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
      },
    }
    await assert.doesNotReject(() => hooks["tool.execute.before"]!({ sessionID: "executor-fresh", tool: "task" } as any, delegation as any))

    const reconciled = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(reconciled.status, "delegated")
    assert.equal(reconciled.taskHash, revisedTaskHash)
    assert.equal(existsSync(join(data.root, ".task-doctor/planner-recovery.json")), false)
    assert.match(delegation.args.prompt, /TASK REVISION RESOLVED H1/)
    assert.doesNotMatch(delegation.args.prompt, /Return this task to Planner|old task wording|REVIEWED WORKER HELP/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("rejected Planner correction restores task and state, then stops Executor", async () => {
  const data = fixture()
  try {
    const execute = await recoveryReviewTool(data.root, data.taskPath, data.taskContent.replace("Old requirement.", "INVALID requirement."))
    const result = await execute({ decision: "planner_recovery" }, { agent: "executor", sessionID: "executor", metadata() {} } as any)

    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    const help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(readFileSync(join(data.root, data.taskPath), "utf8"), data.taskContent)
    assert.deepEqual(state, data.state)
    assert.equal(help.status, "planner_recovery_incomplete")
    assert.match(result.output, /PLANNER RECOVERY INCOMPLETE/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("parent hook replaces any terminal Worker text with the stored canonical help handoff", async () => {
  const data = fixture()
  try {
    let promptCalls = 0
    const client = {
      session: {
        messages: async ({ path }: any) => ({ data: path.id === "worker-old" ? [{
          info: {
            id: "assistant-1",
            role: "assistant",
            parentID: "user-1",
            agent: "worker",
            providerID: "hightrail-local",
            modelID: "gemma4:12b-it-q8",
            time: { completed: Date.now() },
            finish: "stop",
          },
          parts: [{ type: "text", text: "I am ready to continue whenever needed." }],
        }] : [] }),
        prompt: async () => {
          promptCalls += 1
          throw new Error("The parent hook must not ask the model to reformat persisted help.")
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    const output = {
      title: "Worker result",
      output: '<task id="worker-old" state="completed">\n<task_result>\nWrong free-form ending.\n</task_result>\n</task>',
      metadata: { sessionId: "worker-old" },
    }
    await hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args: {
        description: `Execute ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
      },
    } as any, output as any)

    assert.equal(promptCalls, 0)
    assert.match(output.output, /HELP_REQUESTED/)
    assert.match(output.output, /Help ID: H1/)
    assert.match(output.output, /Repeated edits failed on the same source file/)
    assert.doesNotMatch(output.output, /Wrong free-form ending/)
    assert.equal(output.metadata.workerReturnCanonicalized, true)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("another Worker's stale pending help cannot capture the current Worker handoff", async () => {
  const data = fixture()
  try {
    let promptCalls = 0
    const client = {
      session: {
        messages: async ({ path }: any) => ({ data: path.id === "worker-current" ? [{
          info: {
            id: "assistant-current",
            role: "assistant",
            parentID: "user-current",
            agent: "worker",
            providerID: "llamacpp-local",
            modelID: "gemma4-12b-mtp",
            time: { completed: Date.now() },
            finish: "stop",
          },
          parts: [{ type: "text", text: "Wrong free-form ending." }],
        }] : [] }),
        prompt: async () => {
          promptCalls += 1
          throw new Error("Persisted help must be canonicalized without another model call.")
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "worker-current", agent: "worker" } as any, {} as any)
    const help = await hooks.tool!.request_executor_help.execute({
      task_path: data.taskPath,
      category: "test_failure",
      problem: "The current focused E2E verification still times out on the expected navigation link.",
      attempted_actions: ["Read the current test and component, then ran the focused Doctor verification."],
      evidence: ["Playwright timed out waiting for the exact Forgot Password link in the current Worker run."],
      relevant_files: ["src/a.ts"],
      suggested_next_step: "Executor should review the current rendered behavior and approve a focused in-scope retry.",
    }, { agent: "worker", sessionID: "worker-current", metadata() {} } as any)

    assert.equal(help.metadata.helpID, "H2")
    const stored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(stored.requests.length, 2)
    assert.equal(stored.requests[0].workerSessionID, "worker-old")
    assert.equal(stored.requests[1].workerSessionID, "worker-current")
    assert.match(stored.requests[1].problem, /current focused E2E/)

    const output = {
      title: "Worker result",
      output: '<task id="worker-current" state="completed">\n<task_result>\nWrong free-form ending.\n</task_result>\n</task>',
      metadata: { sessionId: "worker-current" },
    }
    await hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args: {
        description: `Execute ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
      },
    } as any, output as any)

    assert.equal(promptCalls, 0)
    assert.match(output.output, /Help ID: H2/)
    assert.match(output.output, /current focused E2E/)
    assert.doesNotMatch(output.output, /Repeated edits failed on the same source file/)
    assert.equal(output.metadata.workerReturnCanonicalized, true)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("parent hook turns an invalid blocked return into reviewable help without another model call", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    write(join(data.root, ".task-doctor/last-doctor-failure.json"), `${JSON.stringify({
      version: 1,
      sessionID: "worker-broken",
      taskPath: data.taskPath,
      gate: "verify",
      command: `npm run task:doctor:verify -- ${data.taskPath}`,
      output: "TASK DOCTOR: FAIL\n- FALLOW_NEW_FINDING: unresolved_imports: src/a.ts\n",
      failedAt: "now",
    }, null, 2)}\n`)
    let promptCalls = 0
    const client = {
      session: {
        messages: async ({ path }: any) => ({ data: path.id === "worker-broken" ? [{
          info: {
            id: "assistant-1",
            role: "assistant",
            parentID: "user-1",
            agent: "worker",
            providerID: "hightrail-local",
            modelID: "gemma4:12b-it-q8",
            time: { completed: Date.now() },
            finish: "stop",
          },
          parts: [{ type: "text", text: "I could not finish this task." }],
        }] : [] }),
        prompt: async () => {
          promptCalls += 1
          throw new Error("Invalid blockers must be canonicalized mechanically.")
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    const output = {
      title: "Worker result",
      output: '<task id="worker-broken" state="completed">\n<task_result>\nI could not finish this task.\n</task_result>\n</task>',
      metadata: { sessionId: "worker-broken" },
    }
    await hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args: {
        description: `Execute ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
      },
    } as any, output as any)

    assert.equal(promptCalls, 0)
    assert.match(output.output, /HELP_REQUESTED/)
    assert.match(output.output, /Help ID: H1/)
    assert.match(output.output, new RegExp(`Task: ${data.taskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
    assert.match(output.output, /FALLOW_NEW_FINDING: unresolved_imports: src\/a\.ts/)
    assert.match(output.output, /call review_worker_help for H1/)
    assert.doesNotMatch(output.output, /I could not finish this task/)
    assert.equal(output.metadata.workerBlockedCanonicalized, true)
    assert.equal(output.metadata.workerHelpSynthesized, true)
    const stored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(stored.requests.length, 1)
    assert.equal(stored.requests[0].workerSessionID, "worker-broken")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("parent hook prefers a later single tool error over an earlier Doctor failure", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    write(join(data.root, ".task-doctor/last-doctor-failure.json"), `${JSON.stringify({
      version: 1,
      sessionID: "worker-latest-tool",
      taskPath: data.taskPath,
      gate: "verify",
      command: `npm run task:doctor:verify -- ${data.taskPath}`,
      output: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: No tests found.\n",
      failedAt: new Date(1_000).toISOString(),
    }, null, 2)}\n`)
    const absolutePath = join(data.root, "src/a.ts")
    const toolError = `Worker changes require an exact project-relative path: ${absolutePath}`
    const client = {
      session: {
        messages: async () => ({ data: [{
          info: {
            id: "assistant-latest-tool",
            role: "assistant",
            parentID: "user-latest-tool",
            agent: "worker",
            providerID: "hightrail-local",
            modelID: "gemma4:12b-it-q8",
            time: { completed: 3_000 },
            finish: "stop",
          },
          parts: [
            {
              type: "tool",
              tool: "preview_worker_changes",
              state: {
                status: "error",
                input: {
                  task_path: data.taskPath,
                  operations: [{ kind: "replace", path: absolutePath, old_text: "a = 1", new_text: "a = 2" }],
                },
                error: toolError,
                time: { end: 2_000 },
              },
            },
            { type: "text", text: "I could not finish this task." },
          ],
        }] }),
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    const output = {
      title: "Worker result",
      output: '<task id="worker-latest-tool" state="completed">\n<task_result>\nI could not finish this task.\n</task_result>\n</task>',
      metadata: { sessionId: "worker-latest-tool" },
    }
    await hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args: { description: `Execute ${data.taskPath}`, prompt: `Resume ${data.taskPath}`, subagent_type: "worker" },
    } as any, output as any)

    assert.match(output.output, /exact project-relative path/)
    const stored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(stored.requests[0].category, "tool-failure")
    assert.ok(stored.requests[0].relevantFiles.includes("src/a.ts"))
    assert.match(stored.requests[0].attemptedActions[0], /preview_worker_changes/)
    assert.match(stored.requests[0].evidence[1], /Earlier Doctor context:[\s\S]*No tests found/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("parent hook keeps a newer Doctor failure over an older tool error", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    write(join(data.root, ".task-doctor/last-doctor-failure.json"), `${JSON.stringify({
      version: 1,
      sessionID: "worker-latest-doctor",
      taskPath: data.taskPath,
      gate: "verify",
      command: `npm run task:doctor:verify -- ${data.taskPath}`,
      output: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: No tests found.\n",
      failedAt: new Date(3_000).toISOString(),
    }, null, 2)}\n`)
    const absolutePath = join(data.root, "src/a.ts")
    const client = {
      session: {
        messages: async () => ({ data: [{
          info: {
            id: "assistant-latest-doctor",
            role: "assistant",
            parentID: "user-latest-doctor",
            agent: "worker",
            providerID: "hightrail-local",
            modelID: "gemma4:12b-it-q8",
            time: { completed: 4_000 },
            finish: "stop",
          },
          parts: [
            {
              type: "tool",
              tool: "preview_worker_changes",
              state: {
                status: "error",
                input: { task_path: data.taskPath, operations: [{ kind: "replace", path: absolutePath }] },
                error: `Worker changes require an exact project-relative path: ${absolutePath}`,
                time: { end: 2_000 },
              },
            },
            { type: "text", text: "I could not finish this task." },
          ],
        }] }),
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    const output = {
      title: "Worker result",
      output: '<task id="worker-latest-doctor" state="completed">\n<task_result>\nI could not finish this task.\n</task_result>\n</task>',
      metadata: { sessionId: "worker-latest-doctor" },
    }
    await hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args: { description: `Execute ${data.taskPath}`, prompt: `Resume ${data.taskPath}`, subagent_type: "worker" },
    } as any, output as any)

    assert.match(output.output, /No tests found/)
    const stored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(stored.requests[0].category, "doctor-failure")
    assert.doesNotMatch(stored.requests[0].problem, /project-relative path/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("an incomplete reviewed retry creates one child-owned follow-up help request", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({
      version: 1,
      updatedAt: "now",
      requests: [{
        version: 1,
        id: "H1",
        status: "delegated",
        taskPath: data.taskPath,
        taskHash: data.state.taskHash,
        workerSessionID: "worker-original",
        category: "test_failure",
        problem: "The first Worker could not finish verification.",
        attemptedActions: ["Ran Doctor verify."],
        evidence: ["Original verification failed."],
        relevantFiles: [data.taskPath, "src/a.ts"],
        suggestedNextStep: "Retry with a fresh Worker.",
        createdAt: "now",
        delegatedAt: "now",
      }],
    }, null, 2)}\n`)
    write(join(data.root, ".task-doctor/last-doctor-failure.json"), `${JSON.stringify({
      version: 1,
      sessionID: "worker-reviewed-retry",
      taskPath: data.taskPath,
      gate: "verify",
      command: `npm run task:doctor:verify -- ${data.taskPath}`,
      output: "[WebServer] AggregateError [ECONNREFUSED]:\nTASK DOCTOR: FAIL\n- VERIFY_FAILED: expected exit 0, got 1: npm run test:e2e:direct\n",
      failedAt: "now",
    }, null, 2)}\n`)
    let promptCalls = 0
    const client = { session: {
      messages: async () => ({ data: [{
        info: { id: "assistant", role: "assistant", parentID: "user", agent: "worker", time: { completed: Date.now() }, finish: "stop" },
        parts: [],
      }] }),
      prompt: async () => { promptCalls += 1 },
    } }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    const output = {
      title: "Worker result",
      output: '<task id="worker-reviewed-retry" state="completed">\n<task_result>\n\n</task_result>\n</task>',
      metadata: { sessionId: "worker-reviewed-retry" },
    }
    await hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args: {
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}\n\nREVIEWED WORKER HELP H1\nRoot cause: previous verification failure`,
        subagent_type: "worker",
      },
    } as any, output as any)

    assert.equal(promptCalls, 0)
    assert.match(output.output, /HELP_REQUESTED/)
    assert.match(output.output, /Help ID: H2/)
    assert.match(output.output, /NODE_ERROR ECONNREFUSED/)
    const stored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(stored.requests.length, 2)
    assert.equal(stored.requests[1].retryOfHelpID, "H1")
    assert.equal(stored.requests[1].category, "reviewed-retry-incomplete")
    assert.deepEqual(stored.requests[1].relevantFiles, [data.taskPath, "src/a.ts"])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("invalid Worker return never consumes another session's Doctor failure", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    write(join(data.root, ".task-doctor/last-doctor-failure.json"), `${JSON.stringify({
      version: 1,
      sessionID: "worker-stale",
      taskPath: data.taskPath,
      gate: "verify",
      output: "TASK DOCTOR: FAIL\n- STALE_FAILURE: must not leak\n",
    }, null, 2)}\n`)
    const client = { session: { messages: async () => ({ data: [{
      info: { id: "assistant", role: "assistant", parentID: "user", agent: "worker", time: { completed: Date.now() }, finish: "stop" },
      parts: [],
    }] }) } }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    const output = {
      title: "Worker result",
      output: '<task id="worker-current" state="completed">\n<task_result>\n\n</task_result>\n</task>',
      metadata: { sessionId: "worker-current" },
    }
    await hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args: { description: `Resume ${data.taskPath}`, prompt: `Resume ${data.taskPath}`, subagent_type: "worker" },
    } as any, output as any)
    assert.match(output.output, /HELP_REQUESTED/)
    assert.doesNotMatch(output.output, /STALE_FAILURE/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("parent hook assigns an out-of-scope-only Verify blocker to Planner", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/last-doctor-failure.json"), `${JSON.stringify({
      version: 1,
      sessionID: "worker-cross-scope",
      taskPath: data.taskPath,
      gate: "verify",
      command: `npm run task:doctor:verify -- ${data.taskPath}`,
      output: "TASK DOCTOR: RUN npm run typecheck\nsrc/b.ts(2,4): error TS2554: Expected 1 arguments, but got 2.\nTASK DOCTOR: FAIL\n- VERIFY_FAILED: expected exit 0, got 2",
      failedAt: "now",
    }, null, 2)}\n`)
    const client = {
      session: {
        messages: async () => ({ data: [{
          info: { id: "assistant", role: "assistant", parentID: "user", agent: "worker", time: { completed: Date.now() }, finish: "stop" },
          parts: [],
        }] }),
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    const output = {
      title: "Worker result",
      output: '<task id="worker-cross-scope" state="completed">\n<task_result>\n\n</task_result>\n</task>',
      metadata: { sessionId: "worker-cross-scope" },
    }
    await hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args: { description: `Resume ${data.taskPath}`, prompt: `Resume ${data.taskPath}`, subagent_type: "worker" },
    } as any, output as any)
    assert.match(output.output, /Required owner: Planner/)
    assert.match(output.output, /EXECUTOR NEXT ACTION: This is a Planner-owned task-definition blocker/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("parent hook turns a truncated 4K Worker response into structured Executor help", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    const workerSessionID = "worker-output-limit"
    let promptCalls = 0
    const client = {
      session: {
        messages: async ({ path }: any) => ({ data: path.id === workerSessionID ? [{
          info: {
            id: "assistant-output-limit",
            role: "assistant",
            parentID: "user-output-limit",
            agent: "worker",
            providerID: "hightrail-local",
            modelID: "gemma4:12b-it-q8",
            tokens: { input: 25000, output: 4096, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { completed: Date.now() },
            finish: "length",
          },
          parts: [],
        }] : [] }),
        prompt: async () => {
          promptCalls += 1
          throw new Error("Output-limit recovery must not ask the truncated Worker to reformat itself.")
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    const output = {
      title: "Worker result",
      output: `<task id="${workerSessionID}" state="completed"><task_result></task_result></task>`,
      metadata: { sessionId: workerSessionID },
    }

    await hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args: {
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
      },
    } as any, output as any)

    const stored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(promptCalls, 0)
    assert.equal(stored.requests.length, 1)
    assert.equal(stored.requests[0].category, "output-limit")
    assert.match(output.output, /HELP_REQUESTED/)
    assert.match(output.output, /fixed 4096-token output limit/)
    assert.match(output.output, /review_worker_help for H1/)
    assert.equal(output.metadata.workerHelpSynthesized, true)
    assert.equal(output.metadata.workerOutputLimit, true)
    assert.equal(output.metadata.workerOutputTokens, 4096)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("parent hook canonicalizes an invalid return after one required learning correction", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    const workerSessionID = "worker-learning"
    let promptCalls = 0
    let hooks: Awaited<ReturnType<typeof WorkflowGuard>>
    let messages: any[] = [{
      info: { id: "user-1", role: "user" },
      parts: [{ type: "text", text: `Resume ${data.taskPath}` }],
    }, {
      info: {
        id: "assistant-1",
        role: "assistant",
        parentID: "user-1",
        agent: "worker",
        providerID: "hightrail-local",
        modelID: "gemma4:12b-it-q8",
        time: { completed: Date.now() },
        finish: "stop",
      },
      parts: [{
        type: "tool",
        state: {
          status: "error",
          error: [
            "WORKFLOW GUARD BLOCKED",
            "Guard learning ID: abc123",
            "LEARNING_STATUS: NEW",
            "Problem: Worker repeated a stale lifecycle command.",
            "Do next: Continue the active task without restarting its Doctor lifecycle.",
          ].join("\n"),
        },
      }, { type: "text", text: "I could not finish this task." }],
    }]
    const client = {
      session: {
        messages: async ({ path }: any) => ({ data: path.id === workerSessionID ? messages : [] }),
        prompt: async () => {
          promptCalls += 1
          await hooks.tool!.record_guard_learning.execute({
            rule: "Continue an active task without restarting its Doctor lifecycle.",
          }, { agent: "worker", sessionID: workerSessionID, metadata() {} } as any)
          messages = [{
            info: { id: "user-2", role: "user" },
            parts: [{ type: "text", text: "Return the required terminal handoff." }],
          }, {
            info: {
              id: "assistant-2",
              role: "assistant",
              parentID: "user-2",
              agent: "worker",
              providerID: "hightrail-local",
              modelID: "gemma4:12b-it-q8",
              time: { completed: Date.now() },
              finish: "stop",
            },
            parts: [{ type: "text", text: "Still unable to finish." }],
          }]
          return { data: { info: {}, parts: [] } }
        },
      },
    }
    hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    const output = {
      title: "Worker result",
      output: `<task id="${workerSessionID}" state="completed">\n<task_result>\nI could not finish this task.\n</task_result>\n</task>`,
      metadata: { sessionId: workerSessionID },
    }

    await hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args: {
        description: `Execute ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
      },
    } as any, output as any)

    assert.equal(promptCalls, 1)
    assert.match(output.output, /HELP_REQUESTED/)
    assert.match(output.output, /call review_worker_help/)
    assert.doesNotMatch(output.output, /Still unable to finish/)
    assert.equal(output.metadata.workerBlockedCanonicalized, true)
    assert.equal(output.metadata.workerHelpSynthesized, true)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("two equivalent Doctor failures require help despite intervening tools", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    const sessionID = "worker-loop"
    const client = {
      session: {
        messages: async ({ path }: any) => ({ data: path.id === sessionID ? [{
          info: {
            id: "assistant-loop",
            role: "assistant",
            parentID: "user-loop",
            agent: "worker",
            providerID: "hightrail-local",
            modelID: "gemma4:12b-it-q8",
            time: { completed: Date.now() },
            finish: "stop",
          },
          parts: [{ type: "text", text: "BLOCKED, but without the required structure." }],
        }] : [] }),
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await initializeWorkerDoctorLifecycle(hooks, data.root, data.taskPath, sessionID)
    const command = `npm run task:doctor:verify -- ${data.taskPath}`
    const first = "TASK DOCTOR: FAIL\n- FALLOW_NEW_FINDING: unresolved_imports: src/a.ts\n- FALLOW_NEW_FINDING: unlisted_dependencies: (project)\n"
    const second = "TASK DOCTOR: FAIL\n- FALLOW_NEW_FINDING: unlisted_dependencies: (project)\n- FALLOW_NEW_FINDING: unresolved_imports: src/a.ts\n"
    const firstArgs = { command }
    await hooks["tool.execute.before"]!({ sessionID, tool: "bash" } as any, { args: firstArgs } as any)
    await hooks["tool.execute.after"]!({ sessionID, tool: "bash", args: firstArgs } as any, {
      title: "Doctor verify",
      output: first,
      metadata: { exitCode: 1 },
    })
    const readArgs = { filePath: join(data.root, "src/a.ts") }
    await hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, { args: readArgs } as any)
    await hooks["tool.execute.after"]!({ sessionID, tool: "read", args: readArgs } as any, {
      title: "Read source",
      output: "export const value = 1",
      metadata: {},
    })
    const secondArgs = { command }
    await hooks["tool.execute.before"]!({ sessionID, tool: "bash" } as any, { args: secondArgs } as any)
    await hooks["tool.execute.after"]!({ sessionID, tool: "bash", args: secondArgs } as any, {
      title: "Doctor verify",
      output: second,
      metadata: { exitCode: 1 },
    })

    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "grep" } as any, {
      args: { pattern: "value", path: "src/a.ts" },
    }), /WORKER HELP IS TERMINAL[\s\S]*Help ID: H1[\s\S]*parent hook constructs/)

    const output = {
      title: "Worker result",
      output: `<task id="${sessionID}" state="completed">\n<task_result>\nWrong ending.\n</task_result>\n</task>`,
      metadata: { sessionId: sessionID },
    }
    await hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args: {
        description: `Execute ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
      },
    } as any, output as any)
    const stored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.match(output.output, /HELP_REQUESTED/)
    assert.equal(output.metadata.workerReturnCanonicalized, true)
    assert.equal(stored.requests.length, 1)
    assert.equal(stored.requests[0].category, "repeated-doctor-failure")
    assert.equal(stored.requests[0].workerSessionID, sessionID)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("one restore-only outside-Scope Doctor failure immediately becomes terminal Executor help", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    write(join(data.root, "src/outside-changed.ts"), "export const changed = true\n")
    write(join(data.root, "src/whitelisted-changed.ts"), "export const whitelisted = true\n")
    const sessionID = "worker-restore-only"
    let abortCalls = 0
    let promptCalls = 0
    const client = {
      session: {
        messages: async () => ({ data: [] }),
        abort: async ({ path }: any) => {
          assert.equal(path.id, sessionID)
          abortCalls += 1
          return { data: true }
        },
        prompt: async () => {
          promptCalls += 1
          throw new Error("Persisted outside-Scope help must be canonicalized without a model call.")
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await initializeWorkerDoctorLifecycle(hooks, data.root, data.taskPath, sessionID)
    const command = `npm run task:doctor:verify -- ${data.taskPath}`
    const doctorFailure = [
      "TASK DOCTOR: FAIL",
      "- CHANGED_OUTSIDE_SCOPE_FILE: src/outside-changed.ts",
      "- MISSING_OUTSIDE_SCOPE_FILE: src/outside-missing.ts",
      "- WHITELISTED_FILE_CHANGED: src/whitelisted-changed.ts",
      "- WHITELISTED_FILE_MISSING: src/whitelisted-missing.ts",
      "- CHANGED_FILE_ACTION: restore the exact original file bytes.",
      "- MISSING_FILE_ACTION: restore the exact original file bytes. Do not create a placeholder.",
      "- WHITELIST_ACTION: restore the whitelisted file to its recorded content or stop and report the blocker.",
    ].join("\n")
    const deliverDoctorFailure = async () => {
      const args = { command }
      await hooks["tool.execute.before"]!({ sessionID, tool: "bash" } as any, { args } as any)
      await hooks["tool.execute.after"]!({ sessionID, tool: "bash", args } as any, {
        title: "Doctor verify",
        output: doctorFailure,
        metadata: { exitCode: 1 },
      } as any)
    }

    await deliverDoctorFailure()

    const storedAfterDoctor = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(storedAfterDoctor.requests.length, 1)
    assert.equal(storedAfterDoctor.requests[0].id, "H1")
    assert.equal(storedAfterDoctor.requests[0].status, "pending")
    assert.equal(storedAfterDoctor.requests[0].category, "task_scope")
    assert.equal(storedAfterDoctor.requests[0].workerSessionID, sessionID)
    assert.equal(storedAfterDoctor.requests[0].taskPath, data.taskPath)
    assert.equal(storedAfterDoctor.requests[0].taskHash, data.state.taskHash)
    assert.deepEqual(storedAfterDoctor.requests[0].relevantFiles, [
      data.taskPath,
      "src/outside-changed.ts",
      "src/outside-missing.ts",
      "src/whitelisted-changed.ts",
      "src/whitelisted-missing.ts",
    ])
    assert.match(storedAfterDoctor.requests[0].evidence.join("\n"), /CHANGED_OUTSIDE_SCOPE_FILE: src\/outside-changed\.ts/)
    assert.match(storedAfterDoctor.requests[0].evidence.join("\n"), /WHITELISTED_FILE_MISSING: src\/whitelisted-missing\.ts/)
    assert.equal(abortCalls, 1)

    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: { filePath: join(data.root, "src/a.ts") },
    }), /WORKER HELP IS TERMINAL[\s\S]*Help ID: H1[\s\S]*parent hook constructs/)

    const output = {
      title: "Worker result",
      output: `<task id="${sessionID}" state="interrupted"></task>`,
      metadata: { sessionId: sessionID },
    }
    await hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args: {
        description: `Execute ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
      },
    } as any, output as any)

    const storedAfterParent = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(promptCalls, 0)
    assert.equal(storedAfterParent.requests.length, 1)
    assert.match(output.output, /HELP_REQUESTED/)
    assert.match(output.output, /Help ID: H1/)
    assert.match(output.output, /CHANGED_OUTSIDE_SCOPE_FILE: src\/outside-changed\.ts/)
    assert.doesNotMatch(output.output, /state="interrupted"/)
    assert.equal(output.metadata.workerReturnValidated, true)
    assert.equal(output.metadata.workerReturnCanonicalized, true)
    assert.equal(output.metadata.workerHelpSynthesized, true)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("a mixed outside-Scope and VERIFY_FAILED Doctor result stays non-terminal", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    write(join(data.root, "src/outside.ts"), "export const outside = true\n")
    const sessionID = "worker-mixed-doctor"
    let abortCalls = 0
    const client = {
      session: {
        abort: async () => {
          abortCalls += 1
          return { data: true }
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await initializeWorkerDoctorLifecycle(hooks, data.root, data.taskPath, sessionID)
    const command = `npm run task:doctor:verify -- ${data.taskPath}`
    const doctorArgs = { command }
    await hooks["tool.execute.before"]!({ sessionID, tool: "bash" } as any, { args: doctorArgs } as any)
    await hooks["tool.execute.after"]!({ sessionID, tool: "bash", args: doctorArgs } as any, {
      title: "Doctor verify",
      output: [
        "TASK DOCTOR: FAIL",
        "- CHANGED_OUTSIDE_SCOPE_FILE: src/outside.ts",
        "- CHANGED_FILE_ACTION: restore the exact original file bytes.",
        "- VERIFY_FAILED: expected exit 0, got 1: npm run typecheck",
      ].join("\n"),
      metadata: { exitCode: 1 },
    } as any)

    const stored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(stored.requests.length, 0)
    assert.equal(abortCalls, 0)
    await assert.doesNotReject(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: { filePath: join(data.root, "src/a.ts") },
    }))
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("outside-Scope help remains durable when best-effort Worker abort fails", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    write(join(data.root, "src/outside.ts"), "export const outside = true\n")
    const sessionID = "worker-abort-failed"
    let abortCalls = 0
    let promptCalls = 0
    const client = {
      session: {
        messages: async () => ({ data: [] }),
        abort: async () => {
          abortCalls += 1
          throw new Error("simulated abort transport failure")
        },
        prompt: async () => {
          promptCalls += 1
          throw new Error("Durable outside-Scope help must not depend on another model call.")
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await initializeWorkerDoctorLifecycle(hooks, data.root, data.taskPath, sessionID)
    const command = `npm run task:doctor:verify -- ${data.taskPath}`
    const doctorArgs = { command }
    await hooks["tool.execute.before"]!({ sessionID, tool: "bash" } as any, { args: doctorArgs } as any)
    await hooks["tool.execute.after"]!({ sessionID, tool: "bash", args: doctorArgs } as any, {
      title: "Doctor verify",
      output: [
        "TASK DOCTOR: FAIL",
        "- CHANGED_OUTSIDE_SCOPE_FILE: src/outside.ts",
        "- CHANGED_FILE_ACTION: restore the exact original file bytes.",
      ].join("\n"),
      metadata: { exitCode: 1 },
    } as any)

    const stored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(abortCalls, 1)
    assert.equal(stored.requests.length, 1)
    assert.equal(stored.requests[0].category, "task_scope")
    assert.equal(stored.requests[0].workerSessionID, sessionID)

    const output = {
      title: "Worker result",
      output: `<task id="${sessionID}" state="interrupted"></task>`,
      metadata: { sessionId: sessionID },
    }
    await hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args: {
        description: `Execute ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
      },
    } as any, output as any)

    assert.equal(promptCalls, 0)
    assert.match(output.output, /HELP_REQUESTED/)
    assert.match(output.output, /Help ID: H1/)
    assert.equal(output.metadata.workerReturnCanonicalized, true)
    assert.equal(output.metadata.workerHelpSynthesized, true)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("repeated pre-start Doctor failures never require an impossible active-task help call", async () => {
  const data = fixture()
  try {
    rmSync(join(data.root, ".task-doctor/state.json"), { force: true })
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    const sessionID = "worker-prestart"
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID, agent: "worker" } as any, {} as any)
    const command = `npm run task:doctor:start -- ${data.taskPath}`
    for (let index = 1; index <= 3; index += 1) {
      await hooks["tool.execute.after"]!({ sessionID, tool: "bash", args: { command } } as any, {
        title: "Doctor start",
        output: "TASK DOCTOR: FAIL\n- PRESTART_CHANGE: project baseline changed\n",
        metadata: { exitCode: 1 },
      })
      await hooks.event!({ event: {
        type: "message.part.updated",
        properties: {
          sessionID,
          part: {
            id: `start-${index}`,
            sessionID,
            type: "tool",
            tool: "bash",
            state: { status: "error", input: { command }, error: "Doctor start failed" },
          },
        },
      } } as any)
    }
    await assert.doesNotReject(() => hooks["tool.execute.before"]!({ sessionID, tool: "grep" } as any, {
      args: { pattern: "value", path: "src/a.ts" },
    }))
    const stored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(stored.requests.length, 0)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("synthesized loop help preserves the latest transactional tool error", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    const sessionID = "worker-preview-loop"
    const client = {
      session: {
        messages: async ({ path }: any) => ({ data: path.id === sessionID ? [{
          info: {
            id: "assistant-preview-loop",
            role: "assistant",
            parentID: "user-preview-loop",
            agent: "worker",
            providerID: "hightrail-local",
            modelID: "gemma4:12b-it-q8",
            time: { completed: Date.now() },
            finish: "stop",
          },
          parts: [{ type: "text", text: "I could not finish the preview." }],
        }] : [] }),
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID, agent: "worker" } as any, {} as any)
    await hooks["tool.execute.after"]!({
      sessionID,
      tool: "read",
      args: { filePath: join(data.root, "WORKER.md") },
    } as any, { title: "Read Worker rules", output: "", metadata: { truncated: false } })
    const args = {
      task_path: data.taskPath,
      purpose: "Replace the exact current value through a transactional preview.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "missing", new_text: "updated", expected_occurrences: 1 }],
    }
    const error = "Worker replace found 0 exact matches while 1 were expected: src/a.ts"
    for (let index = 1; index <= 2; index += 1) {
      await hooks["tool.execute.before"]!({ sessionID, tool: "preview_worker_changes" } as any, { args: structuredClone(args) })
      await hooks.event!({ event: {
        type: "message.part.updated",
        properties: {
          sessionID,
          part: {
            id: `preview-${index}`,
            sessionID,
            type: "tool",
            tool: "preview_worker_changes",
            state: { status: "error", input: structuredClone(args), error },
          },
        },
      } } as any)
    }
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "preview_worker_changes" } as any, {
      args: structuredClone(args),
    }), /MODEL LOOP STOP[\s\S]*Worker replace found/)

    const output = {
      title: "Worker result",
      output: `<task id="${sessionID}" state="completed">\n<task_result>\nWrong ending.\n</task_result>\n</task>`,
      metadata: { sessionId: sessionID },
    }
    await hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args: {
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
      },
    } as any, output as any)

    const stored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(output.metadata.workerHelpSynthesized, true)
    assert.equal(stored.requests[0].category, "replace-occurrence-none")
    assert.ok(stored.requests[0].evidence.includes(error))
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("request_executor_help rejects unresolved Guard learnings before persisting help", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    const messages = [{ info: { id: "user-1", role: "user" }, parts: [{ type: "text", text: "Continue." }] }, {
      info: { id: "assistant-1", role: "assistant", parentID: "user-1", agent: "worker" },
      parts: [{
        type: "tool",
        tool: "edit",
        state: {
          status: "error",
          error: [
            "WORKFLOW GUARD BLOCKED",
            "Problem: Worker repeated a blocked direct edit.",
            "Do next: Use the transactional preview and apply tools.",
            "Guard learning ID: abcdef",
          ].join("\n"),
        },
      }],
    }]
    const client = { session: { messages: async () => ({ data: messages }) } }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await assert.rejects(() => hooks.tool!.request_executor_help.execute({
      category: "model_loop",
      problem: "The Worker cannot proceed safely after repeated equivalent failures.",
      attempted_actions: ["Read the current source and changed the attempted target once."],
      evidence: ["The same guarded direct edit failed repeatedly without progress."],
      relevant_files: [data.taskPath, "src/a.ts"],
      suggested_next_step: "Review the blocker and delegate a fresh Worker with a transactional strategy.",
    }, { agent: "worker", sessionID: "worker-new", metadata() {} } as any), /WORKER HELP NOT RECORDED[\s\S]*abcdef/)

    const stored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.deepEqual(stored.requests, [])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("request_executor_help repairs missing contextual fields from active state and exact evidence", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    const sessionID = "worker-malformed-help"
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID, agent: "worker" } as any, {} as any)
    const call = {
      args: {
        category: "task_scope",
        attempted_actions: ["Read the failing file and checked the referenced project path once."],
        evidence: [
          "Doctor reported unresolved_imports for src/a.ts after the latest Worker change.",
          "No matching project module exists for the relative specifier.\"],problem:",
        ],
      },
    }

    await hooks["tool.execute.before"]!({ sessionID, tool: "request_executor_help" } as any, call as any)
    assert.deepEqual(Object.keys(call.args).sort(), [
      "attempted_actions",
      "category",
      "evidence",
      "problem",
      "suggested_next_step",
      "task_path",
    ])
    const payload = call.args as any
    assert.equal(payload.task_path, data.taskPath)
    assert.match(payload.problem, /Executor review is required\. Evidence: Doctor reported unresolved_imports/)
    assert.match(payload.suggested_next_step, /Executor should inspect the evidence/)

    await hooks.tool!.request_executor_help.execute(call.args as any, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any)
    const stored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(stored.requests.length, 1)
    assert.equal(stored.requests[0].taskPath, data.taskPath)
    assert.match(stored.requests[0].problem, /unresolved_imports/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("request_executor_help links an explicit retry failure to its delegated parent automatically", async () => {
  const data = fixture()
  try {
    const store = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    store.requests[0] = {
      ...store.requests[0],
      status: "delegated",
      executorReview: {
        sessionID: "executor",
        decision: "retry_worker",
        rootCause: "The original Worker used stale transactional input.",
        retryStrategy: "Retry from the current source file.",
        expectedResults: ["The exact preview succeeds."],
        reviewedFiles: [data.taskPath, "src/a.ts"],
        reviewedAt: "now",
      },
      delegatedAt: "now",
      delegatedWorkerSessionID: "worker-reviewed-retry",
    }
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify(store, null, 2)}\n`)
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)

    await hooks.tool!.request_executor_help.execute({
      task_path: data.taskPath,
      category: "tool_failure",
      problem: "The reviewed retry still used exact text that is absent from the current source file.",
      attempted_actions: ["Re-read the task and attempted one exact transactional replacement."],
      evidence: ["Worker replace expected 1 occurrences but found 0: src/a.ts"],
      relevant_files: ["src/a.ts"],
      suggested_next_step: "Executor should review the current source and decide whether another narrow retry is safe.",
    }, { agent: "worker", sessionID: "worker-reviewed-retry", metadata() {} } as any)

    const updated = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(updated.requests.length, 2)
    assert.equal(updated.requests[1].retryOfHelpID, "H1")
    assert.equal(updated.requests[1].category, "tool_failure")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("request_executor_help self-heals malformed optional context without nesting arguments", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    const sessionID = "worker-explicit-invalid-help"
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID, agent: "worker" } as any, {} as any)
    const call = {
      args: {
        task_path: null,
        category: "test_failure",
        problem: "too short",
        attempted_actions: ["Read the current failing source file once."],
        evidence: ["Doctor verify still reports the same focused test failure."],
        relevant_files: ["src/a.ts"],
        suggested_next_step: 7,
      },
    }

    await assert.doesNotReject(
      () => hooks["tool.execute.before"]!({ sessionID, tool: "request_executor_help" } as any, call as any),
    )
    assert.deepEqual(Object.keys(call.args).sort(), [
      "attempted_actions",
      "category",
      "evidence",
      "problem",
      "relevant_files",
      "suggested_next_step",
      "task_path",
    ])
    const payload = call.args as any
    assert.equal(payload.task_path, data.taskPath)
    assert.equal(payload.problem, "too short")
    assert.equal(payload.suggested_next_step, "7")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("a Worker enriches an automatically persisted Doctor help request with its concrete diagnosis", async () => {
  const data = fixture()
  try {
    const store = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    store.requests[0] = {
      ...store.requests[0],
      workerSessionID: "worker-enrich",
      category: "repeated-doctor-failure",
      problem: "VERIFY_FAILED after the safe duration.",
      evidence: ["task:doctor:verify failed after at least 120000 ms."],
      relevantFiles: [data.taskPath],
    }
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify(store, null, 2)}\n`)
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "worker-enrich", agent: "worker" } as any, {} as any)

    const result = await hooks.tool!.request_executor_help.execute({
      task_path: data.taskPath,
      category: "test_failure",
      problem: "The focused navigation test times out because the expected link is not present in the rendered page.",
      attempted_actions: ["Removed the unresolved helper import and reran the focused Doctor verification."],
      evidence: ["Playwright timed out waiting for the Register link in src/a.ts."],
      relevant_files: ["src/a.ts"],
      suggested_next_step: "Executor should inspect the current test and related task-scoped implementation before choosing a retry.",
    }, { agent: "worker", sessionID: "worker-enrich", metadata() {} } as any)

    const updated = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(updated.id, "H1")
    assert.equal(updated.category, "test_failure")
    assert.match(updated.problem, /expected link is not present/)
    assert.ok(updated.evidence.some((entry: string) => /Playwright timed out/.test(entry)))
    assert.deepEqual(updated.relevantFiles, [data.taskPath, "src/a.ts"])
    assert.equal(result.metadata.enriched, true)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("review without help_id closes stale lifecycles and selects only the active matching request", async () => {
  const data = fixture()
  try {
    const completedTaskPath = "kanban/todo/00-completed.md"
    const completedTaskContent = "# Completed task\n"
    write(join(data.root, "kanban/done/00-completed.md"), completedTaskContent)
    const base = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    const requests = [
      {
        ...base,
        id: "H1",
        taskPath: completedTaskPath,
        taskHash: digest(completedTaskContent),
        workerSessionID: "worker-completed",
        problem: "A completed task retained a stale pending help request.",
        relevantFiles: [completedTaskPath],
      },
      {
        ...base,
        id: "H6",
        taskHash: "0".repeat(64),
        workerSessionID: "worker-old-hash",
        problem: "An earlier task revision retained a stale pending help request.",
      },
      {
        ...base,
        id: "H27",
        taskHash: data.state.taskHash,
        workerSessionID: "worker-current",
        problem: "The current task revision needs one Executor review.",
      },
    ]
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests, updatedAt: "now" }, null, 2)}\n`)

    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result: any = await hooks.tool!.review_worker_help.execute(
      {},
      { agent: "executor", sessionID: "executor-lifecycle-selection", metadata() {} } as any,
    )

    assert.match(result.title, /H27/)
    const updated = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests
    const byID = new Map(updated.map((request: any) => [request.id, request]))
    assert.equal((byID.get("H1") as any).status, "resolved")
    assert.equal((byID.get("H1") as any).closureReason, "task_completed")
    assert.equal((byID.get("H6") as any).status, "obsolete")
    assert.equal((byID.get("H6") as any).closureReason, "task_hash_replaced")
    assert.equal((byID.get("H27") as any).status, "retry_approved")
    assert.equal((byID.get("H27") as any).executorReview.rootCause, "The current task revision needs one Executor review.")
    assert.equal((byID.get("H27") as any).executorReview.retryStrategy, base.suggestedNextStep)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("review backfills retry ancestry and advances the exact follow-up receipt", async () => {
  const data = fixture()
  try {
    const base = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    const parent = {
      ...base,
      id: "H26",
      status: "delegated",
      workerSessionID: "worker-original",
      executorReview: {
        sessionID: "executor",
        decision: "retry_worker",
        rootCause: "The original Worker used stale transactional input.",
        retryStrategy: "Retry from the exact current source file.",
        expectedResults: ["The exact preview succeeds."],
        reviewedFiles: [data.taskPath, "src/a.ts"],
        reviewedAt: "now",
      },
      delegatedAt: "now",
      delegatedWorkerSessionID: "worker-follow-up",
    }
    const followUp = {
      ...base,
      id: "H27",
      workerSessionID: "worker-follow-up",
      category: "tool_failure",
      problem: "The delegated retry produced a new help request before retry ancestry was persisted.",
      attemptedActions: ["Ran the exact Executor-reviewed retry once against the active task."],
      evidence: ["Worker replace expected 1 occurrences but found 0: src/a.ts"],
      relevantFiles: [data.taskPath, "src/a.ts"],
      suggestedNextStep: "Review the follow-up while preserving its existing evidence and lifecycle fields.",
      createdAt: "later",
    }
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [parent, followUp], updatedAt: "now" }, null, 2)}\n`)

    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result: any = await hooks.tool!.review_worker_help.execute(
      {},
      { agent: "executor", sessionID: "executor-retry-backfill", metadata() {} } as any,
    )

    assert.match(result.title, /H27/)
    const updated = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests
      .find((request: any) => request.id === "H27")
    const { retryOfHelpID, status, executorReview, ...preserved } = updated
    const { status: originalStatus, ...originalFields } = followUp
    assert.equal(retryOfHelpID, "H26")
    assert.equal(originalStatus, "pending")
    assert.equal(status, "retry_approved")
    assert.equal(executorReview.rootCause, followUp.problem)
    assert.equal(executorReview.retryStrategy, followUp.suggestedNextStep)
    assert.deepEqual(executorReview.expectedResults, followUp.evidence)
    assert.deepEqual(preserved, originalFields)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("a partial Worker-help primary is restored from the durable backup", async () => {
  const data = fixture()
  try {
    await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const primary = join(data.root, ".task-doctor/worker-help.json")
    const backup = join(data.root, ".task-doctor/worker-help.backup.json")
    assert.equal(existsSync(backup), true)
    write(primary, '{"version":1,"requests":[')
    write(join(data.root, ".task-doctor/.worker-help.999.1.tmp"), "partial unpublished data")

    await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)

    const restored = JSON.parse(readFileSync(primary, "utf8"))
    assert.equal(restored.requests.length, 1)
    assert.equal(restored.requests[0].id, "H1")
    assert.deepEqual(restored, JSON.parse(readFileSync(backup, "utf8")))
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Worker-help persistence fails closed when primary and backup are both corrupt", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), "not-json")
    write(join(data.root, ".task-doctor/worker-help.backup.json"), '{"version":1,"requests":"lost"}')

    await assert.rejects(
      WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any),
      /WORKER HELP STORE CORRUPT[\s\S]*refusing to continue with an empty workflow/,
    )
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("concurrent Worker-help requests are serialized with unique IDs and no lost entry", async () => {
  const data = fixture()
  try {
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({ version: 1, requests: [], updatedAt: "now" }, null, 2)}\n`)
    const client = { session: { messages: async () => ({ data: [] }) } }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    const execute = hooks.tool!.request_executor_help.execute
    const args = (sessionID: string) => ({
      task_path: data.taskPath,
      category: "tool_failure" as const,
      problem: `Worker ${sessionID} encountered an independent deterministic tool failure.`,
      attempted_actions: ["Read the active task and reproduced the exact failure once."],
      evidence: [`The transactional tool returned a stable failure for ${sessionID}.`],
      relevant_files: [data.taskPath, "src/a.ts"],
      suggested_next_step: "Executor should inspect this exact failure and choose one bounded fresh retry.",
    })
    const context = (sessionID: string) => ({ agent: "worker", sessionID, metadata() {} } as any)

    const [first, second] = await Promise.all([
      execute(args("worker-concurrent-a"), context("worker-concurrent-a")),
      execute(args("worker-concurrent-b"), context("worker-concurrent-b")),
    ])

    const stored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(stored.requests.length, 2)
    assert.deepEqual(stored.requests.map((request: any) => request.id), ["H1", "H2"])
    assert.deepEqual(new Set(stored.requests.map((request: any) => request.workerSessionID)), new Set(["worker-concurrent-a", "worker-concurrent-b"]))
    assert.notEqual(first.metadata.helpID, second.metadata.helpID)
    assert.deepEqual(stored, JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.backup.json"), "utf8")))
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

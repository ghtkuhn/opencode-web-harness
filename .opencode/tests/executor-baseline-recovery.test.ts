import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { taskHarnessRecoveryStatus } from "../lib/task-harness-recovery.ts"
import { WorkflowGuard } from "../plugins/workflow-guard.ts"

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function digest(content: string) {
  return createHash("sha256").update(content).digest("hex")
}

function fixture(withRecovery = false) {
  const root = mkdtempSync(join(tmpdir(), "executor-baseline-recovery-"))
  const taskPath = "kanban/todo/01-task.md"
  const taskContent = "# Task\n\n## Scope\n- `src/a.ts`\n\n## Requirement\nKeep value stable.\n"
  const beforeAgents = "# Old rules\n"
  const afterAgents = "# Current rules\n"
  const familyRules = "# Gemma rules\n"
  write(join(root, "project.json"), JSON.stringify({
    settings: {
      opencode: {
        workflowGuard: { executorBaselineRecovery: true, executorReview: true, transactionalWorkerChanges: true, guardLearning: true },
        readOnlyAgentPaths: ["WORKER-GEMMA4.md"],
      },
    },
  }))
  write(join(root, "kanban/TASK.md"), "# Template\n")
  write(join(root, "scripts/task-doctor.mjs"), [
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'",
    "const config = JSON.parse(readFileSync('.task-doctor/mechanical-doctor.json', 'utf8'))",
    "appendFileSync('.task-doctor/mechanical-doctor-count', '1\\n')",
    "if (config.executorRecovery) {",
    "  const statePath = '.task-doctor/state.json'",
    "  const state = JSON.parse(readFileSync(statePath, 'utf8'))",
    "  state.executorRecovery = config.executorRecovery",
    "  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n')",
    "}",
    "process.stdout.write(String(config.output ?? ''))",
    "process.exit(Number(config.exitCode ?? 1))",
    "",
  ].join("\n"))
  write(join(root, "WORKER.md"), "# Worker rules\n")
  write(join(root, taskPath), taskContent)
  write(join(root, "src/a.ts"), "export const value = 1\n")
  write(join(root, "AGENTS.md"), afterAgents)
  write(join(root, "WORKER-GEMMA4.md"), familyRules)
  const state: any = {
    version: 4,
    status: "started",
    taskPath,
    taskHash: digest(taskContent),
    snapshot: { "AGENTS.md": digest(beforeAgents), "src/a.ts": digest("export const value = 1\n") },
  }
  if (withRecovery) {
    state.executorRecovery = {
      status: "required",
      code: "HARNESS_BASELINE_DRIFT",
      taskPath,
      taskHash: state.taskHash,
      paths: [
        { path: "AGENTS.md", beforeHash: digest(beforeAgents), afterHash: digest(afterAgents) },
        { path: "WORKER-GEMMA4.md", beforeHash: null, afterHash: digest(familyRules) },
      ],
      detectedAt: "now",
    }
  }
  write(join(root, ".task-doctor/state.json"), `${JSON.stringify(state, null, 2)}\n`)
  return { root, taskPath }
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

function configureMechanicalDoctor(root: string, output: string, executorRecovery: any) {
  write(join(root, ".task-doctor/mechanical-doctor.json"), `${JSON.stringify({ output, exitCode: 1, executorRecovery })}\n`)
  rmSync(join(root, ".task-doctor/mechanical-doctor-count"), { force: true })
}

function writePendingWorkerHelp(root: string, taskPath: string, id = "H8") {
  const taskHash = JSON.parse(readFileSync(join(root, ".task-doctor/state.json"), "utf8")).taskHash
  write(join(root, ".task-doctor/worker-help.json"), `${JSON.stringify({
    version: 1,
    requests: [{
      version: 1,
      id,
      status: "pending",
      taskPath,
      taskHash,
      workerSessionID: "blocked-worker",
      category: "tool_failure",
      problem: "The Worker stopped after a transactional tool failure that still requires Executor review.",
      attemptedActions: ["The Worker attempted one exact transactional change."],
      evidence: ["The transactional tool rejected stale input without changing the project."],
      relevantFiles: [taskPath, "src/a.ts"],
      suggestedNextStep: "Executor must review the live help before another Worker is delegated.",
      createdAt: "2026-07-16T00:00:00.000Z",
    }],
    updatedAt: "2026-07-16T00:00:00.000Z",
  }, null, 2)}\n`)
}

test("canonical Worker delegation discards Executor code and duplicate lifecycle prose", async () => {
  const data = fixture()
  try {
    const statePath = join(data.root, ".task-doctor/state.json")
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    writeFileSync(statePath, `${JSON.stringify({ ...state, memoryAction: "append" }, null, 2)}\n`)
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const originalArgs = {
      subagent_type: "worker",
      description: `Wait for TASK DOCTOR: STARTED before touching ${data.taskPath}`,
      prompt: `Run task:doctor:start for ${data.taskPath}.\nimport { dangerous } from "./copy";\nAfter TASK DOCTOR: PASS return REVIEWABLE.\nAfter TASK DOCTOR: PASS return REVIEWABLE.`,
    }
    const output = { args: originalArgs }
    await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task" } as any, output as any)
    assert.equal(output.args, originalArgs)
    assert.equal(output.args.description, `Resume ${data.taskPath}`)
    assert.match(output.args.prompt, /^ACTIVE TASK RESUME/)
    assert.match(output.args.prompt, /already TASK DOCTOR: STARTED/)
    assert.match(output.args.prompt, /do not wait for another STARTED message/)
    assert.match(output.args.prompt, /Harness runs Doctor verify mechanically before that read/)
    assert.match(output.args.prompt, /first named in-scope file/)
    assert.match(output.args.prompt, /Each preview may target exactly one project file/)
    assert.doesNotMatch(output.args.prompt, /include every exact target in one change set/)
    assert.doesNotMatch(output.args.prompt, /Run task:doctor:start/)
    assert.doesNotMatch(output.args.prompt, /import \{ dangerous \}/)
    assert.equal((output.args.prompt.match(/TERMINAL RETURN CONTRACT/g) ?? []).length, 1)
    assert.equal((output.args.prompt.match(/After TASK DOCTOR: PASS/g) ?? []).length, 1)
    assert.match(output.args.prompt, /before its first apply_worker_changes call, call append_task_memory exactly once/)
    assert.match(output.args.prompt, /After Doctor PASS, return REVIEWABLE immediately/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Planner and Executor cannot read Worker-only rule files", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    await assert.rejects(hooks["tool.execute.before"]!({ sessionID: "executor", tool: "read" } as any, {
      args: { filePath: join(data.root, "WORKER-GEMMA4.md") },
    }), /Worker-only system context/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Harness drift is terminal for Worker and recoverable only by Executor", async () => {
  const data = fixture(true)
  try {
    const taskHash = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8")).taskHash
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({
      version: 1,
      requests: [{
        version: 1,
        id: "H7",
        status: "retry_approved",
        taskPath: data.taskPath,
        taskHash,
        workerSessionID: "previous-worker",
        category: "test_failure",
        problem: "The previous Worker needs a reviewed retry.",
        attemptedActions: [],
        evidence: ["The focused test failed."],
        relevantFiles: [data.taskPath, "src/a.ts"],
        suggestedNextStep: "Review current evidence.",
        createdAt: "2026-07-16T00:00:00.000Z",
        executorReview: {
          sessionID: "executor",
          decision: "retry_worker",
          rootCause: "Old Harness review.",
          retryStrategy: "Retry under old rules.",
          expectedResults: ["The test passes."],
          reviewedFiles: [data.taskPath, "src/a.ts"],
          reviewedAt: "2026-07-16T00:01:00.000Z",
        },
      }],
      updatedAt: "2026-07-16T00:01:00.000Z",
    }, null, 2)}\n`)
    write(join(data.root, ".task-doctor/last-doctor-failure.json"), JSON.stringify({
      version: 1,
      sessionID: "worker",
      taskPath: data.taskPath,
      gate: "verify",
      output: "TASK DOCTOR: EXECUTOR RECOVERY REQUIRED\n- HARNESS_BASELINE_DRIFT: AGENTS.md",
      failedAt: new Date().toISOString(),
    }))
    write(join(data.root, ".task-doctor/planner-recovery.json"), JSON.stringify({
      version: 1,
      status: "incomplete",
      taskPath: data.taskPath,
      taskHash: JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8")).taskHash,
    }))
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "worker", agent: "worker" } as any, {} as any)
    await assert.rejects(hooks["tool.execute.before"]!({ sessionID: "worker", tool: "bash" } as any, {
      args: { command: "git checkout -- AGENTS.md" },
    }), /Required owner: Executor/)

    const result = await hooks.tool!.recover_harness_baseline.execute({
      task_path: data.taskPath,
      paths: ["AGENTS.md", "WORKER-GEMMA4.md"],
      reason: "The Harness files were updated independently of the active application task.",
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any)
    assert.match(result.output, /EXECUTOR RECOVERY COMPLETE/)
    assert.match(result.output, /Re-review H7/)
    assert.equal(taskHarnessRecoveryStatus(data.root), null)
    const help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "pending")
    assert.equal(help.executorReview, undefined)
    assert.equal(readFileSync(join(data.root, ".task-doctor/authorized-harness-changes.json"), "utf8").includes('"recoveryID": "H1"'), true)
    assert.throws(() => readFileSync(join(data.root, ".task-doctor/planner-recovery.json"), "utf8"))
    assert.throws(() => readFileSync(join(data.root, ".task-doctor/last-doctor-failure.json"), "utf8"))

    await assert.rejects(hooks.tool!.recover_harness_baseline.execute({
      task_path: data.taskPath,
      paths: ["AGENTS.md", "WORKER-GEMMA4.md"],
      reason: "The same resolved Harness transition must not be requested a second time.",
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any), /Review H7 .* before delegating/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Harness recovery success directs Executor to live pending Worker help", async () => {
  const data = fixture(true)
  try {
    writePendingWorkerHelp(data.root, data.taskPath)
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)

    const result = await hooks.tool!.recover_harness_baseline.execute({
      task_path: data.taskPath,
      paths: ["AGENTS.md", "WORKER-GEMMA4.md"],
      reason: "The Harness files were updated independently of the active application task.",
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any)

    assert.match(result.output, /Review H8 with review_worker_help/)
    assert.doesNotMatch(result.output, /Delegate one fresh Worker/)
    assert.equal(taskHarnessRecoveryStatus(data.root), null)
    assert.equal(JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0].status, "pending")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("repeated Harness recovery still directs Executor to live pending Worker help", async () => {
  const data = fixture(true)
  try {
    writePendingWorkerHelp(data.root, data.taskPath)
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)

    await hooks.tool!.recover_harness_baseline.execute({
      task_path: data.taskPath,
      paths: ["AGENTS.md", "WORKER-GEMMA4.md"],
      reason: "The Harness files were updated independently of the active application task.",
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any)

    await assert.rejects(hooks.tool!.recover_harness_baseline.execute({
      task_path: data.taskPath,
      paths: ["AGENTS.md", "WORKER-GEMMA4.md"],
      reason: "The same resolved Harness transition must not be requested a second time.",
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any), (error: any) => {
      assert.match(String(error), /Review H8 with review_worker_help/)
      assert.doesNotMatch(String(error), /Delegate one fresh Worker/)
      return true
    })
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("live-shape Harness failure aborts Worker and canonicalizes despite an open learning", async () => {
  const data = fixture(true)
  try {
    const statePath = join(data.root, ".task-doctor/state.json")
    const stateWithRecovery = JSON.parse(readFileSync(statePath, "utf8"))
    const stateBeforeDoctor = { ...stateWithRecovery }
    delete stateBeforeDoctor.executorRecovery
    write(statePath, `${JSON.stringify(stateBeforeDoctor, null, 2)}\n`)
    configureMechanicalDoctor(data.root, [
      "TASK DOCTOR: EXECUTOR RECOVERY REQUIRED",
      "- HARNESS_BASELINE_DRIFT: AGENTS.md",
    ].join("\n"), stateWithRecovery.executorRecovery)
    const aborted: string[] = []
    let promptCalls = 0
    const guardError = [
      "WORKFLOW GUARD BLOCKED",
      "Guard learning ID: bbbf8d",
      "LEARNING_STATUS: NEW",
      "Problem: Worker attempted another action after applying one project file.",
      `Do next: Run npm run task:doctor:verify -- ${data.taskPath} before another change.`,
    ].join("\n")
    const client = {
      session: {
        abort: async ({ path }: any) => {
          aborted.push(path.id)
          return { data: true }
        },
        messages: async ({ path }: any) => ({ data: path.id === "worker" ? [{
          info: { id: "user-1", role: "user" },
          parts: [{ type: "text", text: `Resume ${data.taskPath}.` }],
        }, {
          info: {
            id: "assistant-finished",
            role: "assistant",
            parentID: "user-1",
            agent: "worker",
            providerID: "llamacpp-local",
            modelID: "gemma4-12b-mtp",
            time: { created: Date.now() - 1, completed: Date.now() },
            finish: "stop",
          },
          parts: [{
            type: "tool",
            tool: "read",
            state: { status: "error", error: guardError },
          }, { type: "text", text: "Doctor reported Harness recovery without the required handoff." }],
        }] : [] }),
        prompt: async () => {
          promptCalls += 1
          throw new Error("Terminal Harness recovery must not ask Worker for another model turn.")
        },
        promptAsync: async () => {
          promptCalls += 1
          throw new Error("Terminal Harness recovery must not auto-resume Worker for pending learnings.")
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await initializeWorkerDoctorLifecycle(hooks, data.root, data.taskPath, "worker")
    await hooks.tool!.verify_worker_task.execute({}, {
      agent: "worker",
      sessionID: "worker",
      abort: new AbortController().signal,
      metadata() {},
    } as any)
    assert.deepEqual(aborted, ["worker"])

    const transformed = { messages: [{
      info: { id: "worker-user", sessionID: "worker", role: "user" },
      parts: [{ type: "text", text: "Continue." }],
    }] as any[] }
    await hooks["experimental.chat.messages.transform"]!({} as any, transformed as any)
    assert.doesNotMatch(transformed.messages.map((message) => message.parts?.map((part: any) => part.text).join("\n")).join("\n"), /Pending Guard learnings/)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "worker" } } } as any)
    assert.equal(promptCalls, 0)

    const parentOutput = {
      title: "Worker interrupted",
      output: '<task id="worker" state="interrupted"></task>',
      metadata: { sessionId: "worker" },
    }
    await hooks["tool.execute.after"]!({
      sessionID: "executor",
      tool: "task",
      args: {
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
      },
    } as any, parentOutput as any)

    assert.match(parentOutput.output, /BLOCKED/)
    assert.match(parentOutput.output, /Required owner: Executor/)
    assert.match(parentOutput.output, /call recover_harness_baseline/)
    assert.doesNotMatch(parentOutput.output, /without the required handoff/)
    assert.equal(parentOutput.metadata.workerBlockedCanonicalized, true)
    assert.equal(promptCalls, 0)
    assert.equal(existsSync(join(data.root, ".task-doctor/pending-guard-learnings.json")), false)
    const workerRules = readFileSync(join(data.root, "WORKER.md"), "utf8")
    assert.match(workerRules, /\[5c9976\]/)
    assert.doesNotMatch(workerRules, /\[bbbf8d\]/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

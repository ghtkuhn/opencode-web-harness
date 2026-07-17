import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { claimPlannerOwnership, readPlannerOwnership } from "../lib/planner-ownership.ts"
import { WorkflowGuard } from "../plugins/workflow-guard.ts"

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function digest(content: string) {
  return createHash("sha256").update(content).digest("hex")
}

function fixture(active = false) {
  const root = mkdtempSync(join(tmpdir(), "planner-recovery-"))
  const taskPath = "kanban/todo/01-task.md"
  const taskContent = "# Task\n\n## Scope\n- `src/a.ts`\n\n## Requirement\nOriginal.\n"
  write(join(root, "project.json"), JSON.stringify({ settings: { opencode: { workflowGuard: { plannerRecovery: true } } } }))
  write(join(root, "kanban/TASK.md"), "# Template\n")
  write(join(root, "scripts/task-doctor.mjs"), "")
  write(join(root, taskPath), taskContent)
  write(join(root, "src/a.ts"), "export const value = 1\n")
  if (active) {
    write(join(root, ".task-doctor/state.json"), JSON.stringify({
      version: 4,
      status: "started",
      taskPath,
      taskHash: digest(taskContent),
      snapshot: { "src/a.ts": "before" },
    }))
  }
  return { root, taskPath, taskContent }
}

function authorizePlannerBlocker(root: string, taskPath: string) {
  const state = JSON.parse(readFileSync(join(root, ".task-doctor/state.json"), "utf8"))
  write(join(root, ".task-doctor/authoritative-planner-blocker.json"), JSON.stringify({
    version: 1,
    owner: "Planner",
    taskPath,
    taskHash: state.taskHash,
    workerSessionID: "worker-blocked",
    executorSessionID: "executor",
    recordedAt: "now",
  }))
}

test("the latest Planner that writes or registers a task becomes its owner", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "planner-one", agent: "planner" } as any, {} as any)
    write(join(data.root, data.taskPath), data.taskContent.replace("Original.", "First revision."))
    await hooks["tool.execute.after"]!({
      sessionID: "planner-one",
      tool: "write",
      args: { filePath: join(data.root, data.taskPath) },
    } as any, { title: "write", output: "written", metadata: {} })
    assert.equal(readPlannerOwnership(data.root, data.taskPath)?.plannerSessionID, "planner-one")
    assert.equal(readPlannerOwnership(data.root, data.taskPath)?.source, "task_write")

    await hooks["chat.message"]!({ sessionID: "planner-two", agent: "planner" } as any, {} as any)
    await hooks["tool.execute.after"]!({
      sessionID: "planner-two",
      tool: "bash",
      args: { command: `npm run task:doctor:register -- ${data.taskPath}` },
    } as any, { title: "register", output: `TASK DOCTOR: REGISTERED ${data.taskPath}`, metadata: { exitCode: 0 } })
    const ownership = readPlannerOwnership(data.root, data.taskPath)
    assert.equal(ownership?.plannerSessionID, "planner-two")
    assert.equal(ownership?.source, "registration")
    assert.equal(ownership?.taskHash, digest(readFileSync(join(data.root, data.taskPath), "utf8")))
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Executor returns a pre-start task to its owning Planner and resumes scheduling", async () => {
  const data = fixture()
  try {
    write(join(data.root, "kanban/todo/00-earlier.md"), data.taskContent.replace("Original.", "Earlier queued task."))
    claimPlannerOwnership(data.root, {
      taskPath: data.taskPath,
      plannerSessionID: "planner-original",
      plannerAgent: "planner",
      source: "task_write",
    })
    write(join(data.root, ".task-doctor/last-doctor-failure.json"), JSON.stringify({
      version: 1,
      sessionID: "executor",
      taskPath: data.taskPath,
      gate: "lint",
      output: `TASK DOCTOR: FAIL\n- TASK_FORMAT: ${data.taskPath}: dependency must be an exact task filename.`,
    }))
    const correctedContent = data.taskContent.replace("Original.", "Corrected before task start.")
    write(join(data.root, "project.json"), JSON.stringify({
      settings: { opencode: {
        agentModels: { planner: "llamacpp-local/gemma4-12b-mtp-reasoning" },
        workflowGuard: { plannerRecovery: true },
      } },
    }))
    let hooks: Awaited<ReturnType<typeof WorkflowGuard>>
    let recoveryPrompt = ""
    let recoveryModel: any = null
    const client = {
      session: {
        get: async () => ({ data: { id: "planner-original", directory: data.root } }),
        messages: async () => ({ data: [{
          info: {
            id: "assistant-old-model",
            role: "assistant",
            agent: "planner",
            providerID: "hightrail-local",
            modelID: "gemma4:12b-it-q8-reasoning",
            time: { completed: Date.now() },
          },
          parts: [{ type: "text", text: "Old Planner turn." }],
        }] }),
        prompt: async ({ body }: any) => {
          recoveryPrompt = body.parts[0].text
          recoveryModel = body.model
          await hooks["chat.message"]!({ sessionID: "planner-original", agent: "planner" } as any, {} as any)
          write(join(data.root, data.taskPath), correctedContent)
          await hooks["tool.execute.after"]!({
            sessionID: "planner-original",
            tool: "edit",
            args: {
              filePath: join(data.root, data.taskPath),
              oldString: "Original.",
              newString: "Corrected before task start.",
            },
          } as any, { title: "edit", output: "edited", metadata: {} })
          const taskHash = digest(correctedContent)
          write(join(data.root, ".task-doctor/registrations/01-task.md.json"), JSON.stringify({
            status: "registered",
            taskPath: data.taskPath,
            taskHash,
          }))
          await hooks["tool.execute.after"]!({
            sessionID: "planner-original",
            tool: "bash",
            args: { command: `npm run task:doctor:register -- ${data.taskPath}` },
          } as any, {
            title: "register",
            output: `TASK DOCTOR: REGISTERED ${data.taskPath}`,
            metadata: { exitCode: 0 },
          })
          return { data: { info: {}, parts: [] } }
        },
      },
    }
    hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const result = await hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: "Doctor rejected the queued task definition before it could be started.",
      evidence: [`TASK_FORMAT: ${data.taskPath}: dependency must be an exact task filename.`],
      expected_results: ["The corrected queued task passes Doctor lint and registration."],
      relevant_files: [data.taskPath],
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any)

    assert.match(recoveryPrompt, /task has not started/i)
    assert.match(recoveryPrompt, /Doctor lint command and the exact Doctor register command/i)
    assert.doesNotMatch(recoveryPrompt, /Call revise_active_task once/)
    assert.deepEqual(recoveryModel, { providerID: "llamacpp-local", modelID: "gemma4-12b-mtp-reasoning" })
    assert.match(result.output, /PLANNER RECOVERY COMPLETE/)
    assert.match(result.output, /task:doctor:schedule again/)
    assert.equal(readFileSync(join(data.root, data.taskPath), "utf8"), correctedContent)
    assert.equal(readPlannerOwnership(data.root, data.taskPath)?.source, "registration")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("pre-start recovery rejects structured contracts instead of silently ignoring them", async () => {
  const data = fixture()
  try {
    claimPlannerOwnership(data.root, {
      taskPath: data.taskPath,
      plannerSessionID: "planner-original",
      plannerAgent: "planner",
      source: "task_write",
    })
    write(join(data.root, ".task-doctor/last-doctor-failure.json"), JSON.stringify({
      version: 1,
      sessionID: "executor",
      taskPath: data.taskPath,
      gate: "lint",
      output: `TASK DOCTOR: FAIL\n- TASK_FORMAT: ${data.taskPath}: invalid queued task.`,
    }))
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: { session: {} } } as any)
    await assert.rejects(hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: "The queued task requires its normal pre-start Planner correction path.",
      evidence: ["Doctor rejected the queued task during lint before it was started."],
      expected_results: ["The owning Planner corrects and registers the queued task."],
      relevant_files: [data.taskPath],
      required_scope: ["src/a.ts"],
      required_requirements: ["The queued task uses canonical structure."],
      required_verify: ["npm test"],
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any), /supported only for the exact active started task/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Executor stops when the recorded Planner session ID is invalid", async () => {
  const data = fixture(true)
  try {
    claimPlannerOwnership(data.root, {
      taskPath: data.taskPath,
      plannerSessionID: "planner-deleted",
      plannerAgent: "planner",
      source: "registration",
    })
    authorizePlannerBlocker(data.root, data.taskPath)
    const client = {
      session: {
        get: async () => ({ error: { name: "NotFound", message: "missing" } }),
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const result = await hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: "The active task contains an invalid verification command that only Planner may correct.",
      evidence: ["Doctor rejected the Verify command as invalid shell syntax."],
      expected_results: ["The corrected task passes Doctor lint and is registered."],
      relevant_files: [data.taskPath, "src/a.ts"],
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any)
    assert.match(result.output, /PLANNER UNAVAILABLE/)
    assert.match(result.output, /planner-deleted/)
    assert.match(result.output, /user must open a Planner/i)
    const recovery = JSON.parse(readFileSync(join(data.root, ".task-doctor/planner-recovery.json"), "utf8"))
    assert.equal(recovery.status, "unavailable")
    assert.equal(recovery.plannerSessionID, "planner-deleted")

    await assert.rejects(hooks["tool.execute.before"]!({ sessionID: "executor", tool: "bash" } as any, {
      args: { command: "npm run task:doctor:schedule" },
    }), /No further Executor tool calls/)

    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    await assert.doesNotReject(hooks["tool.execute.before"]!({ sessionID: "executor", tool: "bash" } as any, {
      args: { command: "npm run task:doctor:schedule" },
    }))

    await hooks["chat.message"]!({ sessionID: "executor-new", agent: "executor" } as any, {} as any)
    await assert.rejects(hooks["tool.execute.before"]!({ sessionID: "executor-new", tool: "task" } as any, {
      args: {
        subagent_type: "worker",
        description: `Resume ${data.taskPath}`,
        prompt: `Resume active task ${data.taskPath}. Do not lint, register, start, or schedule.`,
      },
    }), /PLANNER UNAVAILABLE/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Executor stops when an older task has no recorded Planner owner", async () => {
  const data = fixture(true)
  try {
    authorizePlannerBlocker(data.root, data.taskPath)
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: { session: {} } } as any)
    const result = await hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: "The active task definition needs a Planner correction before Worker can continue safely.",
      evidence: ["Worker returned Required owner: Planner after Doctor verification failed."],
      expected_results: ["A Planner corrects and registers the active task."],
      relevant_files: [data.taskPath],
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any)
    assert.match(result.output, /PLANNER UNAVAILABLE/)
    assert.match(result.output, /No owning Planner session is recorded/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Executor cannot escalate an active Executor-owned blocker to Planner", async () => {
  const data = fixture(true)
  try {
    claimPlannerOwnership(data.root, {
      taskPath: data.taskPath,
      plannerSessionID: "planner-original",
      plannerAgent: "planner",
      source: "registration",
    })
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: { session: {} } } as any)
    await assert.rejects(hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: "The Worker stopped after an Executor-owned tool-format blocker.",
      evidence: ["The canonical Worker handoff named Required owner: Executor."],
      expected_results: ["Executor follows the canonical recovery path without changing the task."],
      relevant_files: [data.taskPath],
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any), /authoritative blocker[\s\S]*not Planner-owned/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("an explicit current user request authorizes active Planner review before Worker delegation", async () => {
  const data = fixture(true)
  try {
    claimPlannerOwnership(data.root, {
      taskPath: data.taskPath,
      plannerSessionID: "planner-original",
      plannerAgent: "planner",
      source: "registration",
    })
    const recoveryPrompts: string[] = []
    let latestExecutorMessageID = "user-2"
    let latestExecutorText = `First resolve HARNESS_BASELINE_DRIFT as Executor. Then, before delegating, use the owning Planner to review and revise ${data.taskPath}. Do not delegate until Planner recovery is complete.`
    const executorCursors: Array<string | undefined> = []
    const client = {
      session: {
        get: async () => ({ data: { id: "planner-original", directory: data.root } }),
        messages: async ({ path, query }: any) => {
          if (path.id !== "executor") return { data: { data: [], cursor: {} } }
          executorCursors.push(query.cursor)
          return query.cursor === "page-2"
            ? { data: { data: [{
                info: { id: latestExecutorMessageID, role: "user" },
                parts: [{ type: "text", text: latestExecutorText }],
              }], cursor: {} } }
            : { data: { data: [{
                info: { id: "user-1", role: "user" },
                parts: [{ type: "text", text: "Inspect the current status first." }],
              }], cursor: { next: "page-2" } } }
        },
        prompt: async ({ body }: any) => {
          recoveryPrompts.push(body.parts[0].text)
          return { data: { info: {}, parts: [] } }
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {
      parts: [{ type: "text", text: latestExecutorText }],
    } as any)
    await assert.rejects(hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any), /missing its initial evidence context: problem, evidence, expected_results, relevant_files/)
    const result = await hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: "The active task acceptance contract needs review before another Worker is delegated.",
      evidence: ["The current task does not name a focused test for its required behavior."],
      expected_results: ["The owning Planner defines focused, observable verification for the task."],
      relevant_files: [data.taskPath, "src/a.ts"],
      required_scope: ["src/a.ts"],
      required_requirements: ["The focused behavior is covered by an executable test."],
      required_verify: ["npm test -- focused.spec.ts"],
      contract_mode: "merge",
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any)

    assert.match(recoveryPrompts[0], /Authorizing user request:/)
    assert.match(recoveryPrompts[0], /Executor-owned prerequisites are already complete/)
    assert.doesNotMatch(recoveryPrompts[0], /HARNESS_BASELINE_DRIFT/)
    assert.match(recoveryPrompts[0], /Treat Executor evidence as hypotheses/)
    assert.match(recoveryPrompts[0], /Required exact recovery contract:/)
    assert.match(recoveryPrompts[0], new RegExp(data.taskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.match(recoveryPrompts[1], /PLANNER RECOVERY RETRY/)
    assert.match(result.output, /PLANNER RECOVERY INCOMPLETE/)
    const receipt = JSON.parse(readFileSync(join(data.root, ".task-doctor/planner-review.json"), "utf8"))
    assert.equal(receipt.status, "pending")
    assert.equal(receipt.userMessageID, "user-2")
    assert.deepEqual(executorCursors.slice(0, 2), [undefined, "page-2"])

    const terminalTransform = { messages: [{
      info: { id: latestExecutorMessageID, sessionID: "executor", role: "user", agent: "executor", time: { created: 1 } },
      parts: [{ type: "text", text: latestExecutorText }],
    }] as any[] }
    await hooks["experimental.chat.messages.transform"]!({} as any, terminalTransform as any)
    const terminalStateText = terminalTransform.messages.at(-1).parts[0].text
    assert.match(terminalStateText, /Next action: Executor must stop/)
    assert.doesNotMatch(terminalStateText, /Next action: Executor must call escalate_to_planner/)

    const restartedHooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await restartedHooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {
      parts: [{ type: "text", text: latestExecutorText }],
    } as any)
    await assert.rejects(restartedHooks["tool.execute.before"]!({ sessionID: "executor", tool: "task" } as any, {
      args: {
        subagent_type: "worker",
        description: `Resume ${data.taskPath}`,
        prompt: `Resume active task ${data.taskPath}.`,
      },
    }), /Planner recovery[\s\S]*still pending/)

    latestExecutorMessageID = "user-3"
    latestExecutorText = `Continue the pending Planner recovery for ${data.taskPath} by calling escalate_to_planner now.`
    await restartedHooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {
      parts: [{ type: "text", text: latestExecutorText }],
    } as any)
    const continuationTransform = { messages: [{
      info: { id: latestExecutorMessageID, sessionID: "executor", role: "user", agent: "executor", time: { created: 3 } },
      parts: [{ type: "text", text: latestExecutorText }],
    }] as any[] }
    await restartedHooks["experimental.chat.messages.transform"]!({} as any, continuationTransform as any)
    const continuationStateText = continuationTransform.messages.at(-1).parts[0].text
    assert.match(continuationStateText, new RegExp(`Next action: Executor must call escalate_to_planner now with only task_path=${data.taskPath}`))
    assert.doesNotMatch(continuationStateText, /exact recovery contract from the current user request/)
    const retried = await restartedHooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any)
    assert.match(retried.output, /PLANNER RECOVERY INCOMPLETE/)
    assert.match(recoveryPrompts[2], /Required exact recovery contract:/)
    assert.match(recoveryPrompts[2], /npm test -- focused\.spec\.ts/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("a bare Planner mention does not authorize active recovery", async () => {
  const data = fixture(true)
  try {
    claimPlannerOwnership(data.root, {
      taskPath: data.taskPath,
      plannerSessionID: "planner-original",
      plannerAgent: "planner",
      source: "registration",
    })
    const client = {
      session: {
        messages: async ({ query }: any) => query.cursor === "page-2"
          ? { data: { data: [{
              info: { id: "user-2", role: "user" },
              parts: [{ type: "text", text: `I saw Planner notes about ${data.taskPath}; what is the current status?` }],
            }], cursor: {} } }
          : { data: { data: [{
              info: { id: "user-1", role: "user" },
              parts: [{ type: "text", text: `Use the Planner to revise ${data.taskPath}.` }],
            }], cursor: { next: "page-2" } } },
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await assert.rejects(hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: "The active task acceptance contract may need a review before another Worker is delegated.",
      evidence: ["The user only asked for status and did not request a Planner action."],
      expected_results: ["The current workflow remains unchanged without explicit authorization."],
      relevant_files: [data.taskPath],
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any), /authoritative blocker[\s\S]*not Planner-owned/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("an explicit instruction not to involve Planner allows Worker delegation", async () => {
  const variants = [
    "Do not escalate to Planner.",
    "Do not return to the owning Planner.",
    "Do not send this task to Planner.",
    "Eskaliere nicht zum Planner.",
    "Eskaliere ihn nicht zum Planner.",
    "Schicke das nicht an den Planner.",
    "Beziehe den Planner nicht ein.",
  ]

  for (const instruction of variants) {
    const data = fixture(true)
    try {
      const client = {
        session: {
          messages: async () => ({ data: { data: [{
            info: { id: "user-negative-planner", role: "user" },
            parts: [{
              type: "text",
              text: `Continue ${data.taskPath} with one fresh Worker. ${instruction}`,
            }],
          }], cursor: {} } }),
        },
      }
      const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
      await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
      await assert.doesNotReject(hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task" } as any, {
        args: {
          subagent_type: "worker",
          description: `Resume ${data.taskPath}`,
          prompt: `Resume active task ${data.taskPath}.`,
        },
      }))
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  }
})

test("a newer explicit Planner rejection safely cancels an uncommitted receipt before retry delegation", async () => {
  const data = fixture(true)
  try {
    const taskHash = digest(data.taskContent)
    write(join(data.root, ".task-doctor/worker-help.json"), JSON.stringify({
      version: 1,
      requests: [{
        version: 1,
        id: "H1",
        status: "retry_approved",
        taskPath: data.taskPath,
        taskHash,
        workerSessionID: "worker-terminal",
        category: "tool_failure",
        problem: "The prior Worker used stale replacement evidence.",
        attemptedActions: ["Read the target and attempted one stale replacement."],
        evidence: ["Worker replace expected 1 occurrences but found 0: src/a.ts"],
        relevantFiles: [data.taskPath, "src/a.ts"],
        suggestedNextStep: "Delegate one fresh Worker with current file evidence.",
        createdAt: "2026-07-16T10:00:00.000Z",
        executorReview: {
          sessionID: "executor",
          decision: "retry_worker",
          rootCause: "The replacement evidence was stale.",
          retryStrategy: "Read current bytes and retry one exact change.",
          expectedResults: ["The exact current replacement previews and verifies."],
          reviewedFiles: [data.taskPath, "src/a.ts"],
          reviewedAt: "2026-07-16T10:01:00.000Z",
        },
      }],
      updatedAt: "2026-07-16T10:01:00.000Z",
    }))
    write(join(data.root, ".task-doctor/planner-review.json"), JSON.stringify({
      version: 1,
      status: "pending",
      executorSessionID: "executor",
      userMessageID: "older-planner-request",
      userRequestHash: "older-request-hash",
      taskPath: data.taskPath,
      initialTaskHash: taskHash,
      taskHash,
      contractMode: "replace",
      requestedAt: "2026-07-15T10:00:00.000Z",
      contract: {
        scope: ["src/a.ts"],
        requirements: ["The current source behavior is corrected."],
        behavior: [],
        verify: ["npm test"],
        supersedeTasks: [],
      },
    }))
    write(join(data.root, ".task-doctor/planner-recovery.json"), JSON.stringify({
      version: 1,
      status: "incomplete",
      taskPath: data.taskPath,
      taskHash,
      plannerSessionID: "planner-original",
      executorSessionID: "executor",
      reason: "The earlier exact recovery did not commit.",
      updatedAt: "2026-07-15T10:01:00.000Z",
    }))

    const latestText = `H1 ist bereits retry_approved. Eskaliere nicht zum Planner. Delegiere genau einen frischen Worker für ${data.taskPath}.`
    const client = {
      session: {
        messages: async () => ({ data: { data: [{
          info: { id: "newer-direct-worker-request", role: "user" },
          parts: [{ type: "text", text: latestText }],
        }], cursor: {} } }),
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {
      messageID: "newer-direct-worker-request",
      parts: [{ type: "text", text: latestText }],
    } as any)

    assert.equal(existsSync(join(data.root, ".task-doctor/planner-review.json")), false)
    assert.equal(existsSync(join(data.root, ".task-doctor/planner-recovery.json")), false)

    const transformed = { messages: [{
      info: { id: "newer-direct-worker-request", sessionID: "executor", role: "user", agent: "executor", time: { created: 1 } },
      parts: [{ type: "text", text: latestText }],
    }] as any[] }
    await hooks["experimental.chat.messages.transform"]!({} as any, transformed as any)
    assert.match(transformed.messages.at(-1).parts[0].text, /Next action: Executor must delegate one fresh Worker/)
    assert.doesNotMatch(transformed.messages.at(-1).parts[0].text, /Planner recovery: incomplete/)

    await assert.doesNotReject(hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task" } as any, {
      args: {
        subagent_type: "worker",
        description: `Resume ${data.taskPath}`,
        prompt: `Resume active task ${data.taskPath}.`,
      },
    }))
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("explicit Planner recovery blocks Worker delegation until the recovery tool succeeds", async () => {
  const data = fixture(true)
  try {
    const cursors: Array<string | undefined> = []
    const client = {
      session: {
        messages: async ({ query }: any) => {
          cursors.push(query.cursor)
          return query.cursor === "page-2"
            ? { data: { data: [{
                info: { id: "user-2", role: "user" },
                parts: [{ type: "text", text: `Use the owning Planner to correct ${data.taskPath} before delegating Worker.` }],
              }], cursor: {} } }
            : { data: { data: [], cursor: { next: "page-2" } } }
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    await assert.rejects(hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task" } as any, {
      args: {
        subagent_type: "worker",
        description: `Resume ${data.taskPath}`,
        prompt: `Resume active task ${data.taskPath}.`,
      },
    }), /explicitly requested Planner recovery[\s\S]*Call escalate_to_planner/)
    assert.deepEqual(cursors.slice(-2), [undefined, "page-2"])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("explicit Planner recovery mechanically overrides the generic continuation action", async () => {
  const data = fixture(true)
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const sessionID = "executor"
    const request = `Call escalate_to_planner for ${data.taskPath} with the complete exact replacement contract before any Worker delegation.`
    await hooks["chat.message"]!({ sessionID, agent: "executor" } as any, {
      parts: [{ type: "text", text: request }],
    } as any)

    const transformed = { messages: [{
      info: { id: "msg-user", sessionID, role: "user", agent: "executor", time: { created: 1 } },
      parts: [{ id: "prt-user", sessionID, messageID: "msg-user", type: "text", text: request }],
    }] as any[] }
    await hooks["experimental.chat.messages.transform"]!({} as any, transformed as any)
    const liveStateText = transformed.messages.at(-1).parts[0].text
    assert.match(liveStateText, new RegExp(`Next action: Executor must call escalate_to_planner for ${data.taskPath}`))
    assert.match(liveStateText, /exact recovery contract from the current user request/)
    assert.doesNotMatch(liveStateText, /Next action: Executor must delegate one fresh Worker/)

    await hooks["chat.message"]!({ sessionID, agent: "executor" } as any, {
      parts: [{ type: "text", text: `Continue ${data.taskPath} with the authoritative current state.` }],
    } as any)
    const continued = { messages: [{
      info: { id: "msg-user-2", sessionID, role: "user", agent: "executor", time: { created: 2 } },
      parts: [{ id: "prt-user-2", sessionID, messageID: "msg-user-2", type: "text", text: "Continue." }],
    }] as any[] }
    await hooks["experimental.chat.messages.transform"]!({} as any, continued as any)
    assert.doesNotMatch(continued.messages.at(-1).parts[0].text, /exact recovery contract from the current user request/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Planner must revise an active task through the atomic recovery tool", async () => {
  const data = fixture(true)
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "planner", agent: "planner" } as any, {} as any)
    await assert.rejects(hooks["tool.execute.before"]!({ sessionID: "planner", tool: "edit" } as any, {
      args: { filePath: join(data.root, data.taskPath), oldString: "Original.", newString: "Changed." },
    }), /revise_active_task/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

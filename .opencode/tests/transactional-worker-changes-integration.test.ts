import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { doctorFailureFingerprint } from "../lib/worker-help.ts"
import { WorkflowGuard } from "../plugins/workflow-guard.ts"

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "transactional-worker-"))
  const taskPath = "kanban/todo/01-task.md"
  const taskContent = [
    "# Task",
    "",
    "## Scope",
    "- `src/a.ts`",
    "- NEW: `src/new.ts`",
    "",
    "## Requirement",
    "Change the exact value and add its companion file.",
    "",
  ].join("\n")
  write(join(root, "project.json"), JSON.stringify({
    settings: { opencode: { workflowGuard: { transactionalWorkerChanges: true } } },
  }))
  write(join(root, "scripts/task-doctor.mjs"), [
    "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'",
    "const configPath = '.task-doctor/mechanical-doctor.json'",
    "if (!existsSync(configPath)) process.exit(3)",
    "const config = JSON.parse(readFileSync(configPath, 'utf8'))",
    "const countPath = '.task-doctor/mechanical-doctor-count'",
    "const runIndex = existsSync(countPath) ? readFileSync(countPath, 'utf8').trim().split('\\n').filter(Boolean).length : 0",
    "appendFileSync('.task-doctor/mechanical-doctor-count', '1\\n')",
    "const selected = Array.isArray(config.runs) ? (config.runs[runIndex] ?? config.runs.at(-1) ?? {}) : config",
    "if (selected.executorRecovery) {",
    "  const statePath = '.task-doctor/state.json'",
    "  const state = JSON.parse(readFileSync(statePath, 'utf8'))",
    "  state.executorRecovery = { status: 'required', code: 'HARNESS_BASELINE_DRIFT', taskPath: state.taskPath, taskHash: state.taskHash, paths: [{ path: 'WORKER.md', beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64) }], detectedAt: new Date().toISOString() }",
    "  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n')",
    "}",
    "if (selected.delayMs) await new Promise((resolve) => setTimeout(resolve, selected.delayMs))",
    "process.stdout.write(String(selected.output ?? ''))",
    "process.exit(Number(selected.exitCode ?? 1))",
    "",
  ].join("\n"))
  write(join(root, "kanban/TASK.md"), "# Template\n")
  write(join(root, taskPath), taskContent)
  write(join(root, "WORKER.md"), "# Worker rules\n")
  write(join(root, "src/a.ts"), "export const a = 1\n")
  write(join(root, ".task-doctor/state.json"), `${JSON.stringify({
    version: 4,
    status: "started",
    taskPath,
    taskHash: digest(taskContent),
    memoryAction: "none",
    contractOwnership: "not-applicable",
    snapshot: { "src/a.ts": digest("export const a = 1\n") },
  }, null, 2)}\n`)
  return { root, taskPath }
}

function configureMechanicalDoctor(root: string, output: string, exitCode = output.includes("TASK DOCTOR: PASS") ? 0 : 1, delayMs = 0) {
  write(join(root, ".task-doctor/mechanical-doctor.json"), `${JSON.stringify({ output, exitCode, delayMs })}\n`)
  rmSync(join(root, ".task-doctor/mechanical-doctor-count"), { force: true })
}

function configureMechanicalDoctorRuns(root: string, runs: Array<{ output: string; exitCode: number; delayMs?: number; executorRecovery?: boolean }>) {
  write(join(root, ".task-doctor/mechanical-doctor.json"), `${JSON.stringify({ runs })}\n`)
  rmSync(join(root, ".task-doctor/mechanical-doctor-count"), { force: true })
}

function mechanicalDoctorCount(root: string) {
  const path = join(root, ".task-doctor/mechanical-doctor-count")
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length : 0
}

function persistActiveRecoveryBoost(root: string, taskPath: string, failure: string, sessionID = "worker-session") {
  const state = JSON.parse(readFileSync(join(root, ".task-doctor/state.json"), "utf8"))
  const fingerprint = doctorFailureFingerprint("verify", taskPath, failure)
  assert.ok(fingerprint)
  write(join(root, ".task-doctor/worker-help.json"), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    requests: [{
      version: 1,
      id: "H1",
      status: "delegated",
      taskPath,
      taskHash: state.taskHash,
      workerSessionID: "worker-original",
      category: "test_failure",
      problem: "The reviewed Doctor hurdle remains in src/a.ts.",
      attemptedActions: ["The prior Worker attempted one incomplete correction."],
      evidence: [failure],
      relevantFiles: [taskPath, "src/a.ts"],
      suggestedNextStep: "Use one bounded recovery turn for the exact reviewed hurdle.",
      createdAt: new Date().toISOString(),
      executorReview: {
        sessionID: "executor",
        decision: "retry_worker",
        rootCause: "The exact reviewed source hurdle remains.",
        retryStrategy: "Correct src/a.ts once from current bytes.",
        expectedResults: ["The reviewed Doctor hurdle changes or passes."],
        reviewedFiles: [taskPath, "src/a.ts"],
        reviewedAt: new Date().toISOString(),
      },
      delegatedAt: new Date().toISOString(),
      delegatedWorkerSessionID: sessionID,
      delegationPriorStatus: "retry_approved",
      recoveryBoost: {
        phase: "active",
        hurdleTarget: "src/a.ts",
        hurdleFingerprint: fingerprint.signature,
        activatedAt: new Date().toISOString(),
      },
    }],
  }))
}

function parseProviderToolArgs(shape: Record<string, unknown>, input: Record<string, unknown>): any {
  const parsed: Record<string, any> = {}
  for (const [key, schema] of Object.entries(shape)) {
    const value = (schema as { parse(value: unknown): unknown }).parse(input[key])
    if (value !== undefined) parsed[key] = value
  }
  return parsed
}

async function trustedWorkerVerify(
  hooks: Awaited<ReturnType<typeof WorkflowGuard>>,
  root: string,
  sessionID: string,
  output: string,
  exitCode = output.includes("TASK DOCTOR: PASS") ? 0 : 1,
) {
  configureMechanicalDoctor(root, output, exitCode)
  return hooks.tool!.verify_worker_task.execute({}, {
    agent: "worker",
    sessionID,
    abort: new AbortController().signal,
    metadata() {},
  } as any)
}

async function workerHooks(root: string, options: {
  preflightOutput?: string
  readInitialTarget?: boolean
} = {}) {
  const hooks = await WorkflowGuard({ directory: root, worktree: root, client: {} } as any)
  const sessionID = "worker-session"
  await hooks["chat.message"]!({ sessionID, agent: "worker" } as any, {} as any)

  const read = async (path: string, range: { offset?: number; limit?: number } = {}) => {
    const args = { filePath: join(root, path), ...range }
    await hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, { args })
    await hooks["tool.execute.after"]!({ sessionID, tool: "read", args } as any, {
      title: "read",
      output: existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : "",
      metadata: {},
    })
  }
  const verify = async (output: string) => {
    return trustedWorkerVerify(hooks, root, sessionID, output)
  }

  await read("WORKER.md")
  await read("kanban/todo/01-task.md")
  await verify(options.preflightOutput ?? "TASK DOCTOR: FAIL\n- FALLOW_NEW_FINDING: unresolved_imports: src/a.ts\n")
  if (options.readInitialTarget !== false) await read("src/a.ts")
  return { hooks, sessionID, read, verify }
}

async function initializeWorker(hooks: Awaited<ReturnType<typeof WorkflowGuard>>, root: string, sessionID: string) {
  await hooks["chat.message"]!({ sessionID, agent: "worker" } as any, {} as any)
  const read = async (path: string) => {
    const args = { filePath: join(root, path) }
    await hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, { args })
    await hooks["tool.execute.after"]!({ sessionID, tool: "read", args } as any, {
      title: "read",
      output: existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : "",
      metadata: { truncated: false },
    })
  }
  await read("WORKER.md")
  await read("kanban/todo/01-task.md")
  return { hooks, sessionID, read }
}

async function startupWorker(root: string, sessionID: string) {
  const hooks = await WorkflowGuard({ directory: root, worktree: root, client: {} } as any)
  return initializeWorker(hooks, root, sessionID)
}

async function targetedQwenWorker(root: string, taskPath: string) {
  const state = JSON.parse(readFileSync(join(root, ".task-doctor/state.json"), "utf8"))
  write(join(root, "project.json"), JSON.stringify({
    settings: { opencode: {
      workflowGuard: { transactionalWorkerChanges: true, workerHelp: true },
      agentModels: {
        executor: "llamacpp-local/qwen3.5-9b-q8-mtp-reasoning",
        worker: "llamacpp-local/qwen3.5-9b-q8-mtp",
      },
      workerModelFamilies: {
        QWEN35: { matches: ["qwen3.5", "qwen35"], rulesFile: "WORKER-QWEN35.md", requireRead: true },
      },
    } },
  }))
  write(join(root, "WORKER-QWEN35.md"), "# Qwen 3.5 rules\n\n- Send compact complete tool arguments.\n")
  write(join(root, ".task-doctor/worker-help.json"), JSON.stringify({
    version: 1,
    updatedAt: "2026-07-16T10:01:00.000Z",
    requests: [{
      version: 1,
      id: "H1",
      status: "retry_approved",
      taskPath,
      taskHash: state.taskHash,
      workerSessionID: "worker-original",
      category: "test_failure",
      problem: "The reviewed implementation target still contains the old behavior.",
      attemptedActions: ["The prior Worker attempted one stale source correction."],
      evidence: ["Doctor reported the focused failure in src/a.ts."],
      relevantFiles: [taskPath, "src/a.ts"],
      suggestedNextStep: "Delegate a fresh Worker to the exact reviewed source target.",
      createdAt: "2026-07-16T10:00:00.000Z",
      executorReview: {
        sessionID: "executor",
        decision: "retry_worker",
        rootCause: "The implementation target still has the stale source value.",
        retryStrategy: "Read src/a.ts completely and apply one current exact correction.",
        expectedResults: ["The source correction previews and Doctor verification passes."],
        reviewedFiles: [taskPath, "src/a.ts"],
        reviewedAt: "2026-07-16T10:01:00.000Z",
      },
    }],
  }))
  const hooks = await WorkflowGuard({ directory: root, worktree: root, client: {} } as any)
  await hooks["chat.message"]!({
    sessionID: "executor",
    agent: "executor",
    model: { providerID: "llamacpp-local", modelID: "qwen3.5-9b-q8-mtp-reasoning" },
  } as any, {} as any)
  const delegation = { args: { description: `Resume ${taskPath}`, prompt: `Resume ${taskPath}`, subagent_type: "worker" } }
  await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "delegate" } as any, delegation as any)
  const sessionID = "worker-qwen-targeted"
  await hooks.event!({ event: {
    type: "session.created",
    properties: { info: {
      id: sessionID,
      parentID: "executor",
      agent: "worker",
      model: { providerID: "llamacpp-local", modelID: "qwen3.5-9b-q8-mtp" },
    } },
  } } as any)
  const read = async (path: string, metadata: any = { truncated: false }) => {
    const args = { filePath: join(root, path) }
    await hooks["tool.execute.before"]!({ sessionID, tool: "read", callID: `read-${path}` } as any, { args })
    const output: any = {
      title: "read",
      output: readFileSync(join(root, path), "utf8"),
      metadata,
    }
    await hooks["tool.execute.after"]!({ sessionID, tool: "read", callID: `read-${path}`, args } as any, output)
    return output
  }
  return { hooks, sessionID, read, state }
}

test("a targeted Qwen retry receives the exact active task with its first reviewed target read", async () => {
  const data = fixture()
  try {
    const worker = await targetedQwenWorker(data.root, data.taskPath)
    await worker.read("WORKER.md")
    await worker.read("WORKER-QWEN35.md")

    const taskContent = readFileSync(join(data.root, data.taskPath), "utf8")
    const targetContent = readFileSync(join(data.root, "src/a.ts"), "utf8")
    const args = { filePath: join(data.root, "src/a.ts") }
    await assert.doesNotReject(() => worker.hooks["tool.execute.before"]!({
      sessionID: worker.sessionID,
      tool: "read",
      callID: "live-target-read",
    } as any, { args } as any))
    const output: any = { title: "read", output: targetContent, metadata: { truncated: false } }
    await worker.hooks["tool.execute.after"]!({
      sessionID: worker.sessionID,
      tool: "read",
      callID: "live-target-read",
      args,
    } as any, output)

    assert.equal(output.metadata.automaticRequiredTaskRead, true)
    assert.equal(output.metadata.automaticTaskHash, worker.state.taskHash)
    assert.match(output.output, /AUTOMATIC REQUIRED TASK READ/)
    assert.ok(output.output.includes(taskContent))
    assert.ok(output.output.indexOf(taskContent) < output.output.indexOf(targetContent))
    assert.match(output.output, /Model family: QWEN35 \(WORKER-QWEN35\.md\)/)
    assert.equal(mechanicalDoctorCount(data.root), 0)

    await assert.doesNotReject(() => worker.hooks["tool.execute.before"]!({
      sessionID: worker.sessionID,
      tool: "preview_worker_changes",
    } as any, { args: {
      task_path: data.taskPath,
      description: "Update the exact reviewed source value after the combined startup read.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 2" }],
    } } as any))
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("automatic task reads fail closed for partial, wrong, missing-rule, drifted, and symlinked target reads", async (t) => {
  const cases: Array<[string, (data: ReturnType<typeof fixture>, worker: Awaited<ReturnType<typeof targetedQwenWorker>>) => Promise<void>]> = [
    ["missing family rule read", async (data, worker) => {
      await worker.read("WORKER.md")
      await assert.rejects(() => worker.hooks["tool.execute.before"]!({ sessionID: worker.sessionID, tool: "read" } as any, {
        args: { filePath: join(data.root, "src/a.ts") },
      }), /reading required rules[\s\S]*WORKER-QWEN35\.md/)
    }],
    ["partial target request", async (data, worker) => {
      await worker.read("WORKER.md")
      await worker.read("WORKER-QWEN35.md")
      await assert.rejects(() => worker.hooks["tool.execute.before"]!({ sessionID: worker.sessionID, tool: "read" } as any, {
        args: { filePath: join(data.root, "src/a.ts"), limit: 20 },
      }), /before reading the exact active task/)
    }],
    ["wrong scoped path", async (data, worker) => {
      await worker.read("WORKER.md")
      await worker.read("WORKER-QWEN35.md")
      await assert.rejects(() => worker.hooks["tool.execute.before"]!({ sessionID: worker.sessionID, tool: "read" } as any, {
        args: { filePath: join(data.root, "src/new.ts") },
      }), /before reading the exact active task/)
    }],
    ["task hash drift", async (data, worker) => {
      await worker.read("WORKER.md")
      await worker.read("WORKER-QWEN35.md")
      write(join(data.root, data.taskPath), `${readFileSync(join(data.root, data.taskPath), "utf8")}\nDrift\n`)
      await assert.rejects(() => worker.hooks["tool.execute.before"]!({ sessionID: worker.sessionID, tool: "read" } as any, {
        args: { filePath: join(data.root, "src/a.ts") },
      }), /before reading the exact active task/)
    }],
    ["symlinked target", async (data, worker) => {
      await worker.read("WORKER.md")
      await worker.read("WORKER-QWEN35.md")
      rmSync(join(data.root, "src/a.ts"))
      symlinkSync(join(data.root, "WORKER.md"), join(data.root, "src/a.ts"))
      await assert.rejects(() => worker.hooks["tool.execute.before"]!({ sessionID: worker.sessionID, tool: "read" } as any, {
        args: { filePath: join(data.root, "src/a.ts") },
      }), /before reading the exact active task/)
    }],
    ["truncated target output", async (data, worker) => {
      await worker.read("WORKER.md")
      await worker.read("WORKER-QWEN35.md")
      const args = { filePath: join(data.root, "src/a.ts") }
      await worker.hooks["tool.execute.before"]!({ sessionID: worker.sessionID, tool: "read", callID: "truncated-target" } as any, { args })
      await assert.rejects(() => worker.hooks["tool.execute.after"]!({
        sessionID: worker.sessionID,
        tool: "read",
        callID: "truncated-target",
        args,
      } as any, { title: "read", output: "export const", metadata: { truncated: true } } as any), /requires one complete unbounded read/)
      await assert.doesNotReject(() => worker.hooks["tool.execute.before"]!({ sessionID: worker.sessionID, tool: "read" } as any, {
        args: { filePath: join(data.root, data.taskPath) },
      }))
    }],
    ["target drift after before hook", async (data, worker) => {
      await worker.read("WORKER.md")
      await worker.read("WORKER-QWEN35.md")
      const args = { filePath: join(data.root, "src/a.ts") }
      await worker.hooks["tool.execute.before"]!({ sessionID: worker.sessionID, tool: "read", callID: "drift-target" } as any, { args })
      write(join(data.root, "src/a.ts"), "export const a = 9\n")
      await assert.rejects(() => worker.hooks["tool.execute.after"]!({
        sessionID: worker.sessionID,
        tool: "read",
        callID: "drift-target",
        args,
      } as any, { title: "read", output: "export const a = 1\n", metadata: { truncated: false } } as any), /evidence drifted/)
    }],
  ]

  for (const [name, check] of cases) {
    await t.test(name, async () => {
      const data = fixture()
      try {
        const worker = await targetedQwenWorker(data.root, data.taskPath)
        await check(data, worker)
      } finally {
        rmSync(data.root, { recursive: true, force: true })
      }
    })
  }
})

test("requires startup reads and mechanically runs one Doctor preflight before implementation inspection", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const sessionID = "ordered-worker"
    await hooks["chat.message"]!({ sessionID, agent: "worker" } as any, {} as any)
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: { filePath: join(data.root, "src/a.ts") },
    }), /reading required rules/)

    const workerArgs = { filePath: join(data.root, "WORKER.md") }
    await hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, { args: workerArgs })
    await hooks["tool.execute.after"]!({ sessionID, tool: "read", args: workerArgs } as any, { title: "read", output: "", metadata: { truncated: false } })
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: { filePath: join(data.root, "src/a.ts") },
    }), /exact active task/)

    const taskArgs = { filePath: join(data.root, data.taskPath) }
    await hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, { args: taskArgs })
    await hooks["tool.execute.after"]!({ sessionID, tool: "read", args: taskArgs } as any, { title: "read", output: "", metadata: { truncated: false } })
    const doctorOutput = "TASK DOCTOR: FAIL\n- FALLOW_NEW_FINDING: unresolved_imports: src/a.ts\n"
    configureMechanicalDoctor(data.root, doctorOutput)
    const firstFindingRead = { filePath: join(data.root, "src/a.ts") }
    await assert.doesNotReject(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: firstFindingRead,
    }))
    await hooks["tool.execute.after"]!({ sessionID, tool: "read", args: firstFindingRead } as any, {
      title: "read",
      output: "export const a = 1",
      metadata: { truncated: false },
    })
    assert.equal(mechanicalDoctorCount(data.root), 1)
    assert.ok(existsSync(join(data.root, ".task-doctor/last-doctor-failure.json")))

    const transformed: any = { messages: [{ info: { sessionID, role: "assistant" }, parts: [] }] }
    await hooks["experimental.chat.messages.transform"]!({} as any, transformed)
    assert.match(transformed.messages.at(-1).parts[0].text, /FALLOW_NEW_FINDING: unresolved_imports: src\/a\.ts/)

    await assert.doesNotReject(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: { filePath: join(data.root, "src/new.ts") },
    }))
    assert.equal(mechanicalDoctorCount(data.root), 1)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("a READ Context file must be fully read at its current hash before the first preview", async () => {
  const data = fixture()
  try {
    write(join(data.root, "src/context.ts"), "export const context = 1\n")
    const taskContent = readFileSync(join(data.root, data.taskPath), "utf8").replace(
      "\n## Requirement",
      "\n## Context\n- src/context.ts\n\n## Requirement",
    )
    write(join(data.root, data.taskPath), taskContent)
    const statePath = join(data.root, ".task-doctor/state.json")
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    state.taskHash = digest(taskContent)
    state.snapshot["src/context.ts"] = digest("export const context = 1\n")
    write(statePath, `${JSON.stringify(state, null, 2)}\n`)

    const { hooks, sessionID, read } = await workerHooks(data.root)
    const context = { agent: "worker", sessionID, metadata() {} } as any
    const preview = () => hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      path: "src/a.ts",
      kind: "replace",
      old_text: "a = 1",
      new_text: "a = 2",
    }, context)

    await assert.rejects(preview, /required task Context[\s\S]*src\/context\.ts[\s\S]*fully without offset or limit/)
    await read("src/context.ts")
    write(join(data.root, "src/context-target.ts"), "export const context = 1\n")
    rmSync(join(data.root, "src/context.ts"))
    symlinkSync("context-target.ts", join(data.root, "src/context.ts"))
    await assert.rejects(preview, /Context entry[\s\S]*symbolic link|non-symbolic-link/)
    rmSync(join(data.root, "src/context.ts"))
    write(join(data.root, "src/context.ts"), "export const context = 1\n")
    await read("src/context.ts")
    const result: any = await preview()
    assert.match(result.output, /WORKER CHANGE PREVIEW/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("mechanical preflight failures are fail-closed, retriable, and never cached as evidence", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID, read } = await startupWorker(data.root, "mechanical-invalid")
    configureMechanicalDoctor(data.root, "not a Doctor report\n", 1)
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: { filePath: join(data.root, "src/a.ts") },
    }), /no terminal TASK DOCTOR status/)
    assert.equal(mechanicalDoctorCount(data.root), 1)
    assert.equal(existsSync(join(data.root, ".task-doctor/last-doctor-failure.json")), false)

    configureMechanicalDoctor(data.root, "TASK DOCTOR: FAIL\n- VERIFY_FAILED: src/a.ts still needs work\n")
    await assert.doesNotReject(() => read("src/a.ts"))
    assert.equal(mechanicalDoctorCount(data.root), 1)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("parallel first reads share one hash-bound mechanical Doctor run", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await startupWorker(data.root, "mechanical-single-flight")
    configureMechanicalDoctor(data.root, "TASK DOCTOR: FAIL\n- VERIFY_FAILED: src/a.ts still needs work\n", 1, 150)
    const first = { args: { filePath: join(data.root, "src/a.ts") } }
    const second = { args: { filePath: join(data.root, "src/a.ts") } }
    await Promise.all([
      hooks["tool.execute.before"]!({ sessionID, tool: "read", callID: "read-one" } as any, first as any),
      hooks["tool.execute.before"]!({ sessionID, tool: "read", callID: "read-two" } as any, second as any),
    ])
    assert.equal(mechanicalDoctorCount(data.root), 1)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("parallel applies serialize mutation plus verify and never share a Doctor PASS", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const firstSession = "parallel-apply-one"
    const secondSession = "parallel-apply-two"
    const firstWorker = await initializeWorker(hooks, data.root, firstSession)
    await initializeWorker(hooks, data.root, secondSession)
    const establishPreflight = async (sessionID: string) => {
      await trustedWorkerVerify(hooks, data.root, sessionID, "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the task requirements remain unresolved\n")
    }
    await establishPreflight(firstSession)
    await establishPreflight(secondSession)
    await firstWorker.read("src/a.ts")

    const firstContext = {
      agent: "worker",
      sessionID: firstSession,
      abort: new AbortController().signal,
      metadata() {},
    } as any
    const secondContext = {
      agent: "worker",
      sessionID: secondSession,
      abort: new AbortController().signal,
      metadata() {},
    } as any
    const firstPreview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Update the existing source export in the first Worker.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 2" }],
    }, firstContext)
    const secondPreview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Create the declared companion file in the second Worker.",
      operations: [{ kind: "create", path: "src/new.ts", content: "export const created = true\n" }],
    }, secondContext)

    configureMechanicalDoctorRuns(data.root, [
      { output: "TASK DOCTOR: PASS\n", exitCode: 0, delayMs: 120 },
      { output: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: src/new.ts needs one final correction\n", exitCode: 1 },
    ])
    const [firstApplied, secondApplied]: any[] = await Promise.all([
      hooks.tool!.apply_worker_changes.execute({
        task_path: data.taskPath,
        description: "Apply the first Worker source update.",
        change_id: firstPreview.metadata.changeID,
        preview_token: firstPreview.metadata.previewToken,
      }, firstContext),
      hooks.tool!.apply_worker_changes.execute({
        task_path: data.taskPath,
        description: "Apply the second Worker companion file.",
        change_id: secondPreview.metadata.changeID,
        preview_token: secondPreview.metadata.previewToken,
      }, secondContext),
    ])

    assert.equal(mechanicalDoctorCount(data.root), 2)
    assert.notEqual(firstApplied.metadata.mechanicalDoctorRunID, secondApplied.metadata.mechanicalDoctorRunID)
    assert.equal(firstApplied.metadata.mechanicalDoctorStatus, "pass")
    assert.equal(secondApplied.metadata.mechanicalDoctorStatus, "fail")
    assert.match(secondApplied.output, /src\/new\.ts needs one final correction/)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 2\n")
    assert.equal(readFileSync(join(data.root, "src/new.ts"), "utf8"), "export const created = true\n")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("a queued Apply rechecks Harness recovery before mutating its preview", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const firstSession = "recovery-apply-one"
    const secondSession = "recovery-apply-two"
    const firstWorker = await initializeWorker(hooks, data.root, firstSession)
    await initializeWorker(hooks, data.root, secondSession)
    const establishPreflight = async (sessionID: string) => {
      await trustedWorkerVerify(hooks, data.root, sessionID, "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the task requirements remain unresolved\n")
    }
    await establishPreflight(firstSession)
    await establishPreflight(secondSession)
    await firstWorker.read("src/a.ts")
    const firstContext = {
      agent: "worker",
      sessionID: firstSession,
      abort: new AbortController().signal,
      metadata() {},
    } as any
    const secondContext = {
      agent: "worker",
      sessionID: secondSession,
      abort: new AbortController().signal,
      metadata() {},
    } as any
    const firstPreview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Apply the first source update before Harness recovery is detected.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 2" }],
    }, firstContext)
    const secondPreview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Keep the second companion preview pending behind the first Apply.",
      operations: [{ kind: "create", path: "src/new.ts", content: "export const created = true\n" }],
    }, secondContext)
    configureMechanicalDoctorRuns(data.root, [
      {
        output: "TASK DOCTOR: EXECUTOR RECOVERY REQUIRED\n- HARNESS_BASELINE_DRIFT: WORKER.md\n",
        exitCode: 1,
        executorRecovery: true,
      },
      { output: "TASK DOCTOR: PASS\n", exitCode: 0 },
    ])

    const firstApply = hooks.tool!.apply_worker_changes.execute({
      task_path: data.taskPath,
      description: "Apply the first source update and observe recovery.",
      change_id: firstPreview.metadata.changeID,
      preview_token: firstPreview.metadata.previewToken,
    }, firstContext)
    const secondApply = hooks.tool!.apply_worker_changes.execute({
      task_path: data.taskPath,
      description: "Attempt the queued companion only if recovery permits it.",
      change_id: secondPreview.metadata.changeID,
      preview_token: secondPreview.metadata.previewToken,
    }, secondContext)
    const secondRejected = assert.rejects(() => secondApply, /Harness recovery became authoritative while Apply was queued/)
    const firstApplied: any = await firstApply
    await secondRejected

    assert.equal(firstApplied.metadata.mechanicalDoctorStatus, "executor_recovery_required")
    assert.equal(mechanicalDoctorCount(data.root), 1)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 2\n")
    assert.equal(existsSync(join(data.root, "src/new.ts")), false)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("aborting one queued Apply verify cannot cancel the next Worker's Doctor run", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const firstSession = "abort-apply-one"
    const secondSession = "abort-apply-two"
    const firstWorker = await initializeWorker(hooks, data.root, firstSession)
    await initializeWorker(hooks, data.root, secondSession)
    const establishPreflight = async (sessionID: string) => {
      await trustedWorkerVerify(hooks, data.root, sessionID, "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the task requirements remain unresolved\n")
    }
    await establishPreflight(firstSession)
    await establishPreflight(secondSession)
    await firstWorker.read("src/a.ts")

    const firstAbort = new AbortController()
    const firstContext = { agent: "worker", sessionID: firstSession, abort: firstAbort.signal, metadata() {} } as any
    const secondContext = {
      agent: "worker",
      sessionID: secondSession,
      abort: new AbortController().signal,
      metadata() {},
    } as any
    const firstPreview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Update the existing source before the first verification is aborted.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 2" }],
    }, firstContext)
    const secondPreview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Create the companion in the independently queued Worker.",
      operations: [{ kind: "create", path: "src/new.ts", content: "export const created = true\n" }],
    }, secondContext)
    configureMechanicalDoctorRuns(data.root, [
      { output: "TASK DOCTOR: PASS\n", exitCode: 0, delayMs: 1_000 },
      { output: "TASK DOCTOR: PASS\n", exitCode: 0 },
    ])

    const firstApply = hooks.tool!.apply_worker_changes.execute({
      task_path: data.taskPath,
      description: "Apply the first exact preview before aborting its verify.",
      change_id: firstPreview.metadata.changeID,
      preview_token: firstPreview.metadata.previewToken,
    }, firstContext)
    const secondApply = hooks.tool!.apply_worker_changes.execute({
      task_path: data.taskPath,
      description: "Apply the second exact preview with its own verify.",
      change_id: secondPreview.metadata.changeID,
      preview_token: secondPreview.metadata.previewToken,
    }, secondContext)
    const doctorStartDeadline = Date.now() + 2_000
    while (mechanicalDoctorCount(data.root) < 1) {
      if (Date.now() >= doctorStartDeadline) throw new Error("Timed out waiting for the first queued Doctor run to start.")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    firstAbort.abort()
    const [firstApplied, secondApplied]: any[] = await Promise.all([firstApply, secondApply])

    assert.equal(firstApplied.metadata.mechanicalDoctorStatus, "transport_failure")
    assert.match(firstApplied.output, /applied receipt .* remains authoritative|Do not apply .* again/i)
    assert.equal(secondApplied.metadata.mechanicalDoctorStatus, "pass")
    assert.equal(mechanicalDoctorCount(data.root), 2)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 2\n")
    assert.equal(readFileSync(join(data.root, "src/new.ts"), "utf8"), "export const created = true\n")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("transactional Worker verification rejects Bash and runs only through the trusted queued tool", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const verifySession = "trusted-verify-worker"
    await initializeWorker(hooks, data.root, verifySession)
    const manualArgs = { command: `npm run task:doctor:verify -- ${data.taskPath}` }
    await assert.rejects(
      () => hooks["tool.execute.before"]!({ sessionID: verifySession, tool: "bash" } as any, { args: manualArgs }),
      /verify_worker_task|cannot run through Bash/,
    )
    const verified: any = await trustedWorkerVerify(
      hooks,
      data.root,
      verifySession,
      "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the task requirements remain unresolved\n",
    )
    assert.equal(verified.metadata.mechanicalDoctorStatus, "fail")
    assert.equal(mechanicalDoctorCount(data.root), 1)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("premature trusted Worker verification is idempotent and keeps the current preflight", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(data.root)
    assert.equal(mechanicalDoctorCount(data.root), 1)

    for (let index = 0; index < 2; index += 1) {
      const invocation = { args: {} }
      await hooks["tool.execute.before"]!({ sessionID, tool: "verify_worker_task" } as any, invocation as any)
      const verified: any = await hooks.tool!.verify_worker_task.execute(invocation.args, {
        agent: "worker",
        sessionID,
        abort: new AbortController().signal,
        metadata() {},
      } as any)
      await hooks["tool.execute.after"]!({ sessionID, tool: "verify_worker_task", args: invocation.args } as any, verified)
      assert.equal(verified.metadata.noOp, true)
      assert.equal(verified.metadata.mechanicalDoctorStatus, "already_current")
      assert.match(verified.output, /TRUSTED WORKER VERIFY ALREADY CURRENT/)
      assert.match(verified.output, /Apply verifies automatically/)
    }

    assert.equal(mechanicalDoctorCount(data.root), 1)
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Replace the exact stale value after the current preflight.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 2" }],
    }, { agent: "worker", sessionID, metadata() {} } as any)
    assert.match(preview.output, /\+export const a = 2/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("a different mechanical Doctor finding replaces the preflight loop with the exact target guard", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await startupWorker(data.root, "mechanical-target")
    configureMechanicalDoctor(data.root, "TASK DOCTOR: FAIL\n- FALLOW_NEW_FINDING: missing_file: src/new.ts\n")
    const attempt = () => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: { filePath: join(data.root, "src/a.ts") },
    })
    await assert.rejects(attempt, /src\/new\.ts has not been read/)
    await assert.rejects(attempt, (error: any) => {
      assert.doesNotMatch(String(error), /required Doctor preflight/)
      assert.match(String(error), /src\/new\.ts has not been read/)
      return true
    })
    assert.equal(mechanicalDoctorCount(data.root), 1)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("pending Harness recovery prevents any mechanical Worker preflight", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await startupWorker(data.root, "mechanical-recovery-precedence")
    const statePath = join(data.root, ".task-doctor/state.json")
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    write(statePath, `${JSON.stringify({
      ...state,
      executorRecovery: {
        status: "required",
        code: "HARNESS_BASELINE_DRIFT",
        taskPath: state.taskPath,
        taskHash: state.taskHash,
        paths: [{ path: "WORKER.md", beforeHash: digest("before"), afterHash: digest("after") }],
        detectedAt: "now",
      },
    }, null, 2)}\n`)
    configureMechanicalDoctor(data.root, "TASK DOCTOR: FAIL\n- VERIFY_FAILED: src/a.ts still needs work\n")
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: { filePath: join(data.root, "src/a.ts") },
    }), /EXECUTOR RECOVERY REQUIRED/)
    assert.equal(mechanicalDoctorCount(data.root), 0)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Harness recovery terminalizes every old Worker across recovery and compaction", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const discoverer = await initializeWorker(hooks, data.root, "recovery-discoverer")
    await initializeWorker(hooks, data.root, "recovery-waiter")
    configureMechanicalDoctor(data.root, [
      "TASK DOCTOR: EXECUTOR RECOVERY REQUIRED",
      "- HARNESS_BASELINE_DRIFT: WORKER.md",
      "",
    ].join("\n"), 1)
    await assert.rejects(() => discoverer.read("src/a.ts"), /EXECUTOR RECOVERY REQUIRED/)
    assert.equal(mechanicalDoctorCount(data.root), 1)

    const statePath = join(data.root, ".task-doctor/state.json")
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    write(statePath, `${JSON.stringify({
      ...state,
      executorRecovery: {
        status: "required",
        code: "HARNESS_BASELINE_DRIFT",
        taskPath: state.taskPath,
        taskHash: state.taskHash,
        paths: [{ path: "WORKER.md", beforeHash: digest("before"), afterHash: digest("after") }],
        detectedAt: "now",
      },
    }, null, 2)}\n`)
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID: "recovery-waiter", tool: "read" } as any, {
      args: { filePath: join(data.root, "src/a.ts") },
    }), /EXECUTOR RECOVERY REQUIRED/)
    assert.equal(mechanicalDoctorCount(data.root), 1)

    const recoveredState = JSON.parse(readFileSync(statePath, "utf8"))
    delete recoveredState.executorRecovery
    write(statePath, `${JSON.stringify(recoveredState, null, 2)}\n`)
    for (const sessionID of ["recovery-discoverer", "recovery-waiter"]) {
      await hooks.event!({ event: { type: "session.compacted", properties: { sessionID } } } as any)
    }
    configureMechanicalDoctor(data.root, "TASK DOCTOR: FAIL\n- VERIFY_FAILED: src/a.ts still needs work\n")
    for (const sessionID of ["recovery-discoverer", "recovery-waiter"]) {
      await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
        args: { filePath: join(data.root, "WORKER.md") },
      }), /terminal because it observed Harness drift/)
    }
    assert.equal(mechanicalDoctorCount(data.root), 0)

    const fresh = await initializeWorker(hooks, data.root, "recovery-fresh-worker")
    await assert.doesNotReject(() => fresh.read("src/a.ts"))
    assert.equal(mechanicalDoctorCount(data.root), 1)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("plugin restart hydrates a terminal Worker after Executor cleared recovery evidence", async () => {
  const data = fixture()
  try {
    const sessionID = "restart-recovery-worker"
    const statePath = join(data.root, ".task-doctor/state.json")
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    write(statePath, `${JSON.stringify({
      ...state,
      executorRecovery: {
        status: "required",
        code: "HARNESS_BASELINE_DRIFT",
        taskPath: state.taskPath,
        taskHash: state.taskHash,
        paths: [{ path: "WORKER.md", beforeHash: digest("before"), afterHash: digest("after") }],
        detectedAt: "now",
      },
    }, null, 2)}\n`)
    write(join(data.root, ".task-doctor/last-doctor-failure.json"), `${JSON.stringify({
      version: 1,
      sessionID,
      taskPath: state.taskPath,
      taskHash: state.taskHash,
      gate: "verify",
      output: "TASK DOCTOR: EXECUTOR RECOVERY REQUIRED\n- HARNESS_BASELINE_DRIFT: WORKER.md\n",
    }, null, 2)}\n`)

    await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const recoveredState = JSON.parse(readFileSync(statePath, "utf8"))
    delete recoveredState.executorRecovery
    write(statePath, `${JSON.stringify(recoveredState, null, 2)}\n`)
    rmSync(join(data.root, ".task-doctor/last-doctor-failure.json"), { force: true })
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID, agent: "worker" } as any, {} as any)
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: { filePath: join(data.root, "WORKER.md") },
    }), /terminal because it observed Harness drift/)
    assert.equal(mechanicalDoctorCount(data.root), 0)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("post-Apply trusted verify fallback survives Worker compaction", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID, read } = await workerHooks(data.root)
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Apply one source correction before simulating a verify transport failure.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 2" }],
    }, { agent: "worker", sessionID, metadata() {} } as any)
    configureMechanicalDoctor(data.root, "transport ended without a Doctor marker\n", 1)
    const applied: any = await hooks.tool!.apply_worker_changes.execute({
      task_path: data.taskPath,
      change_id: preview.metadata.changeID,
      preview_token: preview.metadata.previewToken,
    }, { agent: "worker", sessionID, metadata() {} } as any)
    assert.equal(applied.metadata.mechanicalDoctorStatus, "transport_failure")

    await hooks.event!({ event: { type: "session.compacted", properties: { sessionID } } } as any)
    await read("WORKER.md")
    await read(data.taskPath)
    configureMechanicalDoctor(data.root, "TASK DOCTOR: PASS\n", 0)
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: { filePath: join(data.root, "src/new.ts") },
    }), /Call verify_worker_task/)
    assert.equal(mechanicalDoctorCount(data.root), 0)

    const args = { args: {} }
    await hooks["tool.execute.before"]!({ sessionID, tool: "verify_worker_task" } as any, args as any)
    const verified: any = await hooks.tool!.verify_worker_task.execute(args.args, {
      agent: "worker",
      sessionID,
      abort: new AbortController().signal,
      metadata() {},
    } as any)
    assert.match(verified.output, /TASK DOCTOR: PASS/)
    assert.equal(mechanicalDoctorCount(data.root), 1)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("existing previews require an unbounded read at the current hash while declared NEW creates do not", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID, read } = await workerHooks(data.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the task requirement remains unresolved\n",
      readInitialTarget: false,
    })
    const context = { agent: "worker", sessionID, metadata() {} } as any
    const existingChange = () => ({
      task_path: data.taskPath,
      description: "Replace the current source value after inspecting its complete contents.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 2" }],
    })

    const truncatedReadArgs = { filePath: join(data.root, "src/a.ts") }
    await hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, { args: truncatedReadArgs })
    await hooks["tool.execute.after"]!({ sessionID, tool: "read", args: truncatedReadArgs } as any, {
      title: "read",
      output: "export const a = 1\n(File has more lines. Use offset to continue.)",
      metadata: { truncated: true, display: { truncated: true } },
    })
    await assert.rejects(
      () => hooks.tool!.preview_worker_changes.execute(existingChange(), context),
      /has not been fully read at its current hash/,
    )

    await read("src/a.ts", { limit: 1 })
    await assert.rejects(
      () => hooks.tool!.preview_worker_changes.execute(existingChange(), context),
      /has not been fully read at its current hash[\s\S]*without offset or limit/,
    )

    await read("src/a.ts")
    const preview: any = await hooks.tool!.preview_worker_changes.execute(existingChange(), context)
    assert.match(preview.output, /WORKER CHANGE PREVIEW/)
    const discarded: any = await hooks.tool!.discard_worker_changes.execute({}, context)
    assert.equal(discarded.metadata.changeID, preview.metadata.changeID)

    writeFileSync(join(data.root, "src/a.ts"), "export const a = 7\n")
    await assert.rejects(() => hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Replace the externally drifted source value only after a fresh complete read.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 7", new_text: "a = 8" }],
    }, context), /has not been fully read at its current hash/)

    const createPreview = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Create the declared NEW companion without requiring a read of a missing file.",
      operations: [{ kind: "create", path: "src/new.ts", content: "export const created = true\n" }],
    }, context)
    assert.match(createPreview.output, /src\/new\.ts/)
    assert.equal(existsSync(join(data.root, "src/new.ts")), false)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("preview_worker_changes rejects malformed final TSX before storage, mutation, or Doctor verify", async () => {
  const data = fixture()
  try {
    const target = "src/RegisterPage.tsx"
    const source = [
      "const RegisterPage = () => {",
      "  return (",
      '    <div className="container mt-5">',
      '      <div className="card p-4 mx-auto">',
      "        <form>",
      '          <button type="submit">Register</button>',
      "        </form>",
      "      </div>",
      "    </div>",
      "  );",
      "};",
      "",
      "export default RegisterPage;",
      "",
    ].join("\n")
    const taskContent = readFileSync(join(data.root, data.taskPath), "utf8")
      .replace("- `src/a.ts`", `- \`${target}\``)
    write(join(data.root, data.taskPath), taskContent)
    write(join(data.root, target), source)
    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    state.taskHash = digest(taskContent)
    state.snapshot = { [target]: digest(source) }
    write(join(data.root, ".task-doctor/state.json"), `${JSON.stringify(state, null, 2)}\n`)

    const { hooks, sessionID, read } = await workerHooks(data.root, {
      preflightOutput: `TASK DOCTOR: FAIL\n- PARSE_ERROR: ${target} has malformed JSX\n`,
      readInitialTarget: false,
    })
    await read(target)
    const doctorRunsBeforePreview = mechanicalDoctorCount(data.root)
    await assert.rejects(() => hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Remove the outer closing div from the reviewed registration page.",
      operations: [{
        kind: "rewrite",
        path: target,
        content: source.replace("    </div>\n  );", "  );"),
      }],
    }, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any), /Worker source syntax validation failed before preview storage:[\s\S]*src\/RegisterPage\.tsx:\d+:\d+ TS17008: JSX element 'div' has no corresponding closing tag\./)

    assert.equal(readFileSync(join(data.root, target), "utf8"), source)
    assert.equal(existsSync(join(data.root, ".task-doctor/worker-change-sets")), false)
    assert.equal(existsSync(join(data.root, ".task-doctor/worker-change-receipts")), false)
    assert.equal(mechanicalDoctorCount(data.root), doctorRunsBeforePreview)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("apply_worker_changes verifies mechanically and returns the exact next Doctor finding", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID, read } = await workerHooks(data.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- FALLOW_NEW_FINDING: unresolved_imports: src/a.ts\n",
    })
    const context = {
      agent: "worker",
      sessionID,
      abort: new AbortController().signal,
      metadata() {},
    } as any
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Update the exact source value in src/a.ts.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 2" }],
    }, context)
    configureMechanicalDoctor(data.root, "TASK DOCTOR: FAIL\n- VERIFY_FAILED: src/a.ts still needs the companion behavior\n")
    const applied: any = await hooks.tool!.apply_worker_changes.execute({
      task_path: data.taskPath,
      description: "Apply the exact source value update.",
      change_id: preview.metadata.changeID,
      preview_token: preview.metadata.previewToken,
    }, context)
    assert.equal(applied.metadata.mechanicalDoctor, true)
    assert.equal(applied.metadata.mechanicalDoctorStatus, "fail")
    assert.match(applied.output, /TASK DOCTOR: FAIL/)
    assert.match(applied.output, /src\/a\.ts still needs the companion behavior/)
    assert.match(applied.output, /Read that exact file next/)
    assert.equal(mechanicalDoctorCount(data.root), 1)

    await assert.doesNotReject(() => read("src/a.ts"))
    assert.equal(mechanicalDoctorCount(data.root), 1)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Worker recovery boost stays active only for the identical post-Apply hurdle and clears on change or PASS", async (t) => {
  const initialFailure = "TASK DOCTOR: FAIL\n- VERIFY_FAILED: src/a.ts still has the exact reviewed hurdle\n"
  const cases = [
    {
      name: "identical finding remains boosted",
      postApply: initialFailure,
      expectedPhase: "active",
      cleared: false,
    },
    {
      name: "changed finding clears boost",
      postApply: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: src/new.ts is now the next exact hurdle\n",
      expectedPhase: "cleared",
      cleared: true,
    },
    {
      name: "Doctor PASS clears boost",
      postApply: "TASK DOCTOR: PASS\n",
      expectedPhase: "cleared",
      cleared: true,
    },
  ] as const

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const data = fixture()
      try {
        persistActiveRecoveryBoost(data.root, data.taskPath, initialFailure)
        const { hooks, sessionID } = await workerHooks(data.root, { preflightOutput: initialFailure })
        let help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
        assert.equal(help.recoveryBoost.phase, "active", "initial preflight must never consume the bounded boost")

        const context = {
          agent: "worker",
          sessionID,
          abort: new AbortController().signal,
          metadata() {},
        } as any
        const preview: any = await hooks.tool!.preview_worker_changes.execute({
          task_path: data.taskPath,
          description: "Update the exact reviewed source hurdle in src/a.ts.",
          operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 2" }],
        }, context)
        configureMechanicalDoctor(data.root, entry.postApply)
        const applied: any = await hooks.tool!.apply_worker_changes.execute({
          task_path: data.taskPath,
          description: "Apply the exact reviewed source correction.",
          change_id: preview.metadata.changeID,
          preview_token: preview.metadata.previewToken,
        }, context)

        help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
        assert.equal(help.recoveryBoost.phase, entry.expectedPhase)
        assert.equal(applied.metadata.recoveryBoostCleared, entry.cleared)
        if (entry.cleared && !entry.postApply.includes("PASS")) {
          assert.match(applied.output, /End this boosted response now/)
        }
      } finally {
        rmSync(data.root, { recursive: true, force: true })
      }
    })
  }
})

test("a flat replace derives its exact occurrence count mechanically from current bytes", async () => {
  const data = fixture()
  try {
    write(join(data.root, "src/a.ts"), [
      "export const labels = [",
      "  'Login',",
      "  'Login',",
      "  'Login',",
      "  'Login',",
      "]",
      "",
    ].join("\n"))
    const { hooks, sessionID } = await workerHooks(data.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: src/a.ts still uses the old label\n",
    })
    const context = { agent: "worker", sessionID, metadata() {} } as any
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      kind: "replace",
      path: "src/a.ts",
      old_text: "'Login'",
      new_text: "'Sign In'",
    }, context)
    assert.match(preview.output, /derived expected_occurrences=4 from current bytes/)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8").match(/'Login'/g)?.length, 4)

    const receipt: any = await hooks.tool!.apply_worker_changes.execute({}, context)
    assert.equal(receipt.metadata.changeID, preview.metadata.changeID)
    const appliedContent = readFileSync(join(data.root, "src/a.ts"), "utf8")
    assert.equal(appliedContent.includes("'Login'"), false)
    assert.equal(appliedContent.match(/'Sign In'/g)?.length, 4)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("flat Worker paths canonicalize leading-dot and in-project absolute forms", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(data.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: src/a.ts still has the old value\n",
    })
    const context = { agent: "worker", sessionID, metadata() {} } as any
    for (const path of ["./src/a.ts", join(data.root, "src/a.ts")]) {
      const preview: any = await hooks.tool!.preview_worker_changes.execute({
        kind: "replace",
        path,
        old_text: "a = 1",
        new_text: "a = 2",
      }, context)
      assert.match(preview.output, /canonicalized path/)
      const stored = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-change-sets", `${preview.metadata.changeID}.json`), "utf8"))
      assert.equal(stored.files[0].path, "src/a.ts")
      await hooks.tool!.discard_worker_changes.execute({}, context)
    }
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("complete flat Worker input overrides stale nested operations", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(data.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: src/a.ts still has the old value\n",
    })
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      kind: "replace",
      path: "src/a.ts",
      old_text: "a = 1",
      new_text: "a = 2",
      operations: [{ kind: "delete", path: "src/a.ts" }],
    }, { agent: "worker", sessionID, metadata() {} } as any)
    assert.match(preview.output, /\+export const a = 2/)
    assert.doesNotMatch(preview.output, /deleted file/i)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("an explicit child file is eligible under a directory Scope", async () => {
  const data = fixture()
  try {
    const taskContent = readFileSync(join(data.root, data.taskPath), "utf8")
      .replace("- `src/a.ts`\n- NEW: `src/new.ts`", "- `src`")
    write(join(data.root, data.taskPath), taskContent)
    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    state.taskHash = digest(taskContent)
    write(join(data.root, ".task-doctor/state.json"), `${JSON.stringify(state, null, 2)}\n`)
    const { hooks, sessionID } = await workerHooks(data.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: src/a.ts still has the old value\n",
    })
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      kind: "replace",
      path: "src/a.ts",
      old_text: "a = 1",
      new_text: "a = 2",
    }, { agent: "worker", sessionID, metadata() {} } as any)
    assert.match(preview.output, /\+export const a = 2/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("accepts a syntactically valid locator rewrite without judging test semantics", async () => {
  const data = fixture()
  try {
    const testPath = "src/auth.test.ts"
    const baseline = [
      "import { test } from '@playwright/test'",
      "test('login', async ({ page }) => {",
      "  await page.getByRole('button', { name: 'Login' }).click()",
      "})",
      "",
    ].join("\n")
    const taskContent = readFileSync(join(data.root, data.taskPath), "utf8")
      .replace("- `src/a.ts`\n", "- `src/a.ts`\n- `src/auth.test.ts`\n")
    write(join(data.root, data.taskPath), taskContent)
    write(join(data.root, testPath), baseline)
    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    state.taskHash = digest(taskContent)
    state.snapshot[testPath] = digest(baseline)
    write(join(data.root, ".task-doctor/state.json"), `${JSON.stringify(state, null, 2)}\n`)

    const { hooks, sessionID, read } = await workerHooks(data.root, {
      preflightOutput: `TASK DOCTOR: FAIL\n- VERIFY_FAILED: ${testPath} has a stale accessible name\n`,
      readInitialTarget: false,
    })
    await read(testPath)
    const context = { agent: "worker", sessionID, metadata() {} } as any
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      kind: "rewrite",
      path: testPath,
      content: baseline.replace("name: 'Login'", "name: /login/i"),
    }, context)
    assert.match(preview.output, /name: \/login\/i/)
    assert.equal(readFileSync(join(data.root, testPath), "utf8"), baseline)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("derives rewrite or create kind from one flat path and content payload", async () => {
  const rewriteData = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(rewriteData.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the task requirement remains unresolved\n",
    })
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      path: "src/a.ts",
      content: "export const a = 2\n",
    }, { agent: "worker", sessionID, metadata() {} } as any)
    assert.match(preview.output, /derived kind=rewrite from the supplied technical payload and filesystem state/)
    assert.match(preview.output, /\+export const a = 2/)
    assert.equal(readFileSync(join(rewriteData.root, "src/a.ts"), "utf8"), "export const a = 1\n")
  } finally {
    rmSync(rewriteData.root, { recursive: true, force: true })
  }

  const createData = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(createData.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the task requirement remains unresolved\n",
      readInitialTarget: false,
    })
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      path: "src/new.ts",
      content: "export const created = true\n",
    }, { agent: "worker", sessionID, metadata() {} } as any)
    assert.match(preview.output, /derived kind=create from the supplied technical payload and filesystem state/)
    assert.equal(existsSync(join(createData.root, "src/new.ts")), false)
  } finally {
    rmSync(createData.root, { recursive: true, force: true })
  }
})

test("the provider schema exposes one flat optional Worker operation and zero-argument Apply and Discard", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(data.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the task requirement remains unresolved\n",
    })
    const shape = (hooks.tool!.preview_worker_changes as any).args
    assert.deepEqual(Object.keys(shape), ["kind", "path", "old_text", "new_text", "content"])
    const providerArgs = parseProviderToolArgs(shape, {
      kind: "replace",
      path: "src/a.ts",
      old_text: "a = 1",
      new_text: "a = 2",
    })
    assert.deepEqual(providerArgs, {
      kind: "replace",
      path: "src/a.ts",
      old_text: "a = 1",
      new_text: "a = 2",
    })
    assert.deepEqual(parseProviderToolArgs(shape, {}), {})
    const applyShape = (hooks.tool!.apply_worker_changes as any).args
    assert.deepEqual(Object.keys(applyShape), [])
    assert.deepEqual(parseProviderToolArgs(applyShape, {
      task_path: data.taskPath,
      change_id: "C-forged",
      preview_token: "P-forged",
    }), {})
    const discardShape = (hooks.tool!.discard_worker_changes as any).args
    assert.deepEqual(Object.keys(discardShape), [])
    assert.deepEqual(parseProviderToolArgs(discardShape, {
      task_path: data.taskPath,
      change_id: "C-forged",
      description: "forged",
    }), {})

    const preview: any = await hooks.tool!.preview_worker_changes.execute(providerArgs, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any)
    assert.match(preview.output, /\+export const a = 2/)
    assert.match(preview.output, /apply_worker_changes without arguments/)
    assert.doesNotMatch(preview.output, /using .*preview token/)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 1\n")
    await assert.rejects(() => hooks.tool!.preview_worker_changes.execute(providerArgs, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any), (error: any) => {
      assert.match(String(error), /is already the latest pending preview for src\/a\.ts/)
      assert.match(String(error), /apply_worker_changes without arguments/)
      assert.match(String(error), /discard_worker_changes without arguments/)
      return true
    })
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("rejects ambiguous target inference and requires a current read for an explicit target", async () => {
  const ambiguousData = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(ambiguousData.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the task requirement remains unresolved\n",
    })
    await assert.rejects(() => hooks.tool!.preview_worker_changes.execute({
      content: "export const value = 2\n",
    }, { agent: "worker", sessionID, metadata() {} } as any), (error: any) => {
      assert.match(String(error), /Cannot derive one Worker change target from 2 technically eligible Scope paths/)
      assert.match(String(error), /mechanically eligible list: src\/a\.ts, src\/new\.ts/)
      return true
    })
  } finally {
    rmSync(ambiguousData.root, { recursive: true, force: true })
  }

  const unreadData = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(unreadData.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the task requirement remains unresolved\n",
      readInitialTarget: false,
    })
    await assert.rejects(() => hooks.tool!.preview_worker_changes.execute({
      path: "src/a.ts",
      content: "export const a = 2\n",
    }, { agent: "worker", sessionID, metadata() {} } as any), /src\/a\.ts has not been fully read at its current hash/)
  } finally {
    rmSync(unreadData.root, { recursive: true, force: true })
  }
})

test("an out-of-scope Worker target self-heals from one unique exact in-scope anchor or returns exact eligible paths", async () => {
  const repairedData = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(repairedData.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the task requirement remains unresolved\n",
    })
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      path: "src/outside.ts",
      old_text: "export const a = 1",
      new_text: "export const a = 2",
    }, { agent: "worker", sessionID, metadata() {} } as any)
    assert.match(preview.output, /src\/a\.ts: repaired path from the unique exact in-scope anchor match/)
    assert.match(preview.output, /\+export const a = 2/)
    assert.equal(readFileSync(join(repairedData.root, "src/a.ts"), "utf8"), "export const a = 1\n")
  } finally {
    rmSync(repairedData.root, { recursive: true, force: true })
  }

  const rejectedData = fixture()
  try {
    write(join(rejectedData.root, "src/outside.ts"), "export const outside = 1\n")
    const { hooks, sessionID } = await workerHooks(rejectedData.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the task requirement remains unresolved\n",
    })
    await assert.rejects(() => hooks.tool!.preview_worker_changes.execute({
      path: "src/outside.ts",
      old_text: "export const outside = 1",
      new_text: "export const outside = 2",
    }, { agent: "worker", sessionID, metadata() {} } as any), (error: any) => {
      assert.match(String(error), /src\/outside\.ts is not one technically eligible file/)
      assert.match(String(error), /mechanically eligible list: src\/a\.ts\./)
      assert.doesNotMatch(String(error), /mechanically eligible list:.*src\/new\.ts/)
      assert.match(String(error), /sole eligible path in src is src\/a\.ts/)
      return true
    })
  } finally {
    rmSync(rejectedData.root, { recursive: true, force: true })
  }

  const nonReplaceData = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(nonReplaceData.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the task requirement remains unresolved\n",
    })
    await assert.rejects(() => hooks.tool!.preview_worker_changes.execute({
      kind: "delete",
      path: "src/outside.ts",
      old_text: "export const a = 1",
    }, { agent: "worker", sessionID, metadata() {} } as any), /src\/outside\.ts is not one technically eligible file/)
    assert.equal(readFileSync(join(nonReplaceData.root, "src/a.ts"), "utf8"), "export const a = 1\n")
  } finally {
    rmSync(nonReplaceData.root, { recursive: true, force: true })
  }
})

test("a reviewed retry uses Executor evidence once and requires Doctor verify after its first apply", async () => {
  const data = fixture()
  try {
    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({
      version: 1,
      updatedAt: "now",
      requests: [{
        version: 1,
        id: "H1",
        status: "retry_approved",
        taskPath: data.taskPath,
        taskHash: state.taskHash,
        workerSessionID: "worker-original",
        category: "test_failure",
        problem: "src/a.ts still contains the old value after the previous Worker stopped.",
        attemptedActions: ["Ran the exact Doctor verification once."],
        evidence: ["Doctor reported the focused failure in src/a.ts."],
        relevantFiles: [data.taskPath, "src/a.ts"],
        suggestedNextStep: "Retry once from the current source state.",
        createdAt: "now",
        executorReview: {
          sessionID: "executor",
          decision: "retry_worker",
          rootCause: "The previous Worker did not update src/a.ts.",
          retryStrategy: "Read src/a.ts and replace the old value once.",
          expectedResults: ["src/a.ts contains the required value and Doctor verification passes."],
          reviewedFiles: [data.taskPath, "src/a.ts"],
          reviewedAt: "now",
        },
      }],
    }, null, 2)}\n`)
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const delegation = {
      args: {
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
      },
    }
    await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task", callID: "failed-task" } as any, delegation as any)
    assert.match(delegation.args.prompt, /Strict read order: first read WORKER\.md, every Guard-named model-family file, and the exact task \(those reads may occur in any order\)\. Only after all required rule\/task reads, read any Guard-named finding target before another implementation file\. Do not preview a target until its complete current contents were read\./)
    assert.match(delegation.args.prompt, /Executor review below is the authoritative preflight/)
    assert.match(delegation.args.prompt, /Do not rerun Doctor verify before the first correction/)
    assert.match(delegation.args.prompt, /After the required rule\/task reads, read src\/a\.ts as the first implementation file\./)
    assert.match(delegation.args.prompt, /call apply_worker_changes without arguments/)
    assert.doesNotMatch(delegation.args.prompt, /change ID and preview token/)
    assert.doesNotMatch(delegation.args.prompt, /Immediately after the required reads, run npm run task:doctor:verify/)

    let store = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(store.requests[0].status, "delegated")
    await hooks.event!({ event: {
      type: "message.part.updated",
      properties: {
        sessionID: "executor",
        part: { id: "failed-task", type: "tool", tool: "task", state: { status: "error", error: "spawn failed" } },
      },
    } } as any)
    store = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(store.requests[0].status, "retry_approved")
    assert.equal(store.requests[0].delegatedWorkerSessionID, undefined)

    const retryDelegation = {
      args: {
        description: `Resume ${data.taskPath}`,
        prompt: `Resume ${data.taskPath}`,
        subagent_type: "worker",
      },
    }
    await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task" } as any, retryDelegation as any)

    await hooks["chat.message"]!({ sessionID: "worker-retry", agent: "worker" } as any, {} as any)
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: {
        id: "worker-retry",
        parentID: "executor",
        agent: "worker",
        providerID: "llamacpp-local",
        modelID: "gemma4-12b",
      } },
    } } as any)
    const read = async (path: string) => {
      const args = { filePath: join(data.root, path) }
      await hooks["tool.execute.before"]!({ sessionID: "worker-retry", tool: "read" } as any, { args })
      await hooks["tool.execute.after"]!({ sessionID: "worker-retry", tool: "read", args } as any, {
        title: "read",
        output: readFileSync(join(data.root, path), "utf8"),
        metadata: {},
      })
    }
    await read("WORKER.md")
    await read(data.taskPath)
    await read("src/a.ts")

    const reviewedNoOpArgs = {
      task_path: data.taskPath,
      description: "Leave the reviewed finding target at its current value.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 1" }],
    }
    await hooks["tool.execute.before"]!({ sessionID: "worker-retry", tool: "preview_worker_changes" } as any, { args: reviewedNoOpArgs })
    const noChange: any = await hooks.tool!.preview_worker_changes.execute(reviewedNoOpArgs as any, {
      agent: "worker",
      sessionID: "worker-retry",
      metadata() {},
    } as any)
    assert.equal(noChange.metadata.noChange, true)
    assert.equal(noChange.metadata.terminal, undefined)
    assert.match(noChange.output, /WORKER OPERATION VALIDATED: NO BYTE CHANGE/)
    const helpAfterNoChange = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(helpAfterNoChange.requests.length, 1)
    assert.equal(helpAfterNoChange.requests[0].status, "delegated")

    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Replace the reviewed stale value in src/a.ts.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 2" }],
    }, { agent: "worker", sessionID: "worker-retry", metadata() {} } as any)
    const applied: any = await hooks.tool!.apply_worker_changes.execute({}, { agent: "worker", sessionID: "worker-retry", metadata() {} } as any)
    assert.match(applied.output, /Call verify_worker_task exactly once/)

    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID: "worker-retry", tool: "read" } as any, {
      args: { filePath: join(data.root, "src/new.ts") },
    }), /Call verify_worker_task/)
    const postApplyCommand = { args: { command: "npm --prefix code/frontend run test:e2e -- focused.spec.ts" } }
    await assert.rejects(
      () => hooks["tool.execute.before"]!({ sessionID: "worker-retry", tool: "bash" } as any, postApplyCommand as any),
      /Call verify_worker_task/,
    )
    configureMechanicalDoctor(data.root, "TASK DOCTOR: PASS\n", 0)
    const trustedArgs = { args: {} }
    await hooks["tool.execute.before"]!({ sessionID: "worker-retry", tool: "verify_worker_task" } as any, trustedArgs as any)
    const verified: any = await hooks.tool!.verify_worker_task.execute(trustedArgs.args, {
      agent: "worker",
      sessionID: "worker-retry",
      abort: new AbortController().signal,
      metadata() {},
    } as any)
    assert.match(verified.output, /TASK DOCTOR: PASS/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("an untargeted reviewed retry requires a fresh Doctor preflight before implementation inspection", async () => {
  const data = fixture()
  try {
    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({
      version: 1,
      updatedAt: "now",
      requests: [{
        version: 1,
        id: "H2",
        status: "retry_approved",
        taskPath: data.taskPath,
        taskHash: state.taskHash,
        workerSessionID: "worker-original",
        category: "test_failure",
        problem: "The previous verification failed without naming one implementation target.",
        attemptedActions: ["Ran Doctor verification."],
        evidence: ["The data.ts runner stopped before producing a scoped file diagnostic."],
        relevantFiles: [data.taskPath, "src/a.ts"],
        suggestedNextStep: "Run a fresh verification and follow its first exact finding.",
        createdAt: "now",
        executorReview: {
          sessionID: "executor",
          decision: "retry_worker",
          rootCause: "The previous diagnostic is stale and has no exact target.",
          retryStrategy: "Run Doctor verification from current state before inspecting implementation files.",
          expectedResults: ["The fresh Worker follows the current first finding."],
          reviewedFiles: [data.taskPath, "src/a.ts"],
          reviewedAt: "now",
        },
      }],
    }, null, 2)}\n`)
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const delegation = { args: { description: `Resume ${data.taskPath}`, prompt: `Resume ${data.taskPath}`, subagent_type: "worker" } }
    await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task" } as any, delegation as any)
    assert.match(delegation.args.prompt, /Harness runs Doctor verify mechanically before that read/)
    assert.doesNotMatch(delegation.args.prompt, /authoritative preflight|Do not rerun Doctor verify/)

    const sessionID = "worker-untargeted-retry"
    await hooks["chat.message"]!({ sessionID, agent: "worker" } as any, {} as any)
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: sessionID, parentID: "executor", agent: "worker", providerID: "llamacpp-local", modelID: "qwen3.5-9b-q4" } },
    } } as any)
    const read = async (path: string) => {
      const args = { filePath: join(data.root, path) }
      await hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, { args })
      await hooks["tool.execute.after"]!({ sessionID, tool: "read", args } as any, {
        title: "read",
        output: readFileSync(join(data.root, path), "utf8"),
        metadata: {},
      })
    }
    await read("WORKER.md")
    await read(data.taskPath)
    configureMechanicalDoctor(data.root, "TASK DOCTOR: FAIL\n- FALLOW_NEW_FINDING: unresolved_imports: src/a.ts\n")
    await assert.doesNotReject(() => read("src/a.ts"))
    assert.equal(mechanicalDoctorCount(data.root), 1)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("repeated successful no-change previews remain non-terminal", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(data.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the task requirement remains unresolved\n",
      readInitialTarget: false,
    })
    let partID = 0
    const observePreview = async (noChange: boolean, path: string | null = "src/a.ts") => hooks.event!({ event: {
      type: "message.part.updated",
      properties: { part: {
        id: `preview-${++partID}`,
        sessionID,
        type: "tool",
        tool: "preview_worker_changes",
        state: {
          status: "completed",
          input: { task_path: data.taskPath },
          output: noChange ? "WORKER OPERATION VALIDATED: NO BYTE CHANGE" : "WORKER CHANGE PREVIEW C-1",
          metadata: { ...(path ? { paths: [path] } : {}), ...(noChange ? { noChange: true } : {}) },
        },
      } },
    } } as any)

    await observePreview(true)
    await observePreview(false)
    await observePreview(true)
    await observePreview(true, "src/new.ts")
    await observePreview(true, null)
    await observePreview(true, null)
    await assert.doesNotReject(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: { filePath: join(data.root, "src/a.ts") },
    }))

    await observePreview(true)
    assert.equal(existsSync(join(data.root, ".task-doctor/worker-help.json")), false)
    await assert.doesNotReject(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: { filePath: join(data.root, "src/a.ts") },
    }))
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("a Doctor report preserves a current finding read and resets older semantic tool failures", async () => {
  const data = fixture()
  try {
    write(join(data.root, "project.json"), JSON.stringify({
      settings: {
        opencode: {
          workflowGuard: { transactionalWorkerChanges: true },
          workerHelp: { failureThreshold: 2 },
        },
      },
    }))
    const { hooks, sessionID, read } = await workerHooks(data.root, {
      readInitialTarget: false,
    })
    let partID = 0
    const observePreviewError = async () => hooks.event!({ event: {
      type: "message.part.updated",
      properties: { part: {
        id: `preview-error-${++partID}`,
        sessionID,
        type: "tool",
        tool: "preview_worker_changes",
        state: {
          status: "error",
          input: { task_path: data.taskPath, operations: [{ kind: "replace", path: "src/a.ts" }] },
          error: "src/a.ts has not been read since the current Doctor failure.",
        },
      } },
    } } as any)

    await observePreviewError()
    await read("src/a.ts")
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      purpose: "Apply the first correction so the queued Doctor returns a fresh report.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 2" }],
    }, { agent: "worker", sessionID, metadata() {} } as any)
    configureMechanicalDoctor(data.root, "TASK DOCTOR: FAIL\n- VERIFY_FAILED: expected src/a.ts to export the corrected value\n")
    const applied: any = await hooks.tool!.apply_worker_changes.execute({
      task_path: data.taskPath,
      change_id: preview.metadata.changeID,
      preview_token: preview.metadata.previewToken,
    }, { agent: "worker", sessionID, metadata() {} } as any)
    assert.match(applied.output, /expected src\/a\.ts to export the corrected value/)
    await read("src/a.ts")

    await observePreviewError()
    const afterFreshReport = existsSync(join(data.root, ".task-doctor/worker-help.json"))
      ? JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
      : { requests: [] }
    assert.equal(afterFreshReport.requests.length, 0)
    await observePreviewError()
    const store = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(store.requests.length, 1)
    assert.equal(store.requests[0].status, "pending")
    assert.equal(store.requests[0].workerSessionID, sessionID)
    assert.equal(store.requests[0].taskPath, data.taskPath)
    assert.match(store.requests[0].category, /^error:/)
    assert.match(store.requests[0].evidence.join("\n"), /2 equivalent failures occurred for preview_worker_changes on src\/a\.ts\./)
    assert.match(store.requests[0].evidence.join("\n"), /src\/a\.ts has not been read since the current Doctor failure\./)
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: { filePath: join(data.root, "src/a.ts") },
    }), /WORKER HELP IS TERMINAL[\s\S]*Help ID: H1/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Doctor finding selection ignores scoped paths from earlier successful RUN sections", async () => {
  const data = fixture()
  try {
    const taskContent = [
      "# Task",
      "",
      "## Scope",
      "- `src/a.ts`",
      "- `tests/auth-navigation.spec.ts`",
      "- `tests/auth.spec.ts`",
      "",
      "## Requirement",
      "Keep both focused auth tests aligned with the implemented navigation contract.",
      "",
    ].join("\n")
    write(join(data.root, data.taskPath), taskContent)
    write(join(data.root, "tests/auth-navigation.spec.ts"), "export const navigation = true\n")
    write(join(data.root, "tests/auth.spec.ts"), "export const auth = true\n")
    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    write(join(data.root, ".task-doctor/state.json"), `${JSON.stringify({ ...state, taskHash: digest(taskContent) }, null, 2)}\n`)

    const doctorOutput = [
      "TASK DOCTOR: RUN npm test -- tests/auth-navigation.spec.ts",
      "tests/auth-navigation.spec.ts passed",
      "TASK DOCTOR: RUN npm test -- tests/auth.spec.ts",
      "tests/auth.spec.ts failed while waiting for Login",
      "TASK DOCTOR: FAIL",
      "- VERIFY_FAILED: tests/auth.spec.ts",
      "",
    ].join("\n")
    const { hooks, sessionID } = await workerHooks(data.root, {
      preflightOutput: doctorOutput,
      readInitialTarget: false,
    })
    const unrelatedRead = { filePath: join(data.root, "src/a.ts") }
    await assert.rejects(
      () => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, { args: unrelatedRead }),
      /tests\/auth\.spec\.ts has not been read/,
    )
    const earlierSuccessfulRead = { filePath: join(data.root, "tests/auth-navigation.spec.ts") }
    await assert.rejects(
      () => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, { args: earlierSuccessfulRead }),
      /tests\/auth\.spec\.ts has not been read/,
    )

    const failingRead = { filePath: join(data.root, "tests/auth.spec.ts") }
    await hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, { args: failingRead })
    await hooks["tool.execute.after"]!({ sessionID, tool: "read", args: failingRead } as any, {
      title: "read",
      output: readFileSync(join(data.root, "tests/auth.spec.ts"), "utf8"),
      metadata: { truncated: false },
    })
    await assert.doesNotReject(
      () => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, { args: unrelatedRead }),
    )
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("a missing declared NEW finding does not impose model-scored edit ordering", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID, read } = await workerHooks(data.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: expected src/new.ts but the file was not found\n",
      readInitialTarget: false,
    })

    const missingReadArgs = { filePath: join(data.root, "src/new.ts") }
    await assert.doesNotReject(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: missingReadArgs,
    }))
    await read("src/a.ts")

    const existingPreview = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      purpose: "Change an existing file before creating the Doctor-named missing companion file.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 2" }],
    }, { agent: "worker", sessionID, metadata() {} } as any)
    assert.match(existingPreview.output, /src\/a\.ts/)
    await hooks.tool!.discard_worker_changes.execute({}, { agent: "worker", sessionID, metadata() {} } as any)

    const preview = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      purpose: "Create the exact Doctor-named companion file declared NEW by the active task.",
      operations: [{ kind: "create", path: "src/new.ts", content: "export const created = true\n" }],
    }, { agent: "worker", sessionID, metadata() {} } as any)
    assert.match(preview.output, /src\/new\.ts/)
    assert.equal(existsSync(join(data.root, "src/new.ts")), false)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("persists repeated Doctor failures as terminal Worker help", async () => {
  const data = fixture()
  try {
    const failure = "TASK DOCTOR: FAIL\n- VERIFY_FAILED: expected exit 0, got 1: npm test\n"
    const { hooks, sessionID, read } = await workerHooks(data.root, { preflightOutput: failure })
    configureMechanicalDoctorRuns(data.root, [
      { output: failure, exitCode: 1 },
      { output: failure, exitCode: 1 },
    ])
    const first: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Apply the first distinct correction before Doctor reports the remaining failure.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 2" }],
    }, { agent: "worker", sessionID, metadata() {} } as any)
    await hooks.tool!.apply_worker_changes.execute({
      task_path: data.taskPath,
      change_id: first.metadata.changeID,
      preview_token: first.metadata.previewToken,
    }, { agent: "worker", sessionID, metadata() {} } as any)
    await read("src/a.ts")
    const second: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Apply a second distinct correction before the equivalent Doctor failure repeats.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 2", new_text: "a = 3" }],
    }, { agent: "worker", sessionID, metadata() {} } as any)
    await hooks.tool!.apply_worker_changes.execute({
      task_path: data.taskPath,
      change_id: second.metadata.changeID,
      preview_token: second.metadata.previewToken,
    }, { agent: "worker", sessionID, metadata() {} } as any)

    const store = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(store.requests.length, 1)
    assert.equal(store.requests[0].status, "pending")
    assert.equal(store.requests[0].workerSessionID, sessionID)
    assert.equal(store.requests[0].taskPath, data.taskPath)

    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: { filePath: join(data.root, "src/a.ts") },
    }), /WORKER HELP IS TERMINAL/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("an apply does not hide an equivalent Doctor failure", async () => {
  const data = fixture()
  try {
    const failure = "TASK DOCTOR: FAIL\n- FALLOW_NEW_FINDING: unresolved_imports: src/a.ts\n"
    const { hooks, sessionID, read } = await workerHooks(data.root, { preflightOutput: failure })
    configureMechanicalDoctorRuns(data.root, [
      { output: failure, exitCode: 1 },
      { output: failure, exitCode: 1 },
    ])
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      purpose: "Apply one exact source correction before checking the remaining task findings.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 2" }],
    }, { agent: "worker", sessionID, metadata() {} } as any)
    await hooks.tool!.apply_worker_changes.execute({
      task_path: data.taskPath,
      change_id: preview.metadata.changeID,
      preview_token: preview.metadata.previewToken,
    }, { agent: "worker", sessionID, metadata() {} } as any)
    await read("src/a.ts")
    const second: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      purpose: "Apply another distinct correction while preserving the equivalent Doctor history.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 2", new_text: "a = 3" }],
    }, { agent: "worker", sessionID, metadata() {} } as any)
    await hooks.tool!.apply_worker_changes.execute({
      task_path: data.taskPath,
      change_id: second.metadata.changeID,
      preview_token: second.metadata.previewToken,
    }, { agent: "worker", sessionID, metadata() {} } as any)
    const storePath = join(data.root, ".task-doctor/worker-help.json")
    const afterRepeatedFailure = JSON.parse(readFileSync(storePath, "utf8"))
    assert.equal(afterRepeatedFailure.requests.length, 1)
    assert.equal(afterRepeatedFailure.requests[0].category, "repeated-doctor-failure")
    await assert.rejects(() => read("src/a.ts"), /WORKER HELP IS TERMINAL/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("persists one slow failed Doctor verify before a second long retry can detach Worker", async () => {
  const data = fixture()
  const originalNow = Date.now
  let now = 10_000
  try {
    const failure = "TASK DOCTOR: FAIL\n- VERIFY_FAILED: unrelated legacy suite failed after a long run\n"
    const { hooks, sessionID } = await workerHooks(data.root)
    configureMechanicalDoctor(data.root, failure, 1, 50)
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Apply one correction before the configured slow Doctor failure returns.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "a = 1", new_text: "a = 2" }],
    }, { agent: "worker", sessionID, metadata() {} } as any)
    Date.now = () => now
    const apply = hooks.tool!.apply_worker_changes.execute({
      task_path: data.taskPath,
      change_id: preview.metadata.changeID,
      preview_token: preview.metadata.previewToken,
    }, { agent: "worker", sessionID, metadata() {} } as any)
    for (let attempt = 0; attempt < 200 && mechanicalDoctorCount(data.root) < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    assert.equal(mechanicalDoctorCount(data.root), 1)
    now += 120_001
    await apply

    const store = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(store.requests.length, 1)
    assert.match(store.requests[0].evidence.join("\n"), /another long retry would risk detaching/)
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "read" } as any, {
      args: { filePath: join(data.root, "src/a.ts") },
    }), /WORKER HELP IS TERMINAL/)
  } finally {
    Date.now = originalNow
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("persists terminal Worker provider errors but respects an explicit abort", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const workerSessionID = "worker-provider-error"
    await hooks["chat.message"]!({ sessionID: workerSessionID, agent: "worker" } as any, {} as any)
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: workerSessionID, parentID: "executor", agent: "worker", directory: data.root } },
    } } as any)
    await hooks.event!({ event: {
      type: "session.error",
      properties: {
        sessionID: workerSessionID,
        error: { name: "APIError", data: { message: "upstream connection closed", isRetryable: true } },
      },
    } } as any)
    let store = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(store.requests.length, 1)
    assert.match(store.requests[0].problem, /APIError: upstream connection closed/)

    const abortedSessionID = "worker-user-abort"
    await hooks["chat.message"]!({ sessionID: abortedSessionID, agent: "worker" } as any, {} as any)
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: abortedSessionID, parentID: "executor", agent: "worker", directory: data.root } },
    } } as any)
    await hooks.event!({ event: {
      type: "session.error",
      properties: { sessionID: abortedSessionID, error: { name: "MessageAbortedError", data: { message: "stopped by user" } } },
    } } as any)
    store = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8"))
    assert.equal(store.requests.length, 1)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("blocks direct Worker mutations and applies one previewed file at a time", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID, read, verify } = await workerHooks(data.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the general task requirement remains unresolved\n",
    })
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "edit" } as any, {
      args: { filePath: join(data.root, "src/a.ts"), oldString: "a = 1", newString: "a = 2" },
    }), /preview_worker_changes/)
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "bash" } as any, {
      args: { command: "node -e \"require('fs').writeFileSync('src/a.ts', 'bad')\"" },
    }), /transactional allowlist|Arbitrary scripts/)

    await assert.rejects(() => hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      purpose: "Attempt to combine two source files in one unsafe model-sized preview.",
      operations: [
        { operation: "replace", filePath: "src/a.ts", oldText: "a = 1", newText: "a = 2" },
        { kind: "create", path: "src/new.ts", content: "export const created = true\n" },
      ],
    }, { agent: "worker", sessionID, metadata() {} } as any), /Preview exactly one project file/)

    await read("src/a.ts")
    const identicalReplace: any = await hooks.tool!.preview_worker_changes.execute({
      kind: "replace",
      path: "src/a.ts",
      old_text: "a = 1",
      new_text: "a = 1",
    }, { agent: "worker", sessionID, metadata() {} } as any)
    assert.equal(identicalReplace.metadata.noChange, true)
    assert.match(identicalReplace.output, /WORKER OPERATION VALIDATED: NO BYTE CHANGE/)

    const identicalRewrite: any = await hooks.tool!.preview_worker_changes.execute({
      kind: "rewrite",
      path: "src/a.ts",
      content: "export const a = 1\n",
    }, { agent: "worker", sessionID, metadata() {} } as any)
    assert.equal(identicalRewrite.metadata.noChange, true)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 1\n")

    const previewArgs = {
      kind: "replace",
      path: "src/a.ts",
      old_text: "a = 1",
      new_text: "a = 2",
    }
    await assert.doesNotReject(() => hooks["tool.execute.before"]!({ sessionID, tool: "preview_worker_changes" } as any, { args: previewArgs }))
    assert.deepEqual(Object.keys(previewArgs).sort(), ["kind", "new_text", "old_text", "path", "task_path"])
    assert.equal((previewArgs as any).path, "src/a.ts")
    assert.equal((previewArgs as any).task_path, data.taskPath)
    assert.equal((previewArgs as any).__workflow_payload, undefined)
    const preview = await hooks.tool!.preview_worker_changes.execute(previewArgs, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 1\n")
    assert.match(preview.output, /--- a\/src\/a\.ts/)
    await assert.doesNotReject(() => hooks["tool.execute.after"]!({
      sessionID,
      tool: "preview_worker_changes",
      args: previewArgs,
    } as any, preview as any))

    const applyArgs = {}
    await assert.doesNotReject(() => hooks["tool.execute.before"]!({ sessionID, tool: "apply_worker_changes" } as any, { args: applyArgs }))
    assert.deepEqual(applyArgs, {})
    configureMechanicalDoctor(data.root, "not a terminal Doctor report\n", 1)
    const applied: any = await hooks.tool!.apply_worker_changes.execute(applyArgs, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any)
    assert.equal(applied.metadata.changeID, preview.metadata.changeID)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 2\n")
    assert.equal(existsSync(join(data.root, "src/new.ts")), false)

    const forgedArgs = { command: "echo 'TASK DOCTOR: PASS npm run task:doctor:verify -- kanban/todo/01-task.md'" }
    await hooks["tool.execute.after"]!({ sessionID, tool: "bash", args: forgedArgs } as any, {
      title: "Untrusted wrapper output",
      output: "TASK DOCTOR: PASS kanban/todo/01-task.md",
      metadata: { exitCode: 0 },
    })
    const blockedPreview = {
      args: { kind: "create", path: "src/new.ts", content: "export const created = true\n" },
    }
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "preview_worker_changes" } as any, blockedPreview), /Call verify_worker_task/)
    assert.deepEqual(Object.keys(blockedPreview.args).sort(), ["content", "kind", "path", "task_path"])
    assert.equal((blockedPreview.args as any).__workflow_payload, undefined)
    await verify("TASK DOCTOR: FAIL\n- ADD_COMPANION_FILE\n")

    const createArgs = {
      kind: "create",
      path: "src/new.ts",
      content: "export const created = true\n",
    }
    const createPreview = await hooks.tool!.preview_worker_changes.execute(createArgs, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any)
    const createApplied: any = await hooks.tool!.apply_worker_changes.execute({}, { agent: "worker", sessionID, metadata() {} } as any)
    assert.equal(createApplied.metadata.changeID, createPreview.metadata.changeID)
    assert.equal(readFileSync(join(data.root, "src/new.ts"), "utf8"), "export const created = true\n")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("keeps the existing Executor mutation guard separate from Worker transactions", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID: "executor", tool: "edit" } as any, {
      args: { filePath: join(data.root, "src/a.ts"), oldString: "a = 1", newString: "a = 2" },
    }), /Executor attempted to change a file/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("direct custom-tool execute calls keep visible arguments flat and metadata separate", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(data.root)
    const metadataCalls: Array<{ title: string; keys: string[] }> = []
    let activeArgs: Record<string, unknown> | undefined
    const context = {
      agent: "worker",
      sessionID,
      metadata(value: any) {
        metadataCalls.push({ title: value.title, keys: Object.keys(activeArgs ?? {}).sort() })
      },
    } as any
    const previewArgs = {
      kind: "replace",
      path: "src/a.ts",
      old_text: "a = 1",
      new_text: "a = 2",
    }
    activeArgs = previewArgs
    const preview: any = await hooks.tool!.preview_worker_changes.execute(previewArgs, context)

    assert.deepEqual(Object.keys(previewArgs).sort(), ["kind", "new_text", "old_text", "path", "task_path"])
    assert.equal((previewArgs as any).task_path, data.taskPath)
    assert.equal((previewArgs as any).__workflow_payload, undefined)
    assert.deepEqual(metadataCalls[0], {
      title: "Preview replace: a.ts",
      keys: ["kind", "new_text", "old_text", "path", "task_path"],
    })

    const applyArgs = {}
    const applyMetadataIndex = metadataCalls.length
    activeArgs = applyArgs
    const applied: any = await hooks.tool!.apply_worker_changes.execute(applyArgs, context)

    assert.deepEqual(applyArgs, {})
    assert.equal(applied.metadata.changeID, preview.metadata.changeID)
    assert.equal(metadataCalls[applyMetadataIndex].title, "Apply Worker change")
    assert.deepEqual(metadataCalls[applyMetadataIndex].keys, [])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("the pre-tool hook keeps a minimal flat operation and derives only the active task", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(data.root)
    const args: any = {
      kind: "replace",
      path: "src/a.ts",
      old_text: "a = 1",
      new_text: "a = 2",
    }
    await assert.doesNotReject(() => hooks["tool.execute.before"]!({
      sessionID,
      tool: "preview_worker_changes",
    } as any, { args }))
    assert.equal(args.task_path, data.taskPath)
    assert.equal(args.description, undefined)
    assert.equal(args.__workflow_payload, undefined)

    const preview: any = await hooks.tool!.preview_worker_changes.execute(args, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any)
    assert.match(preview.output, /\+export const a = 2/)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 1\n")
    await hooks.tool!.discard_worker_changes.execute({}, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any)

    const unusable: any = {
      kind: "rewrite",
      path: "src/a.ts",
      old_text: ";",
    }
    await assert.doesNotReject(() => hooks["tool.execute.before"]!({
      sessionID,
      tool: "preview_worker_changes",
    } as any, { args: unusable }))
    await assert.rejects(() => hooks.tool!.preview_worker_changes.execute(unusable, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any), /rewrite operation 1 requires content/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("fills a flat preview task path from the sole active started Doctor task", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(data.root)
    const args: any = {
      kind: "replace",
      path: "src/a.ts",
      old_text: "a = 1",
      new_text: "a = 2",
    }
    await assert.doesNotReject(() => hooks["tool.execute.before"]!({
      sessionID,
      tool: "preview_worker_changes",
    } as any, { args }))
    assert.equal(args.task_path, data.taskPath)
    assert.equal(args.__workflow_payload, undefined)
    const preview: any = await hooks.tool!.preview_worker_changes.execute(args, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any)
    assert.equal(preview.metadata.task, data.taskPath)
    assert.match(preview.output, /\+export const a = 2/)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 1\n")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("does not invent a flat preview task path without an active started Doctor task", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(data.root)
    write(join(data.root, ".task-doctor/state.json"), JSON.stringify({ version: 4, status: "ready" }))
    const args: any = {
      kind: "replace",
      path: "src/a.ts",
      old_text: "a = 1",
      new_text: "a = 2",
    }
    await assert.doesNotReject(() => hooks["tool.execute.before"]!({
      sessionID,
      tool: "preview_worker_changes",
    } as any, { args }))
    assert.equal(args.task_path, undefined)
    await assert.rejects(() => hooks.tool!.preview_worker_changes.execute(args, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any), /is not the exact active started task/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("repairs Qwen punctuation-wrapped replace fields and drops one metadata-only pseudo-operation", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(data.root)
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      purpose: "Replace the exact current source value after repairing punctuation-wrapped fields.",
      operations: [{
        expected_occurrences: 1,
        "kind:": { old_text: "a = 1", new_text: "a = 2" },
        "path:": { name: "src/a.ts" },
      }, {
        description: { purpose: "Change the exact current value in src/a.ts." },
      }],
    }, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any)
    assert.match(preview.output, /recovered old_text/)
    assert.match(preview.output, /recovered path/)
    assert.match(preview.output, /inferred kind=replace/)
    assert.match(preview.output, /dropped metadata-only pseudo-operation/)
    assert.match(preview.output, /\+export const a = 2/)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 1\n")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("unwraps one content scalar only for malformed exact replace text fields", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(data.root)
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Replace the exact source value after unwrapping Qwen text fields.",
      operations: [{
        kind: "replace",
        path: "src/a.ts",
        "old_text\n": { content: "a = 1" },
        'new_text\": ': { content: "a = 2" },
      }],
    }, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any)
    assert.match(preview.output, /recovered old_text/)
    assert.match(preview.output, /recovered new_text/)
    assert.match(preview.output, /\+export const a = 2/)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 1\n")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("repairs Qwen embedded path syntax only into the same reviewed replace operation", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(data.root)
    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      purpose: "Replace the exact current source value after separating the embedded path suffix.",
      operations: [{
        expected_occurrences: 1,
        "kind”: replace”, ": {
          old_text: "a = 1,\"path”: “src/a.ts",
          new_text: "a = 2",
        },
      }],
    }, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any)
    assert.match(preview.output, /separated embedded path from old_text/)
    assert.match(preview.output, /\+export const a = 2/)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 1\n")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("fails closed for ambiguous or broadened Qwen operation repairs", async () => {
  const cases: Array<{ name: string; operations: any[] }> = [{
    name: "conflicting canonical and wrapped paths",
    operations: [{
      path: "src/a.ts",
      "path:": { name: "src/new.ts" },
      "kind:": { old_text: "a = 1", new_text: "a = 2" },
    }],
  }, {
    name: "multiple scalar path wrapper candidates",
    operations: [{
      "path:": { name: "src/a.ts", value: "src/new.ts" },
      "kind:": { old_text: "a = 1", new_text: "a = 2" },
    }],
  }, {
    name: "content wrapper used for a path",
    operations: [{
      kind: "replace",
      "path:": { content: "src/a.ts" },
      old_text: "a = 1",
      new_text: "a = 2",
    }],
  }, {
    name: "multiple exact text wrapper candidates",
    operations: [{
      kind: "replace",
      path: "src/a.ts",
      "old_text\n": { content: "a = 1", text: "a = 0" },
      new_text: "a = 2",
    }],
  }, {
    name: "conflicting canonical and wrapped exact text",
    operations: [{
      kind: "replace",
      path: "src/a.ts",
      old_text: "a = 1",
      "old_text\n": { content: "a = 0" },
      new_text: "a = 2",
    }],
  }, {
    name: "unknown kind-container field",
    operations: [{
      "path:": { name: "src/a.ts" },
      "kind:": { old_text: "a = 1", new_text: "a = 2", destination: "src/new.ts" },
    }],
  }, {
    name: "two substantive malformed operations",
    operations: [{
      "path:": { name: "src/a.ts" },
      "kind:": { old_text: "a = 1", new_text: "a = 2" },
    }, {
      "path:": { name: "src/a.ts" },
      "kind:": { old_text: "export", new_text: "export default" },
    }],
  }, {
    name: "metadata-shaped entry that also names a mutation target",
    operations: [{
      "path:": { name: "src/a.ts" },
      "kind:": { old_text: "a = 1", new_text: "a = 2" },
    }, {
      description: { purpose: "This is not metadata-only." },
      path: "src/a.ts",
    }],
  }]

  for (const item of cases) {
    const data = fixture()
    try {
      const { hooks, sessionID } = await workerHooks(data.root)
      await assert.rejects(() => hooks.tool!.preview_worker_changes.execute({
        task_path: data.taskPath,
        purpose: `Reject ambiguous model repair: ${item.name}.`,
        operations: item.operations,
      }, {
        agent: "worker",
        sessionID,
        metadata() {},
      } as any), /requires kind and path|operation repair is ambiguous/)
      assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 1\n")
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  }
})

test("repairs newText as rewrite content for a 4K Worker tool call", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(data.root)
    const preview = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      purpose: "Rewrite one small scoped file using the common model field alias.",
      operations: [{
        kind: "rewrite",
        filePath: "src/a.ts",
        newText: "export const a = 3\n",
      }],
    }, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any)

    assert.match(preview.output, /\+export const a = 3/)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 1\n")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("previews a syntactically valid short rewrite without grading import count or file size", async () => {
  const data = fixture()
  const before = `${Array.from({ length: 74 }, (_, index) => `export const registerLine${index + 1} = ${index + 1}`).join("\n")}\n`
  const importSnippet = [
    'import React from "react";',
    'import { Link, useNavigate } from "react-router-dom";',
    'import { z } from "zod";',
    'import type { UserConfig } from "vite";',
  ].join("\n") + "\n"
  try {
    write(join(data.root, "src/a.ts"), before)
    const statePath = join(data.root, ".task-doctor/state.json")
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    state.snapshot["src/a.ts"] = digest(before)
    write(statePath, `${JSON.stringify(state, null, 2)}\n`)
    const { hooks, sessionID } = await workerHooks(data.root)

    const preview: any = await hooks.tool!.preview_worker_changes.execute({
      kind: "rewrite",
      path: "src/a.ts",
      content: importSnippet,
    }, {
      agent: "worker",
      sessionID,
      metadata() {},
    } as any)

    assert.match(preview.output, /WORKER CHANGE PREVIEW/)
    assert.match(preview.output, /\+import React from "react";/)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), before)
    assert.equal(existsSync(join(data.root, ".task-doctor/worker-change-sets")), true)
    assert.equal(existsSync(join(data.root, ".task-doctor/worker-change-receipts")), false)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("reports a safe literal backslash-n repair in the Worker preview", async () => {
  const data = fixture()
  try {
    const { hooks, sessionID } = await workerHooks(data.root)
    const preview = await hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      purpose: "Repair the model's escaped line separator after an exact baseline match.",
      operations: [{
        kind: "replace",
        path: "src/a.ts",
        old_text: "export const a = 1\\n",
        new_text: "export const a = 2\\n",
      }],
    }, { agent: "worker", sessionID, metadata() {} } as any)

    assert.match(preview.output, /Input repair: src\/a\.ts: expanded literal backslash-n separators/)
    assert.match(preview.output, /\+export const a = 2/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("accepts technically valid JSON without inferring an application-specific translation contract", async () => {
  const data = fixture()
  try {
    const taskContent = [
      "# Task",
      "",
      "## Scope",
      "- `src/a.ts`",
      "- `src/auth/LoginPage.tsx`",
      "- `public/i18n/en.json`",
      "",
      "## Requirement",
      "Keep the localized Forgot Password accessible name available at runtime.",
      "",
    ].join("\n")
    write(join(data.root, data.taskPath), taskContent)
    write(join(data.root, "src/auth/LoginPage.tsx"), [
      "export const LoginPage = ({ t }: { t: (key: string) => string }) => (",
      "  <a href='/forgot-password'>{t('auth.login.forgot_password')}</a>",
      ")",
      "",
    ].join("\n"))
    write(join(data.root, "src/i18n/useTranslation.ts"), [
      "const LOCALES_DIR = '/i18n'",
      "export const DEFAULT_LOCALE = 'en'",
      "export const createT = (translations: Record<string, string>) => (key: string) => (",
      "  Object.prototype.hasOwnProperty.call(translations, key) ? translations[key] : key",
      ")",
      "export const loadTranslations = (locale: string) => fetch(`${LOCALES_DIR}/${locale}.json`)",
      "",
    ].join("\n"))
    write(join(data.root, "src/i18n/I18nProvider.tsx"), [
      "export const acceptTranslations = (data: Record<string, string>, activeLocale: string) => {",
      "  if (data.locale === activeLocale) return data",
      "  return {}",
      "}",
      "",
    ].join("\n"))
    const original = `${JSON.stringify({ auth: { login: { forgot_password: "Forgot Password" } } }, null, 2)}\n`
    write(join(data.root, "public/i18n/en.json"), original)
    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    write(join(data.root, ".task-doctor/state.json"), `${JSON.stringify({ ...state, taskHash: digest(taskContent) }, null, 2)}\n`)

    const { hooks, sessionID, read } = await workerHooks(data.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: the localized accessible name is unresolved\n",
    })
    await read("public/i18n/en.json")
    const context = { agent: "worker", sessionID, metadata() {} } as any
    const rewrite = (content: Record<string, unknown>) => hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      purpose: "Rewrite the loader-resolved translation bundle for the localized accessible name.",
      operations: [{ kind: "rewrite", path: "public/i18n/en.json", content: `${JSON.stringify(content, null, 2)}\n` }],
    }, context)

    const preview: any = await rewrite({ locale: "de", auth: { login: { forgot_password: "Forgot Password?" } } })
    assert.match(preview.output, /WORKER CHANGE PREVIEW/)
    assert.match(preview.output, /Forgot Password\?/)
    assert.equal(readFileSync(join(data.root, "public/i18n/en.json"), "utf8"), original)
    const discarded: any = await hooks.tool!.discard_worker_changes.execute({}, context)
    assert.equal(discarded.metadata.changeID, preview.metadata.changeID)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("preserves the model's technically valid JSON bytes without a task-specific auto-rewrite", async () => {
  const data = fixture()
  try {
    const taskContent = [
      "# Task",
      "",
      "## Scope",
      "- `src/a.ts`",
      "- `src/auth/LoginPage.tsx`",
      "- `public/i18n/en.json`",
      "",
      "## Requirement",
      "The exact values are auth.login.no_account=Don't have an account? auth.register.submit=Register and auth.login.forgot_password=Forgot Password.",
      "",
    ].join("\n")
    write(join(data.root, data.taskPath), taskContent)
    write(join(data.root, "src/auth/LoginPage.tsx"), [
      "export const LoginPage = ({ t }: { t: (key: string) => string }) => (",
      "  <><p>{t('auth.login.no_account')}</p><button>{t('auth.register.submit')}</button></>",
      ")",
      "",
    ].join("\n"))
    write(join(data.root, "src/i18n/useTranslation.ts"), [
      "const LOCALES_DIR = '/i18n'",
      "export const DEFAULT_LOCALE = 'en'",
      "export const createT = (translations: Record<string, string>) => (key: string) => (",
      "  Object.prototype.hasOwnProperty.call(translations, key) ? translations[key] : key",
      ")",
      "export const loadTranslations = (locale: string) => fetch(`${LOCALES_DIR}/${locale}.json`)",
      "",
    ].join("\n"))
    write(join(data.root, "src/i18n/I18nProvider.tsx"), [
      "export const acceptTranslations = (data: Record<string, string>, activeLocale: string) => {",
      "  if (data.locale === activeLocale) return data",
      "  return {}",
      "}",
      "",
    ].join("\n"))
    const original = `${JSON.stringify({
      locale: "en",
      "auth.login.no_account": "Don't have an account? Register",
      "auth.register.submit": "Create Account",
    }, null, 2)}\n`
    write(join(data.root, "public/i18n/en.json"), original)
    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    write(join(data.root, ".task-doctor/state.json"), `${JSON.stringify({ ...state, taskHash: digest(taskContent) }, null, 2)}\n`)

    const { hooks, sessionID, read } = await workerHooks(data.root, {
      preflightOutput: "TASK DOCTOR: FAIL\n- VERIFY_FAILED: exact translated accessible names are unresolved\n",
    })
    await read("public/i18n/en.json")
    const previewValues = (noAccount: string, register: string) => hooks.tool!.preview_worker_changes.execute({
      task_path: data.taskPath,
      description: "Apply the exact task-declared translation values to the English bundle.",
      operations: [{
        kind: "rewrite",
        path: "public/i18n/en.json",
        content: `${JSON.stringify({
          locale: "en",
          "auth.login.no_account": noAccount,
          "auth.register.submit": register,
        }, null, 2)}\n`,
      }],
    }, { agent: "worker", sessionID, metadata() {} } as any)
    const preview: any = await previewValues("Need an account?", "Create Account")
    assert.match(preview.output, /WORKER CHANGE PREVIEW/)
    assert.match(preview.output, /Need an account\?/)
    assert.doesNotMatch(preview.output, /exact task-declared translation values mechanically/)
    assert.doesNotMatch(preview.output, /Forgot Password/)
    assert.equal(readFileSync(join(data.root, "public/i18n/en.json"), "utf8"), original)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

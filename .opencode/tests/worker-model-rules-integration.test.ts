import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setWorkerRecoveryBoostAgentAvailable } from "../lib/worker-recovery-boost.ts"
import { WorkflowGuard } from "../plugins/workflow-guard.ts"

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function digest(content: string) {
  return createHash("sha256").update(content).digest("hex")
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "worker-model-rules-"))
  write(join(root, "project.json"), JSON.stringify({
    settings: {
      opencode: {
        agentModels: { worker: "llamacpp-local/qwen3.5-9b-q4" },
        workerModelFamilies: {
          QWEN35: { matches: ["qwen3.5", "qwen35"], rulesFile: "WORKER-QWEN35.md", requireRead: true },
          GEMMA4: { matches: ["gemma4"], rulesFile: "WORKER-GEMMA4.md", requireRead: true },
        },
      },
    },
  }))
  write(join(root, "scripts/task-doctor.mjs"), "")
  write(join(root, "kanban/TASK.md"), "# Task template\n")
  write(join(root, "kanban/todo/01-task.md"), "# Task\n")
  write(join(root, "WORKER.md"), "# Worker rules\n")
  write(join(root, "WORKER-QWEN35.md"), "# Qwen 3.5 rules\n\n- Always send complete compact tool arguments.\n")
  write(join(root, "WORKER-GEMMA4.md"), "# Gemma 4 rules\n\n- Use real line breaks.\n")
  return root
}

async function hooksFor(root: string) {
  return WorkflowGuard({ directory: root, worktree: root, client: {} } as any)
}

test("injects the matching family rules only into Worker system context", async () => {
  const root = fixture()
  try {
    const hooks = await hooksFor(root)
    await hooks["chat.message"]!({ sessionID: "worker-session", agent: "worker" } as any, {} as any)
    const workerOutput = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({
      sessionID: "worker-session",
      model: { providerID: "hightrail-local", modelID: "gemma4:12b-it-q8" },
    } as any, workerOutput)
    assert.match(workerOutput.system.join("\n"), /Source: WORKER-GEMMA4\.md/)
    assert.match(workerOutput.system.join("\n"), /Use real line breaks/)

    await hooks["chat.message"]!({ sessionID: "executor-session", agent: "executor" } as any, {} as any)
    const executorOutput = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({
      sessionID: "executor-session",
      model: { providerID: "hightrail-local", modelID: "gemma4:12b-it-q8" },
    } as any, executorOutput)
    assert.doesNotMatch(executorOutput.system.join("\n"), /Source: WORKER-GEMMA4\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("names the configured family rules file in canonical Worker delegation", async () => {
  const root = fixture()
  try {
    write(join(root, ".task-doctor/state.json"), JSON.stringify({
      version: 4,
      status: "started",
      taskPath: "kanban/todo/01-task.md",
      taskHash: digest("# Task\n"),
      snapshot: {},
    }))
    const hooks = await hooksFor(root)
    await hooks["chat.message"]!({ sessionID: "executor-session", agent: "executor" } as any, {} as any)
    const delegation = {
      args: {
        description: "Execute kanban/todo/01-task.md",
        prompt: "Execute kanban/todo/01-task.md",
        subagent_type: "worker",
      },
    }
    await hooks["tool.execute.before"]!({ sessionID: "executor-session", tool: "task" } as any, delegation as any)
    assert.match(delegation.args.prompt, /read WORKER\.md, WORKER-QWEN35\.md, and the exact task/)
    assert.doesNotMatch(delegation.args.prompt, /each Guard-named model-family file/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a boosted retry names the selected Planner model family instead of the base Worker family", async () => {
  const root = fixture()
  try {
    const projectPath = join(root, "project.json")
    const project = JSON.parse(readFileSync(projectPath, "utf8"))
    project.settings.opencode.agentModels.planner = "hightrail-local/gemma4:12b-it-q8"
    project.settings.opencode.agentModels.executor = "llamacpp-local/qwen3.5-9b-q4-reasoning"
    project.settings.opencode.workerRecoveryBoost = { enabled: true, model: "planner" }
    write(projectPath, JSON.stringify(project))
    setWorkerRecoveryBoostAgentAvailable(root, true)
    const taskPath = "kanban/todo/01-task.md"
    const taskContent = "# Task\n"
    const taskHash = digest(taskContent)
    write(join(root, ".task-doctor/state.json"), JSON.stringify({
      version: 4,
      status: "started",
      taskPath,
      taskHash,
      snapshot: {},
    }))
    write(join(root, ".task-doctor/worker-help.json"), JSON.stringify({
      version: 1,
      requests: [{
        version: 1,
        id: "H1",
        status: "retry_approved",
        taskPath,
        taskHash,
        workerSessionID: "terminal-worker",
        category: "syntax",
        problem: "The base Worker left one reviewed syntax error in the active target.",
        attemptedActions: ["The base Worker attempted one incomplete syntax repair."],
        evidence: ["The reviewed source still reports one exact missing closing tag."],
        relevantFiles: [taskPath],
        suggestedNextStep: "Delegate one fresh Worker using the reviewed retry.",
        createdAt: "2026-07-16T10:00:00.000Z",
        executorReview: {
          sessionID: "executor-session",
          decision: "retry_worker",
          rootCause: "The reviewed source remains syntactically incomplete.",
          retryStrategy: "Read the complete current source and repair its remaining syntax error.",
          expectedResults: ["The selected source parses without the reviewed syntax error."],
          reviewedFiles: [taskPath],
          reviewedAt: "2026-07-16T10:01:00.000Z",
        },
      }],
      updatedAt: "2026-07-16T10:01:00.000Z",
    }))

    const hooks = await hooksFor(root)
    await hooks["chat.message"]!({ sessionID: "executor-session", agent: "executor" } as any, {} as any)
    const delegation = {
      args: {
        description: `Resume ${taskPath}`,
        prompt: `Resume ${taskPath}`,
        subagent_type: "worker",
      },
    }
    await hooks["tool.execute.before"]!({ sessionID: "executor-session", tool: "task" } as any, delegation as any)
    assert.equal(delegation.args.subagent_type, "worker-recovery-boost")
    assert.match(delegation.args.prompt, /read WORKER\.md, WORKER-GEMMA4\.md, and the exact task/)
    assert.doesNotMatch(delegation.args.prompt, /WORKER-QWEN35\.md/)
  } finally {
    setWorkerRecoveryBoostAgentAvailable(root, false)
    rmSync(root, { recursive: true, force: true })
  }
})

test("keeps the system prefix stable and appends volatile workflow state as the final synthetic message", async () => {
  const root = fixture()
  try {
    const hooks = await hooksFor(root)
    const sessionID = "executor-cache-session"
    const model = { providerID: "llamacpp-local", modelID: "gemma4-12b-reasoning" }
    await hooks["chat.message"]!({ sessionID, agent: "executor", model } as any, {} as any)

    const systemOutput = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID, model } as any, systemOutput)
    const systemText = systemOutput.system.join("\n")
    assert.match(systemText, /stable prompt prefix remains cacheable/)
    assert.doesNotMatch(systemText, /Authoritative live workflow state/)

    const messages = [{
      info: { id: "msg-user", sessionID, role: "user", agent: "executor", model, time: { created: 1 } },
      parts: [{ id: "prt-user", sessionID, messageID: "msg-user", type: "text", text: "Continue." }],
    }]
    const firstOutput = { messages: structuredClone(messages) as any[] }
    await hooks["experimental.chat.messages.transform"]!({} as any, firstOutput as any)
    assert.equal(firstOutput.messages.length, 2)
    assert.equal(firstOutput.messages[0].parts[0].text, "Continue.")
    assert.equal(firstOutput.messages[1].info.role, "user")
    assert.equal(firstOutput.messages[1].parts[0].synthetic, true)
    assert.match(firstOutput.messages[1].parts[0].text, /Authoritative live workflow state/)
    assert.match(firstOutput.messages[1].parts[0].text, /Open Kanban tasks: kanban\/todo\/01-task\.md/)

    const secondOutput = { messages: structuredClone(messages) as any[] }
    await hooks["experimental.chat.messages.transform"]!({} as any, secondOutput as any)
    assert.equal(secondOutput.messages[1].info.id, firstOutput.messages[1].info.id)
    assert.equal(secondOutput.messages[1].parts[0].id, firstOutput.messages[1].parts[0].id)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("coalesces the OpenCode core prompt and guard block for strict Qwen templates", async () => {
  const root = fixture()
  try {
    const hooks = await hooksFor(root)

    for (const agent of ["planner", "executor", "worker"]) {
      const sessionID = `qwen-${agent}`
      const model = {
        providerID: "llamacpp-local",
        modelID: agent === "worker" ? "qwen3.5-9b-q4" : "qwen3.5-9b-q4-reasoning",
      }
      await hooks["chat.message"]!({ sessionID, agent, model } as any, {} as any)
      const output = { system: ["OpenCode core system"] }
      await hooks["experimental.chat.system.transform"]!({ sessionID, model } as any, output)

      assert.equal(output.system.length, 1)
      assert.match(output.system[0], /OpenCode core system/)
      assert.match(output.system[0], /Workflow guard/)
    }

    const remoteModel = { providerID: "hightrail-local", modelID: "qwen3.6:27b" }
    await hooks["chat.message"]!({ sessionID: "remote-qwen", agent: "executor", model: remoteModel } as any, {} as any)
    const remoteOutput = { system: ["OpenCode core system"] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "remote-qwen", model: remoteModel } as any, remoteOutput)
    assert.equal(remoteOutput.system.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("rehydrates Gemma Worker identity and requires both rule files after start and compaction", async () => {
  const root = fixture()
  try {
    const hooks = await hooksFor(root)
    const sessionID = "worker-session"
    await hooks.event!({ event: {
      type: "session.created",
      properties: {
        info: {
          id: sessionID,
          parentID: "executor-session",
          agent: "worker",
          model: { providerID: "hightrail-local", modelID: "gemma4:12b-it-q8" },
        },
      },
    } } as any)
    await hooks["experimental.chat.system.transform"]!({
      sessionID,
      model: { providerID: "hightrail-local", modelID: "gemma4:12b-it-q8" },
    } as any, { system: [] })

    const start = () => hooks["tool.execute.before"]!({ sessionID, tool: "bash" } as any, {
      args: { command: "node scripts/task-doctor.mjs start kanban/todo/01-task.md" },
    })
    await assert.rejects(start, /WORKER\.md, WORKER-GEMMA4\.md/)
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "bash" } as any, {
      args: { command: "node scripts/task-doctor.mjs verify kanban/todo/01-task.md" },
    }), /WORKER\.md, WORKER-GEMMA4\.md/)
    await assert.rejects(() => hooks["tool.execute.before"]!({ sessionID, tool: "write" } as any, {
      args: { filePath: join(root, "src/a.ts"), content: "changed\n" },
    }), /WORKER\.md, WORKER-GEMMA4\.md/)

    await hooks["tool.execute.after"]!({
      sessionID,
      tool: "read",
      args: { filePath: join(root, "WORKER.md") },
    } as any, { title: "read", output: "", metadata: { truncated: false } })
    await assert.rejects(start, /WORKER-GEMMA4\.md/)

    await hooks["tool.execute.after"]!({
      sessionID,
      tool: "read",
      args: { filePath: join(root, "WORKER-GEMMA4.md") },
    } as any, { title: "read", output: "", metadata: { truncated: false } })
    await assert.doesNotReject(start)

    await hooks.event!({ event: { type: "session.compacted", properties: { sessionID } } } as any)
    await assert.rejects(start, /WORKER\.md, WORKER-GEMMA4\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("injects and requires Qwen rules without leaking Gemma rules", async () => {
  const root = fixture()
  try {
    const hooks = await hooksFor(root)
    const sessionID = "qwen-worker"
    await hooks["chat.message"]!({
      sessionID,
      agent: "worker",
      model: { providerID: "llamacpp-local", modelID: "qwen3.5-9b-q4" },
    } as any, {} as any)
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({
      sessionID,
      model: { providerID: "llamacpp-local", modelID: "qwen3.5-9b-q4" },
    } as any, output)
    assert.doesNotMatch(output.system.join("\n"), /WORKER-GEMMA4\.md/)
    assert.match(output.system.join("\n"), /Source: WORKER-QWEN35\.md/)
    assert.match(output.system.join("\n"), /complete compact tool arguments/)

    await hooks["tool.execute.after"]!({
      sessionID,
      tool: "read",
      args: { filePath: join(root, "WORKER.md") },
    } as any, { title: "read", output: "", metadata: { truncated: false } })
    const start = () => hooks["tool.execute.before"]!({ sessionID, tool: "bash" } as any, {
      args: { command: "node scripts/task-doctor.mjs start kanban/todo/01-task.md" },
    })
    await assert.rejects(start, /WORKER-QWEN35\.md/)
    await hooks["tool.execute.after"]!({
      sessionID,
      tool: "read",
      args: { filePath: join(root, "WORKER-QWEN35.md") },
    } as any, { title: "read", output: "", metadata: { truncated: false } })
    await assert.doesNotReject(start)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reconstructs Worker role and model from messages when session.updated omits them", async () => {
  const root = fixture()
  try {
    const client = {
      session: {
        get: async () => ({ data: { id: "restored-worker", parentID: "executor" } }),
        messages: async () => ({ data: [{
          info: {
            role: "assistant",
            agent: "worker",
            providerID: "hightrail-local",
            modelID: "gemma4:12b-it-q8",
          },
          parts: [],
        }] }),
      },
    }
    const hooks = await WorkflowGuard({ directory: root, worktree: root, client } as any)
    await hooks.event!({ event: {
      type: "session.updated",
      properties: { info: { id: "restored-worker", parentID: "executor" } },
    } } as any)
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "restored-worker" } as any, output)
    assert.match(output.system.join("\n"), /Source: WORKER-GEMMA4\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

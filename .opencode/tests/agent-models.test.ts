import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import {
  resolveWorkerRecoveryBoost,
  workerRecoveryBoostAgentAvailable,
  WORKER_RECOVERY_BOOST_AGENT,
} from "../lib/worker-recovery-boost.ts"
import { AgentModels } from "../plugins/agent-models.ts"

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function fixture(opencode: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "agent-models-"))
  write(join(root, "project.json"), JSON.stringify({ settings: { opencode } }))
  return root
}

test("Worker recovery boost resolver supports aliases and explicit refs without guessing invalid names", () => {
  const agentModels = {
    worker: "base/worker",
    executor: "boost/executor",
    planner: { providerID: "boost", modelID: "planner" },
  }
  const cases = [
    [{ agentModels }, { enabled: false, invalid: false, model: undefined }],
    [{ agentModels, workerRecoveryBoost: { enabled: false, model: "executor" } }, { enabled: false, invalid: false, model: undefined }],
    [{ agentModels, workerRecoveryBoost: { enabled: true } }, { enabled: true, invalid: false, model: { providerID: "boost", modelID: "executor" } }],
    [{ agentModels, workerRecoveryBoost: { enabled: true, model: "executor" } }, { enabled: true, invalid: false, model: { providerID: "boost", modelID: "executor" } }],
    [{ agentModels, workerRecoveryBoost: { enabled: true, model: "planner" } }, { enabled: true, invalid: false, model: { providerID: "boost", modelID: "planner" } }],
    [{ agentModels, workerRecoveryBoost: { enabled: true, model: "explicit/model" } }, { enabled: true, invalid: false, model: { providerID: "explicit", modelID: "model" } }],
    [{ agentModels, workerRecoveryBoost: { enabled: true, model: { providerID: "object", id: "model" } } }, { enabled: true, invalid: false, model: { providerID: "object", modelID: "model" } }],
    [{ agentModels, workerRecoveryBoost: { enabled: true, model: "unqualified" } }, { enabled: true, invalid: true, model: undefined }],
    [{ agentModels, workerRecoveryBoost: { enabled: true, model: "provider/   " } }, { enabled: true, invalid: true, model: undefined }],
    [{ agentModels, workerRecoveryBoost: { enabled: true, model: { providerID: "   ", modelID: "model" } } }, { enabled: true, invalid: true, model: undefined }],
    [{ agentModels, workerRecoveryBoost: { enabled: true, model: { providerID: "provider", modelID: "   " } } }, { enabled: true, invalid: true, model: undefined }],
  ] as const

  for (const [settings, expected] of cases) {
    const resolved = resolveWorkerRecoveryBoost(settings)
    assert.equal(resolved.enabled, expected.enabled)
    assert.equal(resolved.invalid, expected.invalid)
    assert.deepEqual(resolved.model, expected.model)
  }
})

test("AgentModels installs one hidden exact Worker clone with the resolved boost model", async () => {
  const root = fixture({
    agentModels: {
      worker: "base/worker",
      executor: "boost/executor",
    },
    workerRecoveryBoost: { enabled: true, model: "executor" },
  })
  try {
    const logs: any[] = []
    const hooks = await AgentModels({
      directory: root,
      worktree: root,
      client: { app: { log: async (input: any) => logs.push(input) } },
    } as any)
    const worker = {
      name: "worker-source",
      description: "Canonical Worker",
      prompt: "Exact Worker prompt",
      mode: "all",
      hidden: false,
      permission: { bash: "allow", task: "deny" },
      options: { temperature: 0.1 },
    }
    const config: any = { agent: { worker, executor: { mode: "primary" } } }
    await hooks.config!(config)

    const alias = config.agent[WORKER_RECOVERY_BOOST_AGENT]
    assert.notEqual(alias, worker)
    assert.equal(alias.name, "worker")
    assert.equal(alias.model, "boost/executor")
    assert.equal(alias.hidden, true)
    assert.equal(alias.mode, "subagent")
    assert.equal(alias.description, worker.description)
    assert.equal(alias.prompt, worker.prompt)
    assert.deepEqual(alias.permission, worker.permission)
    assert.deepEqual(alias.options, worker.options)
    assert.equal(config.agent.worker.model, "base/worker")
    assert.equal(workerRecoveryBoostAgentAvailable(root), true)
    assert.equal(logs.some((entry) => entry.body?.message === "Configured hidden Worker recovery boost agent"), true)

    const executorRules = readFileSync(join(process.cwd(), ".opencode/agents/executor.md"), "utf8")
    assert.match(executorRules, /task:\n\s+"\*": deny\n\s+worker: allow\n\s+worker-recovery-boost: allow/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("AgentModels omits the alias and warns when boost resolution or the Worker source is unsafe", async () => {
  for (const missingWorker of [false, true]) {
    const root = fixture({
      agentModels: { worker: "base/worker", executor: "boost/executor" },
      workerRecoveryBoost: { enabled: true, model: missingWorker ? "executor" : "unqualified" },
    })
    try {
      const logs: any[] = []
      const hooks = await AgentModels({
        directory: root,
        worktree: root,
        client: { app: { log: async (input: any) => logs.push(input) } },
      } as any)
      const config: any = { agent: missingWorker ? {} : { worker: { prompt: "Worker", permission: { task: "deny" } } } }
      await hooks.config!(config)
      assert.equal(config.agent[WORKER_RECOVERY_BOOST_AGENT], undefined)
      assert.equal(workerRecoveryBoostAgentAvailable(root), false)
      assert.equal(logs.some((entry) => entry.body?.level === "warn" && entry.body?.message === "Worker recovery boost unavailable; using base Worker"), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

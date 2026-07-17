import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  modelRefString,
  resolveWorkerRecoveryBoost,
  setWorkerRecoveryBoostAgentAvailable,
  WORKER_RECOVERY_BOOST_AGENT,
} from "../lib/worker-recovery-boost.ts"

function projectRoot(start: string) {
  let current = resolve(start)

  while (true) {
    if (existsSync(resolve(current, "project.json"))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(start)
    current = parent
  }
}

function openCodeSettings(root: string) {
  try {
    const project = JSON.parse(readFileSync(resolve(root, "project.json"), "utf8"))
    return project?.settings?.opencode ?? {}
  } catch {
    return {}
  }
}

function configuredAgentModels(settings: Record<string, unknown>) {
  try {
    const configured = settings.agentModels

    if (!configured || typeof configured !== "object" || Array.isArray(configured)) return {}

    return Object.fromEntries(
      Object.entries(configured).filter(
        ([agent, model]) => agent.trim().length > 0 && typeof model === "string" && model.includes("/"),
      ),
    ) as Record<string, string>
  } catch {
    return {}
  }
}

export const AgentModels: Plugin = async ({ directory, worktree, client }) => {
  const root = projectRoot(worktree || directory)
  const settings = openCodeSettings(root)
  const agentModels = configuredAgentModels(settings)
  const recoveryBoost = resolveWorkerRecoveryBoost(settings)

  return {
    config: async (config) => {
      const agents = ((config as any).agent ??= {})
      const workerSource = agents.worker && typeof agents.worker === "object" && !Array.isArray(agents.worker)
        ? agents.worker
        : null

      for (const [agent, model] of Object.entries(agentModels)) {
        agents[agent] = { ...(agents[agent] ?? {}), model }
      }

      if (recoveryBoost.model && workerSource) {
        agents[WORKER_RECOVERY_BOOST_AGENT] = {
          ...agents.worker,
          name: "worker",
          model: modelRefString(recoveryBoost.model),
          hidden: true,
          mode: "subagent",
        }
      } else {
        delete agents[WORKER_RECOVERY_BOOST_AGENT]
      }
      setWorkerRecoveryBoostAgentAvailable(root, Boolean(recoveryBoost.model && workerSource))

      if (Object.keys(agentModels).length > 0) {
        await client.app.log({
          body: {
            service: "agent-models",
            level: "info",
            message: "Applied project agent models",
            extra: { agentModels },
          },
        })
      }
      if (recoveryBoost.model && workerSource) {
        await client.app.log({
          body: {
            service: "agent-models",
            level: "info",
            message: "Configured hidden Worker recovery boost agent",
            extra: {
              lookupAgent: WORKER_RECOVERY_BOOST_AGENT,
              childAgent: "worker",
              model: modelRefString(recoveryBoost.model),
              selector: recoveryBoost.selector,
            },
          },
        })
      } else if (recoveryBoost.invalid || (recoveryBoost.enabled && !workerSource)) {
        await client.app.log({
          body: {
            service: "agent-models",
            level: "warn",
            message: "Worker recovery boost unavailable; using base Worker",
            extra: {
              reason: recoveryBoost.invalid ? recoveryBoost.reason : "worker-agent-source-unavailable",
              selector: recoveryBoost.selector,
            },
          },
        })
      }
    },
  }
}

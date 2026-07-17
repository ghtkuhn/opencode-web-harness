import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { matchingWorkerModelFamily, workerModelFamiliesFromConfig } from "../lib/worker-model-rules.ts"

function unwrap<T>(value: any): T {
  return (value?.data ?? value) as T
}

export const CompactionGuard: Plugin = async ({ client, directory, worktree }) => {
  const root = worktree || directory
  const project = (() => {
    try {
      const path = resolve(root, "project.json")
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}
    } catch {
      return {}
    }
  })()
  const settings = project?.settings?.opencode ?? {}
  const families = workerModelFamiliesFromConfig(settings.workerModelFamilies)
  const workerAgents = new Set(
    (Array.isArray(settings.modes?.workerAgents) ? settings.modes.workerAgents : ["worker"])
      .filter((value: unknown): value is string => typeof value === "string")
      .map((value: string) => value.toLowerCase()),
  )

  return {
    "experimental.session.compacting": async ({ sessionID }, output) => {
      let requiredWorkerRules: string[] = []
      let roleKnown = false
      try {
        const response: any = await client.session.messages({ path: { id: sessionID }, query: { directory: root, limit: 200 } })
        const messages = response?.error ? [] : (unwrap<any[]>(response) ?? [])
        const latest = [...messages].reverse().find((message) => message?.info?.role === "assistant")?.info
        const agent = String(latest?.agent ?? latest?.mode ?? "").toLowerCase()
        roleKnown = agent.length > 0
        const identity = [latest?.providerID, latest?.modelID]
          .filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
          .join("/")
        const family = matchingWorkerModelFamily(identity, families)
        if (workerAgents.has(agent)) requiredWorkerRules = ["WORKER.md", ...(family?.requireRead ? [family.rulesFile] : [])]
      } catch {
        // The workflow guard also reconstructs identity and enforces the reads after compaction.
      }
      const workerReadInstruction = requiredWorkerRules.length > 0
        ? `Worker must also re-read ${requiredWorkerRules.join(" and ")}.`
        : roleKnown
          ? ""
          : "Worker must also re-read WORKER.md and any model-family rules named by the workflow guard."
      output.context.push(`
## Compaction guard

This is a summary-only turn. Do not call tools, inspect files, ask questions, or perform workflow actions. Use only information already present in the conversation and tool results. If information is unknown, preserve that uncertainty instead of investigating it.

Follow OpenCode's required summary template exactly. Do not add or rename sections. Within that template preserve the active objective, exact status, rules, decisions, dependencies, relevant files, verification results, blockers, and next concrete action.

Record in the existing Next Move section that the next normal turn must re-read applicable AGENTS.md files and the active task before work. ${workerReadInstruction} MEMORY.md and CODEX-INBOX.md must be read when present. These reads happen only after summary generation has finished, never during this turn.
`)

      await client.app.log({
        body: {
          service: "compaction-guard",
          level: "info",
          message: "Injected continuation safety context",
          extra: { sessionID, summaryOnly: true, requiredWorkerRules },
        },
      })
    },
  }
}

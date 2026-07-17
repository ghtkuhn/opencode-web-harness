import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { CompactionGuard } from "../plugins/compaction-guard.ts"

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "compaction-worker-rules-"))
  write(join(root, "project.json"), JSON.stringify({
    settings: {
      opencode: {
        workerModelFamilies: {
          GEMMA4: { matches: ["gemma4"], rulesFile: "WORKER-GEMMA4.md", requireRead: true },
        },
      },
    },
  }))
  return root
}

async function compact(root: string, agent: string, modelID: string) {
  const client = {
    session: {
      messages: async () => ({ data: [{
        info: { role: "assistant", agent, providerID: "hightrail-local", modelID },
        parts: [],
      }] }),
    },
    app: { log: async () => ({}) },
  }
  const hooks = await CompactionGuard({ directory: root, worktree: root, client } as any)
  const output = { context: [] as string[] }
  await hooks["experimental.session.compacting"]!({ sessionID: `${agent}-session` } as any, output)
  return output.context.join("\n")
}

test("names the actual Gemma family file only in Worker compaction context", async () => {
  const root = fixture()
  try {
    const worker = await compact(root, "worker", "gemma-4:12b-it-q8")
    assert.match(worker, /re-read WORKER\.md and WORKER-GEMMA4\.md/)

    const executor = await compact(root, "executor", "gemma-4:12b-it-q8")
    assert.doesNotMatch(executor, /WORKER-GEMMA4\.md/)
    assert.doesNotMatch(executor, /Worker must also re-read/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

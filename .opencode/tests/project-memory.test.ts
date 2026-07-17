import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test from "node:test"
import { parseProjectByteSize, projectMemoryRecoveryStatus, recoverProjectMemory } from "../lib/project-memory.ts"

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "project-memory-"))
  mkdirSync(resolve(root, ".task-doctor"), { recursive: true })
  writeFileSync(resolve(root, "project.json"), JSON.stringify({ settings: { maxMemorySize: "20b" } }))
  writeFileSync(resolve(root, "MEMORY.md"), "# Memory\nThis entry is too large.\n")
  writeFileSync(resolve(root, ".task-doctor/state.json"), JSON.stringify({
    status: "started",
    memory: { hash: "task-baseline" },
    snapshot: { "MEMORY.md": "task-baseline" },
  }))
  return root
}

test("parses project byte sizes", () => {
  assert.equal(parseProjectByteSize("15kb"), 15 * 1024)
  assert.equal(parseProjectByteSize("bad"), null)
})

test("detects over-limit project memory", () => {
  const root = fixture()
  try {
    assert.deepEqual(projectMemoryRecoveryStatus(root), {
      status: "required",
      code: "MEMORY_SIZE_EXCEEDED",
      size: 34,
      maxSize: 20,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Executor recovery shrinks memory and authorizes the task-baseline transition", () => {
  const root = fixture()
  try {
    const result = recoverProjectMemory(root, {
      replacement: "# Memory\nKept.",
      reason: "Condense duplicate history while preserving the durable project fact.",
      executorSessionID: "executor-test",
    })
    assert.equal(result.recoveryID, "M1")
    assert.equal(readFileSync(resolve(root, "MEMORY.md"), "utf8"), "# Memory\nKept.\n")
    const authorization = JSON.parse(readFileSync(resolve(root, ".task-doctor/authorized-memory-changes.json"), "utf8"))
    assert.equal(authorization.changes.some((entry: any) => entry.beforeHash === "task-baseline" && entry.afterHash === result.afterHash), true)
    assert.equal(projectMemoryRecoveryStatus(root), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Executor recovery rejects an over-limit replacement", () => {
  const root = fixture()
  try {
    assert.throws(() => recoverProjectMemory(root, {
      replacement: "x".repeat(30),
      reason: "This replacement is intentionally too large for the configured limit.",
      executorSessionID: "executor-test",
    }), /allows 20 bytes/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  forgetWorkerHarnessRecoveryTerminal,
  loadWorkerHarnessRecoveryTerminals,
  rememberWorkerHarnessRecoveryTerminal,
} from "../lib/worker-harness-recovery-terminals.ts"

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

test("durably keeps multiple terminal Workers without duplicate session receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-recovery-terminals-"))
  try {
    const first = rememberWorkerHarnessRecoveryTerminal(root, {
      sessionID: "worker-one",
      taskPath: "kanban/todo/01-task.md",
      taskHash: digest("task-one"),
      observedAt: "2026-07-16T12:00:00.000Z",
      runID: "run-one",
    })
    rememberWorkerHarnessRecoveryTerminal(root, {
      sessionID: "worker-two",
      taskPath: "kanban/todo/01-task.md",
      taskHash: digest("task-one"),
    })
    const duplicate = rememberWorkerHarnessRecoveryTerminal(root, {
      sessionID: "worker-one",
      taskPath: "kanban/todo/99-other.md",
      taskHash: digest("other"),
    })

    assert.equal(first.created, true)
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.entry.taskPath, "kanban/todo/01-task.md")
    assert.equal(duplicate.entry.observedAt, "2026-07-16T12:00:00.000Z")
    assert.deepEqual(loadWorkerHarnessRecoveryTerminals(root).map((entry) => entry.sessionID), ["worker-one", "worker-two"])

    assert.equal(forgetWorkerHarnessRecoveryTerminal(root, "worker-one"), true)
    assert.deepEqual(loadWorkerHarnessRecoveryTerminals(root).map((entry) => entry.sessionID), ["worker-two"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("self-heals one corrupt copy and fails closed when both durable copies are corrupt", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-recovery-terminal-repair-"))
  try {
    rememberWorkerHarnessRecoveryTerminal(root, {
      sessionID: "worker-one",
      taskPath: "kanban/todo/01-task.md",
      taskHash: digest("task-one"),
    })
    const primary = join(root, ".task-doctor/worker-harness-recovery-terminals.json")
    const backup = join(root, ".task-doctor/worker-harness-recovery-terminals.backup.json")
    const expected = readFileSync(backup, "utf8")
    writeFileSync(primary, "{broken\n")
    assert.equal(loadWorkerHarnessRecoveryTerminals(root).length, 1)
    assert.equal(readFileSync(primary, "utf8"), expected)

    writeFileSync(primary, "{broken\n")
    writeFileSync(backup, "{also-broken\n")
    assert.throws(
      () => loadWorkerHarnessRecoveryTerminals(root),
      /TERMINAL STORE CORRUPT/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import {
  applyWorkerScopeRecoveryPlan,
  planWorkerScopeRecovery,
  type WorkerScopeRecoveryReceipt,
  type WorkerScopeRecoveryState,
} from "../lib/worker-scope-recovery.ts"

const taskPath = "kanban/todo/01-task.md"
const startedAt = "2026-07-16T08:00:00.000Z"

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

function write(path: string, content: string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { mode })
  chmodSync(path, mode)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "worker-scope-recovery-"))
  mkdirSync(join(root, "src"), { recursive: true })
  return root
}

function state(snapshot: Record<string, string>, head?: string): WorkerScopeRecoveryState {
  return { taskPath, startedAt, snapshot, head }
}

function receipt(
  id: string,
  path: string,
  beforeHash: string | null,
  afterHash: string | null,
  appliedAt = "2026-07-16T08:05:00.000Z",
  beforeMode?: number,
  afterMode?: number,
): WorkerScopeRecoveryReceipt {
  return {
    version: 2,
    id,
    status: "applied",
    taskPath,
    appliedAt,
    files: [{ path, beforeHash, afterHash, beforeMode, afterMode }],
  }
}

test("plans from a content-addressed baseline without writing and uses the shortest reachable receipt chain", () => {
  const root = fixture()
  try {
    const path = "src/removed.ts"
    const baseline = "export const value = 1\n"
    const current = "export const value = 2\n"
    const later = "export const value = 3\n"
    write(join(root, path), current, 0o755)
    const baselineHash = digest(baseline)
    const currentHash = digest(current)
    const receipts = [
      receipt("C-first", path, baselineHash, currentHash, "2026-07-16T08:05:00.000Z", 0o755),
      receipt("C-later", path, currentHash, digest(later), "2026-07-16T08:06:00.000Z", 0o755),
    ]

    const plan = planWorkerScopeRecovery({
      root,
      state: state({ [path]: baselineHash }),
      currentSnapshot: { [path]: currentHash },
      previousScope: ["src"],
      nextScope: ["src/kept.ts"],
      receipts,
      readBaselineBlob: (hash) => hash === baselineHash ? Buffer.from(baseline) : null,
    })

    assert.equal(readFileSync(join(root, path), "utf8"), current)
    assert.equal(plan.entries.length, 1)
    assert.equal(plan.entries[0].source, "blob")
    assert.deepEqual(plan.entries[0].receiptIDs, ["C-first"])

    const applied = applyWorkerScopeRecoveryPlan(plan)
    assert.equal(readFileSync(join(root, path), "utf8"), baseline)
    assert.equal(lstatSync(join(root, path)).mode & 0o777, 0o755)
    applied.rollback()
    assert.equal(readFileSync(join(root, path), "utf8"), current)
    assert.equal(lstatSync(join(root, path)).mode & 0o777, 0o755)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("materializes a legacy baseline from the exact recorded Git head and finalizes the restore", () => {
  const root = fixture()
  try {
    const path = "src/legacy.ts"
    const baseline = "export const legacy = 1\n"
    const current = "export const legacy = 2\n"
    write(join(root, path), baseline)
    execFileSync("git", ["init", "-q"], { cwd: root })
    execFileSync("git", ["config", "user.email", "scope-recovery@example.invalid"], { cwd: root })
    execFileSync("git", ["config", "user.name", "Scope Recovery Test"], { cwd: root })
    execFileSync("git", ["add", path], { cwd: root })
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root })
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
    writeFileSync(join(root, path), current)
    const baselineHash = digest(baseline)
    const currentHash = digest(current)

    const plan = planWorkerScopeRecovery({
      root,
      state: state({ [path]: baselineHash }, head),
      currentSnapshot: { [path]: currentHash },
      previousScope: ["src"],
      nextScope: [],
      receipts: [receipt("C-legacy", path, baselineHash, currentHash)],
    })

    assert.equal(plan.entries[0].source, "git")
    const applied = applyWorkerScopeRecoveryPlan(plan)
    assert.equal(readFileSync(join(root, path), "utf8"), baseline)
    applied.finalize()
    assert.equal(readdirSync(join(root, "src")).some((name) => name.includes("scope-recovery")), false)
    assert.throws(() => applied.rollback(), /already finalized or rolled back/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("commits restored targets before best-effort multi-file backup cleanup", () => {
  const root = fixture()
  try {
    const firstPath = "src/finalize-a.ts"
    const secondPath = "src/finalize-b.ts"
    const baselineA = "a baseline\n"
    const baselineB = "b baseline\n"
    const currentA = "a worker\n"
    const currentB = "b worker\n"
    write(join(root, firstPath), currentA)
    write(join(root, secondPath), currentB)
    const plan = planWorkerScopeRecovery({
      root,
      state: state({ [firstPath]: digest(baselineA), [secondPath]: digest(baselineB) }),
      currentSnapshot: { [firstPath]: digest(currentA), [secondPath]: digest(currentB) },
      previousScope: ["src"],
      nextScope: [],
      receipts: [
        receipt("C-finalize-a", firstPath, digest(baselineA), digest(currentA), undefined, 0o644, 0o644),
        receipt("C-finalize-b", secondPath, digest(baselineB), digest(currentB), undefined, 0o644, 0o644),
      ],
      readBaselineBlob: (hash) => {
        if (hash === digest(baselineA)) return Buffer.from(baselineA)
        if (hash === digest(baselineB)) return Buffer.from(baselineB)
        return null
      },
    })
    const applied = applyWorkerScopeRecoveryPlan(plan, {
      beforeFinalizeBackupCleanup(_entry, index) {
        if (index === 1) throw new Error("injected cleanup failure")
      },
    })

    assert.doesNotThrow(() => applied.finalize())
    assert.equal(readFileSync(join(root, firstPath), "utf8"), baselineA)
    assert.equal(readFileSync(join(root, secondPath), "utf8"), baselineB)
    const leftovers = readdirSync(join(root, "src")).filter((name) => name.endsWith(".bak"))
    assert.equal(leftovers.length, 1)
    assert.equal(readFileSync(join(root, "src", leftovers[0]), "utf8"), currentB)
    assert.equal(lstatSync(join(root, "src", leftovers[0])).mode & 0o777, 0o644)
    assert.throws(() => applied.rollback(), /already finalized or rolled back/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("validates every backup before deleting the first and preserves rollback", () => {
  const root = fixture()
  try {
    const firstPath = "src/preflight-a.ts"
    const secondPath = "src/preflight-b.ts"
    const baselineA = "a baseline\n"
    const baselineB = "b baseline\n"
    const currentA = "a worker\n"
    const currentB = "b worker\n"
    write(join(root, firstPath), currentA)
    write(join(root, secondPath), currentB)
    const plan = planWorkerScopeRecovery({
      root,
      state: state({ [firstPath]: digest(baselineA), [secondPath]: digest(baselineB) }),
      currentSnapshot: { [firstPath]: digest(currentA), [secondPath]: digest(currentB) },
      previousScope: ["src"],
      nextScope: [],
      receipts: [
        receipt("C-preflight-a", firstPath, digest(baselineA), digest(currentA), undefined, 0o644, 0o644),
        receipt("C-preflight-b", secondPath, digest(baselineB), digest(currentB), undefined, 0o644, 0o644),
      ],
      readBaselineBlob: (hash) => {
        if (hash === digest(baselineA)) return Buffer.from(baselineA)
        if (hash === digest(baselineB)) return Buffer.from(baselineB)
        return null
      },
    })
    const applied = applyWorkerScopeRecoveryPlan(plan)
    const artifacts = readdirSync(join(root, "src")).filter((name) => name.endsWith(".bak"))
    const firstBackup = artifacts.find((name) => name.startsWith(".preflight-a.ts."))!
    const secondBackup = artifacts.find((name) => name.startsWith(".preflight-b.ts."))!
    const hiddenSecondBackup = `${secondBackup}.held`
    renameSync(join(root, "src", secondBackup), join(root, "src", hiddenSecondBackup))

    assert.throws(() => applied.finalize(), /backup changed before finalize/)
    assert.equal(existsSync(join(root, "src", firstBackup)), true)
    renameSync(join(root, "src", hiddenSecondBackup), join(root, "src", secondBackup))
    applied.rollback()
    assert.equal(readFileSync(join(root, firstPath), "utf8"), currentA)
    assert.equal(readFileSync(join(root, secondPath), "utf8"), currentB)
    assert.equal(readdirSync(join(root, "src")).some((name) => name.includes("scope-recovery")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("rejects current bytes that are not reachable from the Doctor baseline through trusted receipts", () => {
  const root = fixture()
  try {
    const path = "src/unproven.ts"
    const baseline = "baseline\n"
    const worker = "worker change\n"
    const user = "independent user edit\n"
    write(join(root, path), user)

    assert.throws(() => planWorkerScopeRecovery({
      root,
      state: state({ [path]: digest(baseline) }),
      currentSnapshot: { [path]: digest(user) },
      previousScope: ["src"],
      nextScope: [],
      receipts: [receipt("C-worker", path, digest(baseline), digest(worker))],
      readBaselineBlob: () => Buffer.from(baseline),
    }), /refuses unproven current bytes/)
    assert.equal(readFileSync(join(root, path), "utf8"), user)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("checks only exact startup candidates and ignores unrelated authorized drift", () => {
  const root = fixture()
  try {
    const path = "src/recover.ts"
    const unrelatedPath = "rules/authorized.md"
    const baseline = "baseline\n"
    const current = "worker\n"
    const unrelatedBefore = "old rule\n"
    const unrelatedCurrent = "authorized new rule\n"
    write(join(root, path), current)
    write(join(root, unrelatedPath), unrelatedCurrent)
    const plan = planWorkerScopeRecovery({
      root,
      state: state({ [path]: digest(baseline), [unrelatedPath]: digest(unrelatedBefore) }),
      currentSnapshot: { [path]: digest(current), [unrelatedPath]: digest(unrelatedCurrent) },
      candidatePaths: [path],
      nextScope: [],
      receipts: [receipt("C-candidate", path, digest(baseline), digest(current), undefined, 0o644, 0o644)],
      readBaselineBlob: (hash) => hash === digest(baseline) ? Buffer.from(baseline) : null,
    })

    assert.deepEqual(plan.entries.map((entry) => entry.path), [path])
    assert.equal(readFileSync(join(root, unrelatedPath), "utf8"), unrelatedCurrent)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("blocks a user edit made after planning before writing any recovery target", () => {
  const root = fixture()
  try {
    const firstPath = "src/a.ts"
    const secondPath = "src/b.ts"
    const baselineA = "a baseline\n"
    const baselineB = "b baseline\n"
    const currentA = "a worker\n"
    const currentB = "b worker\n"
    write(join(root, firstPath), currentA)
    write(join(root, secondPath), currentB)
    const plan = planWorkerScopeRecovery({
      root,
      state: state({ [firstPath]: digest(baselineA), [secondPath]: digest(baselineB) }),
      currentSnapshot: { [firstPath]: digest(currentA), [secondPath]: digest(currentB) },
      previousScope: ["src"],
      nextScope: [],
      receipts: [
        receipt("C-a", firstPath, digest(baselineA), digest(currentA), undefined, 0o644, 0o644),
        receipt("C-b", secondPath, digest(baselineB), digest(currentB), undefined, 0o644, 0o644),
      ],
      readBaselineBlob: (hash) => {
        if (hash === digest(baselineA)) return Buffer.from(baselineA)
        if (hash === digest(baselineB)) return Buffer.from(baselineB)
        return null
      },
    })
    const user = "new user edit\n"
    writeFileSync(join(root, secondPath), user)

    assert.throws(() => applyWorkerScopeRecoveryPlan(plan), /changed after planning/)
    assert.equal(readFileSync(join(root, firstPath), "utf8"), currentA)
    assert.equal(readFileSync(join(root, secondPath), "utf8"), user)
    assert.equal(readdirSync(join(root, "src")).some((name) => name.includes("scope-recovery")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("aborts the whole transaction when a target changes during multi-entry preparation", () => {
  const root = fixture()
  try {
    const firstPath = "src/prepared-a.ts"
    const secondPath = "src/prepared-b.ts"
    const baselineA = "a baseline\n"
    const baselineB = "b baseline\n"
    const currentA = "a worker\n"
    const currentB = "b worker\n"
    const newerB = "b external edit during preparation\n"
    write(join(root, firstPath), currentA)
    write(join(root, secondPath), currentB)
    const plan = planWorkerScopeRecovery({
      root,
      state: state({ [firstPath]: digest(baselineA), [secondPath]: digest(baselineB) }),
      currentSnapshot: { [firstPath]: digest(currentA), [secondPath]: digest(currentB) },
      previousScope: ["src"],
      nextScope: [],
      receipts: [
        receipt("C-prepare-a", firstPath, digest(baselineA), digest(currentA), "2026-07-16T08:05:00.000Z", 0o644),
        receipt("C-prepare-b", secondPath, digest(baselineB), digest(currentB), "2026-07-16T08:05:00.000Z", 0o644),
      ],
      readBaselineBlob: (hash) => {
        if (hash === digest(baselineA)) return Buffer.from(baselineA)
        if (hash === digest(baselineB)) return Buffer.from(baselineB)
        return null
      },
    })

    assert.throws(() => applyWorkerScopeRecoveryPlan(plan, {
      afterEntryPrepared(_entry, index) {
        if (index === 0) writeFileSync(join(root, secondPath), newerB)
      },
    }), /changed during transaction preparation/)
    assert.equal(readFileSync(join(root, firstPath), "utf8"), currentA)
    assert.equal(readFileSync(join(root, secondPath), "utf8"), newerB)
    assert.equal(readdirSync(join(root, "src")).some((name) => name.includes("scope-recovery")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("restores a Worker-created file to absence and a Worker-deleted file to its exact bytes and mode", () => {
  const root = fixture()
  try {
    const createdPath = "src/created.ts"
    const deletedPath = "src/deleted.sh"
    const created = "export const created = true\n"
    const deleted = "#!/bin/sh\necho baseline\n"
    write(join(root, createdPath), created, 0o640)
    const createdHash = digest(created)
    const deletedHash = digest(deleted)
    const plan = planWorkerScopeRecovery({
      root,
      state: state({ [deletedPath]: deletedHash }),
      currentSnapshot: { [createdPath]: createdHash },
      previousScope: ["src"],
      nextScope: [],
      receipts: [
        receipt("C-create", createdPath, null, createdHash),
        receipt("C-delete", deletedPath, deletedHash, null, "2026-07-16T08:06:00.000Z", 0o750),
      ],
      readBaselineBlob: (hash) => hash === deletedHash ? Buffer.from(deleted) : null,
    })

    const applied = applyWorkerScopeRecoveryPlan(plan)
    assert.equal(existsSync(join(root, createdPath)), false)
    assert.equal(readFileSync(join(root, deletedPath), "utf8"), deleted)
    assert.equal(lstatSync(join(root, deletedPath)).mode & 0o777, 0o750)

    applied.rollback()
    assert.equal(readFileSync(join(root, createdPath), "utf8"), created)
    assert.equal(lstatSync(join(root, createdPath)).mode & 0o777, 0o640)
    assert.equal(existsSync(join(root, deletedPath)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("restores the receipt-proven baseline mode and rolls back to the exact current mode", () => {
  const root = fixture()
  try {
    const path = "src/mode.sh"
    const baseline = "#!/bin/sh\necho baseline\n"
    const current = "#!/bin/sh\necho worker\n"
    write(join(root, path), current, 0o640)
    const plan = planWorkerScopeRecovery({
      root,
      state: state({ [path]: digest(baseline) }),
      currentSnapshot: { [path]: digest(current) },
      previousScope: ["src"],
      nextScope: [],
      receipts: [receipt("C-mode", path, digest(baseline), digest(current), undefined, 0o751, 0o640)],
      readBaselineBlob: (hash) => hash === digest(baseline) ? Buffer.from(baseline) : null,
    })

    const applied = applyWorkerScopeRecoveryPlan(plan)
    assert.equal(readFileSync(join(root, path), "utf8"), baseline)
    assert.equal(lstatSync(join(root, path)).mode & 0o777, 0o751)
    applied.rollback()
    assert.equal(readFileSync(join(root, path), "utf8"), current)
    assert.equal(lstatSync(join(root, path)).mode & 0o777, 0o640)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("rejects a blob-only legacy receipt when neither receipt nor Git proves the baseline mode", () => {
  const root = fixture()
  try {
    const path = "src/legacy-mode.ts"
    const baseline = "baseline\n"
    const current = "worker\n"
    write(join(root, path), current)

    assert.throws(() => planWorkerScopeRecovery({
      root,
      state: state({ [path]: digest(baseline) }),
      currentSnapshot: { [path]: digest(current) },
      previousScope: ["src"],
      nextScope: [],
      receipts: [receipt("C-legacy-mode", path, digest(baseline), digest(current))],
      readBaselineBlob: () => Buffer.from(baseline),
    }), /no trusted baseline mode/)
    assert.equal(readFileSync(join(root, path), "utf8"), current)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("rejects symlink recovery targets without following them", () => {
  const root = fixture()
  try {
    const outside = join(root, "outside.ts")
    const path = "src/link.ts"
    const baseline = "baseline\n"
    const current = "outside\n"
    write(outside, current)
    symlinkSync(outside, join(root, path))

    assert.throws(() => planWorkerScopeRecovery({
      root,
      state: state({ [path]: digest(baseline) }),
      currentSnapshot: { [path]: digest(current) },
      previousScope: ["src"],
      nextScope: [],
      receipts: [receipt("C-link", path, digest(baseline), digest(current))],
      readBaselineBlob: () => Buffer.from(baseline),
    }), /rejects symlinks/)
    assert.equal(readFileSync(outside, "utf8"), current)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

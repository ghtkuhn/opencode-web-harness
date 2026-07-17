import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import {
  planExactReceiptStartupReconciliation,
  type ExactReceiptStartupInput,
} from "../lib/exact-receipt-startup.ts"
import { renderPlannerTask } from "../lib/planner-task.ts"

function digest(content: string) {
  return createHash("sha256").update(content).digest("hex")
}

function fixture(): ExactReceiptStartupInput {
  const taskPath = "kanban/todo/01-auth.md"
  const contract = {
    scope: ["src/auth.ts", "tests/auth-navigation.spec.ts"],
    requirements: ["Auth navigation uses exact accessible links."],
    behavior: ["Login reaches registration: client"],
    verify: ["npm test"],
    supersedeTasks: [],
  }
  const taskContent = renderPlannerTask({
    title: "Repair auth navigation",
    outcome: "Auth navigation follows the exact recovered contract.",
    scope: contract.scope,
    requirements: contract.requirements,
    contract: "not-applicable",
    parallel: false,
    dependsOn: [],
    resources: ["Frontend"],
    behavior: contract.behavior,
    memoryAction: "none",
    memoryReason: "No durable fact is introduced.",
    verify: contract.verify,
  })
  const taskHash = digest(taskContent)
  const baselineHash = digest("original evidence\n")
  const currentHash = digest("old Worker evidence change\n")
  const scopeHash = digest("unchanged current scope\n")
  const workerSessionID = "worker-after-revision"
  return {
    receipt: {
      version: 1,
      status: "complete",
      taskPath,
      initialTaskHash: "previous-task-hash",
      taskHash,
      contractMode: "replace",
      contract,
      relevantFiles: [taskPath, ...contract.scope, "tests/auth.spec.ts", "src/layout.ts"],
      completedAt: "2026-07-16T08:42:40.000Z",
    },
    state: {
      status: "started",
      taskPath,
      taskHash,
      snapshot: {
        "tests/auth.spec.ts": baselineHash,
        "src/layout.ts": digest("layout at start\n"),
        "src/auth.ts": scopeHash,
      },
      taskRevision: {
        previousTaskHash: "previous-task-hash",
        revisedTaskHash: taskHash,
        plannerSessionID: "planner",
        executorSessionID: "executor",
        revisedAt: "2026-07-16T08:42:39.900Z",
      },
    },
    taskContent,
    registration: {
      status: "registered",
      taskPath,
      taskHash,
      snapshot: {
        "tests/auth.spec.ts": currentHash,
        "src/layout.ts": digest("layout at start\n"),
        "src/auth.ts": scopeHash,
      },
    },
    ownership: {
      taskPath,
      taskHash,
      plannerSessionID: "planner",
      source: "active_revision",
    },
    currentHashes: {
      "tests/auth.spec.ts": currentHash,
      "src/layout.ts": digest("layout at start\n"),
      "src/auth.ts": scopeHash,
    },
    baselineSources: {
      "tests/auth.spec.ts": { source: "git-head", hash: baselineHash },
    },
    appliedWorkerChanges: [{
      id: "C-first",
      status: "applied",
      taskPath,
      taskHash: "older-task-hash",
      sessionID: "old-worker",
      appliedAt: "2026-07-15T15:11:06.000Z",
      files: [{ path: "tests/auth.spec.ts", beforeHash: baselineHash, afterHash: currentHash }],
    }, {
      id: "C-abandoned",
      status: "applied",
      taskPath,
      taskHash: "older-task-hash-2",
      sessionID: "old-worker-2",
      appliedAt: "2026-07-16T03:33:13.000Z",
      files: [{ path: "tests/auth.spec.ts", beforeHash: currentHash, afterHash: digest("abandoned bytes\n") }],
    }],
    workerMutationPathsSinceRevision: [],
    workerHelp: {
      version: 1,
      requests: [{
        version: 1,
        id: "H1",
        status: "pending",
        taskPath,
        taskHash,
        workerSessionID,
        category: "doctor-failure",
        problem: "CHANGED_OUTSIDE_SCOPE_FILE: tests/auth.spec.ts",
        attemptedActions: ["Worker ran Doctor verify."],
        evidence: ["CHANGED_FILE_ACTION: restore the exact original file bytes."],
        relevantFiles: [taskPath, "tests/auth.spec.ts"],
        suggestedNextStep: "Executor must review the failure.",
        createdAt: "2026-07-16T08:44:22.000Z",
      }],
      updatedAt: "2026-07-16T08:44:22.000Z",
    },
    lastDoctorFailure: {
      version: 1,
      sessionID: workerSessionID,
      taskPath,
      gate: "verify",
      output: [
        "TASK DOCTOR: FAIL",
        "- CHANGED_OUTSIDE_SCOPE_FILE: tests/auth.spec.ts",
        "- CHANGED_FILE_ACTION: restore the exact original file bytes.",
      ].join("\n"),
      failedAt: "2026-07-16T08:43:33.000Z",
    },
  }
}

test("plans only the changed evidence path and closes its matching scope-only Help", () => {
  const plan = planExactReceiptStartupReconciliation(fixture())

  assert.equal(plan.status, "ready")
  assert.deepEqual(plan.restorePaths.map((entry) => entry.path), ["tests/auth.spec.ts"])
  assert.deepEqual(plan.restorePaths[0].provenanceReceiptIDs, ["C-first"])
  assert.deepEqual(plan.restorePaths[0].abandonedReceiptIDs, ["C-abandoned"])
  assert.equal(plan.restorePaths[0].baselineSource, "git-head")
  assert.equal(plan.lastFailureAction, "resolve")
  assert.deepEqual(plan.helpAction, {
    action: "obsolete",
    requestID: "H1",
    workerSessionID: "worker-after-revision",
    reason: "The exact replacement removed the reported evidence path from mutation Scope and trusted startup reconciliation restored its task-start bytes.",
    closureReason: "exact_scope_reconciled",
    restoredPaths: ["tests/auth.spec.ts"],
  })
})

test("never reconciles pending or merge-mode receipts", () => {
  for (const update of [
    { status: "pending" as const },
    { contractMode: "merge" as const },
    { completedAt: undefined },
  ]) {
    const input = fixture()
    input.receipt = { ...input.receipt!, ...update }
    const plan = planExactReceiptStartupReconciliation(input)
    assert.equal(plan.status, "ineligible")
    assert.match(plan.reason, /completed replace-mode/i)
  }
})

test("requires state, task, registration, ownership, and taskRevision hash alignment", () => {
  const mutations: Array<(input: ExactReceiptStartupInput) => void> = [
    (input) => { input.state!.taskHash = "stale" },
    (input) => { input.taskContent += "\nchanged" },
    (input) => { input.registration!.taskHash = "stale" },
    (input) => { input.ownership!.taskHash = "stale" },
    (input) => { input.ownership!.source = "registration" },
    (input) => { input.state!.taskRevision!.previousTaskHash = "other" },
  ]
  for (const mutate of mutations) {
    const input = fixture()
    mutate(input)
    assert.equal(planExactReceiptStartupReconciliation(input).status, "ineligible")
  }
})

test("does not restore current Scope, unrelated, unproven, or untrusted paths", () => {
  const cases: Array<(input: ExactReceiptStartupInput) => void> = [
    (input) => { input.lastDoctorFailure!.output = "TASK DOCTOR: FAIL\n- CHANGED_OUTSIDE_SCOPE_FILE: src/auth.ts\n- CHANGED_FILE_ACTION: restore" },
    (input) => { input.receipt!.relevantFiles = input.receipt!.relevantFiles!.filter((path) => path !== "tests/auth.spec.ts") },
    (input) => { input.baselineSources["tests/auth.spec.ts"]!.hash = "wrong" },
    (input) => { input.appliedWorkerChanges = [] },
    (input) => { input.registration!.snapshot!["tests/auth.spec.ts"] = "other-current" },
  ]
  for (const mutate of cases) {
    const input = fixture()
    mutate(input)
    const plan = planExactReceiptStartupReconciliation(input)
    assert.equal(plan.status, "ineligible")
    assert.deepEqual(plan.restorePaths, [])
  }
})

test("independent Doctor findings make the entire restore plan ineligible", () => {
  const input = fixture()
  input.lastDoctorFailure!.output += "\n- TEST_FAILURE: independent focused test still fails"
  const plan = planExactReceiptStartupReconciliation(input)

  assert.equal(plan.status, "ineligible")
  assert.deepEqual(plan.independentDoctorFindings.map((finding) => finding.code), ["TEST_FAILURE"])
  assert.deepEqual(plan.restorePaths, [])
})

test("Worker application changes after the exact revision block startup reconciliation", () => {
  const input = fixture()
  input.appliedWorkerChanges.push({
    id: "C-after-revision",
    status: "applied",
    taskPath: input.receipt!.taskPath,
    taskHash: input.receipt!.taskHash,
    sessionID: "new-worker",
    appliedAt: "2026-07-16T08:45:00.000Z",
    files: [{ path: "src/auth.ts", beforeHash: "before", afterHash: "after" }],
  })
  const plan = planExactReceiptStartupReconciliation(input)

  assert.equal(plan.status, "ineligible")
  assert.deepEqual(plan.workerChangesSinceRevision, ["src/auth.ts"])
})

test("keeps a same-Worker Help whose primary finding is independent", () => {
  const input = fixture()
  input.workerHelp!.requests[0] = {
    ...input.workerHelp!.requests[0],
    category: "tool-failure",
    problem: "WORKFLOW GUARD BLOCKED: Worker attempted a shell command outside the transactional allowlist.",
    evidence: ["Earlier Doctor context: CHANGED_OUTSIDE_SCOPE_FILE: tests/auth.spec.ts"],
  }
  const plan = planExactReceiptStartupReconciliation(input)

  assert.equal(plan.status, "ready")
  assert.equal(plan.lastFailureAction, "resolve")
  assert.equal(plan.helpAction?.action, "keep")
  assert.match(plan.helpAction?.reason ?? "", /independent/i)
})

test("keeps Help when independent evidence is separate from a scope-only primary problem", () => {
  const input = fixture()
  input.workerHelp!.requests[0].evidence.push("WORKFLOW GUARD BLOCKED: a shell command violated the transactional allowlist.")
  const plan = planExactReceiptStartupReconciliation(input)

  assert.equal(plan.status, "ready")
  assert.equal(plan.helpAction?.action, "keep")
  assert.match(plan.helpAction?.reason ?? "", /independent/i)
})

test("requires an exact failure taskHash or one unique hash-bound legacy Help", () => {
  const direct = fixture()
  direct.lastDoctorFailure!.taskHash = direct.receipt!.taskHash
  direct.workerHelp = null
  assert.equal(planExactReceiptStartupReconciliation(direct).status, "ready")

  const stale = fixture()
  stale.lastDoctorFailure!.taskHash = "stale-task"
  assert.equal(planExactReceiptStartupReconciliation(stale).status, "ineligible")

  const unboundLegacy = fixture()
  unboundLegacy.workerHelp = null
  assert.equal(planExactReceiptStartupReconciliation(unboundLegacy).status, "ineligible")
})

test("keeps Help when it does not uniquely match the failed Worker", () => {
  const input = fixture()
  input.workerHelp!.requests[0].workerSessionID = "another-worker"
  const plan = planExactReceiptStartupReconciliation(input)

  assert.equal(plan.status, "ineligible")
  assert.match(plan.reason, /not bound to the exact task hash/i)
})

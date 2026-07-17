import test from "node:test"
import assert from "node:assert/strict"
import {
  canonicalBlockedHandoff,
  canonicalReviewableHandoff,
  changedSnapshotPaths,
  blockedHandoffError,
  claimsReviewableHandoff,
  reviewableHandoffError,
  workerReturnIssue,
} from "../lib/review-contract.ts"

test("changedSnapshotPaths reports added, changed, and deleted files", () => {
  assert.deepEqual(changedSnapshotPaths({ a: "1", b: "1" }, { b: "2", c: "1" }), ["a", "b", "c"])
})

test("reviewableHandoffError accepts the minimal technical Worker handoff", () => {
  const taskPath = "kanban/todo/01-task.md"
  const minimal = canonicalReviewableHandoff(taskPath)
  assert.equal(minimal, `REVIEWABLE\nTask: ${taskPath}`)
  assert.equal(reviewableHandoffError(minimal, taskPath), null)
  assert.equal(reviewableHandoffError("REVIEWABLE", taskPath), "exact task path")
  const emphasized = minimal.replace("REVIEWABLE", "**REVIEWABLE**")
  assert.equal(reviewableHandoffError(emphasized, taskPath), null)

  const optionalProse = `${minimal}\nAny additional model-authored prose is ignored by this technical contract.`
  assert.equal(reviewableHandoffError(optionalProse, taskPath), null)
})

test("workerReturnIssue blocks pending learnings before any Worker return", () => {
  assert.deepEqual(workerReturnIssue({
    text: "BLOCKED",
    taskPath: "kanban/todo/01-task.md",
    doctorStatus: "started",
    doctorTaskPath: "kanban/todo/01-task.md",
    pendingGuardLearningIDs: ["bbbbbb", "aaaaaa", "bbbbbb"],
  }), {
    kind: "pending_guard_learnings",
    detail: "pending Guard learnings: aaaaaa, bbbbbb",
  })
})

test("workerReturnIssue rejects REVIEWABLE before the exact Doctor task passed", () => {
  const issue = workerReturnIssue({
    text: "REVIEWABLE\nTask: kanban/todo/01-task.md",
    taskPath: "kanban/todo/01-task.md",
    doctorStatus: "started",
    doctorTaskPath: "kanban/todo/01-task.md",
  })
  assert.equal(claimsReviewableHandoff("Not reviewable yet."), false)
  assert.equal(issue?.kind, "reviewable_before_pass")
})

test("workerReturnIssue accepts blockers before PASS and complete handoffs after PASS", () => {
  const taskPath = "kanban/todo/01-task.md"
  assert.equal(workerReturnIssue({
    text: [
      "BLOCKED",
      `Task: ${taskPath}`,
      "Doctor status: started",
      "Failure: Doctor verify failed.",
      "Required owner: Planner",
    ].join("\n"),
    taskPath,
    doctorStatus: "started",
    doctorTaskPath: taskPath,
    requireTerminalHandoff: true,
  }), null)

  const handoff = canonicalReviewableHandoff(taskPath)
  assert.equal(workerReturnIssue({
    text: handoff,
    taskPath,
    doctorStatus: "passed",
    doctorTaskPath: taskPath,
  }), null)
})

test("workerReturnIssue rejects an ambiguous non-passed return", () => {
  const taskPath = "kanban/todo/01-task.md"
  assert.equal(blockedHandoffError("Ready for further instructions.", taskPath), "BLOCKED heading")
  assert.deepEqual(workerReturnIssue({
    text: "Ready for further instructions.",
    taskPath,
    doctorStatus: "started",
    doctorTaskPath: taskPath,
    requireTerminalHandoff: true,
  }), {
    kind: "invalid_blocked_handoff",
    detail: "missing BLOCKED heading",
  })
})

test("canonicalBlockedHandoff creates a complete bounded Executor handoff", () => {
  const taskPath = "kanban/todo/01-task.md"
  const handoff = canonicalBlockedHandoff({
    taskPath,
    doctorStatus: "started",
    failure: "  FALLOW_NEW_FINDING:   unresolved import  ",
  })
  assert.equal(blockedHandoffError(handoff, taskPath), null)
  assert.match(handoff, /Failure: FALLOW_NEW_FINDING: unresolved import/)
  assert.match(handoff, /Required owner: Executor/)
})

test("workerReturnIssue accepts only the persisted structured help handoff", () => {
  const taskPath = "kanban/todo/01-task.md"
  const complete = [
    "HELP_REQUESTED",
    "Help ID: H1",
    `Task: ${taskPath}`,
    "Problem: The same edit operation failed repeatedly.",
    "Evidence:",
    "- Three equivalent edit-match errors.",
    "Attempted:",
    "- Re-read the file and changed the replacement boundary.",
    "Suggested next step: Start a fresh Worker with the current file content.",
  ].join("\n")
  assert.equal(workerReturnIssue({
    text: complete,
    taskPath,
    doctorStatus: "started",
    doctorTaskPath: taskPath,
    helpRequestID: "H1",
    requireTerminalHandoff: true,
  }), null)
  assert.deepEqual(workerReturnIssue({
    text: complete.replace("Help ID: H1", "Help ID: H2"),
    taskPath,
    doctorStatus: "started",
    doctorTaskPath: taskPath,
    helpRequestID: "H1",
    requireTerminalHandoff: true,
  }), {
    kind: "invalid_help_handoff",
    detail: "missing exact Help ID",
  })
})

test("workerReturnIssue requires a structured handoff after PASS", () => {
  const issue = workerReturnIssue({
    text: "Done.",
    taskPath: "kanban/todo/01-task.md",
    doctorStatus: "passed",
    doctorTaskPath: "kanban/todo/01-task.md",
  })
  assert.deepEqual(issue, {
    kind: "invalid_reviewable_handoff",
    detail: "missing REVIEWABLE heading",
  })
})

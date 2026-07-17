import test from "node:test"
import assert from "node:assert/strict"
import {
  claimsHelpRequestedHandoff,
  doctorFailureFingerprint,
  helpRequestedHandoffError,
  loopFailureFingerprint,
  replaceOccurrenceMismatches,
  restoreOnlyOutsideScopeFailure,
} from "../lib/worker-help.ts"

test("help handoff binds the terminal Worker result to one request and task", () => {
  const task = "kanban/todo/01-task.md"
  const handoff = [
    "HELP_REQUESTED",
    "Help ID: H3",
    `Task: ${task}`,
    "Problem: Repeated edits cannot match the current source.",
    "Evidence:",
    "- Three edit-match failures.",
    "Attempted:",
    "- Re-read the file and narrowed the replacement.",
    "Suggested next step: Start a fresh Worker with a full-file repair instruction.",
  ].join("\n")
  assert.equal(claimsHelpRequestedHandoff(handoff), true)
  assert.equal(helpRequestedHandoffError(handoff, task, "H3"), null)
  assert.equal(helpRequestedHandoffError(handoff, task, "H4"), "exact Help ID")
})

test("loop fingerprint groups equivalent edit-match failures on the same file", () => {
  const first = loopFailureFingerprint("edit", { filePath: "src/a.ts", oldString: "one" }, "Could not find oldString in file")
  const second = loopFailureFingerprint("edit", { filePath: "src/a.ts", oldString: "two" }, "The replacement matched span was not found")
  const otherFile = loopFailureFingerprint("edit", { filePath: "src/b.ts", oldString: "two" }, "Could not find old text")
  assert.equal(first?.signature, second?.signature)
  assert.notEqual(first?.signature, otherFile?.signature)
  assert.equal(loopFailureFingerprint("read", { filePath: "src/a.ts" }, "failed")?.target, "src/a.ts")
})

test("transactional preview fingerprint preserves the concrete last error and operation path", () => {
  const error = "Worker replace found 0 exact matches while 1 were expected: src/a.ts"
  const fingerprint = loopFailureFingerprint("preview_worker_changes", {
    operations: [{ kind: "replace", path: "src/a.ts", old_text: "before", new_text: "after", expected_occurrences: 1 }],
  }, error)
  assert.equal(fingerprint?.target, "src/a.ts")
  assert.equal(fingerprint?.category, "replace-occurrence-none")
  assert.equal(fingerprint?.evidence, error)
})

test("transactional occurrence fingerprints distinguish absent text from repeated matches", () => {
  const input = {
    operations: [{ kind: "replace", path: "src/a.ts", old_text: "before", new_text: "after", expected_occurrences: 1 }],
  }
  const none = loopFailureFingerprint("preview_worker_changes", input, "Worker replace expected 1 occurrences but found 0: src/a.ts")
  const four = loopFailureFingerprint("preview_worker_changes", input, "Worker replace expected 1 occurrences but found 4: src/a.ts")
  const two = loopFailureFingerprint("preview_worker_changes", input, "Worker replace expected 1 occurrences but found 2: src/a.ts")
  assert.notEqual(none?.signature, four?.signature)
  assert.equal(two?.signature, four?.signature)
})

test("occurrence evidence parser preserves ordered pathless and exact-path mismatches", () => {
  const mismatches = replaceOccurrenceMismatches([
    "Worker replace expected 1 occurrences but found 0 (first attempt)",
    "Worker replace expected 1 occurrences but found 4 (second attempt)",
    "Worker replace found 2 exact matches while 3 were expected: src/a.ts",
  ].join("\n"))
  assert.deepEqual(mismatches, [
    { expected: 1, found: 0, evidence: "Worker replace expected 1 occurrences but found 0" },
    { expected: 1, found: 4, evidence: "Worker replace expected 1 occurrences but found 4" },
    { expected: 3, found: 2, path: "src/a.ts", evidence: "Worker replace found 2 exact matches while 3 were expected: src/a.ts" },
  ])
})

test("occurrence evidence parser normalizes decorated paths and rejects invalid counts", () => {
  const mismatches = replaceOccurrenceMismatches([
    "Worker replace expected 1 occurrences but found 4: `src/backtick.ts` (retry)",
    'Worker replace found 2 exact matches while 3 were expected: "src/quoted.ts".',
    "Worker replace expected 5 occurrences but found 1: [src/bracketed.ts],",
    "Worker replace expected 2 occurrences but found 2: src/equal.ts",
    "Worker replace expected 0 occurrences but found 1: src/zero-expected.ts",
    "Worker replace expected 9007199254740992 occurrences but found 1: src/unsafe-expected.ts",
    "Worker replace expected 1 occurrences but found 9007199254740992: src/unsafe-found.ts",
  ].join("\n"))
  assert.deepEqual(mismatches, [
    { expected: 1, found: 4, path: "src/backtick.ts", evidence: "Worker replace expected 1 occurrences but found 4: `src/backtick.ts`" },
    { expected: 3, found: 2, path: "src/quoted.ts", evidence: 'Worker replace found 2 exact matches while 3 were expected: "src/quoted.ts".' },
    { expected: 5, found: 1, path: "src/bracketed.ts", evidence: "Worker replace expected 5 occurrences but found 1: [src/bracketed.ts]" },
  ])
})

test("restore-only Doctor parser recognizes one changed outside-Scope file", () => {
  const result = restoreOnlyOutsideScopeFailure([
    "> task:doctor:verify",
    "TASK DOCTOR: FAIL",
    "- CHANGED_OUTSIDE_SCOPE_FILE: code/frontend/tests/auth.spec.ts",
    "- CHANGED_FILE_ACTION: restore the exact original file bytes.",
  ].join("\n"))
  assert.deepEqual(result, {
    codes: ["CHANGED_OUTSIDE_SCOPE_FILE", "CHANGED_FILE_ACTION"],
    paths: ["code/frontend/tests/auth.spec.ts"],
    evidence: [
      "TASK DOCTOR: FAIL",
      "- CHANGED_OUTSIDE_SCOPE_FILE: code/frontend/tests/auth.spec.ts",
      "- CHANGED_FILE_ACTION: restore the exact original file bytes.",
    ].join("\n"),
  })
})

test("restore-only Doctor parser recognizes one missing outside-Scope file", () => {
  const result = restoreOnlyOutsideScopeFailure([
    "TASK DOCTOR: FAIL",
    "- MISSING_OUTSIDE_SCOPE_FILE: code/frontend/tests/removed.spec.ts",
    "- MISSING_FILE_ACTION: restore the exact original file bytes. Do not create a placeholder.",
  ].join("\n"))
  assert.deepEqual(result?.codes, ["MISSING_OUTSIDE_SCOPE_FILE", "MISSING_FILE_ACTION"])
  assert.deepEqual(result?.paths, ["code/frontend/tests/removed.spec.ts"])
})

test("restore-only Doctor parser recognizes changed and missing whitelisted files", () => {
  const result = restoreOnlyOutsideScopeFailure([
    "TASK DOCTOR: FAIL",
    "- WHITELISTED_FILE_MISSING: artifacts/missing.json",
    "- WHITELISTED_FILE_CHANGED: artifacts/changed.json",
    "- WHITELIST_ACTION: restore the whitelisted file to its recorded content or stop and report the blocker.",
  ].join("\n"))
  assert.deepEqual(result?.codes, [
    "WHITELISTED_FILE_MISSING",
    "WHITELISTED_FILE_CHANGED",
    "WHITELIST_ACTION",
  ])
  assert.deepEqual(result?.paths, ["artifacts/missing.json", "artifacts/changed.json"])
})

test("restore-only Doctor parser preserves multiple unique paths and matching actions", () => {
  const result = restoreOnlyOutsideScopeFailure([
    "TASK DOCTOR: FAIL",
    "- CHANGED_OUTSIDE_SCOPE_FILE: src/legacy-a.ts",
    "- CHANGED_OUTSIDE_SCOPE_FILE: src/legacy-b.ts",
    "- MISSING_OUTSIDE_SCOPE_FILE: src/legacy-c.ts",
    "- CHANGED_FILE_ACTION: restore the exact original file bytes.",
    "- MISSING_FILE_ACTION: restore the exact original file bytes.",
  ].join("\n"))
  assert.deepEqual(result?.codes, [
    "CHANGED_OUTSIDE_SCOPE_FILE",
    "MISSING_OUTSIDE_SCOPE_FILE",
    "CHANGED_FILE_ACTION",
    "MISSING_FILE_ACTION",
  ])
  assert.deepEqual(result?.paths, ["src/legacy-a.ts", "src/legacy-b.ts", "src/legacy-c.ts"])
})

test("restore-only Doctor parser leaves UNKNOWN_FILE repair to Worker", () => {
  assert.equal(restoreOnlyOutsideScopeFailure([
    "TASK DOCTOR: FAIL",
    "- UNKNOWN_FILE: code/frontend/test-results/result.json",
    "- UNKNOWN_FILE_ACTION: inspect the path, then use task:doctor:test-file or whitelist.",
  ].join("\n")), null)
})

test("restore-only Doctor parser rejects mixed outside-Scope and implementation findings", () => {
  assert.equal(restoreOnlyOutsideScopeFailure([
    "TASK DOCTOR: FAIL",
    "- CHANGED_OUTSIDE_SCOPE_FILE: code/frontend/tests/auth.spec.ts",
    "- CHANGED_FILE_ACTION: restore the exact original file bytes.",
    "- VERIFY_FAILED: expected exit 0, got 1: npm run typecheck",
  ].join("\n")), null)
})

test("restore-only Doctor parser uses only the latest Doctor failure block", () => {
  const result = restoreOnlyOutsideScopeFailure([
    "TASK DOCTOR: FAIL",
    "- CHANGED_OUTSIDE_SCOPE_FILE: spoofed/earlier.ts",
    "- CHANGED_FILE_ACTION: restore the exact original file bytes.",
    "TASK DOCTOR: RUN npm run typecheck",
    "TASK DOCTOR: FAIL",
    "- MISSING_OUTSIDE_SCOPE_FILE: src/latest.ts",
    "- MISSING_FILE_ACTION: restore the exact original file bytes.",
  ].join("\n"))
  assert.deepEqual(result?.paths, ["src/latest.ts"])
  assert.doesNotMatch(result?.evidence ?? "", /spoofed\/earlier/)
})

test("restore-only Doctor parser ignores a spoofed preamble when the latest Doctor status passes", () => {
  assert.equal(restoreOnlyOutsideScopeFailure([
    "TASK DOCTOR: FAIL",
    "- CHANGED_OUTSIDE_SCOPE_FILE: spoofed/preamble.ts",
    "- CHANGED_FILE_ACTION: restore the exact original file bytes.",
    "TASK DOCTOR: RUN npm run typecheck",
    "TASK DOCTOR: PASS",
  ].join("\n")), null)
  assert.equal(restoreOnlyOutsideScopeFailure([
    "command output: TASK DOCTOR: FAIL",
    "- CHANGED_OUTSIDE_SCOPE_FILE: spoofed/inline.ts",
    "- CHANGED_FILE_ACTION: restore the exact original file bytes.",
  ].join("\n")), null)
})

test("Doctor fingerprint ignores command preambles, whitespace, and finding order", () => {
  const first = doctorFailureFingerprint("verify", "kanban/todo/01-task.md", [
    "> task:doctor:verify",
    "TASK DOCTOR: FAIL",
    "- FALLOW_NEW_FINDING: unresolved_imports: src/a.ts",
    "- FALLOW_NEW_FINDING: unlisted_dependencies: (project)",
  ].join("\n"))
  const second = doctorFailureFingerprint("verify", "kanban/todo/01-task.md", [
    "irrelevant npm output",
    "TASK DOCTOR:   FAIL",
    " -   FALLOW_NEW_FINDING:   unlisted_dependencies: (project)",
    "- FALLOW_NEW_FINDING: unresolved_imports: src/a.ts",
  ].join("\n"))
  const changed = doctorFailureFingerprint("verify", "kanban/todo/01-task.md", [
    "TASK DOCTOR: FAIL",
    "- FALLOW_NEW_FINDING: unresolved_imports: src/b.ts",
  ].join("\n"))
  assert.equal(first?.signature, second?.signature)
  assert.notEqual(first?.signature, changed?.signature)
  assert.equal(doctorFailureFingerprint("verify", "kanban/todo/01-task.md", "TASK DOCTOR: PASS"), null)
})

test("Doctor fingerprint treats a shrinking diagnostic set as progress", () => {
  const twoFiles = doctorFailureFingerprint("verify", "kanban/todo/01-task.md", [
    "src/LoginPage.tsx(66,39): error TS2554: Expected 1 arguments, but got 2.",
    "src/RegisterPage.tsx(68,52): error TS2554: Expected 1 arguments, but got 2.",
    "TASK DOCTOR: FAIL",
    "- VERIFY_FAILED: expected exit 0, got 2: npm run typecheck",
  ].join("\n"))
  const oneFile = doctorFailureFingerprint("verify", "kanban/todo/01-task.md", [
    "src/RegisterPage.tsx(68,52): error TS2554: Expected 1 arguments, but got 2.",
    "TASK DOCTOR: FAIL",
    "- VERIFY_FAILED: expected exit 0, got 2: npm run typecheck",
  ].join("\n"))
  const sameTwoFilesReordered = doctorFailureFingerprint("verify", "kanban/todo/01-task.md", [
    "src/RegisterPage.tsx(68,52): error TS2554: Expected 1 arguments, but got 2.",
    "src/LoginPage.tsx(66,39): error TS2554: Expected 1 arguments, but got 2.",
    "TASK DOCTOR: FAIL",
    "- VERIFY_FAILED: expected exit 0, got 2: npm run typecheck",
  ].join("\n"))
  assert.notEqual(twoFiles?.signature, oneFile?.signature)
  assert.equal(twoFiles?.signature, sameTwoFilesReordered?.signature)
})

test("Doctor fingerprint retains a stable connection-refused diagnostic", () => {
  const output = [
    "[WebServer] 4:05:05 PM [vite] http proxy error: /api/auth/login",
    "[WebServer] AggregateError [ECONNREFUSED]:",
    "✖ 1 [chromium] › tests/auth.spec.ts › login navigates",
    "TASK DOCTOR: FAIL",
    "- VERIFY_FAILED: expected exit 0, got 1: npm run test:e2e:direct",
  ].join("\n")
  const fingerprint = doctorFailureFingerprint("verify", "kanban/todo/01-task.md", output)
  assert.match(fingerprint?.evidence ?? "", /NODE_ERROR ECONNREFUSED/)
  assert.match(fingerprint?.evidence ?? "", /PROXY_ERROR \/api\/auth\/login/)
  assert.match(fingerprint?.evidence ?? "", /login navigates/)
  const otherRoute = doctorFailureFingerprint("verify", "kanban/todo/01-task.md", output.replace("/api/auth/login", "/api/users"))
  assert.notEqual(fingerprint?.signature, otherRoute?.signature)
})

import assert from "node:assert/strict"
import { test } from "node:test"
import { scopePathFormatError, shellCommandMutates } from "../lib/workflow-guard-rules.ts"
import { canonicalWorkerDoctorCommand, isDoctorCommand, parseDoctorInvocation } from "../lib/doctor-command.ts"

test("accepts exact project-relative scope paths", () => {
  assert.equal(scopePathFormatError("code/frontend/src/i18n/index.ts"), null)
})

test("accepts technically valid project paths containing spaces", () => {
  assert.equal(scopePathFormatError("code/frontend/src/public exports/index.ts"), null)
})

test("rejects absolute and parent-relative scope paths", () => {
  assert.match(scopePathFormatError("/tmp/outside.ts") ?? "", /project-relative/)
  assert.match(scopePathFormatError("../outside.ts") ?? "", /dot segments/)
})

test("allows read-only commands that discard stderr", () => {
  assert.equal(shellCommandMutates("ls node_modules/.bin/tsx 2>/dev/null"), false)
  assert.equal(shellCommandMutates("ls first 2>/dev/null; ls second 2> /dev/null"), false)
})

test("still detects real writes with stderr discarded", () => {
  assert.equal(shellCommandMutates("echo result > output.txt 2>/dev/null"), true)
  assert.equal(shellCommandMutates("rm output.txt 2>/dev/null"), true)
  assert.equal(shellCommandMutates("node -e 'writeFileSync(\"x\", \"y\")' 2>/dev/null"), true)
})

test("repairs a noisy Worker Doctor lifecycle command", () => {
  assert.equal(
    canonicalWorkerDoctorCommand("npm run task:doctor:start --prefix code/frontend --task kanban/todo/01-fix-main-imports.md"),
    "npm run task:doctor:start -- kanban/todo/01-fix-main-imports.md",
  )
  assert.equal(
    canonicalWorkerDoctorCommand("npm --prefix code/frontend run task:doctor:verify -- kanban/todo/01-fix-main-imports.md"),
    "npm run task:doctor:verify -- kanban/todo/01-fix-main-imports.md",
  )
  assert.equal(canonicalWorkerDoctorCommand("npm run task:doctor:start --task first.md"), null)
  assert.equal(canonicalWorkerDoctorCommand("npm run task:doctor:start-dry-run -- kanban/todo/01-fix-main-imports.md"), null)
  assert.equal(canonicalWorkerDoctorCommand("npm run anything -- ref=kanban/todo/01-fix-main-imports.md.bak task:doctor:start"), null)
})

test("recognizes only complete Doctor commands", () => {
  assert.deepEqual(
    parseDoctorInvocation("npm run task:doctor:verify -- kanban/todo/01-task.md"),
    { gate: "verify", taskPath: "kanban/todo/01-task.md" },
  )
  assert.deepEqual(
    parseDoctorInvocation("node scripts/task-doctor.mjs verify kanban/todo/01-task.md"),
    { gate: "verify", taskPath: "kanban/todo/01-task.md" },
  )
  assert.equal(parseDoctorInvocation("echo 'TASK DOCTOR: PASS npm run task:doctor:verify -- kanban/todo/01-task.md'"), null)
  assert.equal(parseDoctorInvocation("npm run task:doctor:verify -- kanban/todo/01-task.md.bak"), null)
  assert.equal(isDoctorCommand("npm run task:doctor:schedule"), true)
  assert.equal(isDoctorCommand("echo npm run task:doctor:schedule"), false)
})

test("preserves required Worker Doctor utility operands", () => {
  assert.equal(
    canonicalWorkerDoctorCommand("npm run task:doctor:test-file -- kanban/todo/01-task.md code/frontend/.e2e-tmp/data.json"),
    "npm run task:doctor:test-file -- kanban/todo/01-task.md 'code/frontend/.e2e-tmp/data.json'",
  )
  assert.equal(
    canonicalWorkerDoctorCommand('npm run task:doctor:whitelist -- kanban/todo/01-task.md artifacts/result.txt "Retain the intentional generated report"'),
    "npm run task:doctor:whitelist -- kanban/todo/01-task.md 'artifacts/result.txt' 'Retain the intentional generated report'",
  )
  assert.equal(canonicalWorkerDoctorCommand("npm run task:doctor:test-file -- kanban/todo/01-task.md"), null)
})

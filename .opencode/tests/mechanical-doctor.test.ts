import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  runMechanicalDoctorVerify,
  validateMechanicalDoctorRun,
  type MechanicalDoctorRun,
} from "../lib/mechanical-doctor.ts"

function result(output: string, exitCode: number | null): MechanicalDoctorRun {
  return {
    runID: "run-1",
    command: "npm run task:doctor:verify -- kanban/todo/01-task.md",
    taskPath: "kanban/todo/01-task.md",
    output,
    stdout: output,
    stderr: "",
    exitCode,
    signal: null,
    elapsedMs: 5,
    timedOut: false,
    aborted: false,
    overflowed: false,
  }
}

test("validates canonical pass, fail, and Executor recovery statuses against exit codes", () => {
  assert.equal(validateMechanicalDoctorRun(result("TASK DOCTOR: PASS\n", 0)).status, "pass")
  assert.equal(validateMechanicalDoctorRun(result("TASK DOCTOR: FAIL\n", 1)).status, "fail")
  assert.equal(validateMechanicalDoctorRun(result("TASK DOCTOR: EXECUTOR RECOVERY REQUIRED\n", 2)).status, "executor_recovery_required")
  assert.throws(() => validateMechanicalDoctorRun(result("TASK DOCTOR: PASS\n", 1)), /contradictory status/)
  assert.throws(() => validateMechanicalDoctorRun(result("TASK DOCTOR: FAIL\n", 0)), /contradictory status/)
  assert.throws(() => validateMechanicalDoctorRun(result("plain output\n", 1)), /no terminal TASK DOCTOR status/)
})

test("accepts PASS from a successful Doctor process without interpreting reporter output", () => {
  const run = result("- B1 skipped reporter\nTODO B2 pending\nTASK DOCTOR: PASS\n", 0)
  assert.equal(validateMechanicalDoctorRun(run).status, "pass")
})

test("rejects every transport-level failure before accepting output markers", () => {
  for (const field of ["timedOut", "aborted", "overflowed"] as const) {
    assert.throws(() => validateMechanicalDoctorRun({ ...result("TASK DOCTOR: PASS\n", 0), [field]: true }), /Mechanical Doctor verify/)
  }
  assert.throws(() => validateMechanicalDoctorRun({ ...result("TASK DOCTOR: PASS\n", 0), error: "ENOENT" }), /spawn failed/)
  assert.throws(() => validateMechanicalDoctorRun({ ...result("TASK DOCTOR: PASS\n", 0), signal: "SIGTERM" }), /signal SIGTERM/)
})

test("the argv runner enforces its timeout and waits for the Doctor process to close", async () => {
  const root = mkdtempSync(join(tmpdir(), "mechanical-doctor-"))
  try {
    mkdirSync(join(root, "scripts"), { recursive: true })
    writeFileSync(join(root, "scripts/task-doctor.mjs"), [
      "await new Promise((resolve) => setTimeout(resolve, 5_000))",
      "console.log('TASK DOCTOR: PASS')",
      "",
    ].join("\n"))
    const run = await runMechanicalDoctorVerify({
      root,
      taskPath: "kanban/todo/01-task.md",
      timeoutMs: 40,
    })
    assert.equal(run.timedOut, true)
    assert.notEqual(run.signal, null)
    assert.ok(run.elapsedMs < 2_000)
    assert.throws(() => validateMechanicalDoctorRun(run), /timed out/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

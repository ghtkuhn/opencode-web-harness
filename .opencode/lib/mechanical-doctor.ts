import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

export type MechanicalDoctorStatus = "fail" | "pass" | "executor_recovery_required"

export type MechanicalDoctorRun = {
  runID: string
  command: string
  taskPath: string
  output: string
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  elapsedMs: number
  timedOut: boolean
  aborted: boolean
  overflowed: boolean
  error?: string
}

export type ValidatedMechanicalDoctorRun = MechanicalDoctorRun & {
  status: MechanicalDoctorStatus
}

type RunMechanicalDoctorOptions = {
  root: string
  taskPath: string
  timeoutMs: number
  maxOutputBytes?: number
  abortSignal?: AbortSignal
}

const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024
const KILL_GRACE_MS = 1_000

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return
  try {
    if (process.platform === "win32") process.kill(pid, signal)
    else process.kill(-pid, signal)
  } catch {
    // The process may have exited between the close check and the signal.
  }
}

export function runMechanicalDoctorVerify(options: RunMechanicalDoctorOptions): Promise<MechanicalDoctorRun> {
  const startedAt = Date.now()
  const command = `npm run task:doctor:verify -- ${options.taskPath}`
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return new Promise((resolve) => {
    const child = spawn("node", ["scripts/task-doctor.mjs", "verify", options.taskPath], {
      cwd: options.root,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let timedOut = false
    let aborted = false
    let overflowed = false
    let spawnError: string | undefined
    let closed = false
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const stop = () => {
      terminateProcessTree(child.pid, "SIGTERM")
      killTimer ??= setTimeout(() => terminateProcessTree(child.pid, "SIGKILL"), KILL_GRACE_MS)
      killTimer.unref?.()
    }
    const append = (target: Buffer[], chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += value.length
      if (outputBytes > maxOutputBytes) {
        overflowed = true
        stop()
        return
      }
      target.push(value)
    }
    child.stdout.on("data", (chunk) => append(stdout, chunk))
    child.stderr.on("data", (chunk) => append(stderr, chunk))
    child.on("error", (error) => {
      spawnError = error.message
    })

    const timeout = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs)
    timeout.unref?.()

    const abort = () => {
      aborted = true
      stop()
    }
    options.abortSignal?.addEventListener("abort", abort, { once: true })
    if (options.abortSignal?.aborted) abort()

    child.on("close", (exitCode, signal) => {
      if (closed) return
      closed = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      options.abortSignal?.removeEventListener("abort", abort)
      const stdoutText = Buffer.concat(stdout).toString("utf8")
      const stderrText = Buffer.concat(stderr).toString("utf8")
      resolve({
        runID: randomUUID(),
        command,
        taskPath: options.taskPath,
        output: [stdoutText, stderrText].filter(Boolean).join("\n").trim(),
        stdout: stdoutText,
        stderr: stderrText,
        exitCode,
        signal,
        elapsedMs: Date.now() - startedAt,
        timedOut,
        aborted,
        overflowed,
        ...(spawnError ? { error: spawnError } : {}),
      })
    })
  })
}

export function validateMechanicalDoctorRun(run: MechanicalDoctorRun): ValidatedMechanicalDoctorRun {
  const transportProblems = [
    run.error ? `spawn failed: ${run.error}` : null,
    run.timedOut ? "timed out" : null,
    run.aborted ? "was aborted" : null,
    run.overflowed ? "exceeded the output limit" : null,
    run.signal ? `ended with signal ${run.signal}` : null,
  ].filter(Boolean)
  if (transportProblems.length > 0) {
    throw new Error(`Mechanical Doctor verify ${transportProblems.join(", ")}.`)
  }

  const statuses = [...run.output.matchAll(/(?:^|\n)TASK DOCTOR:\s+(FAIL|PASS|EXECUTOR RECOVERY REQUIRED)\s*(?=\n|$)/g)]
  const marker = statuses.at(-1)?.[1]
  if (!marker) throw new Error("Mechanical Doctor verify returned no terminal TASK DOCTOR status.")
  const status: MechanicalDoctorStatus = marker === "PASS"
    ? "pass"
    : marker === "FAIL" ? "fail" : "executor_recovery_required"
  const exitMatches = status === "pass" ? run.exitCode === 0 : run.exitCode !== null && run.exitCode !== 0
  if (!exitMatches) {
    throw new Error(`Mechanical Doctor verify returned contradictory status ${marker} with exit code ${run.exitCode ?? "null"}.`)
  }
  return { ...run, status }
}

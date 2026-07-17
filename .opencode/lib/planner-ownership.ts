import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

export type PlannerOwnershipSource = "task_write" | "registration" | "active_revision"

export type PlannerOwnership = {
  version: 1
  taskPath: string
  taskHash: string
  plannerSessionID: string
  plannerAgent: string
  source: PlannerOwnershipSource
  claimedAt: string
}

function normalizedTaskPath(taskPath: string) {
  const normalized = taskPath.replace(/^\.\//, "").replaceAll("\\", "/")
  return /^kanban\/todo\/[^/]+\.md$/.test(normalized) ? normalized : null
}

function digest(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex")
}

export function plannerOwnershipPath(root: string, taskPath: string) {
  const normalized = normalizedTaskPath(taskPath)
  if (!normalized) throw new Error(`Planner ownership requires an exact kanban/todo task path: ${taskPath}`)
  return resolve(root, ".task-doctor/planner-owners", `${normalized.split("/").pop()}.json`)
}

export function readPlannerOwnership(root: string, taskPath: string): PlannerOwnership | null {
  try {
    const value = JSON.parse(readFileSync(plannerOwnershipPath(root, taskPath), "utf8"))
    if (value?.version !== 1
      || value.taskPath !== normalizedTaskPath(taskPath)
      || typeof value.taskHash !== "string"
      || typeof value.plannerSessionID !== "string"
      || typeof value.plannerAgent !== "string"
      || typeof value.source !== "string"
      || typeof value.claimedAt !== "string") return null
    return value as PlannerOwnership
  } catch {
    return null
  }
}

export function claimPlannerOwnership(root: string, input: {
  taskPath: string
  plannerSessionID: string
  plannerAgent: string
  source: PlannerOwnershipSource
}) {
  const taskPath = normalizedTaskPath(input.taskPath)
  if (!taskPath) throw new Error(`Planner ownership requires an exact kanban/todo task path: ${input.taskPath}`)
  if (!input.plannerSessionID.trim()) throw new Error("Planner ownership requires the current Planner session ID.")
  if (!input.plannerAgent.trim()) throw new Error("Planner ownership requires the current Planner agent name.")
  const absoluteTaskPath = resolve(root, taskPath)
  if (!existsSync(absoluteTaskPath)) throw new Error(`Planner ownership task does not exist: ${taskPath}`)

  const ownership: PlannerOwnership = {
    version: 1,
    taskPath,
    taskHash: digest(readFileSync(absoluteTaskPath)),
    plannerSessionID: input.plannerSessionID,
    plannerAgent: input.plannerAgent.toLowerCase(),
    source: input.source,
    claimedAt: new Date().toISOString(),
  }
  const path = plannerOwnershipPath(root, taskPath)
  const temporaryPath = `${path}.${process.pid}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(temporaryPath, `${JSON.stringify(ownership, null, 2)}\n`)
  renameSync(temporaryPath, path)
  return ownership
}

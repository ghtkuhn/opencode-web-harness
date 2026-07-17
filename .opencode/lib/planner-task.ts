export type PlannerTaskDraft = {
  title: string
  outcome: string
  scope: string[]
  context?: string[]
  requirements: string[]
  parallel: boolean
  dependsOn: string[]
  resources: string[]
  memoryAction: "none" | "append" | "update" | "remove"
  memoryReason: string
  verify: string[]
}

export type PlannerTaskRevision = {
  title?: string
  outcome?: string
  addScope?: string[]
  addRequirements?: string[]
  exactScope?: string[]
  exactRequirements?: string[]
  verify?: string[]
}

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function comparable(value: string) {
  return oneLine(value)
    .replace(/\\(["'])/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/<([A-Za-z][\w.]*)>/g, "$1")
    .toLowerCase()
}

// Verification commands are shell input. Collapse only token-separating
// whitespace; quoted bytes, command names, arguments, and case stay exact.
export function normalizePlannerVerifyCommandSyntax(value: string) {
  let result = ""
  let quote: "'" | '"' | null = null
  let escaped = false
  let pendingSpace = false
  for (const character of value.trim()) {
    if (escaped) {
      result += character
      escaped = false
      continue
    }
    if (character === "\\") {
      result += character
      escaped = true
      continue
    }
    if (quote) {
      result += character
      if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"') {
      if (pendingSpace && result) result += " "
      pendingSpace = false
      quote = character
      result += character
      continue
    }
    if (/\s/.test(character)) {
      pendingSpace = true
      continue
    }
    if (pendingSpace && result) result += " "
    pendingSpace = false
    result += character
  }
  return result
}

function comparableVerifyCommand(value: string) {
  return normalizePlannerVerifyCommandSyntax(value)
}

export function plannerTaskCoverageGaps(supersededContent: string, coveringContent: string) {
  const superseded = parsePlannerTask(supersededContent)
  const covering = parsePlannerTask(coveringContent)
  if (!superseded || !covering) return ["Both tasks must use the canonical Planner task format."]

  const gaps: string[] = []
  const missing = (label: string, expected: string[], actual: string[], normalize = comparable) => {
    const actualValues = new Set(actual.map(normalize))
    for (const value of expected) {
      if (!actualValues.has(normalize(value))) gaps.push(`${label} is not covered: ${oneLine(value)}`)
    }
  }
  missing("Scope", superseded.scope, covering.scope)
  missing("Context", superseded.context ?? [], covering.context ?? [])
  missing("Requirement", superseded.requirements, covering.requirements)
  missing("Verify command", superseded.verify, covering.verify, comparableVerifyCommand)
  if (superseded.memoryAction !== "none") gaps.push("Superseded task Memory action must be none.")
  return gaps
}

function section(content: string, names: string[]) {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  return content.match(new RegExp(`(?:^|\\n)##\\s+(?:${escaped})\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i"))?.[1]?.trim() ?? ""
}

function bulletValues(block: string) {
  return block.split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1] ?? "")
    .filter(Boolean)
}

function stripOuterTicks(value: string) {
  return value.replace(/^`([^`]*)`$/, "$1")
}

function unique(values: string[]) {
  const seen = new Set<string>()
  return values.map(oneLine).filter((value) => {
    if (!value) return false
    const key = comparable(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniqueVerify(values: string[]) {
  const seen = new Set<string>()
  return values.map(normalizePlannerVerifyCommandSyntax).filter((value) => {
    if (!value) return false
    const key = comparableVerifyCommand(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniquePaths(values: string[]) {
  const seen = new Set<string>()
  return values.map((value) => value.trim()).filter((value) => {
    if (!value || seen.has(value)) return false
    seen.add(value)
    return true
  })
}

export function parsePlannerTask(content: string): PlannerTaskDraft | null {
  const title = content.match(/^---\s*$[\s\S]*?^title:\s*(.+?)\s*$[\s\S]*?^---\s*$/m)?.[1]
    ?? content.match(/^#\s+(.+?)\s*$/m)?.[1]
  const outcome = section(content, ["Outcome"])
  const scope = bulletValues(section(content, ["Scope", "Allowed scope"])).map(stripOuterTicks)
  const context = bulletValues(section(content, ["Context"])).map(stripOuterTicks)
  const requirements = bulletValues(section(content, ["Requirements"])).map(stripOuterTicks)
  const scheduling = section(content, ["Scheduling"])
  const parallel = scheduling.match(/^Parallel:\s+`?(allowed|denied)`?\s*$/m)?.[1]
  const dependencies = scheduling.match(/^Depends on:\s+(.+)$/m)?.[1]?.trim()
  const resources = scheduling.match(/^Resources:\s+(.+)$/m)?.[1]?.trim()
  const memory = section(content, ["Memory"])
  const memoryAction = memory.match(/^Action:\s+`?(none|append|update|remove)`?\s*$/m)?.[1] as PlannerTaskDraft["memoryAction"] | undefined
  const memoryReason = memory.match(/^Reason:\s+(.+)$/m)?.[1]?.trim()
  const verify = bulletValues(section(content, ["Verify"])).map(stripOuterTicks)
  if (!title || !outcome || scope.length === 0 || requirements.length === 0 || !parallel || !dependencies || !resources || !memoryAction || !memoryReason) return null
  return {
    title: oneLine(title),
    outcome: oneLine(outcome),
    scope: uniquePaths(scope),
    context: uniquePaths(context),
    requirements: unique(requirements),
    parallel: parallel === "allowed",
    dependsOn: dependencies.toLowerCase() === "none" ? [] : unique(dependencies.split(",")),
    resources: resources.toLowerCase() === "none" ? [] : unique(resources.split(",")),
    memoryAction,
    memoryReason: oneLine(memoryReason),
    verify: uniqueVerify(verify),
  }
}

export function mergePlannerTaskRevision(content: string, revision: PlannerTaskRevision) {
  const draft = parsePlannerTask(content)
  if (!draft) throw new Error("The active task is not in the canonical Planner task format.")
  return renderPlannerTask({
    ...draft,
    title: revision.title ? oneLine(revision.title) : draft.title,
    outcome: revision.outcome ? oneLine(revision.outcome) : draft.outcome,
    scope: revision.exactScope
      ? uniquePaths(revision.exactScope)
      : uniquePaths([...draft.scope, ...(revision.addScope ?? [])]),
    requirements: revision.exactRequirements
      ? unique(revision.exactRequirements)
      : unique([...draft.requirements, ...(revision.addRequirements ?? [])]),
    verify: revision.verify !== undefined ? uniqueVerify(revision.verify) : draft.verify,
  })
}

function bullets(values: string[]) {
  return values.map((value) => `- ${oneLine(value)}`)
}

export function renderPlannerTask(draft: PlannerTaskDraft) {
  const contextValues = uniquePaths(draft.context ?? [])
  const context = contextValues.length > 0
    ? [
        "",
        "## Context",
        "",
        ...contextValues.map((value) => `- ${value}`),
      ]
    : []

  return [
    "---",
    `title: ${oneLine(draft.title)}`,
    "---",
    "",
    "## Outcome",
    "",
    oneLine(draft.outcome),
    "",
    "## Scope",
    "",
    ...uniquePaths(draft.scope).map((value) => `- ${value}`),
    ...context,
    "",
    "## Requirements",
    "",
    ...bullets(draft.requirements),
    "",
    "## Scheduling",
    "",
    `Parallel: ${draft.parallel ? "allowed" : "denied"}`,
    `Depends on: ${draft.dependsOn.length > 0 ? draft.dependsOn.map(oneLine).join(", ") : "none"}`,
    `Resources: ${draft.resources.length > 0 ? draft.resources.map(oneLine).join(", ") : "none"}`,
    "",
    "## Memory",
    "",
    `Action: ${draft.memoryAction}`,
    `Reason: ${oneLine(draft.memoryReason)}`,
    "",
    "## Verify",
    "",
    ...uniqueVerify(draft.verify).map((value) => `- ${value}`),
    "",
  ].join("\n")
}

import { normalizePlannerVerifyCommandSyntax, parsePlannerTask } from "./planner-task.ts"

export type PlannerRecoveryContract = {
  scope: string[]
  requirements: string[]
  verify: string[]
  supersedeTasks: string[]
}

function oneLineValues(value: unknown) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item).replace(/\s+/g, " ").trim())
    .filter(Boolean))]
}

export function canonicalPlannerRecoveryContract(contract: PlannerRecoveryContract): PlannerRecoveryContract {
  return {
    scope: oneLineValues(contract?.scope),
    requirements: oneLineValues(contract?.requirements),
    verify: [...new Set((Array.isArray(contract?.verify) ? contract.verify : [])
      .map((item) => normalizePlannerVerifyCommandSyntax(String(item)))
      .filter(Boolean))],
    supersedeTasks: oneLineValues(contract?.supersedeTasks),
  }
}

function comparable(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase()
}

function comparableVerifyCommand(value: string) {
  return normalizePlannerVerifyCommandSyntax(value)
}

function scopePath(value: string) {
  return comparable(value).replace(/^new:\s*/, "").replace(/^`|`$/g, "")
}

function exactScope(value: string) {
  return `${/^\s*NEW:\s*/i.test(value) ? "new:" : "existing:"}${scopePath(value)}`
}

export function plannerRecoveryContractGaps(content: string, contract: PlannerRecoveryContract) {
  const task = parsePlannerTask(content)
  if (!task) return ["The revised task is not in canonical Planner format."]

  const gaps: string[] = []
  const missing = (label: string, expected: string[], actual: string[], normalize = comparable) => {
    const values = new Set(actual.map(normalize))
    for (const value of expected) {
      if (!values.has(normalize(value))) gaps.push(`${label} is missing: ${value.replace(/\s+/g, " ").trim()}`)
    }
  }

  missing("Scope", contract.scope, task.scope, scopePath)
  for (const expected of contract.scope.filter((value) => /^\s*NEW:\s*/i.test(value))) {
    const actual = task.scope.find((value) => scopePath(value) === scopePath(expected))
    if (actual && !/^\s*NEW:\s*/i.test(actual)) gaps.push(`Scope must mark this path NEW: ${scopePath(expected)}`)
  }
  missing("Requirement", contract.requirements, task.requirements)
  missing("Verify command", contract.verify, task.verify, comparableVerifyCommand)
  return gaps
}

export function plannerRecoveryContractExactGaps(content: string, contract: PlannerRecoveryContract) {
  const task = parsePlannerTask(content)
  if (!task) return ["The revised task is not in canonical Planner format."]

  const gaps: string[] = []
  const compare = (label: string, expected: string[], actual: string[], normalize = comparable) => {
    const gapCount = gaps.length
    const expectedValues = expected.map(normalize)
    const actualValues = actual.map(normalize)
    const expectedSet = new Set(expectedValues)
    const actualSet = new Set(actualValues)
    for (const value of expected.filter((_, index) => !actualSet.has(expectedValues[index]))) {
      gaps.push(`${label} is missing: ${value.replace(/\s+/g, " ").trim()}`)
    }
    for (const value of actual.filter((_, index) => !expectedSet.has(actualValues[index]))) {
      gaps.push(`${label} has an extra entry: ${value.replace(/\s+/g, " ").trim()}`)
    }
    if (expectedValues.length !== actualValues.length && gaps.length === gapCount) {
      gaps.push(`${label} entry count differs from the complete recovery contract.`)
    }
  }

  compare("Scope", contract.scope, task.scope, exactScope)
  compare("Requirement", contract.requirements, task.requirements)
  compare("Verify command", contract.verify, task.verify, comparableVerifyCommand)
  return gaps
}

import type { ShadowDifference } from "./types.ts"

export function shadowDifferences(expected: unknown, actual: unknown): ShadowDifference[] {
  const differences: ShadowDifference[] = []
  compare(expected, actual, "$", differences)
  return differences
}

function compare(expected: unknown, actual: unknown, path: string, differences: ShadowDifference[]): void {
  if (Object.is(expected, actual)) return
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length)
    for (let index = 0; index < length; index += 1) compare(expected[index], actual[index], `${path}[${index}]`, differences)
    return
  }
  if (plainObject(expected) && plainObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
    for (const key of keys) compare(expected[key], actual[key], `${path}.${key}`, differences)
    return
  }
  differences.push({ path, expected, actual })
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

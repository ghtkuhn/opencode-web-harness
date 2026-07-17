export type WorkerModelFamily = {
  family: string
  matches: string[]
  rulesFile: string
  requireRead: boolean
}

const workerRuleFile = /^WORKER-[A-Z0-9][A-Z0-9._-]*\.md$/i

function normalized(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

export function workerModelFamiliesFromConfig(value: unknown): WorkerModelFamily[] {
  if (value === undefined || value === null) return []
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settings.opencode.workerModelFamilies must be an object.")
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([family, raw]) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`Worker model family ${family} must be an object.`)
    }
    const configured = raw as Record<string, unknown>
    if (configured.enabled === false) return []
    const matches = configured.matches ?? [family]
    if (!Array.isArray(matches) || matches.length === 0 || !matches.every((item) => typeof item === "string" && item.trim().length > 0)) {
      throw new Error(`Worker model family ${family} must define at least one non-empty match.`)
    }
    const rulesFile = configured.rulesFile ?? `WORKER-${family.toUpperCase()}.md`
    if (typeof rulesFile !== "string" || !workerRuleFile.test(rulesFile)) {
      throw new Error(`Worker model family ${family} must use a root WORKER-<FAMILY>.md rules file.`)
    }
    return [{
      family,
      matches: matches.map((item) => item.trim()),
      rulesFile,
      requireRead: configured.requireRead === true,
    }]
  })
}

export function matchingWorkerModelFamily(identity: string | undefined, families: WorkerModelFamily[]) {
  if (!identity) return null
  const normalizedIdentity = normalized(identity)
  const candidates = families.flatMap((family) => {
    const score = Math.max(0, ...family.matches.map((match) => {
      const normalizedMatch = normalized(match)
      return normalizedMatch && normalizedIdentity.includes(normalizedMatch) ? normalizedMatch.length : 0
    }))
    return score > 0 ? [{ family, score }] : []
  })
  candidates.sort((left, right) => right.score - left.score || left.family.family.localeCompare(right.family.family))
  return candidates[0]?.family ?? null
}

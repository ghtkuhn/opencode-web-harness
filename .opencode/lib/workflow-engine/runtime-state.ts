export class WorkflowRuntimeState {
  readonly #maps = new Map<string, Map<string, unknown>>()
  readonly #sets = new Map<string, Set<unknown>>()

  map<T>(name: string): Map<string, T> {
    if (this.#sets.has(name)) throw new Error(`Runtime state ${name} is already a set`)
    let value = this.#maps.get(name)
    if (!value) {
      value = new Map<string, unknown>()
      this.#maps.set(name, value)
    }
    return value as Map<string, T>
  }

  set(name: string): Set<string> {
    if (this.#maps.has(name)) throw new Error(`Runtime state ${name} is already a map`)
    let value = this.#sets.get(name)
    if (!value) {
      value = new Set<unknown>()
      this.#sets.set(name, value)
    }
    return value as Set<string>
  }

  deleteSession(sessionID: string): void {
    for (const value of this.#maps.values()) value.delete(sessionID)
    for (const value of this.#sets.values()) value.delete(sessionID)
  }

  snapshot(sessionID: string): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {}
    for (const [name, value] of this.#maps) {
      if (value.has(sessionID)) snapshot[name] = serializable(value.get(sessionID))
    }
    for (const [name, value] of this.#sets) {
      if (value.has(sessionID)) snapshot[name] = true
    }
    return snapshot
  }
}

function serializable(value: unknown): unknown {
  if (value instanceof Promise) return "[Promise]"
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [String(key), serializable(item)]))
  if (value instanceof Set) return [...value].map(serializable)
  if (Array.isArray(value)) return value.map(serializable)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializable(item)]))
  }
  return value
}

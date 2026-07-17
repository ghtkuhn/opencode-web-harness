export type FailureFingerprint = {
  signature: string
  tool: string
  target: string
}

export type FailureRecord<T extends FailureFingerprint> = {
  count: number
  lastAt: number
  fingerprint: T
}

export type FailureWindowResult<T extends FailureFingerprint> = {
  history: Map<string, FailureRecord<T>>
  count: number
  terminal: boolean
  reason: "repeated" | "slow" | null
}

export function recordFailure<T extends FailureFingerprint>(input: {
  history?: ReadonlyMap<string, FailureRecord<T>> | null
  fingerprint: T
  now: number
  windowMs: number
  threshold: number
  slow?: boolean
}): FailureWindowResult<T> {
  const history = new Map(input.history ?? [])
  const previous = history.get(input.fingerprint.signature)
  const count = previous && input.now - previous.lastAt <= input.windowMs
    ? previous.count + 1
    : 1
  history.set(input.fingerprint.signature, { count, lastAt: input.now, fingerprint: input.fingerprint })
  const reason = input.slow ? "slow" : count >= input.threshold ? "repeated" : null
  return { history, count, terminal: reason !== null, reason }
}

export function clearFailures<T extends FailureFingerprint>(
  history: ReadonlyMap<string, FailureRecord<T>> | null | undefined,
  matches: (fingerprint: T) => boolean,
): Map<string, FailureRecord<T>> {
  const next = new Map(history ?? [])
  for (const [signature, failure] of next) {
    if (matches(failure.fingerprint)) next.delete(signature)
  }
  return next
}

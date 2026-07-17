export const WORKER_RECOVERY_BOOST_AGENT = "worker-recovery-boost"

export type AgentModelReference = { providerID: string; modelID: string }

export type WorkerRecoveryBoostResolution = {
  enabled: boolean
  model: AgentModelReference | undefined
  invalid: boolean
  reason: string
  selector: string | null
}

const configuredBoostAgentRoots = new Map<string, boolean>()

export function setWorkerRecoveryBoostAgentAvailable(root: string, available: boolean) {
  configuredBoostAgentRoots.set(root, available)
}

export function workerRecoveryBoostAgentAvailable(root: string) {
  return configuredBoostAgentRoots.get(root) === true
}

export function agentModelRef(value: unknown): AgentModelReference | undefined {
  if (typeof value === "string") {
    const normalized = value.trim()
    const separator = normalized.indexOf("/")
    if (separator <= 0 || separator >= normalized.length - 1) return undefined
    const providerID = normalized.slice(0, separator).trim()
    const modelID = normalized.slice(separator + 1).trim()
    return providerID && modelID ? { providerID, modelID } : undefined
  }
  if (!value || typeof value !== "object") return undefined
  const model = value as Record<string, unknown>
  const providerID = typeof model.providerID === "string" ? model.providerID.trim() : ""
  const modelID = typeof model.modelID === "string"
    ? model.modelID.trim()
    : typeof model.id === "string" ? model.id.trim() : ""
  return providerID && modelID ? { providerID, modelID } : undefined
}

function configuredAgentModel(settings: Record<string, unknown>, agent: string) {
  const configured = settings.agentModels
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) return undefined
  const value = Object.entries(configured).find(([name]) => name.toLowerCase() === agent)?.[1]
  return agentModelRef(value)
}

export function resolveWorkerRecoveryBoost(settings: unknown): WorkerRecoveryBoostResolution {
  const openCode = settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings as Record<string, unknown>
    : {}
  const configured = openCode.workerRecoveryBoost
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    return { enabled: false, model: undefined, invalid: false, reason: "worker-recovery-boost-absent", selector: null }
  }
  const boost = configured as Record<string, unknown>
  if (boost.enabled !== true) {
    return { enabled: false, model: undefined, invalid: false, reason: "worker-recovery-boost-disabled", selector: null }
  }

  const rawSelector = boost.model === undefined ? "executor" : boost.model
  let model: AgentModelReference | undefined
  let selector: string
  if (typeof rawSelector === "string") {
    const normalized = rawSelector.trim()
    const alias = normalized.toLowerCase()
    selector = normalized || "<empty>"
    model = alias === "executor" || alias === "planner"
      ? configuredAgentModel(openCode, alias)
      : agentModelRef(normalized)
  } else {
    selector = "object-ref"
    model = agentModelRef(rawSelector)
  }

  return model
    ? { enabled: true, model, invalid: false, reason: "worker-recovery-boost-resolved", selector }
    : { enabled: true, model: undefined, invalid: true, reason: "worker-recovery-boost-unresolved", selector }
}

export function modelRefString(model: AgentModelReference) {
  return `${model.providerID}/${model.modelID}`
}

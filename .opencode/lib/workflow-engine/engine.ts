import { decideAuthoritativeWorkflow } from "./authoritative-state.ts"
import { decideLifecyclePolicy, type LifecyclePolicyInput } from "./lifecycle-policy.ts"
import { decideOperationPolicy, type OperationPolicyInput } from "./operation-policy.ts"
import { decideRoleToolPolicy, type RolePolicyInput } from "./role-policy.ts"
import { decideSessionAction, type SessionActionInput } from "./session-action.ts"
import type { AuthoritativeWorkflowSnapshot } from "./types.ts"

export type WorkflowEvent =
  | { type: "authoritative.snapshot"; snapshot: AuthoritativeWorkflowSnapshot }
  | { type: "role.tool"; input: RolePolicyInput }
  | { type: "lifecycle.tool"; input: LifecyclePolicyInput }
  | { type: "operation.tool"; input: OperationPolicyInput }
  | { type: "session.action"; input: SessionActionInput }
  | { type: "session.deleted"; sessionID: string }

export type WorkflowEffect = {
  type: "runtime.clear_session"
  sessionID: string
}

export type WorkflowTransition = {
  event: WorkflowEvent["type"]
  value: unknown
  effects: WorkflowEffect[]
}

export type WorkflowEffectPorts = {
  clearSession(sessionID: string): void | Promise<void>
}

export function reduceWorkflow(event: WorkflowEvent): WorkflowTransition {
  if (event.type === "authoritative.snapshot") {
    return { event: event.type, value: decideAuthoritativeWorkflow(event.snapshot), effects: [] }
  }
  if (event.type === "role.tool") {
    return { event: event.type, value: decideRoleToolPolicy(event.input), effects: [] }
  }
  if (event.type === "lifecycle.tool") {
    return { event: event.type, value: decideLifecyclePolicy(event.input), effects: [] }
  }
  if (event.type === "operation.tool") {
    return { event: event.type, value: decideOperationPolicy(event.input), effects: [] }
  }
  if (event.type === "session.action") {
    return { event: event.type, value: decideSessionAction(event.input), effects: [] }
  }
  return {
    event: event.type,
    value: null,
    effects: [{ type: "runtime.clear_session", sessionID: event.sessionID }],
  }
}

export async function executeWorkflowEffects(effects: WorkflowEffect[], ports: WorkflowEffectPorts): Promise<void> {
  for (const effect of effects) {
    if (effect.type === "runtime.clear_session") await ports.clearSession(effect.sessionID)
  }
}

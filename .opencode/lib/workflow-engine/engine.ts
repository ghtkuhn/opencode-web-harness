import { decideAuthoritativeWorkflow } from "./authoritative-state.ts"
import { decideLifecyclePolicy, type LifecyclePolicyInput } from "./lifecycle-policy.ts"
import { decideOperationPolicy, type OperationPolicyInput } from "./operation-policy.ts"
import { decideRoleToolPolicy, type RolePolicyInput } from "./role-policy.ts"
import { decideSessionAction, type SessionActionInput } from "./session-action.ts"
import { reconcileDelegationLease, type SessionObservation } from "./delegation-lease.ts"
import type { DelegationLease } from "../worker-help.ts"
import type { AuthoritativeWorkflowSnapshot } from "./types.ts"

export type WorkflowEvent =
  | { type: "authoritative.snapshot"; snapshot: AuthoritativeWorkflowSnapshot }
  | { type: "role.tool"; input: RolePolicyInput }
  | { type: "lifecycle.tool"; input: LifecyclePolicyInput }
  | { type: "operation.tool"; input: OperationPolicyInput }
  | { type: "session.action"; input: SessionActionInput }
  | { type: "delegation.reconcile"; lease: DelegationLease | null; observation: SessionObservation | null; parentSessionID?: string }
  | { type: "session.deleted"; sessionID: string }

export type WorkflowEffect =
  | { type: "runtime.clear_session"; sessionID: string }
  | { type: "delegation.release"; lease: DelegationLease }
  | { type: "delegation.mark_terminal"; lease: DelegationLease; workerSessionID: string; handoff: string }
  | { type: "delegation.deliver_handoff"; lease: DelegationLease; workerSessionID: string; handoff: string; parentSessionID?: string }

export type WorkflowTransition = {
  event: WorkflowEvent["type"]
  value: unknown
  effects: WorkflowEffect[]
}

export type WorkflowEffectPorts = {
  clearSession(sessionID: string): void | Promise<void>
  releaseDelegation?(lease: DelegationLease): void | Promise<void>
  markDelegationTerminal?(lease: DelegationLease, workerSessionID: string, handoff: string): void | Promise<void>
  deliverDelegationHandoff?(effect: Extract<WorkflowEffect, { type: "delegation.deliver_handoff" }>): void | Promise<void>
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
  if (event.type === "delegation.reconcile") {
    const resolution = reconcileDelegationLease(event.lease, event.observation)
    const effects: WorkflowEffect[] = resolution.kind === "fresh"
      ? [{ type: "delegation.release", lease: resolution.lease }]
      : resolution.kind === "deliver"
        ? [
            { type: "delegation.mark_terminal", lease: resolution.lease, workerSessionID: resolution.workerSessionID, handoff: resolution.handoff },
            {
              type: "delegation.deliver_handoff",
              lease: resolution.lease,
              workerSessionID: resolution.workerSessionID,
              handoff: resolution.handoff,
              parentSessionID: event.parentSessionID,
            },
          ]
        : []
    return { event: event.type, value: resolution, effects }
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
    if (effect.type === "delegation.release") await ports.releaseDelegation?.(effect.lease)
    if (effect.type === "delegation.mark_terminal") await ports.markDelegationTerminal?.(effect.lease, effect.workerSessionID, effect.handoff)
    if (effect.type === "delegation.deliver_handoff") await ports.deliverDelegationHandoff?.(effect)
  }
}

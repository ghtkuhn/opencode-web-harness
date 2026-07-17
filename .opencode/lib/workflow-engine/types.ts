export type WorkflowRole = "planner" | "executor" | "worker" | "unknown"

export type WorkflowActionKind = "tool" | "continue" | "return" | "stop" | "wait"

export type DirectivePriority = "recovery" | "terminal" | "help" | "review" | "active" | "schedule" | "idle"

export type WorkflowAction = {
  code: string
  kind: WorkflowActionKind
  role: WorkflowRole
  text: string
  tool?: string
  taskPath?: string
  helpID?: string
}

export type WorkflowDirective = WorkflowAction & {
  priority: DirectivePriority
  precedence?: number
  terminal: boolean
  requires?: string[]
  forbids?: string[]
  after?: WorkflowAction
}

export type PromptFrame = {
  role: WorkflowRole
  revision?: string | null
  taskPath?: string | null
  helpID?: string | null
  facts: string[]
  evidence?: string | null
  directives: WorkflowDirective[]
}

export type WorkflowFeedback = {
  evidence: string
  directive: WorkflowDirective
}

export type ComposedWorkflowPrompt = {
  primary: WorkflowDirective
  after?: WorkflowAction
  diagnostics: string[]
  text: string
}

export type GuardNotice = {
  code: string
  problem: string
  action: WorkflowAction
  success?: string
  learning?: {
    id: string
    status: "new" | "already" | "transient"
    rule?: string
  }
}

export type DoctorWorkflowSnapshot = {
  status: string
  taskPath: string | null
  destination: string | null
  taskHash?: string | null
}

export type WorkflowRecoverySnapshot = {
  memory?: { size: number; maxSize: number } | null
  harness?: { taskPath: string; paths: string[] } | null
  planner?: {
    status: "unavailable" | "incomplete"
    plannerSessionID?: string | null
    reason?: string
  } | null
}

export type WorkflowHelpSnapshot = {
  id: string
  status: string
  taskPath: string
  problem: string
} | null

export type AuthoritativeWorkflowSnapshot = {
  doctor: DoctorWorkflowSnapshot
  completedTask: string | null
  openTasks: string[]
  help: WorkflowHelpSnapshot
  plannerOwnerSessionID: string | null
  recovery: WorkflowRecoverySnapshot
  lastDoctorFailure?: { gate: string; output: string } | null
}

export type AuthoritativeWorkflowDecision = AuthoritativeWorkflowSnapshot & {
  revision: string
  nextAction: WorkflowAction
}

export type ShadowDifference = {
  path: string
  expected: unknown
  actual: unknown
}

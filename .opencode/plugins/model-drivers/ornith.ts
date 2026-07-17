import { stableGuardViolationId } from '../../lib/guard-learning.ts';

export interface OrnithDriverConfig {
  enabled: boolean;
  structuredState: boolean;
  enforceNextStep: boolean;
  automaticLearning: boolean;
  terminalViolationLimit: number;
}

export interface DriverViolation {
  id: string;
  problem: string;
  action: string;
}

export interface DriverWorkflowState {
  revision: string;
  doctorStatus: string;
  doctorTask: string | null;
  openTasks: string[];
  nextAction: string;
  allowedPaths: string[];
}

interface NextStep {
  tools: string[];
  command?: string;
  action: string;
  rejectedAttempts: number;
}

interface SessionState {
  revision?: string;
  lastViolationId?: string;
  repeatedViolations: number;
  nextStep?: NextStep;
  terminalReason?: string;
  terminalAction?: string;
  terminalRevision?: string;
}

const DEFAULTS: OrnithDriverConfig = {
  enabled: true,
  structuredState: true,
  enforceNextStep: true,
  automaticLearning: true,
  terminalViolationLimit: 2,
};

export function isOrnithModelIdentity(modelIdentity: string | undefined): boolean {
  return /(?:^|[/\s])ornith(?::|\/|$)/i.test(modelIdentity ?? '');
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function clean(value: string, maxLength = 320): string {
  return value
    .replace(/kanban\/todo\/[^\s,]+\.md/g, 'the current task')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function commandFromAction(action: string): string | undefined {
  return action.match(/npm run task:doctor:[a-z-]+ -- kanban\/todo\/[^\s,]+\.md/)?.[0]
    ?? action.match(/npm run task:doctor:(?:schedule|next)/)?.[0]
    ?? action.match(/npm run app:[a-z-]+/)?.[0];
}

function inferNextStep(action: string): NextStep | undefined {
  const command = commandFromAction(action);
  if (command) return { tools: ['bash'], command, action, rejectedAttempts: 0 };
  if (/read WORKER\.md/i.test(action)) return { tools: ['read', 'bash'], action, rejectedAttempts: 0 };
  if (/request_command_permission/i.test(action)) return { tools: ['request_command_permission'], action, rejectedAttempts: 0 };
  if (/request_task_change_permission/i.test(action)) return { tools: ['request_task_change_permission'], action, rejectedAttempts: 0 };
  if (/request_dependency_install_permission/i.test(action)) return { tools: ['request_dependency_install_permission'], action, rejectedAttempts: 0 };
  if (/question tool/i.test(action)) return { tools: ['question'], action, rejectedAttempts: 0 };
  if (/\btask tool\b|delegate one Worker/i.test(action)) return { tools: ['task'], action, rejectedAttempts: 0 };
  if (/use write|write or edit|create the exact scoped file/i.test(action)) {
    return { tools: ['write', 'edit', 'patch', 'apply_patch', 'multiedit'], action, rejectedAttempts: 0 };
  }
  return undefined;
}

function requiresTerminalStop(action: string): boolean {
  return /stop and report|report (?:the )?blocker|TASK_SCOPE_INSUFFICIENT|do not spawn a Worker|otherwise stop/i.test(action);
}

export class OrnithModelDriver {
  readonly id = 'ornith';
  readonly config: OrnithDriverConfig;
  private readonly sessions = new Map<string, SessionState>();

  constructor(_root: string, configured: Partial<OrnithDriverConfig> = {}) {
    this.config = {
      ...DEFAULTS,
      ...Object.fromEntries(
        Object.entries(configured).filter(([key, value]) => key in DEFAULTS && typeof value === typeof DEFAULTS[key as keyof OrnithDriverConfig]),
      ),
      terminalViolationLimit: boundedInteger(configured.terminalViolationLimit, DEFAULTS.terminalViolationLimit, 1, 5),
    };
  }

  matches(modelIdentity: string | undefined): boolean {
    return this.config.enabled && isOrnithModelIdentity(modelIdentity);
  }

  get automaticLearning(): boolean {
    return this.config.automaticLearning;
  }

  isTerminal(sessionID: string, revision: string): boolean {
    const state = this.state(sessionID);
    this.refreshRevision(state, revision);
    return Boolean(state.terminalReason);
  }

  beforeTool(sessionID: string, tool: string, args: unknown, revision: string): string | null {
    const state = this.state(sessionID);
    this.refreshRevision(state, revision);

    if (state.terminalReason) {
      return this.renderError({
        id: 'terminal',
        problem: state.terminalReason,
        action: state.terminalAction ?? 'Stop this turn and report the blocker.',
      }, state, false);
    }

    const next = state.nextStep;
    if (!this.config.enforceNextStep || !next) return null;
    const command = typeof args === 'object' && args !== null ? String((args as { command?: unknown }).command ?? '').trim() : '';
    const matches = next.tools.includes(tool) && (!next.command || command === next.command);
    if (matches) {
      state.nextStep = undefined;
      return null;
    }

    next.rejectedAttempts += 1;
    if (next.rejectedAttempts >= this.config.terminalViolationLimit) {
      state.terminalReason = 'The required corrective step was ignored repeatedly.';
      state.terminalAction = 'Stop this turn and report the last Guard blocker.';
      state.terminalRevision = revision;
    }
    return this.renderError({
      id: 'next-step',
      problem: state.terminalReason ?? 'A different tool was attempted while one corrective step was required.',
      action: state.terminalAction ?? next.action,
    }, state, !state.terminalReason);
  }

  guardViolation(
    sessionID: string,
    violation: DriverViolation,
    success: string | undefined,
    revision: string,
    learning?: { status: 'already' | 'recorded'; rule: string },
  ): string {
    const state = this.state(sessionID);
    this.refreshRevision(state, revision);
    state.repeatedViolations = state.lastViolationId === violation.id ? state.repeatedViolations + 1 : 1;
    state.lastViolationId = violation.id;
    if (requiresTerminalStop(violation.action) || state.repeatedViolations >= this.config.terminalViolationLimit) {
      state.terminalReason = violation.problem;
      state.terminalAction = violation.action;
      state.terminalRevision = revision;
      state.nextStep = undefined;
    } else {
      state.nextStep = inferNextStep(violation.action);
    }

    return this.renderError(violation, state, !state.terminalReason, success, learning);
  }

  doctorFailureViolation(output: string): DriverViolation | null {
    let violation: DriverViolation | null = null;
    if (/CHANGED_OUTSIDE_SCOPE_FILE|PRESTART_CHANGE|MEMORY_UNEXPECTED_CHANGE/.test(output)) {
      violation = {
        id: '',
        problem: 'Doctor detected external baseline changes outside the active task.',
        action: 'Stop this turn and report BASELINE_DRIFT. Do not restore files, inspect workflow internals, or rerun Doctor.',
      };
    } else if (/TASK_SCOPE_INSUFFICIENT|outside (?:the active )?task Scope/i.test(output)) {
      violation = {
        id: '',
        problem: 'The active task Scope is insufficient.',
        action: 'Stop this turn and report TASK_SCOPE_INSUFFICIENT. Do not edit or restore files outside Scope.',
      };
    } else if (/TASK_ORDER:.*not ready/i.test(output)) {
      violation = {
        id: '',
        problem: 'Doctor reports that the delegated task is not ready.',
        action: 'Stop this turn and report TASK_NOT_READY to Executor. Do not schedule or restart the lifecycle as Worker.',
      };
    }
    if (violation) violation.id = stableGuardViolationId(violation.problem, violation.action);
    return violation;
  }

  observeDoctorFailure(
    sessionID: string,
    output: string,
    revision: string,
    learning?: { status: 'already' | 'recorded'; rule: string },
  ): string | null {
    const violation = this.doctorFailureViolation(output);
    if (!violation) return null;

    const state = this.state(sessionID);
    state.terminalReason = violation.problem;
    state.terminalAction = violation.action;
    state.terminalRevision = revision;
    state.nextStep = undefined;
    return this.renderError(violation, state, false, undefined, learning);
  }

  toolSucceeded(sessionID: string): void {
    const state = this.state(sessionID);
    if (!state.nextStep && !state.terminalReason) {
      state.lastViolationId = undefined;
      state.repeatedViolations = 0;
    }
  }

  systemBlock(sessionID: string, role: string, workflow: DriverWorkflowState, feedback?: string): string {
    const state = this.state(sessionID);
    this.refreshRevision(state, workflow.revision);
    const next = state.terminalReason
      ? state.terminalAction ?? 'Stop this turn and report the blocker.'
      : state.nextStep?.action ?? workflow.nextAction;
    return [
      '## MODEL DRIVER: ORNITH',
      'DRIVER_STATE',
      `ROLE: ${role || 'unknown'}`,
      `DOCTOR_STATUS: ${workflow.doctorStatus}`,
      `TASK: ${workflow.doctorTask ?? 'none'}`,
      `OPEN_TASKS: ${workflow.openTasks.join(', ') || 'none'}`,
      `ALLOWED_PATHS: ${workflow.allowedPaths.join(', ') || 'none'}`,
      `TERMINAL: ${state.terminalReason ? 'true' : 'false'}`,
      `NEXT_ACTION: ${clean(next, 500)}`,
      state.nextStep ? `NEXT_TOOLS: ${state.nextStep.tools.join(', ')}` : null,
      state.nextStep?.command ? `NEXT_COMMAND: ${state.nextStep.command}` : null,
      feedback ? `LATEST_FAILURE: ${clean(feedback, 500)}` : null,
      'RULE: Execute only NEXT_ACTION. Do not invent recovery steps.',
      'RULE: When TERMINAL is true, call no tools. Report the blocker and stop.',
      'RULE: Only stable catalog Guard rules are stored automatically. Unknown or task-specific violations remain transient and unpersisted. Do not call record_guard_learning.',
    ].filter(Boolean).join('\n');
  }

  private state(sessionID: string): SessionState {
    const existing = this.sessions.get(sessionID);
    if (existing) return existing;
    const created: SessionState = { repeatedViolations: 0 };
    this.sessions.set(sessionID, created);
    return created;
  }

  private refreshRevision(state: SessionState, revision: string): void {
    if (state.terminalReason && state.terminalRevision && state.terminalRevision !== revision) {
      state.terminalReason = undefined;
      state.terminalAction = undefined;
      state.terminalRevision = undefined;
      state.lastViolationId = undefined;
      state.repeatedViolations = 0;
      state.nextStep = undefined;
    }
    state.revision = revision;
  }

  private renderError(
    violation: DriverViolation,
    state: SessionState,
    retry: boolean,
    success?: string,
    learning?: { status: 'already' | 'recorded'; rule: string },
  ): string {
    return [
      'WORKFLOW GUARD BLOCKED',
      'MODEL_DRIVER: ornith',
      `STATE: ${state.terminalReason ? 'TERMINAL' : 'BLOCKED'}`,
      `Guard violation ID: ${violation.id}`,
      `LEARNING_STATUS: ${learning?.status === 'already' ? 'ALREADY_LEARNED' : learning?.status === 'recorded' ? 'RECORDED_AUTOMATICALLY' : 'TRANSIENT_UNPERSISTED'}`,
      `Problem: ${clean(violation.problem)}`,
      learning ? `Learned rule: ${clean(learning.rule, 500)}` : null,
      learning ? 'Do not record this learning again.' : null,
      `Do next: ${clean(violation.action, 500)}`,
      state.nextStep ? `NEXT_TOOL: ${state.nextStep.tools.join(',')}` : null,
      state.nextStep?.command ? `NEXT_COMMAND: ${state.nextStep.command}` : null,
      `RETRY: ${retry ? 'ONLY_NEXT_ACTION' : 'false'}`,
      success ? `Continue only after: ${clean(success)}` : null,
    ].filter(Boolean).join('\n');
  }

}

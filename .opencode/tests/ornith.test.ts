import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { isOrnithModelIdentity, OrnithModelDriver } from '../plugins/model-drivers/ornith.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function driver() {
  const root = mkdtempSync(join(tmpdir(), 'ornith-driver-'));
  roots.push(root);
  return new OrnithModelDriver(root, { terminalViolationLimit: 2 });
}

test('matches only Ornith model identities', () => {
  const subject = driver();
  assert.equal(isOrnithModelIdentity('hightrail-local/ornith:9b-q8_0'), true);
  assert.equal(subject.matches('hightrail-local/ornith:9b-q8_0'), true);
  assert.equal(subject.matches('hightrail-local/qwen3.6:27b'), false);
});

test('permits only the inferred corrective tool', () => {
  const subject = driver();
  const error = subject.guardViolation('session', {
    id: 'read-rules',
    problem: 'Worker did not read its rules.',
    action: 'Read WORKER.md now, then rerun Doctor start.',
  }, undefined, 'rev-1');
  assert.match(error, /NEXT_TOOL: read,bash/);
  assert.match(error, /LEARNING_STATUS: TRANSIENT_UNPERSISTED/);
  assert.doesNotMatch(error, /Learned rule:/);
  assert.match(subject.beforeTool('session', 'write', {}, 'rev-1') ?? '', /Do next:/);
  assert.equal(subject.beforeTool('session', 'read', { filePath: 'WORKER.md' }, 'rev-1'), null);
});

test('enters terminal state after repeated corrective-step rejection', () => {
  const subject = driver();
  subject.guardViolation('session', {
    id: 'read-rules',
    problem: 'Worker did not read its rules.',
    action: 'Read WORKER.md now.',
  }, undefined, 'rev-1');
  subject.beforeTool('session', 'write', {}, 'rev-1');
  const error = subject.beforeTool('session', 'edit', {}, 'rev-1') ?? '';
  assert.match(error, /STATE: TERMINAL/);
  assert.match(subject.beforeTool('session', 'read', {}, 'rev-1') ?? '', /RETRY: false/);
});

test('shows an existing file-backed learning without asking to record it', () => {
  const subject = driver();
  const error = subject.guardViolation('session', {
    id: '726d21',
    problem: 'A Doctor command was combined.',
    action: 'Run the Doctor command alone.',
  }, undefined, 'rev-1', { status: 'already', rule: 'Run each Doctor command alone.' });
  assert.match(error, /LEARNING_STATUS: ALREADY_LEARNED/);
  assert.match(error, /Learned rule: Run each Doctor command alone\./);
  assert.match(error, /Do not record this learning again\./);
});

test('states that only stable catalog rules persist automatically', () => {
  const subject = driver();
  const block = subject.systemBlock('session', 'worker', {
    revision: 'rev-1',
    doctorStatus: 'started',
    doctorTask: 'kanban/todo/01-task.md',
    openTasks: [],
    nextAction: 'Continue the current technical operation.',
    allowedPaths: ['src/a.ts'],
  });
  assert.match(block, /Only stable catalog Guard rules are stored automatically\./);
  assert.match(block, /Unknown or task-specific violations remain transient and unpersisted\./);
});

test('treats baseline drift as terminal until workflow revision changes', () => {
  const subject = driver();
  const error = subject.observeDoctorFailure('session', 'TASK DOCTOR: FAIL\n- PRESTART_CHANGE: package.json', 'rev-1') ?? '';
  assert.match(error, /BASELINE_DRIFT/);
  assert.equal(subject.isTerminal('session', 'rev-1'), true);
  assert.match(subject.beforeTool('session', 'bash', { command: 'npm run task:doctor:start' }, 'rev-1') ?? '', /STATE: TERMINAL/);
  assert.equal(subject.isTerminal('session', 'rev-2'), false);
  assert.equal(subject.beforeTool('session', 'bash', { command: 'npm run task:doctor:start' }, 'rev-2'), null);
});

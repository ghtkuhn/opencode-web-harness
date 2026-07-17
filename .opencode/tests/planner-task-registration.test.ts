import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { claimPlannerOwnership } from "../lib/planner-ownership.ts"
import { plannerRecoveryContractExactGaps, plannerRecoveryContractGaps } from "../lib/planner-recovery-contract.ts"
import { mergePlannerTaskRevision, parsePlannerTask, plannerTaskCoverageGaps, renderPlannerTask } from "../lib/planner-task.ts"
import { applyWorkerChanges, previewWorkerChanges } from "../lib/worker-changes.ts"
import { WorkflowGuard } from "../plugins/workflow-guard.ts"

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "planner-task-registration-"))
  const taskPath = "kanban/todo/01-task.md"
  write(join(root, "project.json"), JSON.stringify({
    settings: {
      opencode: {
        workflowGuard: {
          planningEnforcer: true,
          plannerCompletionGuard: false,
          plannerQuestionEnforcer: false,
          guardLearning: false,
          contextCheckpoint: false,
          executorReview: false,
          idleReview: false,
          todoDiscipline: false,
        },
      },
    },
  }))
  write(join(root, "kanban/TASK.md"), "# Canonical template\n")
  write(join(root, taskPath), "# Invalid legacy draft\n")
  write(join(root, "src/a.ts"), "export const value = 1\n")
  write(join(root, "code/frontend/package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", "test:e2e": "playwright test" } }))
  write(join(root, "code/frontend/src/modules/auth/pages/LoginPage.tsx"), "export function LoginPage() { return null }\n")
  write(join(root, "code/frontend/tests/auth.spec.ts"), "// B1 auth behavior\n")
  write(join(root, "tests/a.spec.ts"), "// B1 behavior\n")
  write(join(root, "scripts/task-doctor.mjs"), [
    'import { createHash } from "node:crypto"',
    'import { mkdirSync, readFileSync, writeFileSync } from "node:fs"',
    'import { dirname } from "node:path"',
    'const [, , command, taskPath] = process.argv',
    'const content = readFileSync(taskPath, "utf8")',
    'const required = ["---\\n", "## Outcome", "## Scope", "## Requirements", "## Scheduling", "## Memory", "## Verify"]',
    'if (!required.every((value) => content.includes(value))) { console.error("TASK DOCTOR: FAIL\\n- TASK_FORMAT: canonical sections missing"); process.exit(1) }',
    'if (command === "lint") { console.log(`TASK DOCTOR: LINT PASS ${taskPath}`); process.exit(0) }',
    'if (command !== "register") process.exit(1)',
    'const path = `.task-doctor/registrations/${taskPath.split("/").pop()}.json`',
    'mkdirSync(dirname(path), { recursive: true })',
    'writeFileSync(path, JSON.stringify({ status: "registered", taskHash: createHash("sha256").update(content).digest("hex") }))',
    'console.log(`TASK DOCTOR: REGISTERED ${taskPath}`)',
    "",
  ].join("\n"))
  claimPlannerOwnership(root, {
    taskPath,
    plannerSessionID: "planner",
    plannerAgent: "planner",
    source: "task_write",
  })
  return { root, taskPath }
}

function taskArgs(taskPath: string) {
  return {
    task_path: taskPath,
    title: "Repair the application root imports",
    outcome: "The frontend typecheck no longer reports duplicate root imports.",
    scope: ["src/a.ts", "tests/a.spec.ts"],
    requirements: ["Preserve the existing exported value while removing the duplicate definition."],
    behavior: ["Success case: the frontend typecheck completes without duplicate identifiers."],
    verify: ["npm test -- a.spec.ts", "git diff --check"],
  }
}

function supersedeFixture(options: { missingRequirement?: boolean; foreignOwner?: boolean; dependentTask?: boolean } = {}) {
  const data = fixture()
  const targetPath = "kanban/todo/02-redundant.md"
  const sharedRequirement = "Auth pages use semantic router links."
  const target = renderPlannerTask({
    title: "Repair auth navigation",
    outcome: "Auth pages are type-safe and use semantic router links.",
    scope: ["src/a.ts", "tests/a.spec.ts"],
    requirements: [sharedRequirement],
    contract: "not-applicable",
    parallel: false,
    dependsOn: ["01-task.md"],
    resources: ["frontend"],
    behavior: ["Auth navigation reaches its route: client"],
    memoryAction: "none",
    memoryReason: "No durable project knowledge changes.",
    verify: ["npm test -- a.spec.ts"],
  })
  const active = renderPlannerTask({
    title: "Repair entry and auth navigation",
    outcome: "The entry point compiles and auth pages are type-safe and use semantic router links.",
    scope: ["src/a.ts", "tests/a.spec.ts", "src/b.ts"],
    requirements: options.missingRequirement ? ["The entry point compiles."] : [sharedRequirement, "The entry point compiles."],
    contract: "not-applicable",
    parallel: false,
    dependsOn: [],
    resources: ["frontend"],
    behavior: ["Auth navigation reaches its route: client"],
    memoryAction: "none",
    memoryReason: "No durable project knowledge changes.",
    verify: ["npm test -- a.spec.ts", "git diff --check"],
  })
  write(join(data.root, data.taskPath), active)
  write(join(data.root, targetPath), target)
  write(join(data.root, "src/b.ts"), "export const previousScopeValue = 1\n")
  const activeHash = createHash("sha256").update(active).digest("hex")
  const targetHash = createHash("sha256").update(target).digest("hex")
  const sourceBHash = createHash("sha256").update("export const previousScopeValue = 1\n").digest("hex")
  write(join(data.root, ".task-doctor/registrations/01-task.md.json"), JSON.stringify({
    version: 1,
    status: "registered",
    taskPath: data.taskPath,
    taskHash: activeHash,
  }))
  write(join(data.root, ".task-doctor/registrations/02-redundant.md.json"), JSON.stringify({
    version: 1,
    status: "registered",
    taskPath: targetPath,
    taskHash: targetHash,
  }))
  write(join(data.root, ".task-doctor/state.json"), JSON.stringify({
    version: 4,
    status: "started",
    taskPath: data.taskPath,
    taskHash: activeHash,
    startedAt: "2026-07-16T08:00:00.000Z",
    snapshot: { [targetPath]: targetHash, "src/a.ts": "baseline", "src/b.ts": sourceBHash },
  }))
  claimPlannerOwnership(data.root, {
    taskPath: data.taskPath,
    plannerSessionID: "planner",
    plannerAgent: "planner",
    source: "active_revision",
  })
  claimPlannerOwnership(data.root, {
    taskPath: targetPath,
    plannerSessionID: options.foreignOwner ? "other-planner" : "planner",
    plannerAgent: "planner",
    source: "registration",
  })
  if (options.dependentTask) {
    const dependentPath = "kanban/todo/03-dependent.md"
    write(join(data.root, dependentPath), renderPlannerTask({
      title: "Consume repaired auth navigation",
      outcome: "A dependent feature uses the repaired auth navigation.",
      scope: ["src/b.ts", "tests/a.spec.ts"],
      requirements: ["Preserve the repaired auth navigation."],
      contract: "not-applicable",
      parallel: false,
      dependsOn: ["02-redundant.md"],
      resources: ["frontend"],
      behavior: ["Dependent navigation remains available: client"],
      memoryAction: "none",
      memoryReason: "No durable project knowledge changes.",
      verify: ["npm test -- a.spec.ts"],
    }))
  }
  return { ...data, targetPath, target, active, targetHash, activeHash, sourceBHash }
}

function applyPreviousScopeWorkerChange(data: ReturnType<typeof supersedeFixture>, content = "export const previousScopeValue = 2\n") {
  const policy = {
    root: data.root,
    sessionID: "worker-before-exact-recovery",
    taskPath: data.taskPath,
    taskHash: data.activeHash,
    scope: ["src/b.ts"],
    newScope: [],
    protectedPaths: [".task-doctor", ".opencode"],
    readOnlyPaths: [],
  }
  const preview = previewWorkerChanges(policy, "Change one previous-Scope file before an exact Planner replacement.", [
    { kind: "rewrite" as const, path: "src/b.ts", content },
  ])
  applyWorkerChanges(policy, preview.id, preview.previewToken)
  return content
}

test("register_planner_task renders, lints, registers, and owns one task atomically", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result = await hooks.tool!.register_planner_task.execute(taskArgs(data.taskPath), {
      agent: "planner",
      sessionID: "planner",
      metadata() {},
    } as any)
    assert.match(result.output, /PLANNER TASK REGISTERED kanban\/todo\/01-task\.md/)
    const task = readFileSync(join(data.root, data.taskPath), "utf8")
    assert.match(task, /^---\ntitle: Repair the application root imports\n---/)
    assert.doesNotMatch(task, /## Behavior|## Contract ownership|Contract:/)
    assert.match(task, /Parallel: denied/)
    assert.match(task, /Depends on: none/)
    assert.match(task, /Action: none/)
    assert.match(task, /- npm test -- a\.spec\.ts\n- git diff --check/)
    assert.match(readFileSync(join(data.root, ".task-doctor/planner-owners/01-task.md.json"), "utf8"), /"source": "registration"/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("minimal Planner registration derives canonical Scope, Context, metadata, and Verify", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result = await hooks.tool!.register_planner_task.execute({
      title: "Repair focused auth navigation",
      files: [
        "NEW: code/frontend/src/modules/auth/pages/LoginPage.tsx",
        "code/frontend/tests/auth.spec.ts",
        "code/frontend/src/modules/auth/new-helper.ts",
        "READ: src/a.ts",
      ],
      done: [
        "The focused auth navigation test passes through the existing managed wrapper.",
        "The new helper is available to the login page.",
      ],
    }, { agent: "planner", sessionID: "planner", metadata() {} } as any) as any

    const taskPath = "kanban/todo/repair-focused-auth-navigation.md"
    const task = readFileSync(join(data.root, taskPath), "utf8")
    assert.match(result.output, /removed NEW: from existing file code\/frontend\/src\/modules\/auth\/pages\/LoginPage\.tsx/)
    assert.match(result.output, /marked missing file NEW: code\/frontend\/src\/modules\/auth\/new-helper\.ts/)
    assert.match(task, /## Scope\n\n- code\/frontend\/src\/modules\/auth\/pages\/LoginPage\.tsx\n- code\/frontend\/tests\/auth\.spec\.ts\n- NEW: code\/frontend\/src\/modules\/auth\/new-helper\.ts/)
    assert.match(task, /## Context\n\n- src\/a\.ts/)
    assert.match(task, /## Requirements\n\n- The focused auth navigation test passes through the existing managed wrapper\./)
    assert.doesNotMatch(task, /## Contract ownership|Contract:/)
    assert.match(task, /Parallel: denied/)
    assert.match(task, /Resources: repo/)
    assert.match(task, /Action: none/)
    assert.doesNotMatch(task, /## Behavior/)
    assert.match(task, /npm --prefix code\/frontend run test:e2e -- tests\/auth\.spec\.ts/)
    assert.match(task, /npm --prefix code\/frontend run typecheck/)
    assert.doesNotMatch(task, /git diff --check/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("minimal Planner registration canonicalizes valid paths and permits no derived Verify command", async () => {
  const data = fixture()
  try {
    write(join(data.root, "docs/notes file.md"), "notes\n")
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result: any = await hooks.tool!.register_planner_task.execute({
      title: "Update project notes",
      files: ["./docs/notes file.md", `READ: ${join(data.root, "src/a.ts")}`],
      done: ["The project notes contain the requested facts."],
    }, { agent: "planner", sessionID: "planner", metadata() {} } as any)
    assert.match(result.output, /removed leading \.\/ from \.\/docs\/notes file\.md/)
    assert.match(result.output, /converted in-project absolute path .*\/src\/a\.ts to src\/a\.ts/)
    assert.match(result.output, /Derived Verify: none mechanically available/)
    const task = readFileSync(join(data.root, "kanban/todo/update-project-notes.md"), "utf8")
    assert.match(task, /- docs\/notes file\.md/)
    assert.match(task, /## Context\n\n- src\/a\.ts/)
    assert.deepEqual(parsePlannerTask(task)?.verify, [])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("minimal Planner dependencies repair none, paths, suffixes, and duplicates", async () => {
  const data = fixture()
  try {
    write(join(data.root, "kanban/done/00-base.md"), "# completed dependency\n")
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result: any = await hooks.tool!.register_planner_task.execute({
      title: "Use completed base",
      files: ["src/a.ts"],
      done: ["The source uses the completed base."],
      depends_on: ["none", "kanban/done/00-base", "./kanban/done/00-base.md", "00-base"],
    }, { agent: "planner", sessionID: "planner", metadata() {} } as any)
    const task = readFileSync(join(data.root, "kanban/todo/use-completed-base.md"), "utf8")
    assert.match(result.output, /removed depends_on=none/)
    assert.match(task, /Depends on: 00-base\.md/)
    assert.equal(task.match(/00-base\.md/g)?.length, 1)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("minimal Planner registration ignores stale content and resolves title collisions deterministically", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const context = { agent: "planner", sessionID: "planner", metadata() {} } as any
    const base = {
      title: "Stable generated task",
      files: ["src/a.ts"],
      done: ["The exact source operation is complete."],
    }
    const first: any = await hooks.tool!.register_planner_task.execute(base, context)
    assert.match(first.output, /kanban\/todo\/stable-generated-task\.md/)
    const idempotent: any = await hooks.tool!.register_planner_task.execute({ ...base, content: "stale malformed legacy task" }, context)
    assert.equal(idempotent.metadata.task, "kanban/todo/stable-generated-task.md")
    assert.equal(idempotent.metadata.ignoredLegacyContent, true)
    const collision: any = await hooks.tool!.register_planner_task.execute({
      ...base,
      done: ["A different exact source operation is complete."],
    }, context)
    assert.equal(collision.metadata.task, "kanban/todo/stable-generated-task-2.md")
    assert.equal(collision.metadata.pathCollisionRepaired, true)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("derived test commands quote shell metacharacters and ignore test support helpers", async () => {
  const data = fixture()
  try {
    write(join(data.root, "code/weird app/package.json"), JSON.stringify({ scripts: { test: "node --test" } }))
    write(join(data.root, "code/weird app/tests/a's.spec.ts"), "export {}\n")
    write(join(data.root, "code/backend/package.json"), JSON.stringify({ scripts: { "test:other": "node --test tests/other.test.ts" } }))
    write(join(data.root, "code/backend/tests/support/helper.ts"), "export const helper = true\n")
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const context = { agent: "planner", sessionID: "planner", metadata() {} } as any
    await hooks.tool!.register_planner_task.execute({
      title: "Run quoted focused test",
      files: ["code/weird app/tests/a's.spec.ts"],
      done: ["The focused test operation is complete."],
    }, context)
    const quoted = readFileSync(join(data.root, "kanban/todo/run-quoted-focused-test.md"), "utf8")
    assert.ok(quoted.includes("npm --prefix 'code/weird app' run test -- 'tests/a'\"'\"'s.spec.ts'"))

    await hooks.tool!.register_planner_task.execute({
      title: "Update backend test helper",
      files: ["code/backend/tests/support/helper.ts"],
      done: ["The support helper operation is complete."],
    }, context)
    const helper = readFileSync(join(data.root, "kanban/todo/update-backend-test-helper.md"), "utf8")
    assert.doesNotMatch(helper, /test:other|other\.test\.ts/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("a hardcoded sibling test script self-heals to the common direct runner", async () => {
  const data = fixture()
  try {
    write(join(data.root, "code/backend/package.json"), JSON.stringify({ scripts: { "test:other": "node --test tests/other.test.ts" } }))
    write(join(data.root, "code/backend/tests/new.test.ts"), "export {}\n")
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks.tool!.register_planner_task.execute({
      title: "Update new backend test",
      files: ["code/backend/tests/new.test.ts"],
      done: ["The new backend test operation is complete."],
    }, { agent: "planner", sessionID: "planner", metadata() {} } as any)
    const task = readFileSync(join(data.root, "kanban/todo/update-new-backend-test.md"), "utf8")
    assert.match(task, /npm --prefix code\/backend exec -- node --test tests\/new\.test\.ts/)
    assert.doesNotMatch(task, /run test:other/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("minimal Planner registration accepts mixed technical Scope without architecture scoring", async () => {
  const data = fixture()
  try {
    write(join(data.root, "code/backend/src/index.ts"), "export const api = true\n")
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result = await hooks.tool!.register_planner_task.execute({
      title: "Change both application boundaries",
      files: [
        "code/backend/src/index.ts",
        "code/frontend/src/modules/auth/pages/LoginPage.tsx",
      ],
      done: ["Both application boundaries contain the requested change."],
    }, { agent: "planner", sessionID: "planner", metadata() {} } as any)
    assert.match(result.output, /PLANNER TASK REGISTERED/)
    const task = readFileSync(join(data.root, "kanban/todo/change-both-application-boundaries.md"), "utf8")
    assert.doesNotMatch(task, /## Contract ownership|Contract:/)
    assert.match(task, /Resources: repo/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("minimal registration preserves explicit dependencies without writing contract ownership", async () => {
  const data = fixture()
  try {
    write(join(data.root, "kanban/done/00-backend-contract.md"), renderPlannerTask({
      title: "Publish the backend contract",
      outcome: "The backend exposes the exact documented interface.",
      scope: ["src/a.ts"],
      context: [],
      requirements: ["The request and response shapes are explicit."],
      contract: "backend-contract",
      parallel: false,
      dependsOn: [],
      resources: ["backend"],
      behavior: [],
      memoryAction: "none",
      memoryReason: "No durable project knowledge changes.",
      verify: ["git diff --check"],
    }))
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks.tool!.register_planner_task.execute({
      title: "Consume the backend contract",
      files: ["code/frontend/src/modules/auth/pages/LoginPage.tsx"],
      done: ["The frontend consumes the completed backend interface."],
      depends_on: ["00-backend-contract.md"],
    }, { agent: "planner", sessionID: "planner", metadata() {} } as any)
    const task = readFileSync(join(data.root, "kanban/todo/consume-the-backend-contract.md"), "utf8")
    assert.doesNotMatch(task, /## Contract ownership|Contract:/)
    assert.match(task, /Depends on: 00-backend-contract\.md/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("legacy canonical content is re-rendered after filesystem and Memory repairs", async () => {
  const data = fixture()
  try {
    const legacy = renderPlannerTask({
      title: "Normalize a legacy Planner task",
      outcome: "The legacy task remains runnable after canonical repair.",
      scope: ["NEW: src/a.ts", "tests/a.spec.ts"],
      context: ["code/frontend/src/modules/auth/pages/LoginPage.tsx"],
      requirements: ["Preserve the existing source value and focused test."],
      contract: "not-applicable",
      parallel: false,
      dependsOn: [],
      resources: ["repo"],
      behavior: [],
      memoryAction: "append",
      memoryReason: "This invalid action is repaired because Memory is outside Scope.",
      verify: ["npm test -- a.spec.ts"],
    })
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result = await hooks.tool!.register_planner_task.execute({
      content: legacy,
      task_path: "kanban/todo/06-legacy.md",
    } as any, { agent: "planner", sessionID: "planner", metadata() {} } as any) as any

    const task = readFileSync(join(data.root, "kanban/todo/06-legacy.md"), "utf8")
    assert.doesNotMatch(task, /NEW: src\/a\.ts/)
    assert.match(task, /## Context\n\n- code\/frontend\/src\/modules\/auth\/pages\/LoginPage\.tsx/)
    assert.match(task, /Action: none/)
    assert.match(task, /Reason: No durable project knowledge changes\./)
    assert.match(result.output, /removed NEW: from existing file src\/a\.ts/)
    assert.match(result.output, /reset memory_action to none/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("register_planner_task makes in-project absolute Verify paths portable", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result = await hooks.tool!.register_planner_task.execute({
      ...taskArgs(data.taskPath),
      scope: [
        "code/frontend/src/modules/auth/pages/LoginPage.tsx",
        "code/frontend/tests/auth.spec.ts",
      ],
      verify: [
        `npm --prefix code/frontend run test:e2e -- ${data.root}/code/frontend/tests/auth.spec.ts`,
        "npm --prefix code/frontend run test:e2e -- tests/e2e.spec.ts --grep register and login new user --headed",
        'npm --prefix code/frontend run test:e2e -- tests/auth.spec.ts --grep "login succeeds" --project chromium',
        "npm --prefix code/frontend run test:e2e -- tests/auth.spec.ts -g failed registration --project chromium",
        "npm --prefix code/frontend run test:e2e -- tests/auth.spec.ts --grep=login succeeds --headed",
      ],
    }, { agent: "planner", sessionID: "planner", metadata() {} } as any)

    assert.match(result.output, /converted in-project absolute Verify paths to portable paths/)
    const task = readFileSync(join(data.root, data.taskPath), "utf8")
    assert.match(task, /npm --prefix code\/frontend run test:e2e -- tests\/auth\.spec\.ts/)
    assert.match(task, /npm --prefix code\/frontend run test:e2e -- tests\/e2e\.spec\.ts --grep "register and login new user" --headed/)
    assert.match(task, /npm --prefix code\/frontend run test:e2e -- tests\/auth\.spec\.ts --grep "login succeeds" --project chromium/)
    assert.match(task, /npm --prefix code\/frontend run test:e2e -- tests\/auth\.spec\.ts -g "failed registration" --project chromium/)
    assert.match(task, /npm --prefix code\/frontend run test:e2e -- tests\/auth\.spec\.ts --grep="login succeeds" --headed/)
    assert.doesNotMatch(task, new RegExp(data.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("register_planner_task rolls back an invalid structured retry", async () => {
  const data = fixture()
  try {
    const original = readFileSync(join(data.root, data.taskPath), "utf8")
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await assert.rejects(hooks.tool!.register_planner_task.execute({
      ...taskArgs(data.taskPath),
      verify: ["npm test\ngit diff --check"],
    }, { agent: "planner", sessionID: "planner", metadata() {} } as any), /more than one shell command line/)
    assert.equal(readFileSync(join(data.root, data.taskPath), "utf8"), original)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("register_planner_task ignores legacy Behavior input", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result = await hooks.tool!.register_planner_task.execute({
      ...taskArgs("kanban/todo/02-typecheck.md"),
      verify: ["npm --prefix code/frontend run typecheck"],
    }, { agent: "planner", sessionID: "planner", metadata() {} } as any)
    assert.match(result.output, /PLANNER TASK REGISTERED/)
    assert.doesNotMatch(readFileSync(join(data.root, "kanban/todo/02-typecheck.md"), "utf8"), /## Behavior/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("register_planner_task repairs an irrelevant Memory action mechanically", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result = await hooks.tool!.register_planner_task.execute({
      ...taskArgs("kanban/todo/03-memory-default.md"),
      memory_action: "append",
      memory_reason: "Record a durable fact.",
    }, { agent: "planner", sessionID: "planner", metadata() {} } as any)
    assert.match(result.output, /Input repair: reset memory_action to none because MEMORY\.md is not in Scope/)
    const task = readFileSync(join(data.root, "kanban/todo/03-memory-default.md"), "utf8")
    assert.match(task, /Action: none/)
    assert.match(task, /Reason: No durable project knowledge changes\./)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("register_planner_task does not synthesize model-shaped Behavior lines", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks.tool!.register_planner_task.execute({
      ...taskArgs("kanban/todo/04-behavior.md"),
      behavior: [
        "B1 Scenario: state - The translated title is visible",
        "B9 Error response: 422",
      ],
    }, { agent: "planner", sessionID: "planner", metadata() {} } as any)
    const task = readFileSync(join(data.root, "kanban/todo/04-behavior.md"), "utf8")
    assert.doesNotMatch(task, /## Behavior|translated title|Error response/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Planner rendering drops retired Behavior and Contract ownership metadata", () => {
  const rendered = renderPlannerTask({
    title: "Repair auth navigation",
    outcome: "Auth navigation remains observable and type-safe.",
    scope: ["src/a.ts", "tests/a.spec.ts"],
    requirements: ["Preserve exact semantic navigation."],
    contract: "not-applicable",
    parallel: false,
    dependsOn: [],
    resources: ["frontend"],
    behavior: ["A legacy scenario must not be rendered."],
    memoryAction: "none",
    memoryReason: "No durable project knowledge changes.",
    verify: ["npm test -- a.spec.ts"],
  })
  const parsed = parsePlannerTask(rendered)!
  assert.doesNotMatch(rendered, /## Behavior|## Contract ownership|Contract:/)
  assert.equal("behavior" in parsed, false)
  assert.equal("contract" in parsed, false)
  assert.equal(renderPlannerTask(parsed), rendered)
  assert.deepEqual(plannerRecoveryContractExactGaps(rendered, {
    scope: parsed.scope,
    requirements: parsed.requirements,
    verify: parsed.verify,
    supersedeTasks: [],
  }), [])
})

test("legacy Behavior metadata is not written into new canonical tasks", () => {
  const content = renderPlannerTask({
    title: "Repair auth navigation",
    outcome: "Login navigation uses a real router link.",
    scope: ["src/a.ts"],
    requirements: ["Preserve link semantics."],
    contract: "not-applicable",
    parallel: false,
    dependsOn: [],
    resources: ["repo"],
    behavior: ["Forgot-password navigation reaches its route"],
    memoryAction: "none",
    memoryReason: "No durable project knowledge changes.",
    verify: ["npm --prefix code/frontend run typecheck"],
  })
  assert.doesNotMatch(content, /## Behavior|Forgot-password navigation/)
})

test("active-task revisions merge structured additions into canonical Markdown", () => {
  const original = renderPlannerTask({
    title: "Fix duplicate imports",
    outcome: "The frontend entry point has no duplicate imports.",
    scope: ["code/frontend/src/main.tsx"],
    requirements: ["Remove duplicate imports from the entry point."],
    contract: "not-applicable",
    parallel: false,
    dependsOn: [],
    resources: ["Frontend source"],
    behavior: [],
    memoryAction: "none",
    memoryReason: "No durable project knowledge changes.",
    verify: ["npm --prefix code/frontend run typecheck"],
  })
  const revised = mergePlannerTaskRevision(original, {
    addScope: ["code/frontend/src/modules/auth/pages/LoginPage.tsx", "code/frontend/tests/auth.spec.ts"],
    addRequirements: ["Correct the LoginPage argument-count error."],
    verify: ["npm --prefix code/frontend run test:e2e:direct auth.spec.ts"],
  })
  const parsed = parsePlannerTask(revised)
  assert.ok(parsed)
  assert.deepEqual(parsed.scope, [
    "code/frontend/src/main.tsx",
    "code/frontend/src/modules/auth/pages/LoginPage.tsx",
    "code/frontend/tests/auth.spec.ts",
  ])
  assert.equal("contract" in parsed, false)
  assert.deepEqual(parsed.dependsOn, [])
  assert.deepEqual(parsed.verify, ["npm --prefix code/frontend run test:e2e:direct auth.spec.ts"])
  assert.doesNotMatch(revised, /## Behavior/)
})

test("complete recovery contracts replace task sections and remove cosmetic duplicates", () => {
  const original = renderPlannerTask({
    title: "Repair auth navigation",
    outcome: "Auth navigation is type-safe and covered by E2E tests.",
    scope: ["code/frontend/src/Login.tsx"],
    requirements: [
      "Use React Router's `<Link>` component.",
      "Use React Router's Link component.",
      "Keep an obsolete requirement.",
    ],
    contract: "not-applicable",
    parallel: false,
    dependsOn: [],
    resources: ["Frontend source"],
    behavior: [
      "Login opens the \\\"Register\\\" route: client",
      "Login opens the \"Register\" route: client",
      "Obsolete scenario: state",
    ],
    memoryAction: "none",
    memoryReason: "No durable project knowledge changes.",
    verify: ["npm run old-test"],
  })
  const revised = mergePlannerTaskRevision(original, {
    exactScope: ["code/frontend/src/Login.tsx", "NEW: code/frontend/tests/auth-navigation.spec.ts"],
    exactRequirements: ["Use React Router's Link component."],
    verify: ["npm run test:e2e -- auth-navigation.spec.ts"],
  })
  const parsed = parsePlannerTask(revised)
  assert.ok(parsed)
  assert.deepEqual(parsed.scope, ["code/frontend/src/Login.tsx", "NEW: code/frontend/tests/auth-navigation.spec.ts"])
  assert.deepEqual(parsed.requirements, ["Use React Router's Link component."])
  assert.equal("behavior" in parsed, false)
  assert.deepEqual(parsed.verify, ["npm run test:e2e -- auth-navigation.spec.ts"])
})

test("planner task coverage requires exact scope, requirements, verification commands, and no memory action", () => {
  const data = supersedeFixture()
  try {
    assert.deepEqual(plannerTaskCoverageGaps(data.target, data.active), [])
    const focusedVerification = renderPlannerTask({
      ...parsePlannerTask(data.active)!,
      verify: ["npm test -- focused-auth.spec.ts", "git diff --check"],
    })
    assert.match(plannerTaskCoverageGaps(data.target, focusedVerification).join("\n"), /Verify command is not covered/)
    const missing = renderPlannerTask({
      ...parsePlannerTask(data.active)!,
      requirements: ["The entry point compiles."],
    })
    assert.match(plannerTaskCoverageGaps(data.target, missing).join("\n"), /Requirement is not covered/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("verification comparison preserves script names and every declared argument", () => {
  const base = renderPlannerTask({
    title: "Run the declared verification",
    outcome: "The declared verification command completes.",
    scope: ["src/a.ts"],
    requirements: ["Use the exact declared verification command."],
    parallel: false,
    dependsOn: [],
    resources: ["repo"],
    memoryAction: "none",
    memoryReason: "No durable project knowledge changes.",
    verify: ['npm run test:e2e:direct -- a.spec.ts --grep "focused case"'],
  })
  const renamedScript = renderPlannerTask({
    ...parsePlannerTask(base)!,
    verify: ['npm run test:e2e -- a.spec.ts --grep "focused case"'],
  })
  const strippedArgument = renderPlannerTask({
    ...parsePlannerTask(base)!,
    verify: ["npm run test:e2e:direct -- a.spec.ts"],
  })
  const changedQuotedBytes = renderPlannerTask({
    ...parsePlannerTask(base)!,
    verify: ['npm run test:e2e:direct -- a.spec.ts --grep "focused  case"'],
  })

  assert.match(plannerTaskCoverageGaps(base, renamedScript).join("\n"), /Verify command is not covered/)
  assert.match(plannerTaskCoverageGaps(base, strippedArgument).join("\n"), /Verify command is not covered/)
  assert.match(plannerTaskCoverageGaps(base, changedQuotedBytes).join("\n"), /Verify command is not covered/)
  assert.match(plannerRecoveryContractGaps(renamedScript, {
    scope: [],
    requirements: [],
    verify: parsePlannerTask(base)!.verify,
    supersedeTasks: [],
  }).join("\n"), /Verify command is missing/)
  assert.deepEqual(plannerRecoveryContractGaps(base.replace(/npm run/, "npm   run"), {
    scope: [],
    requirements: [],
    verify: parsePlannerTask(base)!.verify,
    supersedeTasks: [],
  }), [])
})

test("Planner recovery ignores retired legacy Behavior metadata", () => {
  const content = renderPlannerTask({
    title: "Repair auth navigation",
    outcome: "The login link reaches the registration route.",
    scope: ["src/a.ts", "tests/a.spec.ts"],
    requirements: ["Login exposes semantic registration navigation."],
    contract: "not-applicable",
    parallel: false,
    dependsOn: [],
    resources: ["frontend"],
    behavior: ["Login reaches registration: client"],
    memoryAction: "none",
    memoryReason: "No durable project knowledge changes.",
    verify: ["npm test -- a.spec.ts"],
  })
  assert.deepEqual(plannerRecoveryContractGaps(content, {
    scope: [],
    requirements: [],
    behavior: ["Scenario: client - Login reaches registration"],
    verify: [],
    supersedeTasks: [],
  }), [])
  assert.doesNotMatch(content, /## Behavior/)
})

test("supersede_registered_task archives a fully covered unstarted task and updates Doctor state atomically", async () => {
  const data = supersedeFixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result = await hooks.tool!.supersede_registered_task.execute({
      task_path: data.targetPath,
      reason: "The active task contains the complete auth-navigation scope, requirements, behavior, and stronger verification.",
    }, { agent: "planner", sessionID: "planner", metadata() {} } as any) as any
    const archivePath = "kanban/superseded/02-redundant.md"
    assert.match(result.output, /PLANNER TASK SUPERSEDED/)
    assert.equal(existsSync(join(data.root, data.targetPath)), false)
    const archived = readFileSync(join(data.root, archivePath), "utf8")
    assert.match(archived, /Status: superseded/)
    assert.match(archived, /Superseded by: 01-task\.md/)
    const registration = JSON.parse(readFileSync(join(data.root, ".task-doctor/registrations/02-redundant.md.json"), "utf8"))
    assert.equal(registration.status, "superseded")
    assert.equal(registration.archivePath, archivePath)
    assert.equal(registration.coveringTaskPath, data.taskPath)
    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    assert.equal(state.status, "started")
    assert.equal(state.taskPath, data.taskPath)
    assert.equal(state.taskHash, data.activeHash)
    assert.equal(state.snapshot[data.targetPath], undefined)
    assert.equal(state.snapshot[archivePath], createHash("sha256").update(archived).digest("hex"))
    assert.equal(state.snapshot["src/a.ts"], "baseline")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("explicit Planner recovery enforces its contract, supersedes first, repairs evidence paths, and survives restart", async () => {
  const data = supersedeFixture()
  try {
    let hooks: Awaited<ReturnType<typeof WorkflowGuard>>
    let recoveryPrompt = ""
    const focusedTest = "tests/focused-auth.spec.ts"
    const requirement = "Focused auth navigation has executable regression coverage."
    const behavior = "Auth navigation reaches its route: client"
    const verify = `npm test -- ${focusedTest.split("/").pop()}`
    const client = {
      session: {
        get: async () => ({ data: { id: "planner", directory: data.root } }),
        messages: async ({ path }: any) => ({ data: { data: path.id === "executor" ? [{
          info: { id: "user-review-1", role: "user" },
          parts: [{ type: "text", text: `Use the owning Planner to revise ${data.taskPath} and supersede ${data.targetPath} before Worker delegation.` }],
        }] : [], cursor: {} } }),
        prompt: async ({ body }: any) => {
          recoveryPrompt = body.parts[0].text
          await hooks["chat.message"]!({ sessionID: "planner", agent: "planner" } as any, {} as any)
          const activePaths = [
            data.taskPath,
            ".task-doctor/state.json",
            ".task-doctor/registrations/01-task.md.json",
            ".task-doctor/planner-owners/01-task.md.json",
          ]
          const snapshot = () => activePaths.map((path) => readFileSync(join(data.root, path)))
          const taskMtime = () => statSync(join(data.root, data.taskPath), { bigint: true }).mtimeNs
          const beforeSupersede = snapshot()
          const beforeSupersedeMtime = taskMtime()
          await assert.rejects(hooks.tool!.revise_active_task.execute({
            task_path: data.taskPath,
            add_scope: [`NEW: ${focusedTest}`],
            add_requirements: [requirement],
            add_behavior: [behavior],
            verify: ["npm test -- a.spec.ts", verify],
            reason: "This deliberately exercises the required supersede-before-revision ordering guard.",
          }, { agent: "planner", sessionID: "planner", metadata() {} } as any), /must supersede redundant tasks before revising/)
          assert.deepEqual(snapshot(), beforeSupersede)
          assert.equal(taskMtime(), beforeSupersedeMtime)
          const superseded = await hooks.tool!.supersede_registered_task.execute({
            task_path: data.targetPath,
            reason: "The active task already covers the complete redundant auth-navigation contract.",
          }, { agent: "planner", sessionID: "planner", metadata() {} } as any) as any
          assert.match(superseded.output, /Now call revise_active_task/)
          const beforeContractFailure = snapshot()
          const beforeContractFailureMtime = taskMtime()
          const activeDraft = parsePlannerTask(readFileSync(join(data.root, data.taskPath), "utf8"))!
          const unsafeReplacement = renderPlannerTask({
            ...activeDraft,
            scope: [...activeDraft.scope, `NEW: ${focusedTest}`],
            requirements: [requirement],
            behavior: [behavior],
            verify: [verify],
          })
          await assert.rejects(hooks.tool!.revise_active_task.execute({
            task_path: data.taskPath,
            replacement: unsafeReplacement,
            reason: "This deliberately drops a superseded requirement to verify final coverage enforcement.",
          }, { agent: "planner", sessionID: "planner", metadata() {} } as any), /PLANNER SUPERSEDE COVERAGE INCOMPLETE[\s\S]*Requirement is not covered/)
          assert.deepEqual(snapshot(), beforeContractFailure)
          assert.equal(taskMtime(), beforeContractFailureMtime)
          await assert.rejects(hooks.tool!.revise_active_task.execute({
            task_path: data.taskPath,
            add_scope: [`NEW: ${focusedTest}`],
            add_behavior: [behavior],
            verify: ["npm test -- a.spec.ts", verify],
            reason: "This deliberately omits one required contract item to verify write-free rejection.",
          }, { agent: "planner", sessionID: "planner", metadata() {} } as any), /PLANNER RECOVERY CONTRACT INCOMPLETE[\s\S]*Requirement is missing/)
          assert.deepEqual(snapshot(), beforeContractFailure)
          assert.equal(taskMtime(), beforeContractFailureMtime)
          await hooks.tool!.revise_active_task.execute({
            task_path: data.taskPath,
            add_scope: [`NEW: ${focusedTest}`],
            add_requirements: [requirement],
            add_behavior: [behavior],
            verify: ["npm test -- a.spec.ts", verify],
            reason: "The explicit user review requires focused verification and removal of a redundant queued task.",
          }, { agent: "planner", sessionID: "planner", metadata() {} } as any)
          return { data: { info: {}, parts: [] } }
        },
      },
    }
    hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const result = await hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: "The active auth task needs focused acceptance coverage before another Worker may continue.",
      evidence: ["The broad legacy auth suite contains unrelated failures and is not focused evidence."],
      expected_results: ["The final task names one focused auth-navigation test and supersedes the redundant task."],
      relevant_files: ["wrong/directory/a.ts"],
      required_scope: [`NEW: ${focusedTest}`],
      required_requirements: [requirement],
      required_behavior: [behavior],
      required_verify: [verify],
      supersede_tasks: [data.targetPath],
      contract_mode: "merge",
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any) as any

    assert.match(result.output, /PLANNER RECOVERY COMPLETE/)
    assert.match(recoveryPrompt, /Inspect these files: kanban\/todo\/01-task\.md, src\/a\.ts/)
    assert.doesNotMatch(recoveryPrompt, /wrong\/directory/)
    assert.ok(existsSync(join(data.root, "kanban/superseded/02-redundant.md")))
    const revised = readFileSync(join(data.root, data.taskPath), "utf8")
    assert.match(revised, new RegExp(`NEW: ${focusedTest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
    const receipt = JSON.parse(readFileSync(join(data.root, ".task-doctor/planner-review.json"), "utf8"))
    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    assert.equal(receipt.status, "complete")
    assert.equal(receipt.taskHash, state.taskHash)

    const restartedHooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await restartedHooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const delegation = {
      args: {
        subagent_type: "worker",
        description: `Resume ${data.taskPath}`,
        prompt: `Resume active task ${data.taskPath}.`,
      },
    }
    await assert.doesNotReject(restartedHooks["tool.execute.before"]!({ sessionID: "executor", tool: "task" } as any, delegation as any))
    assert.match(delegation.args.prompt, /Do not run Doctor lint, register, start, or schedule/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("explicit replace-mode recovery applies mechanically and canonicalizes a legacy pending receipt idempotently", async () => {
  const data = supersedeFixture()
  try {
    let hooks: Awaited<ReturnType<typeof WorkflowGuard>>
    let promptCount = 0
    let latestUser = {
      id: "user-replace-review",
      text: `Call escalate_to_planner for ${data.taskPath} with a complete replace contract before Worker delegation.`,
    }
    const originalContent = readFileSync(join(data.root, data.taskPath), "utf8")
    const original = parsePlannerTask(originalContent)!
    applyPreviousScopeWorkerChange(data)
    const suppliedScope = ["NEW: src/a.ts", "tests/a.spec.ts"]
    const scope = ["src/a.ts", "tests/a.spec.ts"]
    const requirements = ["Auth navigation uses one canonical semantic router contract."]
    const suppliedBehavior = ["Auth navigation reaches its focused route client"]
    const behavior = ["Auth navigation reaches its focused route: client"]
    const suppliedVerify = ["npm test -- a.spec.ts --grep register and login new user"]
    const verify = ['npm test -- a.spec.ts --grep "register and login new user"']
    const client = {
      session: {
        get: async () => ({ data: { id: "planner", directory: data.root } }),
        messages: async ({ path }: any) => ({ data: { data: path.id === "executor" ? [{
          info: { id: latestUser.id, role: "user" },
          parts: [{ type: "text", text: latestUser.text }],
        }] : [], cursor: {} } }),
        prompt: async () => {
          promptCount += 1
          throw new Error("Exact replace recovery must not prompt the Planner model.")
        },
      },
    }
    hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const first = await hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: "The active task has stale duplicate auth entries that must be replaced by one complete canonical contract.",
      evidence: ["The current Requirements and Behavior sections contain obsolete entries alongside the desired final contract."],
      expected_results: ["The four contract-controlled sections exactly match the supplied complete final arrays."],
      relevant_files: [data.taskPath, "src/a.ts", "tests/a.spec.ts"],
      required_scope: suppliedScope,
      required_requirements: requirements,
      required_behavior: suppliedBehavior,
      required_verify: suppliedVerify,
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any) as any

    assert.match(first.output, /PLANNER RECOVERY COMPLETE/)
    assert.match(first.output, /applied mechanically/)
    assert.match(first.output, /TASK SCOPE BASELINE RESTORED src\/b\.ts/)
    assert.equal(readFileSync(join(data.root, "src/b.ts"), "utf8"), "export const previousScopeValue = 1\n")
    assert.equal(promptCount, 0)
    const initialReceipt = JSON.parse(readFileSync(join(data.root, ".task-doctor/planner-review.json"), "utf8"))
    assert.equal(initialReceipt.status, "complete")
    assert.equal(initialReceipt.contractMode, "replace")
    assert.equal("behavior" in initialReceipt.contract, false)
    assert.deepEqual(initialReceipt.contract.verify, verify)
    const frozenContract = structuredClone(initialReceipt.contract)
    writeFileSync(join(data.root, ".task-doctor/planner-review.json"), `${JSON.stringify({
      ...initialReceipt,
      status: "pending",
      completedForMessageID: undefined,
      completedAt: undefined,
      contract: { ...initialReceipt.contract, behavior: suppliedBehavior },
    }, null, 2)}\n`)
    latestUser = {
      id: "user-replace-continue",
      text: `Finalize the pending Planner recovery for ${data.taskPath} by calling escalate_to_planner, then delegate Worker.`,
    }
    hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const result = await hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any) as any
    assert.match(result.output, /PLANNER RECOVERY COMPLETE/)
    assert.match(result.output, /without another Planner request/)
    assert.equal(promptCount, 0)
    const completedReceipt = JSON.parse(readFileSync(join(data.root, ".task-doctor/planner-review.json"), "utf8"))
    assert.equal(completedReceipt.completedForMessageID, latestUser.id)
    assert.equal(completedReceipt.contractMode, "replace")
    assert.deepEqual(completedReceipt.contract, frozenContract)
    writeFileSync(join(data.root, ".task-doctor/planner-review.json"), `${JSON.stringify({
      ...completedReceipt,
      status: "pending",
      initialTaskHash: completedReceipt.taskHash,
      completedForMessageID: undefined,
      completedAt: undefined,
      lastError: "The owning Planner session returned after the exact revision committed.",
    }, null, 2)}\n`)
    latestUser = {
      id: "user-replace-retry",
      text: `Retry finalize pending Planner recovery for ${data.taskPath} with escalate_to_planner, then delegate Worker.`,
    }
    hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const recoveredAgain = await hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: "The already-complete recovery receipt must satisfy this explicit continuation before Worker delegation.",
      evidence: ["The exact active task hash already matches the complete Planner recovery receipt."],
      expected_results: ["The current continuation is recorded as satisfied without another Planner request."],
      relevant_files: [data.taskPath],
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any) as any
    assert.match(recoveredAgain.output, /PLANNER RECOVERY COMPLETE/)
    assert.equal(promptCount, 0)
    assert.equal(JSON.parse(readFileSync(join(data.root, ".task-doctor/planner-review.json"), "utf8")).completedForMessageID, latestUser.id)
    latestUser = {
      id: "user-replace-final",
      text: `Continue finalized Planner recovery for ${data.taskPath} with escalate_to_planner, then delegate Worker.`,
    }
    const idempotent = await hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: "The complete receipt must satisfy one final explicit continuation without another Planner request.",
      evidence: ["The exact active task hash remains bound to the complete recovery receipt."],
      expected_results: ["The final continuation is recorded as satisfied idempotently."],
      relevant_files: [data.taskPath],
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any) as any
    assert.match(idempotent.output, /PLANNER RECOVERY COMPLETE/)
    assert.equal(promptCount, 0)
    assert.equal(JSON.parse(readFileSync(join(data.root, ".task-doctor/planner-review.json"), "utf8")).completedForMessageID, latestUser.id)
    const delegation = {
      args: {
        subagent_type: "worker",
        description: `Resume ${data.taskPath}`,
        prompt: `Resume active task ${data.taskPath}.`,
      },
    }
    await assert.doesNotReject(hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task" } as any, delegation as any))
    const revised = readFileSync(join(data.root, data.taskPath), "utf8")
    const expected = renderPlannerTask({ ...original, scope, requirements, verify })
    assert.equal(revised, expected)
    const parsed = parsePlannerTask(revised)!
    assert.deepEqual(parsed.scope, scope)
    assert.deepEqual(parsed.requirements, requirements)
    assert.equal("behavior" in parsed, false)
    assert.deepEqual(parsed.verify, verify)
    assert.equal(parsed.title, original.title)
    assert.equal(parsed.outcome, original.outcome)
    assert.equal("contract" in parsed, false)
    assert.equal(parsed.parallel, original.parallel)
    assert.deepEqual(parsed.dependsOn, original.dependsOn)
    assert.deepEqual(parsed.resources, original.resources)
    assert.equal(parsed.memoryAction, original.memoryAction)
    assert.equal(parsed.memoryReason, original.memoryReason)
    const receipt = JSON.parse(readFileSync(join(data.root, ".task-doctor/planner-review.json"), "utf8"))
    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    assert.equal(receipt.contractMode, "replace")
    assert.equal(receipt.taskHash, state.taskHash)
    assert.equal(state.taskHash, createHash("sha256").update(revised).digest("hex"))
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("mechanical exact recovery rolls back one deterministic failure without prompting or retrying the Planner model", async () => {
  const data = supersedeFixture()
  try {
    const workerChangedSource = applyPreviousScopeWorkerChange(data, "export const previousScopeValue = 9\n")
    let promptCount = 0
    const originalTask = readFileSync(join(data.root, data.taskPath), "utf8")
    const originalState = readFileSync(join(data.root, ".task-doctor/state.json"), "utf8")
    const originalRegistration = readFileSync(join(data.root, ".task-doctor/registrations/01-task.md.json"), "utf8")
    const client = {
      session: {
        get: async () => ({ data: { id: "planner", directory: data.root } }),
        messages: async ({ path }: any) => ({ data: { data: path.id === "executor" ? [{
          info: { id: "user-invalid-exact", role: "user" },
          parts: [{ type: "text", text: `Use the owning Planner with a complete replace contract for ${data.taskPath} before Worker delegation.` }],
        }] : [], cursor: {} } }),
        prompt: async () => {
          promptCount += 1
          throw new Error("Mechanical exact recovery must not prompt or retry the Planner model.")
        },
      },
    }
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const result = await hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: "The active task must be replaced by a deliberately invalid exact behavior contract for rollback coverage.",
      evidence: ["The supplied Scope intentionally omits a test file required by its Behavior section."],
      expected_results: ["The trusted transition rejects the invalid contract without changing the active task."],
      relevant_files: [data.taskPath, "src/a.ts"],
      required_scope: ["src/a.ts"],
      required_requirements: ["Preserve one observable auth navigation behavior."],
      required_behavior: ["Auth navigation remains observable client"],
      required_verify: ["npm test -- a.spec.ts"],
      contract_mode: "replace",
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any) as any

    assert.match(result.output, /PLANNER RECOVERY INCOMPLETE/)
    assert.match(result.output, /mechanical exact-contract transition stopped without a model retry/)
    assert.equal(promptCount, 0)
    assert.equal(readFileSync(join(data.root, data.taskPath), "utf8"), originalTask)
    assert.equal(readFileSync(join(data.root, "src/b.ts"), "utf8"), workerChangedSource)
    assert.equal(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"), originalState)
    assert.equal(readFileSync(join(data.root, ".task-doctor/registrations/01-task.md.json"), "utf8"), originalRegistration)
    const receipt = JSON.parse(readFileSync(join(data.root, ".task-doctor/planner-review.json"), "utf8"))
    assert.equal(receipt.status, "pending")
    assert.equal("behavior" in receipt.contract, false)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("plugin restart self-heals a previously committed exact replacement that left a Worker change outside Scope", async () => {
  const data = supersedeFixture()
  try {
    const workerChangedSource = applyPreviousScopeWorkerChange(data)
    const original = parsePlannerTask(readFileSync(join(data.root, data.taskPath), "utf8"))!
    const contract = {
      scope: ["src/a.ts", "tests/a.spec.ts"],
      requirements: ["Auth navigation uses one exact recovered contract."],
      behavior: ["Auth navigation reaches its route: client"],
      verify: ["npm test -- a.spec.ts"],
      supersedeTasks: [],
    }
    const replacement = renderPlannerTask({
      ...original,
      scope: contract.scope,
      requirements: contract.requirements,
      behavior: contract.behavior,
      verify: contract.verify,
    })
    const replacementHash = createHash("sha256").update(replacement).digest("hex")
    const changedHash = createHash("sha256").update(workerChangedSource).digest("hex")
    const revisedAt = new Date(Date.now() + 1_000).toISOString()
    write(join(data.root, data.taskPath), replacement)
    write(join(data.root, ".task-doctor/registrations/01-task.md.json"), JSON.stringify({
      version: 1,
      status: "registered",
      taskPath: data.taskPath,
      taskHash: replacementHash,
      snapshot: { "src/b.ts": changedHash },
    }))
    write(join(data.root, ".task-doctor/state.json"), JSON.stringify({
      version: 4,
      status: "started",
      taskPath: data.taskPath,
      taskHash: replacementHash,
      startedAt: "2026-07-16T08:00:00.000Z",
      snapshot: { "src/b.ts": data.sourceBHash },
      taskRevision: {
        previousTaskHash: data.activeHash,
        revisedTaskHash: replacementHash,
        plannerSessionID: "planner",
        plannerAgent: "planner",
        executorSessionID: "executor",
        revisedAt,
      },
    }))
    claimPlannerOwnership(data.root, {
      taskPath: data.taskPath,
      plannerSessionID: "planner",
      plannerAgent: "planner",
      source: "active_revision",
    })
    write(join(data.root, ".task-doctor/planner-review.json"), JSON.stringify({
      version: 1,
      status: "complete",
      executorSessionID: "executor",
      userMessageID: "user-review",
      userRequestHash: "request-hash",
      taskPath: data.taskPath,
      initialTaskHash: data.activeHash,
      taskHash: replacementHash,
      contractMode: "replace",
      completedForMessageID: "user-review",
      requestedAt: revisedAt,
      completedAt: revisedAt,
      contract,
      relevantFiles: [data.taskPath, ...contract.scope, "src/b.ts"],
    }))
    write(join(data.root, ".task-doctor/last-doctor-failure.json"), JSON.stringify({
      version: 1,
      taskHash: replacementHash,
      sessionID: "worker-after-revision",
      taskPath: data.taskPath,
      gate: "verify",
      output: "TASK DOCTOR: FAIL\n- CHANGED_OUTSIDE_SCOPE_FILE: src/b.ts\n- CHANGED_FILE_ACTION: restore the exact original file bytes.",
      failedAt: "2026-07-16T23:01:00.000Z",
    }))
    write(join(data.root, ".task-doctor/worker-help.json"), JSON.stringify({
      version: 1,
      requests: [{
        version: 1,
        id: "H1",
        status: "pending",
        taskPath: data.taskPath,
        taskHash: replacementHash,
        workerSessionID: "worker-after-revision",
        category: "task_scope",
        problem: "CHANGED_OUTSIDE_SCOPE_FILE: src/b.ts",
        attemptedActions: ["Worker ran Doctor verify once."],
        evidence: ["CHANGED_FILE_ACTION: restore the exact original file bytes."],
        relevantFiles: [data.taskPath, "src/b.ts"],
        suggestedNextStep: "Executor should retry after trusted baseline recovery.",
        createdAt: "2026-07-16T23:01:00.000Z",
      }],
      updatedAt: "2026-07-16T23:01:00.000Z",
    }))

    await WorkflowGuard({
      directory: data.root,
      worktree: data.root,
      client: { app: { log: async () => { throw new Error("logging unavailable") } } },
    } as any)

    assert.equal(readFileSync(join(data.root, "src/b.ts"), "utf8"), "export const previousScopeValue = 1\n")
    assert.equal(existsSync(join(data.root, ".task-doctor/last-doctor-failure.json")), false)
    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    assert.deepEqual(state.taskRevision.restoredRemovedScopePaths.map((entry: any) => entry.path), ["src/b.ts"])
    const registration = JSON.parse(readFileSync(join(data.root, ".task-doctor/registrations/01-task.md.json"), "utf8"))
    assert.equal(registration.snapshot["src/b.ts"], data.sourceBHash)
    const help = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-help.json"), "utf8")).requests[0]
    assert.equal(help.status, "resolved")
    assert.equal(help.closureReason, "scope_baseline_recovered")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("merge-mode owning Planner recovery retries once when the first turn makes no trusted tool call", async () => {
  const data = supersedeFixture()
  try {
    let hooks: Awaited<ReturnType<typeof WorkflowGuard>>
    let promptCount = 0
    const plannerStatePrompts: string[] = []
    const original = parsePlannerTask(readFileSync(join(data.root, data.taskPath), "utf8"))!
    const requirements = ["Auth navigation uses the corrected canonical router contract."]
    const client = {
      session: {
        get: async () => ({ data: { id: "planner", directory: data.root } }),
        messages: async ({ path }: any) => ({ data: { data: path.id === "executor" ? [{
          info: { id: "user-retry-review", role: "user" },
          parts: [{ type: "text", text: `Use the owning Planner with a merge correction contract for ${data.taskPath}.` }],
        }] : [], cursor: {} } }),
        prompt: async () => {
          promptCount += 1
          const transformed = { messages: [{
            info: { id: `planner-user-${promptCount}`, sessionID: "planner", role: "user", agent: "planner", time: { created: promptCount } },
            parts: [{ type: "text", text: "Continue the trusted recovery." }],
          }] as any[] }
          await hooks["experimental.chat.messages.transform"]!({} as any, transformed as any)
          plannerStatePrompts.push(transformed.messages.at(-1).parts[0].text)
          if (promptCount === 1) return { data: { info: {}, parts: [] } }
          await hooks["chat.message"]!({ sessionID: "planner", agent: "planner" } as any, {} as any)
          await hooks.tool!.revise_active_task.execute({
            task_path: data.taskPath,
            add_requirements: requirements,
            reason: "Add the reviewed corrected router requirement to the active task contract.",
          }, { agent: "planner", sessionID: "planner", metadata() {} } as any)
          return { data: { info: {}, parts: [] } }
        },
      },
    }
    hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const result = await hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: "The active task contains a stale requirement that needs one exact owning-Planner replacement.",
      evidence: ["The current requirement no longer describes the corrected canonical router contract."],
      expected_results: ["The exact task requirements match the supplied complete final contract."],
      relevant_files: [data.taskPath, "src/a.ts", "tests/a.spec.ts"],
      required_scope: ["src/a.ts", "tests/a.spec.ts"],
      required_requirements: requirements,
      required_behavior: original.behavior,
      required_verify: original.verify,
      contract_mode: "merge",
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any) as any

    assert.match(result.output, /PLANNER RECOVERY COMPLETE/)
    assert.equal(promptCount, 2)
    assert.equal(plannerStatePrompts.length, 2)
    for (const stateText of plannerStatePrompts) {
      assert.match(stateText, /Planner recovery: active trusted recovery/)
      assert.match(stateText, /Next action: Planner must call revise_active_task now/)
      assert.doesNotMatch(stateText, /Next action: Executor must delegate one fresh Worker/)
    }
    assert.deepEqual(parsePlannerTask(readFileSync(join(data.root, data.taskPath), "utf8"))!.requirements, [
      ...original.requirements,
      ...requirements,
    ])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("pending explicit recovery continues once after Executor idles without calling the recovery tool again", async () => {
  const data = supersedeFixture()
  try {
    let hooks: Awaited<ReturnType<typeof WorkflowGuard>>
    let phase: "initial" | "idle-recovery" = "initial"
    let promptCount = 0
    const executorPrompts: string[] = []
    const original = parsePlannerTask(readFileSync(join(data.root, data.taskPath), "utf8"))!
    const requirements = ["Auth navigation uses the persisted corrected router contract."]
    const client = {
      session: {
        get: async () => ({ data: { id: "planner", directory: data.root } }),
        messages: async ({ path }: any) => ({ data: { data: path.id === "executor"
          ? phase === "initial"
            ? [{
                info: { id: "user-idle-recovery", role: "user" },
                parts: [{ type: "text", text: `Use the owning Planner with a merge correction contract for ${data.taskPath}.` }],
              }]
            : [{
                info: { id: "assistant-idle-recovery", role: "assistant", agent: "executor", finish: "stop", time: { completed: 1 } },
                parts: [{ type: "text", text: "Please continue the Planner manually." }],
              }]
          : [], cursor: {} } }),
        prompt: async () => {
          promptCount += 1
          if (phase === "initial") return { data: { info: {}, parts: [] } }
          await hooks["chat.message"]!({ sessionID: "planner", agent: "planner" } as any, {} as any)
          await hooks.tool!.revise_active_task.execute({
            task_path: data.taskPath,
            add_requirements: requirements,
            reason: "Add the persisted corrected router requirement during the trusted idle continuation.",
          }, { agent: "planner", sessionID: "planner", metadata() {} } as any)
          return { data: { info: {}, parts: [] } }
        },
        promptAsync: async ({ body }: any) => {
          executorPrompts.push(body.parts[0].text)
          return { data: {} }
        },
      },
    }
    hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const first = await hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: "The active task has one stale requirement that must be replaced by the persisted exact contract.",
      evidence: ["The current requirement differs from the reviewed corrected router contract."],
      expected_results: ["The registered active task exactly matches the supplied replacement sections."],
      relevant_files: [data.taskPath, "src/a.ts", "tests/a.spec.ts"],
      required_scope: ["src/a.ts", "tests/a.spec.ts"],
      required_requirements: requirements,
      required_behavior: original.behavior,
      required_verify: original.verify,
      contract_mode: "merge",
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any) as any
    assert.match(first.output, /PLANNER RECOVERY INCOMPLETE/)
    assert.equal(promptCount, 2)

    phase = "idle-recovery"
    hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "executor" } } } as any)

    const receipt = JSON.parse(readFileSync(join(data.root, ".task-doctor/planner-review.json"), "utf8"))
    assert.equal(receipt.status, "complete")
    assert.equal(receipt.automaticContinuationAttempts, 1)
    assert.equal(promptCount, 3)
    assert.deepEqual(parsePlannerTask(readFileSync(join(data.root, data.taskPath), "utf8"))!.requirements, [
      ...original.requirements,
      ...requirements,
    ])
    assert.equal(executorPrompts.length, 1)
    assert.match(executorPrompts[0], /PLANNER RECOVERY COMPLETE/)
    assert.match(executorPrompts[0], /Delegate one fresh Worker/)

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "executor" } } } as any)
    assert.equal(promptCount, 3)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("pending explicit recovery ignores reconstructed fields after an already-committed supersede transition", async () => {
  const data = supersedeFixture()
  try {
    let hooks: Awaited<ReturnType<typeof WorkflowGuard>>
    let promptCount = 0
    let latestUserText = `Use the owning Planner to revise ${data.taskPath} and supersede ${data.targetPath}.`
    const focusedTest = "tests/focused-recovery.spec.ts"
    const requirement = "Focused recovery behavior has executable regression coverage."
    const behavior = "Auth navigation reaches its route: client"
    const focusedVerify = "npm test -- focused-recovery.spec.ts"
    const client = {
      session: {
        get: async () => ({ data: { id: "planner", directory: data.root } }),
        messages: async ({ path }: any) => ({ data: { data: path.id === "executor" ? [{
          info: { id: latestUserText.startsWith("Use") ? "user-review" : "user-continue", role: "user" },
          parts: [{ type: "text", text: latestUserText }],
        }] : [], cursor: {} } }),
        prompt: async ({ body }: any) => {
          promptCount += 1
          await hooks["chat.message"]!({ sessionID: "planner", agent: "planner" } as any, {} as any)
          if (promptCount === 1) {
            await hooks.tool!.supersede_registered_task.execute({
              task_path: data.targetPath,
              reason: "The active task already covers the complete redundant auth-navigation contract.",
            }, { agent: "planner", sessionID: "planner", metadata() {} } as any)
            return { data: { info: {}, parts: [] } }
          }
          if (promptCount === 2) return { data: { info: {}, parts: [] } }
          assert.match(body.parts[0].text, /already complete and must not be repeated/)
          await hooks.tool!.revise_active_task.execute({
            task_path: data.taskPath,
            add_scope: [`NEW: ${focusedTest}`],
            add_requirements: [requirement],
            add_behavior: [behavior],
            verify: ["npm test -- a.spec.ts", focusedVerify],
            reason: "The resumed recovery now completes its persisted focused acceptance contract.",
          }, { agent: "planner", sessionID: "planner", metadata() {} } as any)
          return { data: { info: {}, parts: [] } }
        },
      },
    }
    const escalation = {
      task_path: data.taskPath,
      problem: "The active task needs focused acceptance coverage before another Worker may continue.",
      evidence: ["The existing broad suite is not focused evidence for the required navigation behavior."],
      expected_results: ["The final task has focused verification and the redundant task is superseded."],
      relevant_files: [data.taskPath, "src/a.ts"],
      required_scope: [`NEW: ${focusedTest}`],
      required_requirements: [requirement],
      required_behavior: [behavior],
      required_verify: [focusedVerify],
      supersede_tasks: [data.targetPath],
      contract_mode: "merge",
    }

    hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const first = await hooks.tool!.escalate_to_planner.execute(structuredClone(escalation), {
      agent: "executor", sessionID: "executor", metadata() {},
    } as any) as any
    assert.match(first.output, /PLANNER RECOVERY INCOMPLETE/)
    assert.ok(existsSync(join(data.root, "kanban/superseded/02-redundant.md")))
    const pendingReceipt = JSON.parse(readFileSync(join(data.root, ".task-doctor/planner-review.json"), "utf8"))
    assert.equal(pendingReceipt.status, "pending")
    const frozenContract = structuredClone(pendingReceipt.contract)

    latestUserText = "Continue the pending Executor recovery."
    hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const second = await hooks.tool!.escalate_to_planner.execute({
      task_path: data.taskPath,
      problem: escalation.problem,
      evidence: escalation.evidence,
      expected_results: escalation.expected_results,
      relevant_files: [data.taskPath],
      required_scope: ["src/hallucinated.ts"],
      required_requirements: ["A reconstructed requirement must not replace the frozen receipt."],
      required_behavior: ["A reconstructed behavior must not replace the frozen receipt: client"],
      required_verify: ["npm test -- hallucinated.spec.ts"],
      supersede_tasks: [data.taskPath],
      contract_mode: "replace",
    }, { agent: "executor", sessionID: "executor", metadata() {} } as any) as any
    assert.match(second.output, /PLANNER RECOVERY COMPLETE/)
    assert.equal(promptCount, 3)
    const completeReceipt = JSON.parse(readFileSync(join(data.root, ".task-doctor/planner-review.json"), "utf8"))
    assert.equal(completeReceipt.status, "complete")
    assert.equal(completeReceipt.contractMode, "merge")
    assert.deepEqual(completeReceipt.contract, frozenContract)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

for (const [label, options, expected] of [
  ["coverage gap", { missingRequirement: true }, /does not fully cover/],
  ["foreign owner", { foreignOwner: true }, /owned by this exact Planner session/],
  ["open dependent", { dependentTask: true }, /depends on it/],
] as const) {
  test(`supersede_registered_task rejects ${label} without partial mutation`, async () => {
    const data = supersedeFixture(options)
    try {
      const beforeTask = readFileSync(join(data.root, data.targetPath))
      const beforeRegistration = readFileSync(join(data.root, ".task-doctor/registrations/02-redundant.md.json"))
      const beforeState = readFileSync(join(data.root, ".task-doctor/state.json"))
      const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
      await assert.rejects(hooks.tool!.supersede_registered_task.execute({
        task_path: data.targetPath,
        reason: "The Planner is attempting to remove a redundant registered task through the trusted transition.",
      }, { agent: "planner", sessionID: "planner", metadata() {} } as any), expected)
      assert.deepEqual(readFileSync(join(data.root, data.targetPath)), beforeTask)
      assert.deepEqual(readFileSync(join(data.root, ".task-doctor/registrations/02-redundant.md.json")), beforeRegistration)
      assert.deepEqual(readFileSync(join(data.root, ".task-doctor/state.json")), beforeState)
      assert.equal(existsSync(join(data.root, "kanban/superseded/02-redundant.md")), false)
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  })
}

test("revise_active_task applies technical additions, ignores Behavior, and preserves active Doctor state", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks.tool!.register_planner_task.execute(taskArgs(data.taskPath), {
      agent: "planner",
      sessionID: "planner",
      metadata() {},
    } as any)
    const original = readFileSync(join(data.root, data.taskPath), "utf8")
    const originalHash = createHash("sha256").update(original).digest("hex")
    write(join(data.root, ".task-doctor/state.json"), JSON.stringify({
      version: 4,
      status: "started",
      taskPath: data.taskPath,
      taskHash: originalHash,
      snapshot: { "src/a.ts": "baseline" },
    }))
    await hooks["chat.message"]!({ sessionID: "planner", agent: "planner" } as any, {} as any)
    const result = await hooks.tool!.revise_active_task.execute({
      task_path: data.taskPath,
      add_scope: ["code/frontend/src/modules/auth/pages/LoginPage.tsx", "code/frontend/tests/auth.spec.ts"],
      add_requirements: ["Correct the LoginPage argument-count error."],
      add_behavior: ["Login navigation remains functional: client", "Login translation remains type-safe: state"],
      verify: ["npm test -- a.spec.ts", "npm --prefix code/frontend run test:e2e auth.spec.ts"],
      reason: "The global verifier reports a related scoped diagnostic that must be resolved in the active task.",
    }, { agent: "planner", sessionID: "planner", metadata() {} } as any) as any
    assert.match(result.output, /PLANNER TASK REVISED/)
    const revised = readFileSync(join(data.root, data.taskPath), "utf8")
    assert.match(revised, /code\/frontend\/src\/modules\/auth\/pages\/LoginPage\.tsx/)
    assert.doesNotMatch(revised, /## Behavior|Login navigation remains functional/)
    const state = JSON.parse(readFileSync(join(data.root, ".task-doctor/state.json"), "utf8"))
    assert.deepEqual(state.snapshot, { "src/a.ts": "baseline" })
    assert.equal(state.taskRevision.previousTaskHash, originalHash)
    assert.equal(state.taskHash, createHash("sha256").update(revised).digest("hex"))
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("revise_active_task canonicalizes complete legacy replacement Markdown", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks.tool!.register_planner_task.execute(taskArgs(data.taskPath), {
      agent: "planner",
      sessionID: "planner",
      metadata() {},
    } as any)
    const original = readFileSync(join(data.root, data.taskPath), "utf8")
    const originalHash = createHash("sha256").update(original).digest("hex")
    write(join(data.root, ".task-doctor/state.json"), JSON.stringify({
      version: 4,
      status: "started",
      taskPath: data.taskPath,
      taskHash: originalHash,
      snapshot: { "src/a.ts": "baseline" },
    }))
    const legacyReplacement = original
      .replace("title: Repair the application root imports", "title: Repair the application root imports exactly")
      .replace("## Scheduling", [
        "## Contract ownership",
        "",
        "Contract: frontend-consumer",
        "",
        "## Behavior",
        "",
        "- B1 Retired metadata must not survive: state",
        "",
        "## Scheduling",
      ].join("\n"))
    const result = await hooks.tool!.revise_active_task.execute({
      task_path: data.taskPath,
      replacement: legacyReplacement,
      reason: "Canonicalize the complete replacement while preserving its technical task content.",
    }, { agent: "planner", sessionID: "planner", metadata() {} } as any) as any

    assert.match(result.output, /PLANNER TASK REVISED/)
    const revised = readFileSync(join(data.root, data.taskPath), "utf8")
    assert.match(revised, /title: Repair the application root imports exactly/)
    assert.doesNotMatch(revised, /## Behavior|## Contract ownership|frontend-consumer|Retired metadata/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("the plugin module exports only the real OpenCode plugin entry", async () => {
  const module = await import("../plugins/workflow-guard.ts")
  assert.deepEqual(Object.keys(module), ["WorkflowGuard"])
})

test("register_planner_task ignores legacy Behavior without requiring test Scope", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    const result = await hooks.tool!.register_planner_task.execute({
      task_path: "kanban/todo/05-auth.md",
      title: "Repair auth navigation",
      outcome: "Login navigation uses a real router link.",
      scope: ["code/frontend/src/modules/auth/pages/LoginPage.tsx"],
      requirements: ["Preserve auth link semantics."],
      behavior: ["Forgot-password navigation reaches its route", "Login navigation reaches its route"],
      verify: ["npm --prefix code/frontend run test:i18n"],
    }, { agent: "planner", sessionID: "planner", metadata() {} } as any) as any
    assert.match(result.output, /PLANNER TASK REGISTERED/)
    assert.doesNotMatch(readFileSync(join(data.root, "kanban/todo/05-auth.md"), "utf8"), /## Behavior/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("Planner writes are redirected to the atomic tool and Doctor commands use project root", async () => {
  const data = fixture()
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client: {} } as any)
    await hooks["chat.message"]!({ sessionID: "planner", agent: "planner" } as any, {} as any)
    await assert.rejects(hooks["tool.execute.before"]!({ sessionID: "planner", tool: "write" } as any, {
      args: { filePath: join(data.root, data.taskPath), content: "# Another free-form draft\n" },
    } as any), /Call register_planner_task with only title, exact files, concrete done facts/)

    await hooks["chat.message"]!({ sessionID: "executor", agent: "executor" } as any, {} as any)
    const command = { args: { command: "npm run task:doctor:schedule", workdir: join(data.root, "src") } }
    await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "bash" } as any, command as any)
    assert.equal(command.args.workdir, data.root)

    const malformedPlannerSchedule = { args: { command: "npm run task:doctor:schedule --prefix code/frontend", workdir: join(data.root, "src") } }
    await hooks["tool.execute.before"]!({ sessionID: "planner", tool: "bash" } as any, malformedPlannerSchedule as any)
    assert.equal(malformedPlannerSchedule.args.command, "npm run task:doctor:schedule")
    assert.equal(malformedPlannerSchedule.args.workdir, data.root)

    const malformedScriptListing = { args: { command: "npm run --prefix code/frontend", workdir: join(data.root, "code/frontend") } }
    await hooks["tool.execute.before"]!({ sessionID: "planner", tool: "bash" } as any, malformedScriptListing as any)
    assert.equal(malformedScriptListing.args.command, "jq '.scripts' code/frontend/package.json")
    assert.equal(malformedScriptListing.args.workdir, data.root)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

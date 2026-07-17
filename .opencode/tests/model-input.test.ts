import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  CUSTOM_MODEL_TOOL_NAMES,
  formatModelInputError,
  repairModelInput,
} from "../lib/model-input.ts"
import { parsePlannerTask, renderPlannerTask } from "../lib/planner-task.ts"

test("accepts the preferred flat Planner task contract and ignores retired legacy metadata", () => {
  const preferred = repairModelInput("register_planner_task", {
    title: "Add one focused account test",
    paths: "src/account.ts, READ: src/contracts.ts, NEW: tests/account.test.ts",
    done: "- The account result is covered by one focused test.\n- Existing callers remain technically valid.",
    dependencies: "078-backend-test-settlement-status-mapping.md",
  })

  assert.deepEqual(preferred.issues, [])
  assert.deepEqual(preferred.value, {
    title: "Add one focused account test",
    files: ["src/account.ts", "READ: src/contracts.ts", "NEW: tests/account.test.ts"],
    done: [
      "The account result is covered by one focused test.",
      "Existing callers remain technically valid.",
    ],
    depends_on: ["078-backend-test-settlement-status-mapping.md"],
  })
  assert.ok(preferred.repairs.includes("renamed paths to files"))
  assert.ok(preferred.repairs.includes("renamed dependencies to depends_on"))

  const legacy = repairModelInput("register_planner_task", {
    taskPath: "kanban/todo/080-project-legacy-task.md",
    outcome: "One legacy structured task remains accepted during migration.",
    scope: ["src/legacy.ts"],
    requirements: ["Preserve the existing legacy registration path."],
    contract: "not-applicable",
    parallel: false,
    resources: ["repo"],
    behavior: [],
    memoryAction: "none",
    memoryReason: "No durable project knowledge changes.",
    verify: ["git diff --check"],
  })

  assert.deepEqual(legacy.issues, [])
  assert.equal(legacy.value.task_path, "kanban/todo/080-project-legacy-task.md")
  assert.deepEqual(legacy.value.scope, ["src/legacy.ts"])
  assert.deepEqual(legacy.value.requirements, ["Preserve the existing legacy registration path."])
  assert.equal("contract" in legacy.value, false)
  assert.equal("behavior" in legacy.value, false)
})

test("round-trips canonical read-only Context while legacy tasks default it to empty", () => {
  const draft = {
    title: "Use one existing contract",
    outcome: "The implementation consumes the established contract.",
    scope: ["src/consumer.ts", "NEW: tests/consumer.test.ts"],
    context: ["src/contracts.ts", "src/provider.ts"],
    requirements: ["Consume the existing provider contract."],
    parallel: false,
    dependsOn: [],
    resources: ["repo"],
    memoryAction: "none" as const,
    memoryReason: "No durable project knowledge changes.",
    verify: ["npm test", "git diff --check"],
  }
  const rendered = renderPlannerTask(draft)

  assert.match(rendered, /## Scope[\s\S]*## Context\n\n- src\/contracts\.ts\n- src\/provider\.ts[\s\S]*## Requirements/)
  assert.deepEqual(parsePlannerTask(rendered), draft)

  const legacyRendered = renderPlannerTask({ ...draft, context: [] })
  assert.doesNotMatch(legacyRendered, /## Context/)
  assert.deepEqual(parsePlannerTask(legacyRendered)?.context, [])
})

test("drops legacy review metadata from zero-argument technical completion", () => {
  const result = repairModelInput("submit_task_review", {
    task_path: "kanban/todo/07-task.md",
    verdict: "APPROVED",
    summary: "The implementation satisfies the exact task requirements.",
    reviewed_files: ["kanban/todo/07-task.md", "src/a.ts"],
    checks: ["Legacy model-authored checks are no longer part of the tool contract."],
    findings: "src/a.ts requires one concrete correction.",
  })

  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.value, {})
  assert.ok(result.repairs.includes("ignored unknown field task_path"))
  assert.ok(result.repairs.includes("ignored unknown field verdict"))
  assert.ok(result.repairs.includes("ignored unknown field summary"))
  assert.ok(result.repairs.includes("ignored unknown field reviewed_files"))
  assert.ok(result.repairs.includes("ignored unknown field checks"))
  assert.ok(result.repairs.includes("ignored unknown field findings"))
})

test("normalizes aliases, list text, enums, and booleans", () => {
  const review = repairModelInput("review_worker_help", {
    helpId: "h12",
    taskPath: "kanban/todo/01-task.md",
    decision: "Retry Worker",
    rootCause: "The original Worker repeated an ineffective action without changing its inputs.",
    retryStrategy: "Use a fresh Worker with a narrower evidence-driven recovery strategy.",
    expectedResults: "- The failing behavior is corrected.\n- The task passes Doctor verification.",
    files: "kanban/todo/01-task.md, src/a.ts",
  })
  assert.deepEqual(review.issues, [])
  assert.equal(review.value.help_id, "h12")
  assert.equal(review.value.decision, "retry_worker")
  assert.deepEqual(review.value.expected_results, ["The failing behavior is corrected.", "The task passes Doctor verification."])
  assert.deepEqual(review.value.reviewed_files, ["kanban/todo/01-task.md", "src/a.ts"])

  const dependency = repairModelInput("request_dependency_install_permission", {
    reason: "The registered task explicitly requires these development test packages.",
    path: "packages/client",
    dependencies: "workbox-precaching, workbox-routing",
    saveDev: "yes",
  })
  assert.deepEqual(dependency.issues, [])
  assert.equal(dependency.value.workspace, "packages/client")
  assert.deepEqual(dependency.value.packages, ["workbox-precaching", "workbox-routing"])
  assert.equal(dependency.value.dev, true)
})

test("omits blank optional scalar placeholders generically", () => {
  const review = repairModelInput("review_worker_help", {
    help_id: "",
    task_path: "kanban/todo/01-task.md",
    decision: "retry_worker",
    root_cause: "The Worker returned a technically invalid operation payload.",
    retry_strategy: "Delegate a fresh Worker using the current canonical tool contract.",
    expected_results: ["The Worker returns one technically valid canonical operation."],
    reviewed_files: ["kanban/todo/01-task.md", "src/a.ts"],
    contract_mode: " ",
  })

  assert.deepEqual(review.issues, [])
  assert.equal("help_id" in review.value, false)
  assert.equal("contract_mode" in review.value, false)
  assert.ok(review.repairs.includes("omitted empty optional field help_id"))
  assert.ok(review.repairs.includes("omitted empty optional field contract_mode"))

  const learning = repairModelInput("record_guard_learning", {
    violation_id: "\t",
    rule: "Follow the current canonical workflow instruction exactly.",
  })
  assert.deepEqual(learning.issues, [])
  assert.deepEqual(learning.value, {})
  assert.ok(learning.repairs.includes("ignored unknown field violation_id"))
  assert.ok(learning.repairs.includes("ignored unknown field rule"))
})

test("preserves technical replace inputs and ignores retired Behavior metadata", () => {
  const review = repairModelInput("review_worker_help", {
    taskPath: "kanban/todo/01-task.md",
    decision: "Planner Recovery",
    rootCause: "The active Scope and its required behavior contradict the reviewed application contract.",
    retryStrategy: "Replace the four task sections with the complete evidence-backed final contract.",
    expectedResults: ["The registered task contains only the complete corrected contract."],
    files: ["kanban/todo/01-task.md", "src/a.ts"],
    contractMode: "Replace",
    requiredScope: ["src/a.ts"],
    requiredRequirements: ["The established source contract remains intact."],
    requiredBehavior: [],
    requiredVerify: ["npm test -- a.spec.ts"],
  })

  assert.deepEqual(review.issues, [])
  assert.equal(review.value.contract_mode, "replace")
  assert.deepEqual(review.value.required_scope, ["src/a.ts"])
  assert.deepEqual(review.value.required_requirements, ["The established source contract remains intact."])
  assert.equal("required_behavior" in review.value, false)
  assert.ok(review.repairs.includes("ignored unknown field requiredBehavior"))
  assert.deepEqual(review.value.required_verify, ["npm test -- a.spec.ts"])
})

test("does not score or rewrite legacy Executor review prose", () => {
  const longStrategy = [
    "Read the current task-scoped UI and focused test before choosing a correction.",
    "Then use semantic locators and preserve the established routing contract. ".repeat(12),
  ].join(" ")
  const review = repairModelInput("review_worker_help", {
    help_id: "H16",
    task_path: "kanban/todo/01-task.md",
    decision: "retry_worker",
    root_cause: "The Worker changed only the test while the related page contract remained incomplete.",
    retry_strategy: longStrategy,
    expected_results: ["The scoped behavior passes the exact Doctor verification."],
    reviewed_files: ["kanban/todo/01-task.md", "src/a.ts"],
  })

  assert.deepEqual(review.issues, [])
  assert.equal(review.value.retry_strategy, longStrategy.trim())
  assert.ok(!review.repairs.some((repair) => repair.startsWith("truncated retry_strategy")))
})

test("accepts technically structured help without grading prose length", () => {
  const shortHelp = repairModelInput("request_executor_help", {
    task_path: "kanban/todo/01-task.md",
    category: "test_failure",
    problem: "The focused verification still fails after a distinct correction attempt.",
    attempted_actions: ["retried"],
    evidence: ["failed"],
    relevant_files: [],
    suggested_next_step: "Executor should inspect the exact evidence and choose the next safe workflow action.",
  })

  assert.deepEqual(shortHelp.issues, [])
  assert.deepEqual(shortHelp.value.attempted_actions, ["retried"])
  assert.deepEqual(shortHelp.value.evidence, ["failed"])

  const mechanicallyValidReview = repairModelInput("review_worker_help", {
    help_id: "H1",
    task_path: "kanban/todo/01-task.md",
    decision: "retry_worker",
    root_cause: "The Worker used stale evidence after the implementation state changed.",
    retry_strategy: "Read the current scoped files and choose a fresh evidence-driven correction.",
    expected_results: ["x".repeat(301)],
    reviewed_files: ["kanban/todo/01-task.md"],
  })

  assert.deepEqual(mechanicallyValidReview.issues, [])
  assert.deepEqual(mechanicallyValidReview.value.expected_results, ["x".repeat(301)])
})

test("parses wrapped JSON arguments and preserves exact multiline replacements", () => {
  const replacement = "---\ntitle: Corrected task\n---\n\n## Outcome\n\nA complete task body that is intentionally longer than one hundred characters and keeps its exact line breaks.\n"
  const result = repairModelInput("revise_active_task", JSON.stringify({
    arguments: {
      taskPath: "kanban/todo/01-task.md",
      content: replacement,
      reason: "Doctor lint found a task-definition error that requires Planner ownership.",
    },
  }))
  assert.deepEqual(result.issues, [])
  assert.equal(result.value.replacement, replacement)
  assert.ok(result.repairs.includes("parsed argument object from JSON text"))
  assert.ok(result.repairs.includes("unwrapped arguments"))
})

test("accepts a structured active-task revision without replacement Markdown", () => {
  const result = repairModelInput("revise_active_task", {
    taskPath: "kanban/todo/01-task.md",
    addScope: "src/a.ts, tests/a.spec.ts",
    requirements: ["Fix the exact scoped diagnostic."],
    behavior: ["The repaired behavior remains observable: state"],
    checks: ["npm test -- a.spec.ts"],
    reason: "The active task scope must include the files reported by Doctor verification.",
  })
  assert.deepEqual(result.issues, [])
  assert.equal(result.value.replacement, undefined)
  assert.deepEqual(result.value.add_scope, ["src/a.ts", "tests/a.spec.ts"])
  assert.deepEqual(result.value.add_requirements, ["Fix the exact scoped diagnostic."])
  assert.equal("add_behavior" in result.value, false)
  assert.ok(result.repairs.includes("ignored unknown field behavior"))
  assert.deepEqual(result.value.verify, ["npm test -- a.spec.ts"])
})

test("repairs over-escaped quotes in Verify without changing source payloads", () => {
  const behavior = String.raw`B1 Scenario: client - Login reaches the \\\"Register\\\" link.`
  const verify = String.raw`npm test -- auth.spec.ts --grep \\\"login succeeds\\\"`
  const revision = repairModelInput("revise_active_task", {
    task_path: "kanban/todo/01-task.md",
    add_behavior: [behavior],
    verify: [verify],
    reason: "The active task must preserve exact quoted labels in its observable contract.",
  })

  assert.deepEqual(revision.issues, [])
  assert.equal("add_behavior" in revision.value, false)
  assert.deepEqual(revision.value.verify, ['npm test -- auth.spec.ts --grep "login succeeds"'])
  assert.ok(revision.repairs.includes("ignored unknown field add_behavior"))
  assert.ok(revision.repairs.includes("unescaped over-escaped quotes in verify"))

  const source = String.raw`const label = \\\"Register\\\";`
  const edit = repairModelInput("edit", {
    filePath: "src/a.ts",
    oldString: "before",
    newString: source,
  })
  assert.equal(edit.value.newString, source)
})

test("parses unquoted JSON-like fields only when the known contract is unambiguous", () => {
  const result = repairModelInput("request_dependency_install_permission", [
    "reason: The active task explicitly requires this exact development dependency.",
    "workspace: code/frontend",
    "packages: [\"workbox-precaching\"]",
    "dev: true",
  ].join("\n"))
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.value, {
    reason: "The active task explicitly requires this exact development dependency.",
    workspace: "code/frontend",
    packages: ["workbox-precaching"],
    dev: true,
  })
  assert.ok(result.repairs.includes("parsed loose argument fields"))

  const ambiguous = repairModelInput("request_task_change_permission", [
    "task_path: kanban/todo/01-task.md",
    "reason: Doctor requires a precise correction before task start.",
    "old_text: first line",
    "reason: this line belongs to the exact old text",
    "new_text: replacement",
  ].join("\n"))
  assert.ok(ambiguous.issues.length > 0)
})

test("defaults only semantically safe empty lists", () => {
  const review = repairModelInput("submit_task_review", {
    task_path: "kanban/todo/01-task.md",
    verdict: "approved",
    summary: "The implementation satisfies all requirements without material findings.",
    reviewed_files: ["kanban/todo/01-task.md", "src/a.ts"],
    checks: ["First concrete check passes.", "Second concrete check passes.", "Third concrete check passes."],
  })
  assert.deepEqual(review.issues, [])
  assert.deepEqual(review.value, {})

  const escalationContinuation = repairModelInput("escalate_to_planner", {
    task_path: "kanban/todo/01-task.md",
  })
  assert.deepEqual(escalationContinuation.issues, [])
  assert.deepEqual(escalationContinuation.value, { task_path: "kanban/todo/01-task.md" })

  const emptyOptionalRecoveryLists = repairModelInput("escalate_to_planner", {
    task_path: "kanban/todo/01-task.md",
    problem: "The active task needs a corrected loader-resolved translation resource path.",
    evidence: ["The loader fetches the English bundle from the public i18n directory."],
    expected_results: ["The corrected task names the exact loader-resolved bundle path."],
    relevant_files: ["kanban/todo/01-task.md", "src/i18n/useTranslation.ts"],
    required_scope: [],
    required_requirements: [],
    required_behavior: [],
    required_verify: [],
    supersede_tasks: [],
  })
  assert.deepEqual(emptyOptionalRecoveryLists.issues, [])
  assert.equal("required_scope" in emptyOptionalRecoveryLists.value, false)
  assert.equal("required_requirements" in emptyOptionalRecoveryLists.value, false)
  assert.equal("required_behavior" in emptyOptionalRecoveryLists.value, false)
  assert.equal("required_verify" in emptyOptionalRecoveryLists.value, false)
  assert.equal("supersede_tasks" in emptyOptionalRecoveryLists.value, false)
  assert.ok(emptyOptionalRecoveryLists.repairs.includes("omitted empty optional field supersede_tasks"))
  assert.ok(emptyOptionalRecoveryLists.repairs.includes("ignored unknown field required_behavior"))
})

test("returns one actionable error instead of exposing type failures", () => {
  const result = repairModelInput("request_command_permission", {
    purpose: "Create the directory required by the active registered task.",
    command: ["mkdir", "src/new"],
    affected_paths: { path: "src/new" },
  })
  assert.ok(result.issues.includes("command must be string"))
  assert.match(formatModelInputError("request_command_permission", result), /^MODEL INPUT INVALID/m)
  assert.match(formatModelInputError("request_command_permission", result), /Retry this tool once/)
})

test("repairs common built-in file tool aliases before guard inspection", () => {
  const edit = repairModelInput("edit", {
    file_path: "src/a.ts",
    old_string: "before",
    new_string: "after",
    replace_all: "false",
  })
  assert.deepEqual(edit.issues, [])
  assert.deepEqual(edit.value, {
    filePath: "src/a.ts",
    oldString: "before",
    newString: "after",
    replaceAll: false,
  })
})

test("derives a missing task description from its prompt", () => {
  const result = repairModelInput("task", {
    prompt: "Resume kanban/todo/09-i18n-auth-migration.md from the authoritative active state.\nDo not restart the lifecycle.",
    subagent_type: "worker",
  })

  assert.deepEqual(result.issues, [])
  assert.equal(result.value.description, "Resume kanban/todo/09-i18n-auth-migration.md from the authoritative active state.")
  assert.ok(result.repairs.includes("derived description from prompt"))
})

test("normalizes a legacy preview alias without grading its prose", () => {
  const description = `Fix the exact Doctor finding. ${"Reasoning may be verbose without changing technical validity. ".repeat(40)}`
  const result = repairModelInput("preview_worker_changes", {
    task_path: "kanban/todo/01-task.md",
    purpose: description,
    operations: [{ kind: "replace", path: "src/a.ts", old_text: "before", new_text: "after" }],
  })

  assert.deepEqual(result.issues, [])
  assert.equal(result.value.description, description.trim())
  assert.equal(result.value.purpose, undefined)
  assert.ok(result.repairs.includes("renamed purpose to description"))
  assert.ok(!result.repairs.some((repair) => repair.startsWith("truncated description")))
})

test("accepts one flat Worker operation and preserves an empty source payload", () => {
  const result = repairModelInput("preview_worker_changes", {
    operationKind: "Replace",
    filePath: "src/a.ts",
    before: "before",
    after: "",
    expectedOccurrences: "1",
  })

  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.value, {
    kind: "replace",
    path: "src/a.ts",
    old_text: "before",
    new_text: "",
    expected_occurrences: 1,
  })
  assert.ok(result.repairs.includes("normalized kind"))
  assert.ok(result.repairs.includes("coerced expected_occurrences to number"))
})

test("accepts minimal context-derived workflow calls", () => {
  const taskContent = "---\ntitle: One task\n---\n"
  const calls: Array<[string, Record<string, unknown>]> = [
    ["register_planner_task", { content: taskContent }],
    ["preview_worker_changes", {}],
    ["apply_worker_changes", {}],
    ["review_worker_help", {}],
    ["submit_task_review", {}],
  ]

  for (const [toolName, input] of calls) {
    const result = repairModelInput(toolName, input)
    assert.deepEqual(result.issues, [], toolName)
  }
  assert.equal(repairModelInput("register_planner_task", { content: taskContent }).value.content, taskContent)
})

test("keeps legacy wrapped/direct workflow arguments compatible", () => {
  const preview = repairModelInput("preview_worker_changes", {
    arguments: {
      taskPath: "kanban/todo/01-task.md",
      purpose: "Legacy descriptive metadata remains accepted.",
      operation: { kind: "replace", path: "src/a.ts", old_text: "before", new_text: "after" },
    },
  })
  assert.deepEqual(preview.issues, [])
  assert.equal(preview.value.task_path, "kanban/todo/01-task.md")
  assert.equal(preview.value.description, "Legacy descriptive metadata remains accepted.")
  assert.deepEqual(preview.value.operations, [
    { kind: "replace", path: "src/a.ts", old_text: "before", new_text: "after" },
  ])

  const apply = repairModelInput("apply_worker_changes", {
    taskPath: "kanban/todo/01-task.md",
    changeId: "C-abcdef",
    token: "P-1234abcd",
  })
  assert.deepEqual(apply.issues, [])
  assert.deepEqual(apply.value, {
    task_path: "kanban/todo/01-task.md",
    change_id: "C-abcdef",
    preview_token: "P-1234abcd",
  })
})

test("omits malformed optional metadata so downstream context can self-heal", () => {
  const preview = repairModelInput("preview_worker_changes", {
    kind: "unsupported",
    path: "src/a.ts",
    description: { nested: "not a scalar" },
    content: "export const value = 1\n",
  })

  assert.deepEqual(preview.issues, [])
  assert.equal("kind" in preview.value, false)
  assert.equal("description" in preview.value, false)
  assert.ok(preview.repairs.includes("omitted invalid optional field kind"))
  assert.ok(preview.repairs.includes("omitted invalid optional field description"))
})

test("every custom tool accepts one complete canonical input", () => {
  const task = "kanban/todo/01-task.md"
  const files = [task, "src/a.ts"]
  const valid: Record<string, Record<string, unknown>> = {
    register_planner_task: {
      title: "Update one observable value",
      files: ["src/a.ts", "NEW: src/a.test.ts"],
      done: ["The exported value reflects the approved project behavior."],
      depends_on: [],
    },
    preview_worker_changes: {
      task_path: task,
      purpose: "Replace one exact source value through a reviewable transaction.",
      operations: [{ kind: "replace", path: "src/a.ts", old_text: "before", new_text: "after", expected_occurrences: 1 }],
    },
    apply_worker_changes: {
      task_path: task,
      change_id: "C-abcdef",
      preview_token: "P-1234abcd",
    },
    verify_worker_task: {},
    discard_worker_changes: {},
    revise_active_task: {
      replacement: "# Task\n\n## Scope\n- src/a.ts\n\n## Requirement\nKeep the corrected task explicit, observable, deterministic, and long enough for independent execution.\n",
    },
    supersede_registered_task: {},
    escalate_to_planner: {
      task_path: task,
      problem: "The active task definition does not provide the required observable contract.",
      evidence: ["Doctor rejected the task definition during its lint gate."],
      expected_results: ["The corrected task passes Doctor lint and registration."],
      relevant_files: files,
      required_scope: ["src/a.ts", "NEW: tests/a.spec.ts"],
      required_requirements: ["The corrected behavior has focused regression coverage."],
      required_verify: ["npm test -- a.spec.ts"],
      supersede_tasks: ["kanban/todo/02-redundant-task.md"],
    },
    recover_harness_baseline: {
      task_path: task,
      paths: ["AGENTS.md"],
      reason: "The Harness file changed independently from the active implementation task.",
    },
    recover_project_memory: {
      replacement: "# MEMORY.md\n\nOnly durable verified project facts remain.\n",
      reason: "Duplicate historical entries were condensed while durable project facts were preserved.",
    },
    append_task_memory: {
      entry: "The application root provides the shared i18n context through I18nProvider.",
    },
    request_executor_help: {
      task_path: task,
      category: "model_loop",
      problem: "The Worker repeated the same ineffective edit without changing the failing condition.",
      attempted_actions: ["Re-read the current file and narrowed the target edit once."],
      evidence: ["Three equivalent edit failures were returned for the same source location."],
      relevant_files: files,
      suggested_next_step: "Review the failure evidence and delegate a fresh Worker with a narrower strategy.",
    },
    review_worker_help: {
      help_id: "H1",
      task_path: task,
      decision: "retry_worker",
      root_cause: "The previous Worker retried stale source text after the file had already changed.",
      retry_strategy: "Use a fresh Worker that reads the current source before selecting its edit strategy.",
      expected_results: ["The current source is changed once and Doctor verification passes."],
      reviewed_files: files,
    },
    submit_task_review: {},
    record_guard_learning: {},
    request_command_permission: {
      purpose: "Create the exact directory required by the active registered task scope.",
      command: "mkdir -p src/new",
      affected_paths: ["src/new"],
    },
    request_task_change_permission: {
      task_path: task,
      reason: "Doctor lint requires one exact correction to the task definition before start.",
      old_text: "Old requirement.",
      new_text: "Corrected requirement.",
    },
    request_dependency_install_permission: {
      reason: "The active registered task explicitly requires this exact package.",
      workspace: "code/frontend",
      packages: ["workbox-precaching"],
      dev: true,
    },
  }

  assert.deepEqual(Object.keys(valid).sort(), CUSTOM_MODEL_TOOL_NAMES)
  for (const [toolName, input] of Object.entries(valid)) {
    assert.deepEqual(repairModelInput(toolName, input).issues, [], toolName)
  }
})

test("every custom plugin tool has a declared model-input contract", () => {
  const source = readFileSync(resolve(process.cwd(), ".opencode/plugins/workflow-guard.ts"), "utf8")
  const declared = [...source.matchAll(/^\s+([a-z][a-z0-9_]+): tool\(\{/gm)].map((match) => match[1]).sort()
  const directlyChecked = [...source.matchAll(/checkedModelArgs\("([a-z][a-z0-9_]+)"/g)].map((match) => match[1]).sort()
  assert.deepEqual(declared, CUSTOM_MODEL_TOOL_NAMES)
  assert.deepEqual(directlyChecked, CUSTOM_MODEL_TOOL_NAMES)
  assert.match(source, /"tool\.execute\.before"[\s\S]*?const checkedArgs = await checkedModelArgs\(input\.tool, output\.args, input\.sessionID\)/)
  assert.match(source, /output\.args = replaceModelArgsInPlace\(output\.args, checkedArgs\)/)
})

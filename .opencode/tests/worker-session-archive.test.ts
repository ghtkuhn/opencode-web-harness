import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { WorkflowGuard } from "../plugins/workflow-guard.ts"

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "worker-session-archive-"))
  const taskPath = "kanban/todo/01-task.md"
  const taskContent = [
    "# Task",
    "",
    "## Scope",
    "- `src/a.ts`",
    "",
    "## Requirement",
    "Keep the implementation deterministic and independently reviewable.",
    "",
  ].join("\n")
  write(join(root, "project.json"), JSON.stringify({
    settings: { opencode: { workflowGuard: { workerSessionArchive: true } } },
  }))
  write(join(root, "kanban/TASK.md"), "# Template\n")
  write(join(root, taskPath), taskContent)
  write(join(root, "src/a.ts"), "export const value = 1\n")
  write(join(root, "scripts/task-doctor.mjs"), "// Test fixture marker.\n")
  write(join(root, ".task-doctor/state.json"), `${JSON.stringify({
    version: 4,
    status: "started",
    taskPath,
    taskHash: digest(taskContent),
    snapshot: { "src/a.ts": "before" },
    memoryAction: "none",
    memoryReason: "none",
    contractOwnership: "not-applicable",
    risk: { required: false },
  }, null, 2)}\n`)
  return { root, taskPath, taskContent }
}

function reviewFixture() {
  const data = fixture()
  const sourcePath = "src/a.ts"
  const sourceBefore = "export const value = 1\n"
  const sourceAfter = "export const value = 2\n"
  const reportPath = ".task-doctor/reports/01-task.json"
  write(join(data.root, sourcePath), sourceAfter)
  write(join(data.root, reportPath), `${JSON.stringify({ changedFiles: [sourcePath] }, null, 2)}\n`)
  write(join(data.root, ".task-doctor/state.json"), `${JSON.stringify({
    version: 4,
    status: "passed",
    taskPath: data.taskPath,
    taskHash: digest(data.taskContent),
    snapshot: { [sourcePath]: digest(sourceBefore) },
    verifiedSnapshot: { [sourcePath]: digest(sourceAfter) },
    verifiedSnapshotHash: digest(sourceAfter),
    reportPath,
    memoryAction: "none",
    memoryReason: "none",
    contractOwnership: "not-applicable",
    risk: { required: false },
  }, null, 2)}\n`)
  write(join(data.root, "scripts/task-doctor.mjs"), [
    'import { mkdirSync, readFileSync, renameSync } from "node:fs"',
    'import { dirname } from "node:path"',
    'const [, , command, taskPath] = process.argv',
    'const path = ".task-doctor/state.json"',
    'const state = JSON.parse(readFileSync(path, "utf8"))',
    'if (state.status !== "passed" || state.taskPath !== taskPath) process.exit(1)',
    'if (command === "complete") {',
    '  const donePath = taskPath.replace("kanban/todo/", "kanban/done/")',
    '  mkdirSync(dirname(donePath), { recursive: true })',
    '  renameSync(taskPath, donePath)',
    '  console.log(`TASK DOCTOR: COMPLETED ${donePath}`)',
    '} else {',
    '  process.exit(1)',
    '}',
    "",
  ].join("\n"))
  return data
}

function blockedHandoff(taskPath: string) {
  return [
    "BLOCKED",
    `Task: ${taskPath}`,
    "Doctor status: started",
    "Failure: The active task needs Executor review before another Worker starts.",
    "Required owner: Executor",
  ].join("\n")
}

function workerResult(workerSessionID: string, taskPath: string) {
  const handoff = blockedHandoff(taskPath)
  return {
    handoff,
    output: {
      title: "Worker result",
      output: `<task id="${workerSessionID}" state="completed">\n<task_result>\n${handoff}\n</task_result>\n</task>`,
      metadata: { sessionId: workerSessionID },
    },
  }
}

function reviewableWorkerResult(workerSessionID: string, taskPath: string) {
  const handoff = [
    "REVIEWABLE",
    `Task: ${taskPath}`,
  ].join("\n")
  return {
    handoff,
    output: {
      title: "Worker result",
      output: `<task id="${workerSessionID}" state="completed">\n<task_result>\n${handoff}\n</task_result>\n</task>`,
      metadata: { sessionId: workerSessionID },
    },
  }
}

function opencodeClient(workerSessionID: string, handoff: string, onWorkerMessages?: () => void) {
  return {
    session: {
      get: async ({ path }: any) => ({
        data: {
          id: path.id,
          agent: "executor",
          providerID: "test-provider",
          modelID: "test-model",
        },
      }),
      messages: async ({ path }: any) => {
        assert.equal(path.id, workerSessionID)
        onWorkerMessages?.()
        return { data: [{
          info: {
            id: "assistant-worker",
            role: "assistant",
            parentID: "user-worker",
            agent: "worker",
            providerID: "test-provider",
            modelID: "test-model",
            time: { completed: Date.now() },
            finish: "stop",
          },
          parts: [{ type: "text", text: handoff }],
        }] }
      },
    },
  }
}

type CapturedRequest = {
  method: string | undefined
  pathname: string
  searchParams: URLSearchParams
  body: any
}

async function archiveServer(statusCode: number, onRequest?: () => void) {
  const requests: CapturedRequest[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const rawBody = Buffer.concat(chunks).toString("utf8")
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`)
    requests.push({
      method: request.method,
      pathname: url.pathname,
      searchParams: url.searchParams,
      body: rawBody ? JSON.parse(rawBody) : null,
    })
    onRequest?.()
    response.statusCode = statusCode
    response.setHeader("content-type", "application/json")
    response.end(statusCode >= 400
      ? JSON.stringify({ error: "archive failed" })
      : JSON.stringify({ id: "worker-archive" }))
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    requests,
    server,
    serverUrl: new URL(`http://127.0.0.1:${address.port}`),
  }
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushDetachedWork() {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function withInjectedArchive(
  client: ReturnType<typeof opencodeClient>,
  http: Awaited<ReturnType<typeof archiveServer>>,
) {
  ;(client.session as any).update = async (args: any) => {
    const url = new URL(`/session/${args.path.id}`, http.serverUrl)
    url.searchParams.set("directory", args.query.directory)
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args.body),
    })
    const body = await response.json()
    return response.ok ? { data: body } : { error: body }
  }
  return client
}

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(predicate(), true, message)
}

function completedAssistantMessage(sessionID: string) {
  return {
    info: {
      id: `assistant-${sessionID}`,
      sessionID,
      role: "assistant",
      agent: "worker",
      time: { created: Date.now() - 1000, completed: Date.now() - 500 },
      finish: "stop",
    },
    parts: [{ type: "text", text: "Worker finished." }],
  }
}

function workerTaskInput(taskPath: string) {
  return {
    sessionID: "executor",
    tool: "task",
    args: {
      description: `Execute ${taskPath}`,
      prompt: `Resume ${taskPath}`,
      subagent_type: "worker",
    },
  }
}

function delegationArgs(taskPath: string, sessionID?: string) {
  return {
    description: `Resume ${taskPath}`,
    prompt: `Resume ${taskPath}`,
    subagent_type: "worker",
    ...(sessionID === undefined ? {} : { session_id: sessionID }),
  }
}

function assertPersistedReviewableWorkers(root: string, taskPath: string, workerSessionIDs: string[]) {
  const store = JSON.parse(readFileSync(join(root, ".task-doctor/reviewable-worker-sessions.json"), "utf8"))
  assert.equal(store.version, 1)
  assert.deepEqual(store.sessions, workerSessionIDs.map((workerSessionID) => ({ taskPath, workerSessionID })))
  assert.equal(typeof store.updatedAt, "string")
}

function assertPersistedReviewableWorker(root: string, taskPath: string, workerSessionID: string) {
  assertPersistedReviewableWorkers(root, taskPath, [workerSessionID])
}

test("validated Worker return archives its child session exactly once", async () => {
  const data = fixture()
  const workerSessionID = "worker-archive"
  const result = workerResult(workerSessionID, data.taskPath)
  const events: string[] = []
  let validatedAtArchiveRequest = false
  const http = await archiveServer(200, () => {
    validatedAtArchiveRequest = result.output.metadata.workerReturnValidated === true
    events.push("archive-request")
  })
  try {
    const client = withInjectedArchive(
      opencodeClient(workerSessionID, result.handoff, () => events.push("worker-validation")),
      http,
    )
    const hooks = await WorkflowGuard({
      directory: data.root,
      worktree: data.root,
      client,
      serverUrl: http.serverUrl,
    } as any)

    await hooks["tool.execute.after"]!(workerTaskInput(data.taskPath) as any, result.output as any)
    await hooks["tool.execute.after"]!(workerTaskInput(data.taskPath) as any, result.output as any)

    assert.equal(result.output.metadata.workerReturnValidated, true)
    assert.equal(validatedAtArchiveRequest, true)
    assert.ok(events.indexOf("worker-validation") < events.indexOf("archive-request"))
    assert.equal(http.requests.length, 1)
    assert.equal(http.requests[0].method, "PATCH")
    assert.equal(http.requests[0].pathname, `/session/${workerSessionID}`)
    assert.equal(http.requests[0].searchParams.get("directory"), data.root)
    assert.deepEqual(Object.keys(http.requests[0].body), ["time"])
    assert.equal(Number.isFinite(http.requests[0].body.time?.archived), true)
    assert.ok(http.requests[0].body.time.archived > 0)
  } finally {
    await closeServer(http.server)
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("injected session update archives through the authenticated client without HTTP fallback", async () => {
  const data = fixture()
  const workerSessionID = "worker-injected-archive"
  const result = workerResult(workerSessionID, data.taskPath)
  const http = await archiveServer(200)
  const updates: any[] = []
  try {
    const client: any = opencodeClient(workerSessionID, result.handoff)
    client.session.update = async (args: any) => {
      updates.push(args)
      return { data: { id: workerSessionID } }
    }
    const hooks = await WorkflowGuard({
      directory: data.root,
      worktree: data.root,
      client,
      serverUrl: http.serverUrl,
    } as any)

    await hooks["tool.execute.after"]!(workerTaskInput(data.taskPath) as any, result.output as any)

    assert.equal(result.output.metadata.workerReturnValidated, true)
    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0].path, { id: workerSessionID })
    assert.deepEqual(updates[0].query, { directory: data.root })
    assert.deepEqual(Object.keys(updates[0].body), ["time"])
    assert.equal(Number.isFinite(updates[0].body.time?.archived), true)
    assert.equal(http.requests.length, 0)
  } finally {
    await closeServer(http.server)
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("archive HTTP 500 is best-effort and preserves the validated parent result", async () => {
  const data = fixture()
  const workerSessionID = "worker-archive-failure"
  const result = workerResult(workerSessionID, data.taskPath)
  const original = structuredClone(result.output)
  const http = await archiveServer(500)
  try {
    const client = withInjectedArchive(opencodeClient(workerSessionID, result.handoff), http)
    const hooks = await WorkflowGuard({
      directory: data.root,
      worktree: data.root,
      client,
      serverUrl: http.serverUrl,
    } as any)

    await assert.doesNotReject(() => hooks["tool.execute.after"]!(
      workerTaskInput(data.taskPath) as any,
      result.output as any,
    ))

    assert.deepEqual(result.output, {
      ...original,
      metadata: { ...original.metadata, workerReturnValidated: true },
    })
    assert.equal(http.requests.length, 1)
    assert.equal(http.requests[0].method, "PATCH")
    assert.equal(http.requests[0].pathname, `/session/${workerSessionID}`)
    assert.equal(Number.isFinite(http.requests[0].body.time?.archived), true)
  } finally {
    await closeServer(http.server)
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("plugin restart preserves a REVIEWABLE mapping until zero-argument technical completion", async () => {
  const data = reviewFixture()
  const workerSessionID = "worker-reviewable"
  const http = await archiveServer(200)
  try {
    const result = reviewableWorkerResult(workerSessionID, data.taskPath)
    const firstHooks = await WorkflowGuard({
      directory: data.root,
      worktree: data.root,
      client: withInjectedArchive(opencodeClient(workerSessionID, result.handoff), http),
      serverUrl: http.serverUrl,
    } as any)

    await firstHooks["tool.execute.after"]!(workerTaskInput(data.taskPath) as any, result.output as any)
    assert.equal(result.output.metadata.workerReturnValidated, true)
    assert.equal(http.requests.length, 0, "REVIEWABLE return stays available until technical completion")
    assertPersistedReviewableWorker(data.root, data.taskPath, workerSessionID)

    const restartedHooks = await WorkflowGuard({
      directory: data.root,
      worktree: data.root,
      client: withInjectedArchive(opencodeClient(workerSessionID, result.handoff), http),
      serverUrl: http.serverUrl,
    } as any)
    const completion = await restartedHooks.tool!.submit_task_review.execute(
      {},
      { agent: "executor", sessionID: "executor", metadata() {} } as any,
    )

    assert.match(completion.output, /TASK DOCTOR: COMPLETED/)
    assert.deepEqual(completion.metadata, {
      task: data.taskPath,
      completedPath: data.taskPath.replace("kanban/todo/", "kanban/done/"),
    })
    assert.equal(http.requests.length, 1)
    assert.equal(http.requests[0].method, "PATCH")
    assert.equal(http.requests[0].pathname, `/session/${workerSessionID}`)
    assert.equal(Number.isFinite(http.requests[0].body.time?.archived), true)
    assert.equal(existsSync(join(data.root, ".task-doctor/reviewable-worker-sessions.json")), false)
  } finally {
    await closeServer(http.server)
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("a Doctor-passed task cannot be delegated instead of technically completed", async () => {
  const data = reviewFixture()
  const workerSessionID = "worker-reviewable-no-redelegate"
  const http = await archiveServer(200)
  try {
    const result = reviewableWorkerResult(workerSessionID, data.taskPath)
    const hooks = await WorkflowGuard({
      directory: data.root,
      worktree: data.root,
      client: withInjectedArchive(opencodeClient(workerSessionID, result.handoff), http),
      serverUrl: http.serverUrl,
    } as any)

    await hooks["tool.execute.after"]!(workerTaskInput(data.taskPath) as any, result.output as any)
    const taskCall = { args: delegationArgs(data.taskPath) }
    await assert.rejects(
      () => hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task" } as any, taskCall as any),
      /passed Doctor[\s\S]*submit_task_review without arguments/,
    )
    assert.equal(http.requests.length, 0)
    assertPersistedReviewableWorker(data.root, data.taskPath, workerSessionID)
  } finally {
    await closeServer(http.server)
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("periodic maintenance is detached and archives one old completed idle Worker through the injected client", async () => {
  const data = fixture()
  const workerSessionID = "worker-maintenance-idle"
  const updates: any[] = []
  let listStarted = false
  let releaseList!: () => void
  const listGate = new Promise<void>((resolve) => {
    releaseList = resolve
  })
  const client: any = {
    session: {
      list: async () => {
        listStarted = true
        await listGate
        return { data: [{
          id: workerSessionID,
          parentID: "executor-old",
          agent: "worker",
          time: { updated: Date.now() - 2 * 60 * 60 * 1000 },
        }] }
      },
      status: async () => ({ data: { [workerSessionID]: { type: "idle" } } }),
      messages: async ({ path }: any) => ({ data: [completedAssistantMessage(path.id)] }),
      update: async (args: any) => {
        updates.push(args)
        return { data: { id: args.path.id } }
      },
    },
  }
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)

    await hooks["chat.message"]!({ sessionID: "executor-current", agent: "executor" } as any, {} as any)
    await waitFor(() => listStarted, "detached maintenance should start after chat.message returns")
    assert.equal(updates.length, 0, "chat.message must not await the blocked maintenance list call")

    releaseList()
    await waitFor(() => updates.length === 1, "the eligible Worker should be archived")

    assert.deepEqual(updates[0].path, { id: workerSessionID })
    assert.deepEqual(updates[0].query, { directory: data.root })
    assert.deepEqual(Object.keys(updates[0].body), ["time"])
    assert.equal(Number.isFinite(updates[0].body.time.archived), true)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("periodic maintenance archives explicitly aborted Workers but fails closed for protected and incomplete sessions", async () => {
  const data = fixture()
  const now = Date.now()
  const old = now - 2 * 60 * 60 * 1000
  const ids = {
    eligible: "worker-maintenance-eligible",
    busy: "worker-maintenance-busy",
    retry: "worker-maintenance-retry",
    current: "worker-maintenance-current",
    root: "worker-maintenance-root",
    planner: "planner-maintenance-child",
    young: "worker-maintenance-young",
    aborted: "worker-maintenance-aborted",
    incomplete: "worker-maintenance-incomplete",
    reviewable: "worker-maintenance-reviewable",
    helpPending: "worker-maintenance-help-pending",
    helpDelegated: "worker-maintenance-help-delegated",
    resumed: "worker-maintenance-resumed",
    unknownStatus: "worker-maintenance-unknown-status",
    missingAgent: "worker-maintenance-missing-agent",
  }
  write(join(data.root, "kanban/todo/other.md"), "# Other task\n")
  write(join(data.root, ".task-doctor/reviewable-worker-sessions.json"), `${JSON.stringify({
    version: 1,
    sessions: [{ taskPath: "kanban/todo/other.md", workerSessionID: ids.reviewable }],
    updatedAt: new Date().toISOString(),
  })}\n`)

  const sessions = [
    { id: ids.eligible, parentID: "executor", agent: "worker", time: { updated: old } },
    { id: ids.busy, parentID: "executor", agent: "worker", time: { updated: old } },
    { id: ids.retry, parentID: "executor", agent: "worker", time: { updated: old } },
    { id: ids.current, parentID: "executor", agent: "worker", time: { updated: old } },
    { id: ids.root, agent: "worker", time: { updated: old } },
    { id: ids.planner, parentID: "executor", agent: "planner", time: { updated: old } },
    { id: ids.young, parentID: "executor", agent: "worker", time: { updated: now } },
    { id: ids.aborted, parentID: "executor", agent: "worker", time: { updated: old } },
    { id: ids.incomplete, parentID: "executor", agent: "worker", time: { updated: old } },
    { id: ids.reviewable, parentID: "executor", agent: "worker", time: { updated: old } },
    { id: ids.helpPending, parentID: "executor", agent: "worker", time: { updated: old } },
    { id: ids.helpDelegated, parentID: "executor", agent: "worker", time: { updated: old } },
    { id: ids.resumed, parentID: "executor", agent: "worker", time: { updated: old } },
    { id: ids.unknownStatus, parentID: "executor", agent: "worker", time: { updated: old } },
    { id: ids.missingAgent, parentID: "executor", time: { updated: old } },
  ]
  const statuses = Object.fromEntries(Object.values(ids).map((id) => [id, { type: "idle" }]))
  statuses[ids.busy] = { type: "busy" }
  statuses[ids.retry] = { type: "retry", attempt: 1 }
  statuses[ids.unknownStatus] = { type: "paused" }
  const updates: any[] = []
  const client: any = {
    session: {
      get: async ({ path }: any) => ({ data: {
        id: path.id,
        agent: "executor",
        providerID: "test-provider",
        modelID: "test-model",
      } }),
      list: async () => ({ data: sessions }),
      status: async () => ({ data: statuses }),
      messages: async ({ path }: any) => ({
        data: path.id === ids.aborted
          ? [{ ...completedAssistantMessage(path.id), info: {
              ...completedAssistantMessage(path.id).info,
              finish: undefined,
              error: { name: "MessageAbortedError", data: { message: "The operation was aborted." } },
            } }]
          : path.id === ids.incomplete
          ? [{ ...completedAssistantMessage(path.id), info: {
              ...completedAssistantMessage(path.id).info,
              time: { created: old },
              finish: undefined,
            } }]
          : [completedAssistantMessage(path.id)],
      }),
      update: async (args: any) => {
        updates.push(args)
        return { data: { id: args.path.id } }
      },
    },
  }
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    const resumedTask = { args: delegationArgs(data.taskPath, ids.resumed) }
    await hooks["tool.execute.before"]!({ sessionID: "executor", tool: "task" } as any, resumedTask as any)
    write(join(data.root, ".task-doctor/worker-help.json"), `${JSON.stringify({
      version: 1,
      requests: [
        {
          id: "H1",
          status: "pending",
          taskPath: data.taskPath,
          taskHash: digest(data.taskContent),
          workerSessionID: ids.helpPending,
        },
        {
          id: "H2",
          status: "delegated",
          taskPath: data.taskPath,
          taskHash: digest(data.taskContent),
          workerSessionID: "worker-help-source",
          delegatedWorkerSessionID: ids.helpDelegated,
        },
      ],
      updatedAt: new Date().toISOString(),
    })}\n`)

    await hooks["chat.message"]!({ sessionID: ids.current, agent: "worker" } as any, {} as any)
    await waitFor(() => updates.length === 2, "only the completed and explicitly aborted unprotected Workers should be archived")
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.deepEqual(updates.map((entry) => entry.path.id), [ids.eligible, ids.aborted])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("failed detached maintenance is throttled instead of retrying on every chat message", async () => {
  const data = fixture()
  let listCalls = 0
  const warnings: any[] = []
  const client: any = {
    app: {
      log: async ({ body }: any) => {
        if (body.level === "warn") warnings.push(body)
        return { data: true }
      },
    },
    session: {
      list: async () => {
        listCalls += 1
        throw new Error("session list unavailable")
      },
      status: async () => ({ data: {} }),
      update: async () => ({ data: true }),
    },
  }
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    await hooks["chat.message"]!({ sessionID: "executor-one", agent: "executor" } as any, {} as any)
    await waitFor(() => warnings.length === 1, "the detached failure should be logged")

    await hooks["chat.message"]!({ sessionID: "executor-two", agent: "executor" } as any, {} as any)
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.equal(listCalls, 1)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("parallel terminal archive callers share one in-flight authenticated update", async () => {
  const data = fixture()
  const workerSessionID = "worker-archive-concurrent"
  const result = workerResult(workerSessionID, data.taskPath)
  let updateCalls = 0
  let releaseUpdate!: () => void
  const updateGate = new Promise<void>((resolve) => {
    releaseUpdate = resolve
  })
  const client: any = opencodeClient(workerSessionID, result.handoff)
  client.session.update = async () => {
    updateCalls += 1
    await updateGate
    return { data: { id: workerSessionID } }
  }
  try {
    const hooks = await WorkflowGuard({ directory: data.root, worktree: data.root, client } as any)
    const first = hooks["tool.execute.after"]!(workerTaskInput(data.taskPath) as any, structuredClone(result.output) as any)
    const second = hooks["tool.execute.after"]!(workerTaskInput(data.taskPath) as any, structuredClone(result.output) as any)

    await waitFor(() => updateCalls === 1, "parallel callers should start one archive update")
    releaseUpdate()
    await Promise.all([first, second])

    assert.equal(updateCalls, 1)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

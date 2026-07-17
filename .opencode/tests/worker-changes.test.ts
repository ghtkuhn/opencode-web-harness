import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  applyWorkerChanges,
  cleanupWorkerChangesForSession,
  discardWorkerChanges,
  persistWorkerChangeBaseline,
  previewWorkerChanges,
  readWorkerChangeBaseline,
  selectLatestPendingWorkerChange,
  type WorkerChangePolicy,
} from "../lib/worker-changes.ts"

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function digest(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex")
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "worker-changes-"))
  write(join(root, "src/a.ts"), "export const a = 1\n")
  write(join(root, "src/b.ts"), "export const b = 1\n")
  const policy: WorkerChangePolicy = {
    root,
    sessionID: "worker-1",
    taskPath: "kanban/todo/01-task.md",
    taskHash: "task-hash",
    scope: ["src"],
    newScope: ["src/new.ts"],
    protectedPaths: [".task-doctor", ".opencode"],
    readOnlyPaths: ["WORKER.md"],
  }
  return { root, policy }
}

const VALID_WIDGET_TSX = [
  "export const Widget = () => {",
  "  const value = 1;",
  "  return (",
  '    <section className="widget">',
  "      <h1>Ready</h1>",
  "      <p>{value}</p>",
  "    </section>",
  "  );",
  "};",
  "",
].join("\n")

const INVALID_WIDGET_TSX = VALID_WIDGET_TSX.replace("    </section>\n", "")

test("previews without touching the project and applies the exact previewed change", () => {
  const data = fixture()
  try {
    const preview = previewWorkerChanges(data.policy, "Update one constant and create its companion module.", [
      { kind: "replace", path: "src/a.ts", oldText: "a = 1", newText: "a = 2", expectedOccurrences: 1 },
      { kind: "create", path: "src/new.ts", content: "export const created = true\n" },
    ])

    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 1\n")
    assert.equal(existsSync(join(data.root, "src/new.ts")), false)
    assert.match(preview.id, /^C-[a-f0-9]{6}$/)
    assert.match(preview.previewToken, /^P-[a-f0-9]{8}$/)
    assert.match(preview.diff, /--- a\/src\/a\.ts/)
    assert.match(preview.diff, /\+export const a = 2/)
    assert.match(preview.diff, /\+\+\+ b\/src\/new\.ts/)

    const receipt = applyWorkerChanges(data.policy, preview.id, preview.previewToken)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 2\n")
    assert.equal(readFileSync(join(data.root, "src/new.ts"), "utf8"), "export const created = true\n")
    assert.deepEqual(receipt.files.map((file) => file.path), ["src/a.ts", "src/new.ts"])
    const storedReceipt = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-change-receipts", `${preview.id}.json`), "utf8"))
    assert.equal(storedReceipt.status, "applied")
    assert.equal("before" in storedReceipt.files[0], false)
    assert.equal("after" in storedReceipt.files[0], false)
    assert.equal(existsSync(join(data.root, ".task-doctor/worker-change-sets", `${preview.id}.json`)), false)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("allows a scoped technically valid rewrite regardless of its shrink ratio", () => {
  const data = fixture()
  const path = "src/large.ts"
  const before = `${Array.from({ length: 74 }, (_, index) => `export const line${index + 1} = ${index + 1}`).join("\n")}\n`
  const after = "export const compact = true\n"
  try {
    write(join(data.root, path), before)
    const preview = previewWorkerChanges(data.policy, "Replace one scoped module with compact valid content.", [{
      kind: "rewrite",
      path,
      content: after,
    }])

    assert.deepEqual(preview.paths, [path])
    assert.match(preview.diff, /\+export const compact = true/)
    assert.equal(readFileSync(join(data.root, path), "utf8"), before)
    assert.equal(existsSync(join(data.root, ".task-doctor/worker-change-sets", `${preview.id}.json`)), true)
    discardWorkerChanges(data.policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("allows a normal whole-file rewrite that preserves most of an existing file", () => {
  const data = fixture()
  const path = "src/LargeModule.tsx"
  const beforeLines = Array.from({ length: 30 }, (_, index) => `export const moduleLine${index + 1} = ${index + 1}`)
  const before = `${beforeLines.join("\n")}\n`
  const after = `${beforeLines.map((line, index) => index === 14 ? "export const moduleLine15 = 150" : line).join("\n")}\n`
  try {
    write(join(data.root, path), before)
    const preview = previewWorkerChanges(data.policy, "Update one value while preserving the complete module.", [{
      kind: "rewrite",
      path,
      content: after,
    }])

    assert.deepEqual(preview.paths, [path])
    assert.match(preview.diff, /\+export const moduleLine15 = 150/)
    assert.equal(readFileSync(join(data.root, path), "utf8"), before)
    discardWorkerChanges(data.policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("allows a scoped text rewrite with any size delta", () => {
  const data = fixture()
  const path = "src/notes.txt"
  const before = `${Array.from({ length: 20 }, (_, index) => `note ${index + 1}`).join("\n")}\n`
  try {
    assert.ok(Buffer.byteLength(before) < 256)
    write(join(data.root, path), before)
    const preview = previewWorkerChanges(data.policy, "Condense one small text fixture.", [{
      kind: "rewrite",
      path,
      content: "condensed\n",
    }])

    assert.deepEqual(preview.paths, [path])
    assert.equal(readFileSync(join(data.root, path), "utf8"), before)
    discardWorkerChanges(data.policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("previews create and delete operations using only technical constraints", () => {
  const data = fixture()
  const removedPath = "src/removed.ts"
  const createdPath = "src/new.ts"
  const removed = `${Array.from({ length: 74 }, (_, index) => `export const removedLine${index + 1} = ${index + 1}`).join("\n")}\n`
  const policy = { ...data.policy, newScope: [createdPath] }
  try {
    write(join(data.root, removedPath), removed)
    const preview = previewWorkerChanges(policy, "Replace one obsolete module with one small declared companion.", [
      { kind: "delete", path: removedPath },
      { kind: "create", path: createdPath, content: "export const created = true\n" },
    ])

    assert.deepEqual(preview.paths, [removedPath, createdPath])
    assert.equal(readFileSync(join(data.root, removedPath), "utf8"), removed)
    assert.equal(existsSync(join(data.root, createdPath)), false)
    discardWorkerChanges(policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("rejects malformed JSX without changing project bytes or storing a preview", () => {
  const data = fixture()
  const path = "src/Widget.tsx"
  try {
    write(join(data.root, path), VALID_WIDGET_TSX)
    assert.throws(() => previewWorkerChanges(data.policy, "syntax", [{
      kind: "rewrite",
      path,
      content: INVALID_WIDGET_TSX,
    }]), /Worker source syntax validation failed before preview storage:/)
    assert.equal(readFileSync(join(data.root, path), "utf8"), VALID_WIDGET_TSX)
    const storage = join(data.root, ".task-doctor/worker-change-sets")
    assert.deepEqual(existsSync(storage) ? readdirSync(storage) : [], [])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("accepts a technically valid JSX rewrite without synthesizing extra edits", () => {
  const data = fixture()
  const path = "src/Widget.tsx"
  const after = VALID_WIDGET_TSX.replace("<h1>Ready</h1>", "<h1>Updated</h1>")
  try {
    write(join(data.root, path), VALID_WIDGET_TSX)
    const preview = previewWorkerChanges(data.policy, "x", [{ kind: "rewrite", path, content: after }])
    assert.deepEqual(preview.inputRepairs, [])
    assert.match(preview.diff, /\+      <h1>Updated<\/h1>/)
    assert.equal(readFileSync(join(data.root, path), "utf8"), VALID_WIDGET_TSX)
    discardWorkerChanges(data.policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("gives generic guidance when an operation leaves an invalid source baseline unchanged", () => {
  const data = fixture()
  const path = "src/Widget.tsx"
  try {
    write(join(data.root, path), INVALID_WIDGET_TSX)
    assert.throws(() => previewWorkerChanges(data.policy, "x", [{
      kind: "replace",
      path,
      oldText: "  const value = 1;",
      newText: "  const value = 2;",
      expectedOccurrences: 1,
    }]), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /ALREADY INVALID BASELINE \(UNCHANGED\): src\/Widget\.tsx already had syntax errors before this preview/)
      assert.match(error.message, /left the same syntax diagnostics unchanged even if their source positions moved\./)
      assert.match(error.message, /Submit an operation set whose aggregated final file is syntactically valid; partial previews cannot be stored\./)
      return true
    })
    assert.equal(readFileSync(join(data.root, path), "utf8"), INVALID_WIDGET_TSX)
    const storage = join(data.root, ".task-doctor/worker-change-sets")
    assert.deepEqual(existsSync(storage) ? readdirSync(storage) : [], [])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("distinguishes a partial repair that changes but does not clear an invalid baseline", () => {
  const data = fixture()
  try {
    write(join(data.root, "src/a.ts"), "export const a = {\n")
    assert.throws(() => previewWorkerChanges(data.policy, "Attempt a different but still incomplete syntax repair.", [{
      kind: "rewrite",
      path: "src/a.ts",
      content: "export const a: = true\n",
    }]), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /ALREADY INVALID BASELINE \(PARTIAL REPAIR\): src\/a\.ts already had syntax errors before this preview\./)
      assert.match(error.message, /changed the diagnostics but its aggregated final content is still syntactically invalid\./)
      assert.match(error.message, /Submit an operation set whose aggregated final file is syntactically valid; partial previews cannot be stored\./)
      return true
    })
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = {\n")
    const storage = join(data.root, ".task-doctor/worker-change-sets")
    assert.deepEqual(existsSync(storage) ? readdirSync(storage) : [], [])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("accepts an operation set whose aggregated source result is syntactically valid", () => {
  const data = fixture()
  const path = "src/Widget.tsx"
  try {
    write(join(data.root, path), INVALID_WIDGET_TSX)
    const preview = previewWorkerChanges(data.policy, "ok", [
      {
        kind: "replace",
        path,
        oldText: "  const value = 1;",
        newText: "  const value = 2;",
        expectedOccurrences: 1,
      },
      {
        kind: "replace",
        path,
        oldText: "      <p>{value}</p>\n  );",
        newText: "      <p>{value}</p>\n    </section>\n  );",
        expectedOccurrences: 1,
      },
    ])

    assert.deepEqual(preview.paths, [path])
    assert.match(preview.diff, /\+  const value = 2;/)
    assert.match(preview.diff, /\+    <\/section>/)
    assert.equal(readFileSync(join(data.root, path), "utf8"), INVALID_WIDGET_TSX)
    discardWorkerChanges(data.policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("labels syntax damage from a valid source baseline as introduced by the preview", () => {
  const data = fixture()
  const path = "src/Widget.tsx"
  try {
    write(join(data.root, path), VALID_WIDGET_TSX)
    assert.throws(() => previewWorkerChanges(data.policy, "syntax", [{
      kind: "rewrite",
      path,
      content: INVALID_WIDGET_TSX,
    }]), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /PREVIEW INTRODUCED SYNTAX ERRORS: src\/Widget\.tsx was syntactically valid or did not exist before this preview\./)
      assert.doesNotMatch(error.message, /ALREADY INVALID BASELINE/)
      return true
    })
    assert.equal(readFileSync(join(data.root, path), "utf8"), VALID_WIDGET_TSX)
    const storage = join(data.root, ".task-doctor/worker-change-sets")
    assert.deepEqual(existsSync(storage) ? readdirSync(storage) : [], [])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("validates every co-created TS, JS, and JSX final while leaving non-code content alone", () => {
  const data = fixture()
  try {
    const panelPath = "src/Panel.tsx"
    const scriptPath = "src/new.js"
    const typesPath = "src/new.ts"
    const viewPath = "src/NewView.jsx"
    const notesPath = "src/notes.txt"
    write(join(data.root, panelPath), VALID_WIDGET_TSX)
    write(join(data.root, notesPath), "const deliberatelyUnparsed = {\n")
    const policy = {
      ...data.policy,
      newScope: [scriptPath, typesPath, viewPath],
    }
    const preview = previewWorkerChanges(policy, "Preview valid source companions and opaque notes together.", [
      {
        kind: "rewrite",
        path: panelPath,
        content: VALID_WIDGET_TSX.replace("<h1>Ready</h1>", "<h1>Updated</h1>"),
      },
      { kind: "create", path: scriptPath, content: "export const scriptValue = { ready: true }\n" },
      { kind: "create", path: typesPath, content: "export type Ready = { ready: true }\n" },
      { kind: "create", path: viewPath, content: "export const NewView = () => <section>Ready</section>\n" },
      { kind: "rewrite", path: notesPath, content: "const stillDeliberatelyUnparsed = {\n" },
    ])

    assert.deepEqual(preview.paths, [panelPath, scriptPath, typesPath, viewPath, notesPath])
    assert.equal(readFileSync(join(data.root, panelPath), "utf8"), VALID_WIDGET_TSX)
    assert.equal(readFileSync(join(data.root, notesPath), "utf8"), "const deliberatelyUnparsed = {\n")
    assert.equal(existsSync(join(data.root, scriptPath)), false)
    assert.equal(existsSync(join(data.root, typesPath)), false)
    assert.equal(existsSync(join(data.root, viewPath)), false)
    discardWorkerChanges(policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("checks only the aggregated final source content and skips deleted source bytes", () => {
  const valid = fixture()
  try {
    const preview = previewWorkerChanges(valid.policy, "Repair a transiently invalid edit within one final transaction.", [
      { kind: "replace", path: "src/a.ts", oldText: "a = 1", newText: "a = {", expectedOccurrences: 1 },
      { kind: "replace", path: "src/a.ts", oldText: "a = {", newText: "a = 2", expectedOccurrences: 1 },
    ])
    assert.match(preview.diff, /\+export const a = 2/)
    assert.equal(readFileSync(join(valid.root, "src/a.ts"), "utf8"), "export const a = 1\n")
    discardWorkerChanges(valid.policy, preview.id)
  } finally {
    rmSync(valid.root, { recursive: true, force: true })
  }

  const deleted = fixture()
  try {
    const malformed = "export const alreadyBroken = {\n"
    writeFileSync(join(deleted.root, "src/a.ts"), malformed)
    const preview = previewWorkerChanges(deleted.policy, "Delete the malformed source declared by the task.", [
      { kind: "delete", path: "src/a.ts" },
    ])
    assert.match(preview.diff, /--- a\/src\/a\.ts/)
    assert.equal(readFileSync(join(deleted.root, "src/a.ts"), "utf8"), malformed)
    discardWorkerChanges(deleted.policy, preview.id)
  } finally {
    rmSync(deleted.root, { recursive: true, force: true })
  }
})

test("rejects a malformed co-created source without persisting the valid companion", () => {
  const data = fixture()
  try {
    const scriptPath = "src/entry.js"
    const brokenPath = "src/broken.ts"
    const policy = { ...data.policy, newScope: [scriptPath, brokenPath] }
    assert.throws(() => previewWorkerChanges(policy, "Create two source companions only when both parse.", [
      { kind: "create", path: scriptPath, content: "export const entry = true\n" },
      { kind: "create", path: brokenPath, content: "export const broken: = true\n" },
    ]), /src\/broken\.ts:1:\d+ TS1110: Type expected\./)
    assert.equal(existsSync(join(data.root, scriptPath)), false)
    assert.equal(existsSync(join(data.root, brokenPath)), false)
    const storage = join(data.root, ".task-doctor/worker-change-sets")
    assert.deepEqual(existsSync(storage) ? readdirSync(storage) : [], [])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("rejects malformed JavaScript and JSX finals with their exact source paths", () => {
  const cases = [
    {
      path: "src/broken.js",
      content: "export const broken = {\n",
      diagnostic: /src\/broken\.js:2:1 TS1005: '\}' expected\./,
    },
    {
      path: "src/BrokenView.jsx",
      content: "export const BrokenView = () => <section>\n",
      diagnostic: /src\/BrokenView\.jsx:1:\d+ TS17008: JSX element 'section' has no corresponding closing tag\./,
    },
  ]

  for (const item of cases) {
    const data = fixture()
    try {
      const policy = { ...data.policy, newScope: [item.path] }
      assert.throws(() => previewWorkerChanges(policy, `Reject malformed ${item.path} source content.`, [
        { kind: "create", path: item.path, content: item.content },
      ]), item.diagnostic)
      assert.equal(existsSync(join(data.root, item.path)), false)
      const storage = join(data.root, ".task-doctor/worker-change-sets")
      assert.deepEqual(existsSync(storage) ? readdirSync(storage) : [], [])
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  }
})

test("parse-checks MTS, CTS, MJS, and CJS with extension-appropriate syntax", () => {
  const cases = [
    { path: "src/broken.mts", content: "export const broken: = true\n", diagnostic: /src\/broken\.mts:1:\d+ TS1110: Type expected\./ },
    { path: "src/broken.cts", content: "export const broken: = true\n", diagnostic: /src\/broken\.cts:1:\d+ TS1110: Type expected\./ },
    { path: "src/broken.mjs", content: "export const broken: number = 1\n", diagnostic: /src\/broken\.mjs:1:\d+ TS8010: Type annotations can only be used in TypeScript files\./ },
    { path: "src/broken.cjs", content: "const broken: number = 1\n", diagnostic: /src\/broken\.cjs:1:\d+ TS8010: Type annotations can only be used in TypeScript files\./ },
  ]

  for (const item of cases) {
    const data = fixture()
    try {
      const policy = { ...data.policy, newScope: [item.path] }
      assert.throws(() => previewWorkerChanges(policy, `Reject invalid ${item.path} syntax.`, [
        { kind: "create", path: item.path, content: item.content },
      ]), item.diagnostic)
      assert.equal(existsSync(join(data.root, item.path)), false)
      const storage = join(data.root, ".task-doctor/worker-change-sets")
      assert.deepEqual(existsSync(storage) ? readdirSync(storage) : [], [])
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  }
})

test("accepts valid typed MTS and CTS plus plain MJS and CJS finals", () => {
  const data = fixture()
  const paths = ["src/typed.mts", "src/typed.cts", "src/plain.mjs", "src/plain.cjs"]
  try {
    const policy = { ...data.policy, newScope: paths }
    const preview = previewWorkerChanges(policy, "Preview valid module variants.", [
      { kind: "create", path: paths[0], content: "export const typed: number = 1\n" },
      { kind: "create", path: paths[1], content: "export const typed: number = 1\n" },
      { kind: "create", path: paths[2], content: "export const plain = 1\n" },
      { kind: "create", path: paths[3], content: "module.exports = { plain: 1 }\n" },
    ])

    assert.deepEqual(preview.paths, paths)
    for (const path of paths) assert.equal(existsSync(join(data.root, path)), false)
    discardWorkerChanges(policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("rejects invalid JSON rewrites and creates before preview storage", () => {
  const data = fixture()
  const existingPath = "src/config.json"
  const createdPath = "src/new.json"
  const before = "{\"ready\":true}\n"
  try {
    write(join(data.root, existingPath), before)
    const policy = { ...data.policy, newScope: [createdPath] }

    assert.throws(() => previewWorkerChanges(policy, "Rewrite invalid JSON.", [
      { kind: "rewrite", path: existingPath, content: "{\"ready\":}\n" },
    ]), /Worker JSON syntax validation failed before preview storage: src\/config\.json:/)
    assert.equal(readFileSync(join(data.root, existingPath), "utf8"), before)

    assert.throws(() => previewWorkerChanges(policy, "Create invalid JSON.", [
      { kind: "create", path: createdPath, content: "[1,]\n" },
    ]), /Worker JSON syntax validation failed before preview storage: src\/new\.json:/)
    assert.equal(existsSync(join(data.root, createdPath)), false)
    const storage = join(data.root, ".task-doctor/worker-change-sets")
    assert.deepEqual(existsSync(storage) ? readdirSync(storage) : [], [])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("accepts arbitrary valid JSON values for rewrite and create operations", () => {
  const data = fixture()
  const existingPath = "src/config.json"
  const createdPath = "src/new.json"
  try {
    write(join(data.root, existingPath), "{\"before\":true}\n")
    const policy = { ...data.policy, newScope: [createdPath] }
    const preview = previewWorkerChanges(policy, "Preview valid JSON values.", [
      { kind: "rewrite", path: existingPath, content: "[1,{\"nested\":null}]\n" },
      { kind: "create", path: createdPath, content: "\"ready\"\n" },
    ])

    assert.deepEqual(preview.paths, [existingPath, createdPath])
    assert.equal(readFileSync(join(data.root, existingPath), "utf8"), "{\"before\":true}\n")
    assert.equal(existsSync(join(data.root, createdPath)), false)
    discardWorkerChanges(policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("fails only source previews closed when the Harness-local TypeScript parser is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-changes-no-parser-"))
  try {
    const moduleURL = pathToFileURL(join(process.cwd(), ".opencode/lib/worker-changes.ts")).href
    const script = [
      `import { discardWorkerChanges, previewWorkerChanges } from ${JSON.stringify(moduleURL)}`,
      "import { existsSync, mkdirSync, writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "const root = process.cwd()",
      "mkdirSync(join(root, 'src'), { recursive: true })",
      "writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\\n')",
      "writeFileSync(join(root, 'src/notes.txt'), 'opaque before\\n')",
      "const policy = { root, sessionID: 'worker', taskPath: 'kanban/todo/task.md', taskHash: 'hash', scope: ['src'], newScope: [], protectedPaths: ['.task-doctor'], readOnlyPaths: [] }",
      "let sourceError = ''",
      "try { previewWorkerChanges(policy, 'Preview a source change without an installed parser.', [{ kind: 'rewrite', path: 'src/a.ts', content: 'export const a = 2\\n' }]) } catch (error) { sourceError = error instanceof Error ? error.message : String(error) }",
      "const sourceStored = existsSync(join(root, '.task-doctor/worker-change-sets'))",
      "const text = previewWorkerChanges(policy, 'Preview opaque non-source content without a parser.', [{ kind: 'rewrite', path: 'src/notes.txt', content: 'const opaque = {\\n' }])",
      "discardWorkerChanges(policy, text.id)",
      "const deleted = previewWorkerChanges(policy, 'Preview deletion of source bytes without parsing removed content.', [{ kind: 'delete', path: 'src/a.ts' }])",
      "discardWorkerChanges(policy, deleted.id)",
      "process.stdout.write(JSON.stringify({ sourceError, sourceStored, textAccepted: Boolean(text.id), deleteAccepted: Boolean(deleted.id) }))",
    ].join("\n")
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
    })

    assert.equal(result.status, 0, result.stderr)
    const observed = JSON.parse(result.stdout)
    assert.match(observed.sourceError, /WORKER CHANGE SYNTAX CHECK UNAVAILABLE for src\/a\.ts:/)
    assert.match(observed.sourceError, /No preview was stored\./)
    assert.equal(observed.sourceStored, false)
    assert.equal(observed.textAccepted, true)
    assert.equal(observed.deleteAccepted, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("loads TypeScript from the target project's Harness dependencies before root dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-changes-harness-parser-"))
  try {
    const sourceHarnessTypeScript = join(process.cwd(), ".opencode/node_modules/typescript")
    assert.equal(existsSync(sourceHarnessTypeScript), true)
    write(join(root, "node_modules/typescript/package.json"), JSON.stringify({ name: "typescript", main: "index.js" }))
    write(join(root, "node_modules/typescript/index.js"), "module.exports = {}\n")
    mkdirSync(join(root, ".opencode/node_modules"), { recursive: true })
    symlinkSync(sourceHarnessTypeScript, join(root, ".opencode/node_modules/typescript"), "dir")

    const moduleURL = pathToFileURL(join(process.cwd(), ".opencode/lib/worker-changes.ts")).href
    const script = [
      `import { discardWorkerChanges, previewWorkerChanges } from ${JSON.stringify(moduleURL)}`,
      "import { mkdirSync, writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "const root = process.cwd()",
      "mkdirSync(join(root, 'src'), { recursive: true })",
      "writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\\n')",
      "const policy = { root, sessionID: 'worker', taskPath: 'kanban/todo/task.md', taskHash: 'hash', scope: ['src'], newScope: [], protectedPaths: ['.task-doctor', '.opencode'], readOnlyPaths: [] }",
      "const preview = previewWorkerChanges(policy, 'Use the Harness-local parser.', [{ kind: 'rewrite', path: 'src/a.ts', content: 'export const a: number = 2\\n' }])",
      "discardWorkerChanges(policy, preview.id)",
      "process.stdout.write(JSON.stringify({ previewStored: Boolean(preview.id) }))",
    ].join("\n")
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { previewStored: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("persists exact Unicode and CRLF before bytes privately without adding them to the receipt", () => {
  const data = fixture()
  try {
    const before = Buffer.from('export const greeting = "Grüße 🌍"\r\n', "utf8")
    writeFileSync(join(data.root, "src/a.ts"), before)
    const preview = previewWorkerChanges(data.policy, "Update the greeting while preserving an exact recovery baseline.", [
      { kind: "rewrite", path: "src/a.ts", content: 'export const greeting = "Hello"\n' },
    ])

    assert.equal(readWorkerChangeBaseline(data.root, digest(before)), null)
    applyWorkerChanges(data.policy, preview.id, preview.previewToken)

    const hash = digest(before)
    const directory = join(data.root, ".task-doctor/worker-change-baselines")
    const blobPath = join(directory, `${hash}.blob`)
    assert.deepEqual(readFileSync(blobPath), before)
    assert.deepEqual(readWorkerChangeBaseline(data.root, hash), before)
    assert.equal(statSync(directory).mode & 0o777, 0o700)
    assert.equal(statSync(blobPath).mode & 0o777, 0o600)

    const receipt = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-change-receipts", `${preview.id}.json`), "utf8"))
    assert.deepEqual(Object.keys(receipt.files[0]).sort(), ["afterHash", "afterMode", "beforeHash", "beforeMode", "path"])
    assert.equal(JSON.stringify(receipt).includes(before.toString("utf8")), false)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("deduplicates identical before baselines by content hash", () => {
  const data = fixture()
  try {
    const before = "export const shared = 'Grüße'\r\n"
    writeFileSync(join(data.root, "src/a.ts"), before)
    writeFileSync(join(data.root, "src/b.ts"), before)
    const preview = previewWorkerChanges(data.policy, "Update two files with one shared immutable baseline blob.", [
      { kind: "rewrite", path: "src/a.ts", content: "export const a = 2\n" },
      { kind: "rewrite", path: "src/b.ts", content: "export const b = 2\n" },
    ])

    applyWorkerChanges(data.policy, preview.id, preview.previewToken)
    const persisted = persistWorkerChangeBaseline(data.root, before)
    assert.deepEqual(persisted, {
      hash: digest(before),
      path: join(data.root, ".task-doctor/worker-change-baselines", `${digest(before)}.blob`),
    })
    assert.deepEqual(readdirSync(join(data.root, ".task-doctor/worker-change-baselines")), [`${digest(before)}.blob`])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("rejects a corrupt existing baseline blob before mutating any project file", () => {
  const data = fixture()
  try {
    const before = readFileSync(join(data.root, "src/a.ts"))
    const preview = previewWorkerChanges(data.policy, "Prepare a change whose persisted recovery baseline is corrupt.", [
      { kind: "rewrite", path: "src/a.ts", content: "export const a = 9\n" },
    ])
    const directory = join(data.root, ".task-doctor/worker-change-baselines")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `${digest(before)}.blob`), "corrupt baseline")

    assert.throws(
      () => applyWorkerChanges(data.policy, preview.id, preview.previewToken),
      /baseline blob is corrupt/,
    )
    assert.deepEqual(readFileSync(join(data.root, "src/a.ts")), before)
    assert.equal(existsSync(join(data.root, ".task-doctor/worker-change-sets", `${preview.id}.json`)), true)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("rejects a symlinked baseline directory before writing outside the project or mutating a target", () => {
  const data = fixture()
  const outside = mkdtempSync(join(tmpdir(), "worker-baseline-escape-"))
  try {
    const before = readFileSync(join(data.root, "src/a.ts"))
    const preview = previewWorkerChanges(data.policy, "Prepare a change while the baseline store remains project-local.", [
      { kind: "rewrite", path: "src/a.ts", content: "export const a = 7\n" },
    ])
    symlinkSync(outside, join(data.root, ".task-doctor/worker-change-baselines"), "dir")

    assert.throws(
      () => applyWorkerChanges(data.policy, preview.id, preview.previewToken),
      /storage rejects symlink/,
    )
    assert.deepEqual(readFileSync(join(data.root, "src/a.ts")), before)
    assert.deepEqual(readdirSync(outside), [])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("persists exact before and after modes and preserves an executable mode on apply", () => {
  const data = fixture()
  try {
    chmodSync(join(data.root, "src/a.ts"), 0o751)
    const preview = previewWorkerChanges(data.policy, "Update an executable source without weakening its mode.", [
      { kind: "rewrite", path: "src/a.ts", content: "export const a = 8\n" },
    ])

    const receipt = applyWorkerChanges(data.policy, preview.id, preview.previewToken)
    assert.equal(statSync(join(data.root, "src/a.ts")).mode & 0o777, 0o751)
    assert.equal(receipt.files[0].beforeMode, 0o751)
    assert.equal(receipt.files[0].afterMode, 0o751)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("applies a legacy v1 StoredChangeSet that only carries the original mode field", () => {
  const data = fixture()
  try {
    chmodSync(join(data.root, "src/a.ts"), 0o744)
    const preview = previewWorkerChanges(data.policy, "Apply a preview persisted by the legacy v1 schema.", [
      { kind: "rewrite", path: "src/a.ts", content: "export const a = 6\n" },
    ])
    const storedPath = join(data.root, ".task-doctor/worker-change-sets", `${preview.id}.json`)
    const stored = JSON.parse(readFileSync(storedPath, "utf8"))
    delete stored.files[0].beforeMode
    delete stored.files[0].afterMode
    writeFileSync(storedPath, `${JSON.stringify(stored, null, 2)}\n`)

    const receipt = applyWorkerChanges(data.policy, preview.id, preview.previewToken)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 6\n")
    assert.equal(statSync(join(data.root, "src/a.ts")).mode & 0o777, 0o744)
    assert.equal(receipt.files[0].beforeMode, 0o744)
    assert.equal(receipt.files[0].afterMode, 0o744)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("repairs literal backslash-n separators only when the expanded baseline matches exactly", () => {
  const data = fixture()
  try {
    const preview = previewWorkerChanges(data.policy, "Remove one import name from the current source header.", [
      {
        kind: "replace",
        path: "src/a.ts",
        oldText: "export const a = 1\\n",
        newText: "export const a = 2\\n",
        expectedOccurrences: 1,
      },
    ])

    assert.deepEqual(preview.inputRepairs, ["src/a.ts: expanded literal backslash-n separators after exact baseline match"])
    assert.match(preview.diff, /\+export const a = 2/)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 1\n")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("rejects identical replace bytes without inferring an edit from purpose prose", () => {
  const data = fixture()
  try {
    const before = "export const value = 1\n"
    writeFileSync(join(data.root, "src/a.ts"), before)
    assert.throws(
      () => previewWorkerChanges(
        data.policy,
        "Change from 'value = 1' to 'value = 2'.",
        [{ kind: "replace", path: "src/a.ts", oldText: before, newText: before, expectedOccurrences: 1 }],
      ),
      /would not change bytes because old_text and new_text are identical: src\/a\.ts/,
    )
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), before)
    const directory = join(data.root, ".task-doctor/worker-change-sets")
    assert.deepEqual(existsSync(directory) ? readdirSync(directory) : [], [])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("derives a neutral technical purpose for blank input and preserves a short supplied purpose", () => {
  const blank = fixture()
  try {
    const preview = previewWorkerChanges(blank.policy, "", [
      { kind: "replace", path: "src/a.ts", oldText: "a = 1", newText: "a = 2", expectedOccurrences: 1 },
    ])
    const stored = JSON.parse(readFileSync(join(blank.root, ".task-doctor/worker-change-sets", `${preview.id}.json`), "utf8"))
    assert.equal(stored.purpose, "Worker replace operation for src/a.ts")
    discardWorkerChanges(blank.policy, preview.id)
  } finally {
    rmSync(blank.root, { recursive: true, force: true })
  }

  const short = fixture()
  try {
    const preview = previewWorkerChanges(short.policy, "x", [
      { kind: "replace", path: "src/a.ts", oldText: "a = 1", newText: "a = 2", expectedOccurrences: 1 },
    ])
    const stored = JSON.parse(readFileSync(join(short.root, ".task-doctor/worker-change-sets", `${preview.id}.json`), "utf8"))
    assert.equal(stored.purpose, "x")
    discardWorkerChanges(short.policy, preview.id)
  } finally {
    rmSync(short.root, { recursive: true, force: true })
  }
})

test("reports the longest unique line-aligned current anchor for a nonmatching replace", () => {
  const data = fixture()
  const before = [
    "export const alpha = 1",
    "export const stable = true",
    "export const omega = 3",
    "",
  ].join("\n")
  try {
    writeFileSync(join(data.root, "src/a.ts"), before)
    assert.throws(() => previewWorkerChanges(data.policy, "", [{
      kind: "replace",
      path: "src/a.ts",
      oldText: [
        "export const alpha = 0",
        "export const stable = true",
        "export const omega = 0",
        "",
      ].join("\n"),
      newText: "export const replacement = true\n",
      expectedOccurrences: 1,
    }]), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /expected 1 occurrences but found 0: src\/a\.ts/)
      assert.ok(error.message.includes('unique current anchor: "export const stable = true\\n"'))
      assert.match(error.message, /retry replace with exact current bytes or rewrite with complete content/)
      return true
    })
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), before)
    const directory = join(data.root, ".task-doctor/worker-change-sets")
    assert.deepEqual(existsSync(directory) ? readdirSync(directory) : [], [])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("repairs one minimal shared suffix character only after an exact zero-match baseline check", () => {
  const data = fixture()
  try {
    const path = "src/a.json"
    const before = [
      '  "auth.register.submit": "Create Account",',
      '  "auth.register.title": "Register"',
      "",
    ].join("\n")
    writeFileSync(join(data.root, path), before)

    const preview = previewWorkerChanges(data.policy, "Fix the submit translation.", [{
      kind: "replace",
      path,
      oldText: '  "auth.register.submit": "Create Account",\n"',
      newText: '  "auth.register.submit": "Register",\n"',
      expectedOccurrences: 1,
    }])

    assert.deepEqual(preview.inputRepairs, [
      `${path}: trimmed 1 shared suffix character after exact baseline match`,
    ])
    assert.match(preview.diff, /^-  "auth\.register\.submit": "Create Account",$/m)
    assert.match(preview.diff, /^\+  "auth\.register\.submit": "Register",$/m)
    assert.equal(readFileSync(join(data.root, path), "utf8"), before)
    discardWorkerChanges(data.policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("preserves one existing JSON member delimiter only after exact parse validation", () => {
  const data = fixture()
  try {
    const before = [
      "{",
      '  "auth.register.submit": "Create Account",',
      '  "auth.register.login_link": "Login"',
      "}",
      "",
    ].join("\n")
    writeFileSync(join(data.root, "src/a.json"), before)
    const preview = previewWorkerChanges(data.policy, "Fix the exact registration translation value.", [{
      kind: "replace",
      path: "src/a.json",
      oldText: '"auth.register.submit": "Create Account",',
      newText: '"auth.register.submit": "Register"',
      expectedOccurrences: 1,
    }])

    assert.deepEqual(preview.inputRepairs, [
      "src/a.json: preserved one existing JSON member delimiter after exact parse validation",
    ])
    assert.match(preview.diff, /^\+  "auth\.register\.submit": "Register",$/m)
    const after = before.replace('"auth.register.submit": "Create Account",', '"auth.register.submit": "Register",')
    assert.doesNotThrow(() => JSON.parse(after))
    assert.equal(readFileSync(join(data.root, "src/a.json"), "utf8"), before)
    discardWorkerChanges(data.policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("repairs one minimal shared prefix character after the original replace finds zero matches", () => {
  const data = fixture()
  try {
    const preview = previewWorkerChanges(data.policy, "Update one exact constant.", [{
      kind: "replace",
      path: "src/a.ts",
      oldText: "\"export const a = 1",
      newText: "\"export const a = 2",
      expectedOccurrences: 1,
    }])

    assert.deepEqual(preview.inputRepairs, [
      "src/a.ts: trimmed 1 shared prefix character after exact baseline match",
    ])
    assert.match(preview.diff, /^\+export const a = 2$/m)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 1\n")
    discardWorkerChanges(data.policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("repairs one shared leading ASCII space on every replace line after a unique line-aligned match", () => {
  const data = fixture()
  try {
    const before = "  export const a = 1\r\n\r\n  export const b = 2\r\n"
    writeFileSync(join(data.root, "src/a.ts"), before)
    const preview = previewWorkerChanges(data.policy, "Update the exact two-line constant block.", [{
      kind: "replace",
      path: "src/a.ts",
      oldText: "   export const a = 1\r\n\r\n   export const b = 2\r\n",
      newText: "   export const a = 3\r\n\r\n   export const b = 2\r\n",
      expectedOccurrences: 1,
    }])

    assert.deepEqual(preview.inputRepairs, [
      "src/a.ts: trimmed 1 shared leading indentation character from every non-blank replace line after exact baseline match",
    ])
    assert.match(preview.diff, /export const a = 3/)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), before)
    discardWorkerChanges(data.policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("rejects ambiguous, misaligned, or structurally mismatched shared line indentation", () => {
  const cases = [
    {
      name: "tab prefix",
      before: "  export const a = 1\n  export const b = 2\n",
      oldText: "\t  export const a = 1\n\t  export const b = 2",
      newText: "\t  export const a = 3\n\t  export const b = 2",
    },
    {
      name: "mismatched EOL topology",
      before: "  export const a = 1\n  export const b = 2\n",
      oldText: "   export const a = 1\n   export const b = 2",
      newText: "   export const a = 3\r\n   export const b = 2",
    },
    {
      name: "matching mixed EOL topology",
      before: "  export const a = 1\r\n  export const b = 2\n  export const c = 3\n",
      oldText: "   export const a = 1\r\n   export const b = 2\n   export const c = 3",
      newText: "   export const a = 4\r\n   export const b = 2\n   export const c = 3",
    },
    {
      name: "ambiguous repeated candidate",
      before: "  export const a = 1\n  export const b = 2\n  export const a = 1\n  export const b = 2\n",
      oldText: "   export const a = 1\n   export const b = 2",
      newText: "   export const a = 3\n   export const b = 2",
    },
    {
      name: "mid-line candidate",
      before: "prefix  export const a = 1\n  export const b = 2\n",
      oldText: "   export const a = 1\n   export const b = 2",
      newText: "   export const a = 3\n   export const b = 2",
    },
    {
      name: "changed whitespace-only line",
      before: "  export const a = 1\n  \n  export const b = 2\n",
      oldText: "   export const a = 1\n   \n   export const b = 2",
      newText: "   export const a = 3\n  \n   export const b = 2",
    },
  ]
  for (const item of cases) {
    const data = fixture()
    try {
      writeFileSync(join(data.root, "src/a.ts"), item.before)
      assert.throws(() => previewWorkerChanges(data.policy, item.name, [{
        kind: "replace",
        path: "src/a.ts",
        oldText: item.oldText,
        newText: item.newText,
        expectedOccurrences: 1,
      }]), /expected 1 occurrences but found 0/, item.name)
      assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), item.before, item.name)
      const directory = join(data.root, ".task-doctor/worker-change-sets")
      assert.deepEqual(existsSync(directory) ? readdirSync(directory) : [], [], item.name)
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  }
})

test("rejects ambiguous and overlong shared-boundary repairs without storing a preview", () => {
  const cases = [
    {
      name: "shared alphanumeric prefix",
      before: "unsafe\n",
      oldText: "xsafe",
      newText: "xgood",
    },
    {
      name: "same-length prefix and suffix candidates",
      before: "OLDx ... xOLD\n",
      oldText: "xOLDx",
      newText: "xNEWx",
    },
    {
      name: "more than eight shared prefix characters",
      before: "OLD\n",
      oldText: "123456789OLD",
      newText: "123456789NEW",
    },
  ]

  for (const item of cases) {
    const data = fixture()
    try {
      writeFileSync(join(data.root, "src/a.ts"), item.before)
      assert.throws(() => previewWorkerChanges(data.policy, "Attempt a bounded repair.", [{
        kind: "replace",
        path: "src/a.ts",
        oldText: item.oldText,
        newText: item.newText,
        expectedOccurrences: 1,
      }]), /expected 1 occurrences but found 0/, item.name)
      assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), item.before, item.name)
      const directory = join(data.root, ".task-doctor/worker-change-sets")
      assert.deepEqual(existsSync(directory) ? readdirSync(directory) : [], [], item.name)
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  }
})

for (const kind of ["rewrite", "create"] as const) {
  test(`repairs mixed serialized newlines in ${kind} content without changing string escapes`, () => {
    const data = fixture()
    try {
      const path = kind === "rewrite" ? "src/a.ts" : "src/new.ts"
      const policy = kind === "create" ? { ...data.policy, newScope: [path] } : data.policy
      const content = [
        "export const first = 1",
        String.raw`\nexport const escaped = 'a\nb'\nexport const last = 3\n`,
      ].join("\n")
      const expected = [
        "export const first = 1",
        "",
        "export const escaped = 'a\\nb'",
        "export const last = 3",
        "",
      ].join("\n")
      const operation = kind === "rewrite"
        ? { kind: "rewrite" as const, path, content }
        : { kind: "create" as const, path, content }

      const preview = previewWorkerChanges(policy, `Repair Gemma ${kind} content.`, [operation])

      assert.deepEqual(preview.inputRepairs, [
        `${path}: expanded structural literal backslash-n separators in ${kind} content`,
      ])
      assert.match(preview.diff, /^\+export const escaped = 'a\\nb'$/m)
      assert.match(preview.diff, /^\+export const last = 3$/m)
      assert.doesNotMatch(preview.diff, /\\nexport const/)

      applyWorkerChanges(policy, preview.id, preview.previewToken)
      assert.equal(readFileSync(join(data.root, path), "utf8"), expected)
    } finally {
      rmSync(data.root, { recursive: true, force: true })
    }
  })
}

test("preserves legitimate backslash-n escapes inside string and template literals exactly", () => {
  const data = fixture()
  try {
    const path = "src/new.ts"
    const content = [
      "export const stringValue = 'a\\nb'",
      "export const templateValue = `c\\nd`",
      "",
    ].join("\n")
    const preview = previewWorkerChanges(data.policy, "Create values containing legitimate newline escapes.", [
      { kind: "create", path, content },
    ])

    assert.deepEqual(preview.inputRepairs, [])
    applyWorkerChanges(data.policy, preview.id, preview.previewToken)
    assert.equal(readFileSync(join(data.root, path), "utf8"), content)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("preserves repeated backslash-n escapes inside regular expression literals", () => {
  const data = fixture()
  try {
    const path = "src/new.ts"
    const content = [
      String.raw`export const blankLines = /\n\n/g`,
      "export const value = 1",
      "",
    ].join("\n")
    const preview = previewWorkerChanges(data.policy, "Create a regular expression containing newline escapes.", [
      { kind: "create", path, content },
    ])

    assert.deepEqual(preview.inputRepairs, [])
    applyWorkerChanges(data.policy, preview.id, preview.previewToken)
    assert.equal(readFileSync(join(data.root, path), "utf8"), content)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("rejects unsafe paths, symlinks, protected targets, and inaccurate replacements", () => {
  const data = fixture()
  const outside = mkdtempSync(join(tmpdir(), "worker-changes-outside-"))
  try {
    write(join(outside, "secret.ts"), "secret\n")
    symlinkSync(outside, join(data.root, "src/link"))
    assert.throws(() => previewWorkerChanges(data.policy, "Escape the project.", [
      { kind: "rewrite", path: "../outside.ts", content: "bad\n" },
    ]), /exact project-relative|dot-segment|outside/)
    assert.throws(() => previewWorkerChanges(data.policy, "Use a glob.", [
      { kind: "rewrite", path: "src/*.ts", content: "bad\n" },
    ]), /glob/)
    assert.throws(() => previewWorkerChanges({ ...data.policy, scope: [".task-doctor"] }, "Touch protected state.", [
      { kind: "create", path: ".task-doctor/x.json", content: "{}\n" },
    ]), /protected or read-only/)
    assert.throws(() => previewWorkerChanges(data.policy, "Follow a symlink.", [
      { kind: "rewrite", path: "src/link/secret.ts", content: "bad\n" },
    ]), /symlink/)
    assert.throws(() => previewWorkerChanges(data.policy, "Miss the expected match count.", [
      { kind: "replace", path: "src/a.ts", oldText: "a = 1", newText: "a = 2", expectedOccurrences: 2 },
    ]), /expected 2 occurrences but found 1/)
    assert.throws(() => previewWorkerChanges(data.policy, "Attempt an unnecessary replacement.", [
      { kind: "replace", path: "src/a.ts", oldText: "a = 1", newText: "a = 1", expectedOccurrences: 1 },
    ]), /would not change bytes because old_text and new_text are identical/)
    assert.throws(() => previewWorkerChanges(data.policy, "Create an undeclared file.", [
      { kind: "create", path: "src/other.ts", content: "export {}\n" },
    ]), /not declared NEW/)
    assert.equal(readFileSync(join(outside, "secret.ts"), "utf8"), "secret\n")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("rejects an unresolved relative import in a new TSX file without persisting a change set", () => {
  const data = fixture()
  try {
    const newPath = "src/BrokenPanel.tsx"
    const policy = { ...data.policy, newScope: [newPath] }
    const changeSetDirectory = join(data.root, ".task-doctor/worker-change-sets")

    assert.throws(() => previewWorkerChanges(policy, "Create a panel backed by a local component.", [
      {
        kind: "create",
        path: newPath,
        content: [
          "import { MissingPanel } from './MissingPanel'",
          "",
          "export const BrokenPanel = MissingPanel",
          "",
        ].join("\n"),
      },
    ]), /unresolved relative import in src\/BrokenPanel\.tsx: \.\/MissingPanel/)
    assert.equal(existsSync(join(data.root, newPath)), false)
    assert.deepEqual(existsSync(changeSetDirectory) ? readdirSync(changeSetDirectory) : [], [])
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("does not treat import-like text inside strings or templates as module dependencies", () => {
  const data = fixture()
  try {
    const newPath = "src/import-text.ts"
    const policy = { ...data.policy, newScope: [newPath] }
    const preview = previewWorkerChanges(policy, "Store import examples as ordinary source text.", [{
      kind: "create",
      path: newPath,
      content: [
        "export const quoted = 'import \\\"./MissingQuoted\\\"'",
        "export const required = 'require(\\\"./MissingRequired\\\")'",
        "export const templated = `export { value } from './MissingTemplate'`",
        "",
      ].join("\n"),
    }])
    assert.match(preview.diff, /MissingTemplate/)
    assert.equal(existsSync(join(data.root, ".task-doctor/worker-change-sets", `${preview.id}.json`)), true)
    discardWorkerChanges(policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("accepts existing and co-created relative modules alongside package imports", () => {
  const data = fixture()
  try {
    const consumerPath = "src/new.ts"
    const companionPath = "src/companion.ts"
    const policy = { ...data.policy, newScope: [consumerPath, companionPath] }
    const preview = previewWorkerChanges(policy, "Create a module using existing, previewed, and package dependencies.", [
      {
        kind: "create",
        path: consumerPath,
        content: [
          "import type { Kysely } from 'kysely'",
          "import { a } from './a'",
          "import { companion } from './companion'",
          "",
          "export const combined = (db: Kysely<unknown>) => ({ db, value: a + companion })",
          "",
        ].join("\n"),
      },
      { kind: "create", path: companionPath, content: "export const companion = 2\n" },
    ])

    assert.match(preview.diff, /\+import type \{ Kysely \} from 'kysely'/)
    assert.match(preview.diff, /\+import \{ a \} from '\.\/a'/)
    assert.match(preview.diff, /\+import \{ companion \} from '\.\/companion'/)
    assert.equal(existsSync(join(data.root, ".task-doctor/worker-change-sets", `${preview.id}.json`)), true)
    discardWorkerChanges(policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("previews technically valid test changes without grading locator, assertion, focus, or timeout style", () => {
  const data = fixture()
  try {
    const testPath = "tests/auth.spec.ts"
    const before = [
      "import { test, expect } from '@playwright/test'",
      "test('admin navigation', async ({ page }) => {",
      "  await expect(page.getByRole('button', { name: 'Admin', exact: true })).toBeVisible()",
      "})",
      "",
    ].join("\n")
    const after = [
      "import { test } from '@playwright/test'",
      "test.only('admin navigation', async ({ page }) => {",
      "  await page.waitForTimeout(50)",
      "  await page.click('text=Admin')",
      "})",
      "",
    ].join("\n")
    write(join(data.root, testPath), before)
    const policy = { ...data.policy, scope: ["src", "tests"] }

    const preview = previewWorkerChanges(policy, "Preview one syntactically valid test rewrite without quality grading.", [{
      kind: "rewrite",
      path: testPath,
      content: after,
    }])

    assert.match(preview.diff, /\+test\.only/)
    assert.match(preview.diff, /\+  await page\.waitForTimeout\(50\)/)
    assert.match(preview.diff, /\+  await page\.click\('text=Admin'\)/)
    assert.equal(readFileSync(join(data.root, testPath), "utf8"), before)
    discardWorkerChanges(policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("selects the latest pending preview for one exact Worker and task revision", () => {
  const data = fixture()
  try {
    const first = previewWorkerChanges(data.policy, "Prepare the first exact pending preview.", [
      { kind: "replace", path: "src/a.ts", oldText: "a = 1", newText: "a = 2", expectedOccurrences: 1 },
    ])
    const latest = previewWorkerChanges(data.policy, "Prepare a newer exact pending preview.", [
      { kind: "replace", path: "src/a.ts", oldText: "a = 1", newText: "a = 3", expectedOccurrences: 1 },
    ])
    const otherSession = previewWorkerChanges({ ...data.policy, sessionID: "worker-2" }, "Prepare another Worker's preview.", [
      { kind: "replace", path: "src/a.ts", oldText: "a = 1", newText: "a = 4", expectedOccurrences: 1 },
    ])
    const otherRevision = previewWorkerChanges({ ...data.policy, taskHash: "other-task-hash" }, "Prepare another task revision's preview.", [
      { kind: "replace", path: "src/a.ts", oldText: "a = 1", newText: "a = 5", expectedOccurrences: 1 },
    ])
    const stamp = (id: string, createdAt: string) => {
      const path = join(data.root, ".task-doctor/worker-change-sets", `${id}.json`)
      const value = JSON.parse(readFileSync(path, "utf8"))
      value.createdAt = createdAt
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
    }
    stamp(first.id, "2026-01-01T00:00:00.000Z")
    stamp(latest.id, "2026-01-02T00:00:00.000Z")

    assert.deepEqual(selectLatestPendingWorkerChange(data.policy), {
      id: latest.id,
      previewToken: latest.previewToken,
      taskPath: data.policy.taskPath,
      taskHash: data.policy.taskHash,
      paths: ["src/a.ts"],
      createdAt: "2026-01-02T00:00:00.000Z",
    })
    assert.equal(selectLatestPendingWorkerChange({ ...data.policy, sessionID: "missing-worker" }), null)

    discardWorkerChanges(data.policy, latest.id)
    assert.equal(selectLatestPendingWorkerChange(data.policy)?.id, first.id)
    discardWorkerChanges(data.policy, first.id)
    assert.equal(selectLatestPendingWorkerChange(data.policy), null)
    discardWorkerChanges({ ...data.policy, sessionID: "worker-2" }, otherSession.id)
    discardWorkerChanges({ ...data.policy, taskHash: "other-task-hash" }, otherRevision.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("binds apply to the preview token, Worker session, task revision, and baseline", () => {
  const data = fixture()
  try {
    const preview = previewWorkerChanges(data.policy, "Update one constant.", [
      { kind: "replace", path: "src/a.ts", oldText: "a = 1", newText: "a = 2", expectedOccurrences: 1 },
    ])
    assert.throws(() => applyWorkerChanges(data.policy, preview.id, "P-deadbeef"), /exact preview token/)
    assert.throws(() => applyWorkerChanges({ ...data.policy, sessionID: "worker-2" }, preview.id, preview.previewToken), /another Worker session/)
    assert.throws(() => applyWorkerChanges({ ...data.policy, taskHash: "new-task-hash" }, preview.id, preview.previewToken), /different task revision/)
    writeFileSync(join(data.root, "src/a.ts"), "export const a = 3\n")
    assert.throws(() => applyWorkerChanges(data.policy, preview.id, preview.previewToken), /baseline drift/)
    writeFileSync(join(data.root, "src/a.ts"), "export const a = 1\n")
    applyWorkerChanges(data.policy, preview.id, preview.previewToken)
    assert.throws(() => applyWorkerChanges(data.policy, preview.id, preview.previewToken), /does not exist|cleaned up/)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("rolls back every file when a multi-file apply fails", () => {
  const data = fixture()
  try {
    const preview = previewWorkerChanges(data.policy, "Update two constants as one batch.", [
      { kind: "replace", path: "src/a.ts", oldText: "a = 1", newText: "a = 2", expectedOccurrences: 1 },
      { kind: "replace", path: "src/b.ts", oldText: "b = 1", newText: "b = 2", expectedOccurrences: 1 },
    ])
    assert.throws(() => applyWorkerChanges(data.policy, preview.id, preview.previewToken, { failAfterCommits: 1 }), /Injected/)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 1\n")
    assert.equal(readFileSync(join(data.root, "src/b.ts"), "utf8"), "export const b = 1\n")
    assert.equal(existsSync(join(data.root, ".task-doctor/worker-change-sets", `${preview.id}.json`)), true)
    assert.equal(discardWorkerChanges(data.policy, preview.id).length, 2)
    const receipt = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-change-receipts", `${preview.id}.json`), "utf8"))
    assert.equal(receipt.status, "discarded")
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("requires a complete bounded preview before Apply", () => {
  const data = fixture()
  try {
    const preview = previewWorkerChanges(data.policy, "Prepare an intentionally oversized preview.", [
      { kind: "rewrite", path: "src/a.ts", content: `${"x".repeat(50_000)}\n` },
    ])
    assert.equal(preview.diffTruncated, true)
    assert.throws(() => applyWorkerChanges(data.policy, preview.id, preview.previewToken), /truncated preview/)
    assert.equal(readFileSync(join(data.root, "src/a.ts"), "utf8"), "export const a = 1\n")
    discardWorkerChanges(data.policy, preview.id)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

test("cleans pending previews for a terminal Worker session", () => {
  const data = fixture()
  try {
    const preview = previewWorkerChanges(data.policy, "Prepare a change that will be abandoned.", [
      { kind: "rewrite", path: "src/a.ts", content: "export const a = 4\n" },
    ])
    assert.deepEqual(cleanupWorkerChangesForSession(data.root, "worker-1"), [preview.id])
    assert.equal(existsSync(join(data.root, ".task-doctor/worker-change-sets", `${preview.id}.json`)), false)
    const receipt = JSON.parse(readFileSync(join(data.root, ".task-doctor/worker-change-receipts", `${preview.id}.json`), "utf8"))
    assert.equal(receipt.status, "cleaned")
    assert.equal("before" in receipt.files[0], false)
    assert.equal("after" in receipt.files[0], false)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
})

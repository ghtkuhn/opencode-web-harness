type FieldKind = "string" | "string_array" | "boolean" | "enum" | "number" | "object_array"

type FieldSpec = {
  kind: FieldKind
  required?: boolean
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  itemMinLength?: number
  itemMaxLength?: number
  values?: readonly string[]
  pattern?: RegExp
  aliases?: readonly string[]
  preserveWhitespace?: boolean
  splitCommas?: boolean
  defaultValue?: unknown
}

type ToolInputContract = {
  fields: Record<string, FieldSpec>
  strict?: boolean
}

export type ModelInputRepairResult = {
  value: Record<string, unknown>
  repairs: string[]
  issues: string[]
  knownTool: boolean
}

const stringField = (minLength = 1, maxLength?: number, options: Partial<FieldSpec> = {}): FieldSpec => ({
  kind: "string",
  required: true,
  minLength,
  maxLength,
  ...options,
})

const optionalString = (options: Partial<FieldSpec> = {}): FieldSpec => ({ kind: "string", ...options })

const stringArray = (minItems = 0, maxItems?: number, options: Partial<FieldSpec> = {}): FieldSpec => ({
  kind: "string_array",
  required: true,
  minItems,
  maxItems,
  ...options,
})

const enumField = (values: readonly string[], options: Partial<FieldSpec> = {}): FieldSpec => ({
  kind: "enum",
  required: true,
  values,
  ...options,
})

const CUSTOM_CONTRACTS: Record<string, ToolInputContract> = {
  register_planner_task: {
    strict: true,
    fields: {
      title: optionalString(),
      files: { kind: "string_array", aliases: ["paths"], splitCommas: true },
      done: { kind: "string_array" },
      depends_on: { kind: "string_array", aliases: ["dependsOn", "dependencies"], splitCommas: true },
      task_path: optionalString({ aliases: ["task", "taskPath", "path"] }),
      content: optionalString({ aliases: ["replacement", "taskContent", "markdown", "body"], preserveWhitespace: true }),
      outcome: optionalString({ aliases: ["result"] }),
      scope: { kind: "string_array", splitCommas: true },
      requirements: { kind: "string_array", aliases: ["acceptanceCriteria", "criteria"] },
      parallel: { kind: "boolean" },
      resources: { kind: "string_array" },
      memory_action: { kind: "enum", values: ["none", "append", "update", "remove"], aliases: ["memoryAction"] },
      memory_reason: optionalString({ aliases: ["memoryReason"] }),
      verify: { kind: "string_array", aliases: ["verification", "checks"] },
    },
  },
  preview_worker_changes: {
    strict: true,
    fields: {
      kind: { kind: "enum", values: ["replace", "rewrite", "create", "delete"], aliases: ["type", "operationKind"] },
      path: optionalString({ aliases: ["file_path", "filePath", "file"] }),
      old_text: optionalString({ aliases: ["oldText", "before"], preserveWhitespace: true }),
      new_text: optionalString({ aliases: ["newText", "after"], preserveWhitespace: true }),
      content: optionalString({ preserveWhitespace: true }),
      expected_occurrences: { kind: "number", aliases: ["expectedOccurrences", "occurrences", "count"] },
      task_path: optionalString({ aliases: ["task", "taskPath"] }),
      description: optionalString({ aliases: ["purpose", "reason"] }),
      operations: { kind: "object_array", aliases: ["operation", "changes", "edits"] },
    },
  },
  apply_worker_changes: {
    strict: true,
    fields: {
      task_path: optionalString({ aliases: ["task", "taskPath"] }),
      change_id: optionalString({ aliases: ["changeId"] }),
      preview_token: optionalString({ aliases: ["previewToken", "token"] }),
    },
  },
  verify_worker_task: {
    strict: true,
    fields: {},
  },
  discard_worker_changes: {
    strict: true,
    fields: {
      task_path: optionalString({ aliases: ["task", "taskPath"] }),
      change_id: optionalString({ aliases: ["changeId"], pattern: /^C-[a-f0-9]{6}$/ }),
    },
  },
  revise_active_task: {
    strict: true,
    fields: {
      task_path: optionalString({ aliases: ["task", "taskPath"] }),
      replacement: optionalString({ minLength: 100, maxLength: 100000, aliases: ["content", "taskContent"], preserveWhitespace: true }),
      title: optionalString({ minLength: 3, maxLength: 160 }),
      outcome: optionalString({ minLength: 10, maxLength: 1000 }),
      add_scope: { kind: "string_array", minItems: 1, maxItems: 40, aliases: ["addScope", "scope", "paths"], splitCommas: true },
      add_requirements: { kind: "string_array", minItems: 1, maxItems: 30, aliases: ["addRequirements", "requirements", "criteria"] },
      verify: { kind: "string_array", minItems: 1, maxItems: 20, aliases: ["verification", "checks"] },
      reason: optionalString({ maxLength: 1000 }),
    },
  },
  supersede_registered_task: {
    strict: true,
    fields: {
      task_path: optionalString({ aliases: ["task", "taskPath", "path"] }),
      reason: optionalString({ maxLength: 1000 }),
    },
  },
  escalate_to_planner: {
    strict: true,
    fields: {
      task_path: stringField(1, undefined, { aliases: ["task", "taskPath"] }),
      problem: optionalString({ minLength: 20, maxLength: 1200 }),
      evidence: { kind: "string_array", minItems: 1, maxItems: 8 },
      expected_results: { kind: "string_array", minItems: 1, maxItems: 8, aliases: ["expectedResults", "results"] },
      relevant_files: { kind: "string_array", minItems: 1, maxItems: 20, aliases: ["relevantFiles", "files"], splitCommas: true },
      required_scope: { kind: "string_array", minItems: 1, maxItems: 40, aliases: ["requiredScope", "scope"] },
      required_requirements: { kind: "string_array", minItems: 1, maxItems: 30, aliases: ["requiredRequirements", "requirements", "criteria"] },
      required_verify: { kind: "string_array", minItems: 1, maxItems: 20, aliases: ["requiredVerify", "verify", "verification", "checks"] },
      supersede_tasks: { kind: "string_array", minItems: 1, maxItems: 20, aliases: ["supersedeTasks", "redundantTasks"], splitCommas: true },
      contract_mode: { kind: "enum", values: ["merge", "replace"], aliases: ["contractMode", "mode"] },
    },
  },
  recover_harness_baseline: {
    strict: true,
    fields: {},
  },
  recover_project_memory: {
    strict: true,
    fields: {
      replacement: stringField(1, 100000, { aliases: ["content", "memory"], preserveWhitespace: true }),
      reason: optionalString(),
    },
  },
  append_task_memory: {
    strict: true,
    fields: {
      task_path: optionalString({ aliases: ["task", "taskPath"] }),
      entry: stringField(1, 1500, { aliases: ["fact", "memoryEntry", "content"], preserveWhitespace: true }),
    },
  },
  request_executor_help: {
    strict: true,
    fields: {
      note: optionalString({ aliases: ["message", "reason"] }),
      task_path: optionalString({ aliases: ["task", "taskPath"] }),
      category: { kind: "enum", values: ["model_loop", "task_scope", "task_definition", "tool_failure", "test_failure", "dependency", "unknown"] },
      problem: optionalString(),
      attempted_actions: { kind: "string_array", aliases: ["attemptedActions", "attempts"] },
      evidence: { kind: "string_array" },
      relevant_files: { kind: "string_array", aliases: ["relevantFiles", "files"], splitCommas: true },
      suggested_next_step: optionalString({ aliases: ["suggestedNextStep", "nextStep"] }),
    },
  },
  review_worker_help: {
    strict: true,
    fields: {
      decision: { kind: "enum", values: ["retry_worker", "planner_recovery"] },
      help_id: optionalString({ aliases: ["helpId"] }),
      task_path: optionalString({ aliases: ["task", "taskPath"] }),
      root_cause: optionalString({ aliases: ["rootCause", "cause"] }),
      retry_strategy: optionalString({ aliases: ["retryStrategy", "strategy"] }),
      expected_results: { kind: "string_array", aliases: ["expectedResults", "results"] },
      reviewed_files: { kind: "string_array", aliases: ["reviewedFiles", "files"], splitCommas: true },
      contract_mode: { kind: "enum", values: ["replace"], aliases: ["contractMode", "mode"] },
      required_scope: { kind: "string_array", aliases: ["requiredScope", "scope"] },
      required_requirements: { kind: "string_array", aliases: ["requiredRequirements", "requirements", "criteria"] },
      required_verify: { kind: "string_array", aliases: ["requiredVerify", "verify", "verification", "checks"] },
    },
  },
  submit_task_review: {
    strict: true,
    fields: {},
  },
  record_guard_learning: {
    strict: true,
    fields: {},
  },
  request_command_permission: {
    strict: true,
    fields: {
      purpose: stringField(20),
      command: stringField(1, undefined, { aliases: ["cmd"], preserveWhitespace: true }),
      affected_paths: stringArray(1, undefined, { aliases: ["affectedPaths", "paths", "files"], splitCommas: true }),
    },
  },
  request_task_change_permission: {
    strict: true,
    fields: {
      task_path: stringField(1, undefined, { aliases: ["task", "taskPath"] }),
      reason: stringField(20),
      old_text: stringField(1, undefined, { aliases: ["oldText", "before"], preserveWhitespace: true }),
      new_text: stringField(1, undefined, { aliases: ["newText", "after"], preserveWhitespace: true }),
    },
  },
  request_dependency_install_permission: {
    strict: true,
    fields: {
      reason: stringField(20),
      workspace: stringField(1, undefined, { aliases: ["directory", "path"] }),
      packages: stringArray(1, undefined, { aliases: ["dependencies", "packageNames"], splitCommas: true }),
      dev: { kind: "boolean", required: true, aliases: ["devDependency", "devDependencies", "saveDev"] },
    },
  },
}

const BUILTIN_CONTRACTS: Record<string, ToolInputContract> = {
  bash: { fields: { command: stringField(1, undefined, { aliases: ["cmd"], preserveWhitespace: true }) } },
  read: {
    fields: {
      filePath: stringField(1, undefined, { aliases: ["file_path", "path", "filename"] }),
      offset: { kind: "number" },
      limit: { kind: "number" },
    },
  },
  write: {
    fields: {
      filePath: stringField(1, undefined, { aliases: ["file_path", "path", "filename"] }),
      content: stringField(0, undefined, { preserveWhitespace: true }),
    },
  },
  edit: {
    fields: {
      filePath: stringField(1, undefined, { aliases: ["file_path", "path", "filename"] }),
      oldString: stringField(1, undefined, { aliases: ["old_string", "oldText", "before"], preserveWhitespace: true }),
      newString: stringField(0, undefined, { aliases: ["new_string", "newText", "after"], preserveWhitespace: true }),
      replaceAll: { kind: "boolean", aliases: ["replace_all"] },
    },
  },
  patch: { fields: { patchText: stringField(1, undefined, { aliases: ["patch_text", "patch"], preserveWhitespace: true }) } },
  apply_patch: { fields: { patchText: stringField(1, undefined, { aliases: ["patch_text", "patch"], preserveWhitespace: true }) } },
  multiedit: {
    fields: {
      filePath: stringField(1, undefined, { aliases: ["file_path", "path", "filename"] }),
      edits: { kind: "object_array", required: true, minItems: 1 },
    },
  },
  task: {
    fields: {
      description: stringField(1),
      prompt: stringField(1, undefined, { preserveWhitespace: true }),
      subagent_type: optionalString({ aliases: ["subagentType", "agent", "role"] }),
      task_id: optionalString({ aliases: ["taskId", "session_id", "sessionId"] }),
    },
  },
  todowrite: { fields: { todos: { kind: "object_array", required: true, maxItems: 5 } } },
  question: { fields: { questions: { kind: "object_array", required: true, minItems: 1, maxItems: 3 } } },
  glob: {
    fields: {
      pattern: stringField(1),
      path: optionalString({ aliases: ["directory", "root"] }),
    },
  },
  grep: {
    fields: {
      pattern: stringField(1),
      path: optionalString({ aliases: ["directory", "root"] }),
      include: optionalString({ aliases: ["glob"] }),
    },
  },
}

export const CUSTOM_MODEL_TOOL_NAMES = Object.freeze(Object.keys(CUSTOM_CONTRACTS).sort())
export const KNOWN_MODEL_TOOL_NAMES = Object.freeze([...Object.keys(CUSTOM_CONTRACTS), ...Object.keys(BUILTIN_CONTRACTS)].sort())

function contractFor(toolName: string) {
  return CUSTOM_CONTRACTS[toolName] ?? BUILTIN_CONTRACTS[toolName] ?? null
}

function normalizedName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function stripOuterCodeFence(value: string) {
  const match = value.trim().match(/^```(?:json|javascript|js|text)?\s*\n([\s\S]*?)\n```$/i)
  return match ? match[1] : value
}

function parseJsonValue(value: string): unknown {
  const candidate = stripOuterCodeFence(value).trim()
  try {
    return JSON.parse(candidate)
  } catch {
    return undefined
  }
}

function inputRecord(input: unknown, repairs: string[]): Record<string, unknown> | null {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = { ...(input as Record<string, unknown>) }
    if (Object.keys(record).length === 1) {
      const wrapper = ["args", "arguments", "parameters"].find((key) => key in record)
      if (wrapper) {
        const wrapped = typeof record[wrapper] === "string" ? parseJsonValue(record[wrapper] as string) : record[wrapper]
        if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
          repairs.push(`unwrapped ${wrapper}`)
          return { ...(wrapped as Record<string, unknown>) }
        }
      }
    }
    return record
  }
  if (typeof input === "string") {
    const parsed = parseJsonValue(input)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      repairs.push("parsed argument object from JSON text")
      return inputRecord(parsed, repairs)
    }
  }
  return null
}

function fieldNameMap(contract: ToolInputContract) {
  const names = new Map<string, string>()
  for (const [field, spec] of Object.entries(contract.fields)) {
    names.set(normalizedName(field), field)
    for (const alias of spec.aliases ?? []) names.set(normalizedName(alias), field)
  }
  return names
}

function canonicalizeKeys(record: Record<string, unknown>, contract: ToolInputContract, repairs: string[]) {
  const names = fieldNameMap(contract)
  const result: Record<string, unknown> = {}
  for (const [rawName, value] of Object.entries(record)) {
    const field = names.get(normalizedName(rawName))
    if (!field) {
      if (contract.strict) repairs.push(`ignored unknown field ${rawName}`)
      else result[rawName] = value
      continue
    }
    if (!(field in result) || rawName === field) {
      if (rawName !== field) repairs.push(`renamed ${rawName} to ${field}`)
      result[field] = value
    } else {
      repairs.push(`ignored duplicate alias ${rawName} for ${field}`)
    }
  }
  return result
}

function cleanEmbeddedPrefix(value: string) {
  return value.replace(/[\s,`'"\]}]+$/g, "").trim()
}

function markerMatches(value: string, names: Map<string, string>) {
  const matches: Array<{ index: number; end: number; field: string }> = []
  const pattern = /(^|[\n,{\],}`'"])\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*/g
  for (const match of value.matchAll(pattern)) {
    const field = names.get(normalizedName(match[2]))
    if (!field) continue
    matches.push({ index: match.index ?? 0, end: (match.index ?? 0) + match[0].length, field })
  }
  return matches
}

function parseEmbeddedArray(segment: string, tail: unknown[]) {
  const value = segment.trim().replace(/^[,`]+/, "").replace(/[,`]+$/, "")
  if (!value.startsWith("[")) return { value: [value].filter(Boolean), consumeTail: false }
  const closing = value.lastIndexOf("]")
  if (closing < 0) {
    const inline = value.slice(1).trim()
    const parsed = inline ? parseJsonValue(`[${inline}]`) : []
    return {
      value: [...(Array.isArray(parsed) ? parsed : inline ? [inline] : []), ...tail],
      consumeTail: true,
    }
  }
  const arrayText = value.slice(0, closing + 1)
  const parsed = parseJsonValue(arrayText)
  if (Array.isArray(parsed)) return { value: parsed, consumeTail: false }
  const inner = arrayText.slice(1, -1).trim()
  return { value: inner ? [inner.replace(/^['"]|['"]$/g, "")] : [], consumeTail: false }
}

function parseEmbeddedScalar(segment: string) {
  const value = segment.trim().replace(/^[,`]+/, "").replace(/[,`\]}]+$/, "").trim()
  const parsed = parseJsonValue(value)
  return parsed === undefined ? value.replace(/^['"]|['"]$/g, "") : parsed
}

function parseLooseRecord(input: string, contract: ToolInputContract) {
  const value = stripOuterCodeFence(input).trim().replace(/^\{\s*/, "").replace(/\s*\}$/, "")
  const markers = markerMatches(value, fieldNameMap(contract))
  if (markers.length === 0) return null
  if (new Set(markers.map((marker) => marker.field)).size !== markers.length) return null
  const record: Record<string, unknown> = {}
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]
    const next = markers[index + 1]
    const spec = contract.fields[marker.field]
    if (!spec) continue
    const segment = value.slice(marker.end, next?.index ?? value.length)
    if (spec.preserveWhitespace && next && segment.includes("\n")) return null
    record[marker.field] = spec.kind === "string_array" || spec.kind === "object_array"
      ? parseEmbeddedArray(segment, []).value
      : parseEmbeddedScalar(segment)
  }
  return Object.keys(record).length > 0 ? record : null
}

function recoverEmbeddedFields(record: Record<string, unknown>, contract: ToolInputContract, repairs: string[]) {
  const names = fieldNameMap(contract)
  for (const [sourceField, sourceValue] of Object.entries({ ...record })) {
    const sourceSpec = contract.fields[sourceField]
    if (sourceSpec?.preserveWhitespace) continue
    const entries = Array.isArray(sourceValue) ? sourceValue : [sourceValue]
    const index = entries.findIndex((entry) => typeof entry === "string" && markerMatches(entry, names).some((marker) => marker.field !== sourceField))
    if (index < 0) continue
    const text = String(entries[index])
    const markers = markerMatches(text, names).filter((marker) => marker.field !== sourceField)
    if (markers.length === 0) continue

    const prefix = cleanEmbeddedPrefix(text.slice(0, markers[0].index))
    const tail = entries.slice(index + 1)
    let consumedTail = false
    for (let markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
      const marker = markers[markerIndex]
      const next = markers[markerIndex + 1]
      const segment = text.slice(marker.end, next?.index ?? text.length)
      const targetSpec = contract.fields[marker.field]
      if (!targetSpec) continue
      const parsed = targetSpec.kind === "string_array" || targetSpec.kind === "object_array"
        ? parseEmbeddedArray(segment, next ? [] : tail)
        : { value: parseEmbeddedScalar(segment), consumeTail: false }
      if (!(marker.field in record) || record[marker.field] === undefined) {
        record[marker.field] = parsed.value
        repairs.push(`recovered embedded field ${marker.field}`)
      }
      consumedTail ||= parsed.consumeTail
    }

    const head = entries.slice(0, index)
    if (prefix) head.push(prefix)
    record[sourceField] = Array.isArray(sourceValue)
      ? [...head, ...(consumedTail ? [] : tail)]
      : (head[0] ?? "")
    repairs.push(`removed embedded field syntax from ${sourceField}`)
  }
}

function scalarString(value: unknown, preserveWhitespace: boolean) {
  let candidate = value
  if (Array.isArray(candidate) && candidate.length === 1) candidate = candidate[0]
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const record = candidate as Record<string, unknown>
    const keys = ["value", "text", "path", "name"].filter((key) => typeof record[key] === "string")
    if (keys.length === 1) candidate = record[keys[0]]
  }
  if (!["string", "number", "boolean"].includes(typeof candidate)) return undefined
  const text = String(candidate)
  return preserveWhitespace ? text : text.trim().replace(/^`([^`]*)`$/, "$1")
}

function listItems(value: unknown, splitCommas: boolean) {
  let candidate = value
  if (typeof candidate === "string") {
    const parsed = parseJsonValue(candidate)
    if (Array.isArray(parsed)) candidate = parsed
    else {
      const lines = candidate.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim()).filter(Boolean)
      candidate = lines.length > 1 ? lines : splitCommas && candidate.includes(",")
        ? candidate.split(",").map((item) => item.trim()).filter(Boolean)
        : [candidate]
    }
  }
  const values: unknown[] = Array.isArray(candidate)
    ? candidate
    : candidate === undefined || candidate === null ? [] : [candidate]
  return values.flatMap((item: unknown) => Array.isArray(item) ? item : [item])
}

function unescapeSemanticQuotes(value: unknown) {
  const repair = (item: unknown) => typeof item === "string" ? item.replace(/\\+(?=")/g, "") : item
  return Array.isArray(value) ? value.map(repair) : repair(value)
}

function coerceField(value: unknown, spec: FieldSpec) {
  if (spec.kind === "string") return scalarString(value, Boolean(spec.preserveWhitespace))
  if (spec.kind === "string_array") {
    const values = listItems(value, Boolean(spec.splitCommas))
      .map((item: unknown) => scalarString(item, false))
      .filter((item: string | undefined): item is string => typeof item === "string" && item.length > 0)
    return [...new Set(values)]
  }
  if (spec.kind === "object_array") {
    let candidate = value
    if (typeof candidate === "string") {
      const parsed = parseJsonValue(candidate)
      if (parsed !== undefined) candidate = parsed
    }
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) candidate = [candidate]
    return Array.isArray(candidate) ? candidate : undefined
  }
  if (spec.kind === "boolean") {
    if (typeof value === "boolean") return value
    if (typeof value === "number" && (value === 0 || value === 1)) return Boolean(value)
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase()
      if (["true", "yes", "ja", "1", "dev", "development"].includes(normalized)) return true
      if (["false", "no", "nein", "0", "prod", "production"].includes(normalized)) return false
    }
    return undefined
  }
  if (spec.kind === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
    return undefined
  }
  const candidate = scalarString(value, false)
  if (candidate === undefined) return undefined
  const normalized = candidate.toLowerCase().replace(/[\s-]+/g, "_")
  return spec.values?.find((entry) => entry.toLowerCase().replace(/[\s-]+/g, "_") === normalized)
}

function typeLabel(spec: FieldSpec) {
  if (spec.kind === "string_array") return "a string list"
  if (spec.kind === "object_array") return "an object list"
  return spec.kind === "enum" ? `one of ${spec.values?.join(", ")}` : spec.kind
}

function validateField(field: string, value: unknown, spec: FieldSpec) {
  const issues: string[] = []
  if (value === undefined) {
    if (spec.required) issues.push(`${field} is required and must be ${typeLabel(spec)}`)
    return issues
  }
  if (spec.kind === "string" || spec.kind === "enum") {
    if (typeof value !== "string") return [`${field} must be ${typeLabel(spec)}`]
    const length = value.trim().length
    if (spec.minLength !== undefined && length < spec.minLength) issues.push(`${field} needs at least ${spec.minLength} characters`)
    if (spec.maxLength !== undefined && value.length > spec.maxLength) issues.push(`${field} exceeds ${spec.maxLength} characters`)
    if (spec.pattern && !spec.pattern.test(value)) issues.push(`${field} has an invalid format`)
    if (spec.kind === "enum" && !spec.values?.includes(value)) issues.push(`${field} must be ${typeLabel(spec)}`)
  } else if (spec.kind === "boolean" && typeof value !== "boolean") {
    issues.push(`${field} must be boolean`)
  } else if (spec.kind === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    issues.push(`${field} must be a finite number`)
  } else if (spec.kind === "string_array" || spec.kind === "object_array") {
    if (!Array.isArray(value)) return [`${field} must be ${typeLabel(spec)}`]
    if (spec.minItems !== undefined && value.length < spec.minItems) issues.push(`${field} needs at least ${spec.minItems} item${spec.minItems === 1 ? "" : "s"}`)
    if (spec.maxItems !== undefined && value.length > spec.maxItems) issues.push(`${field} exceeds ${spec.maxItems} items`)
    if (spec.kind === "string_array") {
      if (value.some((entry) => typeof entry !== "string" || !entry.trim())) issues.push(`${field} must contain only non-empty strings`)
      else {
        if (spec.itemMinLength !== undefined && value.some((entry) => entry.trim().length < spec.itemMinLength!)) {
          issues.push(`${field} items need at least ${spec.itemMinLength} characters`)
        }
        if (spec.itemMaxLength !== undefined && value.some((entry) => entry.length > spec.itemMaxLength!)) {
          issues.push(`${field} items must not exceed ${spec.itemMaxLength} characters`)
        }
      }
    }
    if (spec.kind === "object_array" && value.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) issues.push(`${field} must contain only objects`)
  }
  return issues
}

function remainingEmbeddedSyntax(record: Record<string, unknown>, contract: ToolInputContract) {
  const names = fieldNameMap(contract)
  const issues: string[] = []
  for (const [field, value] of Object.entries(record)) {
    const spec = contract.fields[field]
    if (spec?.preserveWhitespace) continue
    const values = Array.isArray(value) ? value : [value]
    if (values.some((entry) => typeof entry === "string" && markerMatches(entry, names).some((marker) => marker.field !== field))) {
      issues.push(`${field} still contains embedded argument syntax`)
    }
  }
  return issues
}

export function repairModelInput(toolName: string, input: unknown): ModelInputRepairResult {
  const repairs: string[] = []
  const contract = contractFor(toolName)
  let record = inputRecord(input, repairs)
  if (contract && record && Object.keys(record).length === 1) {
    const wrapper = ["args", "arguments", "parameters"].find((key) => typeof record?.[key] === "string")
    const loose = wrapper ? parseLooseRecord(record[wrapper] as string, contract) : null
    if (loose) {
      record = loose
      repairs.push(`unwrapped and parsed loose ${wrapper}`)
    }
  }
  if (contract && !record && typeof input === "string") {
    record = parseLooseRecord(input, contract)
    if (record) repairs.push("parsed loose argument fields")
  }
  if (!record) {
    return {
      value: {},
      repairs,
      issues: ["arguments must be one object; JSON text was also attempted"],
      knownTool: Boolean(contract),
    }
  }

  if (!contract) return { value: record, repairs, issues: [], knownTool: false }
  const value = canonicalizeKeys(record, contract, repairs)
  recoverEmbeddedFields(value, contract, repairs)

  if (toolName === "task" && value.description === undefined && typeof value.prompt === "string") {
    const description = value.prompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
      ?.replace(/\s+/g, " ")
      .slice(0, 200)
    if (description) {
      value.description = description
      repairs.push("derived description from prompt")
    }
  }

  for (const [field, spec] of Object.entries(contract.fields)) {
    if (value[field] === undefined && spec.defaultValue !== undefined) {
      value[field] = structuredClone(spec.defaultValue)
      repairs.push(`defaulted ${field}`)
      continue
    }
    if (value[field] === undefined) continue
    if (!spec.required
      && spec.kind !== "string_array"
      && spec.kind !== "object_array"
      && !spec.preserveWhitespace
      && typeof value[field] === "string"
      && value[field].trim() === "") {
      delete value[field]
      repairs.push(`omitted empty optional field ${field}`)
      continue
    }
    if (!spec.preserveWhitespace && (spec.kind === "string" || spec.kind === "string_array" || spec.kind === "enum")) {
      const repaired = unescapeSemanticQuotes(value[field])
      if (JSON.stringify(repaired) !== JSON.stringify(value[field])) {
        value[field] = repaired
        repairs.push(`unescaped over-escaped quotes in ${field}`)
      }
    }
    const before = value[field]
    const coerced = coerceField(before, spec)
    if (coerced === undefined && !spec.required) {
      delete value[field]
      repairs.push(`omitted invalid optional field ${field}`)
      continue
    }
    if (coerced !== undefined) {
      value[field] = coerced
      if (typeof before !== typeof coerced || (Array.isArray(before) !== Array.isArray(coerced))) repairs.push(`coerced ${field} to ${typeLabel(spec)}`)
      else if (spec.kind === "enum" && before !== coerced) repairs.push(`normalized ${field}`)
    }
    if (!spec.required
      && (spec.kind === "string_array" || spec.kind === "object_array")
      && Array.isArray(value[field])
      && value[field].length === 0
      && (spec.minItems ?? 0) > 0) {
      delete value[field]
      repairs.push(`omitted empty optional field ${field}`)
      continue
    }
  }

  const issues = Object.entries(contract.fields).flatMap(([field, spec]) => validateField(field, value[field], spec))
  issues.push(...remainingEmbeddedSyntax(value, contract))
  return { value, repairs: [...new Set(repairs)], issues: [...new Set(issues)], knownTool: true }
}

export function formatModelInputError(toolName: string, result: ModelInputRepairResult) {
  return [
    "MODEL INPUT INVALID",
    `Tool: ${toolName}`,
    "Problem:",
    ...result.issues.map((issue) => `- ${issue}`),
    result.repairs.length > 0 ? `Repairs already attempted: ${result.repairs.join("; ")}.` : "Repairs already attempted: none were unambiguous.",
    "Do next: Retry this tool once. Keep every named field separate. Use lists for list fields and do not place field names inside list items.",
  ].join("\n")
}

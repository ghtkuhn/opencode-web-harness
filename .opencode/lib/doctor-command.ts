const taskPathPattern = /^kanban\/todo\/[A-Za-z0-9._-]+\.md$/
const lifecycleGates = new Set(["lint", "register", "start", "verify", "complete", "whitelist", "test-file"])
const workerGates = new Set(["start", "verify", "complete", "whitelist", "test-file"])

function unsafeShell(value: string) {
  return /[;&|><`\n]|\$\(/.test(value)
}

function shellWords(value: string) {
  const words: string[] = []
  let word = ""
  let quote: "'" | '"' | null = null
  let escaped = false
  for (const character of value.trim()) {
    if (escaped) {
      word += character
      escaped = false
    } else if (character === "\\" && quote !== "'") {
      escaped = true
    } else if (quote) {
      if (character === quote) quote = null
      else word += character
    } else if (character === "'" || character === '"') {
      quote = character
    } else if (/\s/.test(character)) {
      if (word) words.push(word)
      word = ""
    } else {
      word += character
    }
  }
  if (escaped || quote) return null
  if (word) words.push(word)
  return words
}

function npmScript(words: string[]) {
  if (words[0] !== "npm") return null
  let index = 1
  if (words[index] === "--prefix") index += 2
  else if (words[index]?.startsWith("--prefix=")) index += 1
  if (words[index] !== "run" || !words[index + 1]) return null
  return { script: words[index + 1], args: words.slice(index + 2) }
}

function normalizedDoctorArgs(args: string[]) {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === "--") continue
    if (value === "--prefix") {
      if (!args[index + 1]) return null
      index += 1
      continue
    }
    if (value.startsWith("--prefix=")) continue
    if (["--task", "--file", "--path", "--reason"].includes(value)) {
      if (!args[index + 1]) return null
      values.push(args[index + 1])
      index += 1
      continue
    }
    const assignment = value.match(/^--(?:task|file|path|reason)=(.+)$/)
    values.push(assignment?.[1] ?? value)
  }
  return values
}

function parsedNpmDoctor(command: string) {
  if (unsafeShell(command)) return null
  const words = shellWords(command)
  if (!words) return null
  const invocation = npmScript(words)
  const match = invocation?.script.match(/^task:doctor:(lint|register|start|verify|complete|whitelist|test-file)$/)
  if (!invocation || !match) return null
  const values = normalizedDoctorArgs(invocation.args)
  if (!values) return null
  const tasks = values.filter((value) => taskPathPattern.test(value))
  if (tasks.length !== 1) return null
  return { gate: match[1], taskPath: tasks[0], values }
}

export function parseDoctorInvocation(command: string) {
  const npm = parsedNpmDoctor(command)
  if (npm && lifecycleGates.has(npm.gate)) return { gate: npm.gate, taskPath: npm.taskPath }
  if (unsafeShell(command)) return null
  const words = shellWords(command)
  if (!words || words.length < 4 || words[0] !== "node" || words[1] !== "scripts/task-doctor.mjs") return null
  const gate = words[2]
  const taskPath = words[3]
  if (!lifecycleGates.has(gate) || !taskPathPattern.test(taskPath)) return null
  if (!["whitelist", "test-file"].includes(gate) && words.length !== 4) return null
  return { gate, taskPath }
}

export function isDoctorUtilityCommand(command: string) {
  if (unsafeShell(command)) return false
  const words = shellWords(command)
  if (!words) return false
  const npm = npmScript(words)
  if (npm && npm.args.length === 0 && /^task:doctor:(?:next|schedule|test)$/.test(npm.script)) return true
  return words.length === 3
    && words[0] === "node"
    && words[1] === "scripts/task-doctor.mjs"
    && /^(?:next|schedule|self-test)$/.test(words[2])
}

export function isDoctorCommand(command: string) {
  return parseDoctorInvocation(command) !== null || isDoctorUtilityCommand(command)
}

export function canonicalWorkerDoctorCommand(command: string) {
  const parsed = parsedNpmDoctor(command)
  if (!parsed || !workerGates.has(parsed.gate)) return null
  const operands = parsed.values.filter((value) => value !== parsed.taskPath)
  if (!["whitelist", "test-file"].includes(parsed.gate)) {
    return operands.length === 0 ? `npm run task:doctor:${parsed.gate} -- ${parsed.taskPath}` : null
  }
  const filePath = operands.shift()
  if (!filePath || filePath.startsWith("/") || filePath.split("/").includes("..")) return null
  const quotedFile = `'${filePath.replace(/'/g, "'\\''")}'`
  if (parsed.gate === "test-file") {
    return operands.length === 0 ? `npm run task:doctor:test-file -- ${parsed.taskPath} ${quotedFile}` : null
  }
  const reason = operands.join(" ").trim()
  if (!reason) return null
  const quotedReason = `'${reason.replace(/'/g, "'\\''")}'`
  return `npm run task:doctor:whitelist -- ${parsed.taskPath} ${quotedFile} ${quotedReason}`
}

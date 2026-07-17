const mutatingCommand = /(?:^|[;&|]\s*)(?:npm\s+(?:install|uninstall)|(?:pnpm|yarn|bun)\s+(?:add|remove|install)|git\s+(?:add|commit|push|reset|checkout|restore|rebase|merge)|(?:rm|mv|cp|mkdir|touch|chmod|chown)\b|(?:sed|perl)\s+-i\b|cat\s+[^|>]*>|printf\s+[^|>]*>|tee\s+)/
const opaqueInlineCommand = /(?:^|[;&|]\s*)(?:(?:node|bun)\b[^;&|\n]*\s(?:-e|--eval|-p|--print)(?=\s|=)|deno\s+eval\b|python(?:3)?\s+-c\b|ruby\s+-e\b|perl\s+-e\b|php\s+-r\b)/
const shellOutputRedirect = /(?:^|[^<])(?:\d*)>>?\s*(?!&\d)[^\s&]/

export function shellCommandMutates(command: string) {
  const redirectScan = command.replace(/(?:^|\s)2>>?\s*\/dev\/null\b/g, " ")
  return mutatingCommand.test(command) || shellOutputRedirect.test(redirectScan) || opaqueInlineCommand.test(command)
}

export function scopePathFormatError(path: string) {
  if (!path) return "path is empty"
  if (path.startsWith("/") || path.startsWith("~")) return "path must be project-relative"
  if (path.includes("\\")) return "path must use forward slashes"
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return "path must not contain dot segments"
  if (/[*?[\]]/.test(path)) return "path must be exact and must not contain glob metacharacters"
  return null
}

export function stripHarmlessOutputSuffix(command: string) {
  const value = command.trim()
  const match = value.match(/^(.*?)\s+2>&1(?:\s*\|\s*head(?:\s+-n)?\s+-?\d+)?\s*$/)
  return match?.[1]?.trim() || value
}

export function canonicalUniqueNpmScript(command: string, scriptNames: string[]) {
  const value = stripHarmlessOutputSuffix(command)
  if (/[;&|><`\n]|\$\(/.test(value)) return null
  const requested = value.match(/^npm\s+run\s+([A-Za-z0-9:_-]+)\s*$/)?.[1]
  if (!requested || scriptNames.includes(requested)) return null
  const matches = scriptNames.filter((name) => name.endsWith(`:${requested}`))
  return matches.length === 1 ? `npm run ${matches[0]}` : null
}

export function hasTechnicalOperationEvidence(report: any) {
  const changedFiles = Array.isArray(report?.changedFiles)
    ? report.changedFiles.filter((path: unknown) => typeof path === "string" && path.length > 0)
    : []
  const successfulCommands = Array.isArray(report?.commands)
    ? report.commands.filter((entry: any) => (
        entry
        && Number.isInteger(entry.expectedExit)
        && Number.isInteger(entry.actualExit)
        && entry.actualExit === entry.expectedExit
      ))
    : []
  return changedFiles.length > 0 || successfulCommands.length > 0
}

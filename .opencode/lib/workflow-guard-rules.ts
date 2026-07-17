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
  return null
}

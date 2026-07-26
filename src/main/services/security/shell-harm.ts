import { basename, dirname, isAbsolute, parse as parsePath, resolve, sep, win32 } from 'node:path'
import { parse as parseShellCommand } from 'shell-quote'
import { dangerousInSandboxReasons, normalizeShellCommandForAnalysis } from './shell-scope.ts'

export type ShellHarmDecision =
  | { action: 'allow'; reasons: string[] }
  | { action: 'prompt'; reasons: string[] }
  | { action: 'deny'; reasons: string[] }

export interface ShellHarmContext {
  workspaceRoot: string | null
  homeDir: string
  /** Resolve symlinks when possible. Falls back to lexical resolution when absent/throwing. */
  canonicalizePath?: (path: string) => string
  /** Read an interpreter/direct-execution script. Null means missing, unreadable, or too large. */
  readScript?: (path: string) => string | null
}

interface MutableDecision {
  deny: string[]
  prompt: string[]
}

const MAX_SCRIPT_DEPTH = 3
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const CODE_INTERPRETERS = new Set([
  ...SHELL_INTERPRETERS,
  'node',
  'deno',
  'bun',
  'python',
  'python2',
  'python3',
  'ruby',
  'perl',
  'pwsh',
  'powershell',
])
const SCRIPT_EXTENSIONS = /\.(?:sh|bash|zsh|js|cjs|mjs|ts|py|rb|pl|ps1|cmd|bat)$/i

function isWindowsPath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)
}

function addUnique(target: string[], reason: string): void {
  if (!target.includes(reason)) target.push(reason)
}

function canonicalPath(path: string, context: ShellHarmContext): string {
  const lexical = isWindowsPath(path) ? win32.normalize(path) : resolve(path)
  try {
    return context.canonicalizePath?.(lexical) ?? lexical
  } catch {
    return lexical
  }
}

function expandPathToken(token: string, context: ShellHarmContext): string {
  const expanded = token
    .replace(/^~(?=$|[\\/])/, context.homeDir)
    .replace(/\$(?:\{HOME\}|HOME)(?=$|[\\/])/, context.homeDir)
    .replace(/\$(?:\{PWD\}|PWD)(?=$|[\\/])/, context.workspaceRoot ?? '')
    .replace(/^\$env:USERPROFILE(?=$|[\\/])/i, context.homeDir)
    .replace(/^\$USERPROFILE(?=$|[\\/])/i, context.homeDir)
    .replace(/^%(?:USERPROFILE|HOMEPATH)%(?=$|[\\/])/i, context.homeDir)
    .replace(/^%CD%(?=$|[\\/])/i, context.workspaceRoot ?? '')
  if (isAbsolute(expanded) || isWindowsPath(expanded)) return canonicalPath(expanded, context)
  const base = context.workspaceRoot ?? process.cwd()
  return canonicalPath(
    isWindowsPath(base) ? win32.resolve(base, expanded) : resolve(base, expanded),
    context,
  )
}

function isAtOrAbove(path: string, boundary: string): boolean {
  if (isWindowsPath(path) || isWindowsPath(boundary)) {
    const normalizedPath = win32.normalize(path).toLowerCase()
    const normalizedBoundary = win32.normalize(boundary).toLowerCase()
    return (
      normalizedPath === normalizedBoundary ||
      normalizedBoundary.startsWith(normalizedPath + win32.sep)
    )
  }
  const normalizedPath = resolve(path)
  const normalizedBoundary = resolve(boundary)
  return (
    normalizedPath === normalizedBoundary || normalizedBoundary.startsWith(normalizedPath + sep)
  )
}

function destructiveTargetBase(target: string): string {
  const globIndex = target.search(/[?*[{]/)
  if (globIndex < 0) return target
  const prefix = target.slice(0, globIndex)
  const root = isWindowsPath(target) ? win32.parse(target).root : parsePath(target).root
  if (prefix === root) return root
  return prefix.replace(/[\\/]+$/, '') || '.'
}

function catastrophicTargetReason(target: string, context: ShellHarmContext): string | null {
  const resolved = expandPathToken(destructiveTargetBase(target), context)
  const root = isWindowsPath(resolved) ? win32.parse(resolved).root : parsePath(resolved).root
  if (resolved.toLowerCase() === root.toLowerCase())
    return `broad deletion targets filesystem root: ${target}`
  if (isAtOrAbove(resolved, context.homeDir)) return `broad deletion targets home root: ${target}`
  if (context.workspaceRoot && isAtOrAbove(resolved, context.workspaceRoot)) {
    return `broad deletion targets workspace root: ${target}`
  }
  return null
}

function commandSegments(command: string): string[][] {
  let tokens: ReturnType<typeof parseShellCommand>
  try {
    tokens = parseShellCommand(command)
  } catch {
    return []
  }
  const segments: string[][] = []
  let current: string[] = []
  const flush = (): void => {
    if (current.length > 0) segments.push(current)
    current = []
  }
  for (const token of tokens) {
    if (typeof token === 'string') current.push(token)
    else flush()
  }
  flush()
  return segments
}

function rawTokens(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => {
    const first = token[0]
    const last = token[token.length - 1]
    return (first === '"' && last === '"') || (first === "'" && last === "'")
      ? token.slice(1, -1)
      : token
  })
}

/** Preserve globs and Windows backslashes that shell-quote treats as expansions/escapes. */
function rawDeletionSegments(command: string): string[][] {
  const segments: string[][] = []
  const patterns = [
    /(?:^|[;&|(\r\n])\s*((?:sudo\s+)?rm\b[^;&|\r\n]*)/gi,
    /(?:^|[;&|(\r\n])\s*((?:rd|rmdir|del)\b[^;&|\r\n]*)/gi,
    /(?:^|[;&|(\r\n])\s*(Remove-Item\b[^;&|\r\n]*)/gi,
  ]
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const segment = rawTokens((match[1] ?? match[0]).replace(/["']$/, ''))
      if (segment.length > 0) segments.push(segment)
    }
  }
  return segments
}

/** Extract command/process substitutions without executing shell expansion. */
function substitutionBodies(command: string): string[] {
  const bodies: string[] = []
  let singleQuoted = false
  let doubleQuoted = false
  let escaped = false

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && !singleQuoted) {
      escaped = true
      continue
    }
    if (char === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted
      continue
    }
    if (char === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted
      continue
    }
    if (singleQuoted) continue

    const opensSubstitution =
      (char === '$' && command[index + 1] === '(') ||
      ((char === '<' || char === '>') && command[index + 1] === '(')
    if (!opensSubstitution) continue

    const bodyStart = index + 2
    let depth = 1
    let bodySingleQuoted = false
    let bodyDoubleQuoted = false
    let bodyEscaped = false
    for (let cursor = bodyStart; cursor < command.length; cursor += 1) {
      const bodyChar = command[cursor]
      if (bodyEscaped) {
        bodyEscaped = false
        continue
      }
      if (bodyChar === '\\' && !bodySingleQuoted) {
        bodyEscaped = true
        continue
      }
      if (bodyChar === "'" && !bodyDoubleQuoted) {
        bodySingleQuoted = !bodySingleQuoted
        continue
      }
      if (bodyChar === '"' && !bodySingleQuoted) {
        bodyDoubleQuoted = !bodyDoubleQuoted
        continue
      }
      if (bodySingleQuoted) continue
      if (bodyChar === '(') depth += 1
      if (bodyChar === ')') depth -= 1
      if (depth === 0) {
        bodies.push(command.slice(bodyStart, cursor))
        index = cursor
        break
      }
    }
  }
  return bodies
}

function embeddedProcessBodies(command: string): string[] {
  const bodies: string[] = []
  const pattern = /\b(?:exec|execSync|system|popen)\s*\(\s*(['"`])([\s\S]*?)\1/g
  for (const match of command.matchAll(pattern)) {
    const body = match[2]
    if (body) bodies.push(body)
  }
  return bodies
}

function unwrapCommand(argv: string[]): string[] {
  const current = [...argv]
  for (;;) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(current[0] ?? '')) current.shift()
    const head = basename(current[0] ?? '').toLowerCase()
    if (head === 'env') {
      current.shift()
      while (
        (current[0] ?? '').startsWith('-') ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(current[0] ?? '')
      ) {
        current.shift()
      }
      continue
    }
    if (head === 'command' || head === 'builtin' || head === 'nohup') {
      current.shift()
      while ((current[0] ?? '').startsWith('-')) current.shift()
      continue
    }
    if (head === 'sudo') {
      current.shift()
      while ((current[0] ?? '').startsWith('-')) current.shift()
      continue
    }
    return current
  }
}

function hasRecursiveForce(args: string[]): boolean {
  const flags = args.filter((arg) => arg.startsWith('-')).join('')
  return flags.includes('r') && flags.includes('f')
}

function nonOptionArgs(args: string[]): string[] {
  const separator = args.indexOf('--')
  if (separator >= 0) return args.slice(separator + 1).filter(Boolean)
  return args.filter((arg) => arg.length > 0 && !arg.startsWith('-'))
}

function inspectDeletion(argv: string[], context: ShellHarmContext, out: MutableDecision): void {
  const command = basename(argv[0] ?? '').toLowerCase()
  const args = argv.slice(1)
  if (command === 'rm' && hasRecursiveForce(args)) {
    const targets = nonOptionArgs(args)
    for (const target of targets) {
      const catastrophic = catastrophicTargetReason(target, context)
      if (catastrophic) addUnique(out.deny, catastrophic)
    }
    if (targets.length === 0 || out.deny.length === 0) {
      addUnique(out.prompt, 'recursive/forced delete requires confirmation')
    }
    return
  }

  if (command === 'find' && args.includes('-delete')) {
    const target = args.find((arg) => !arg.startsWith('-')) ?? '.'
    const catastrophic = catastrophicTargetReason(target, context)
    if (catastrophic) addUnique(out.deny, catastrophic)
    else addUnique(out.prompt, 'find -delete performs bulk removal')
    return
  }

  const windowsRecursiveDelete =
    (command === 'rmdir' || command === 'rd' || command === 'del') &&
    args.some((arg) => /^\/(?:s|q)$/i.test(arg))
  const powershellRecursiveDelete =
    command === 'remove-item' &&
    args.some((arg) => /^-(?:recurse|r)$/i.test(arg)) &&
    args.some((arg) => /^-(?:force|fo)$/i.test(arg))
  if (windowsRecursiveDelete || powershellRecursiveDelete) {
    const targets = args.filter((arg) => !/^[/-]/.test(arg))
    for (const target of targets) {
      const driveRoot = /^[A-Za-z]:[\\/]?$/.test(target)
      const catastrophic = driveRoot
        ? `broad deletion targets drive root: ${target}`
        : catastrophicTargetReason(target, context)
      if (catastrophic) addUnique(out.deny, catastrophic)
    }
    if (out.deny.length === 0) addUnique(out.prompt, 'recursive deletion requires confirmation')
  }
}

function inspectRawDevice(command: string, out: MutableDecision): void {
  const normalized = normalizeShellCommandForAnalysis(command)
  const rawDevice = String.raw`(?:/dev/(?:disk|rdisk|sd|nvme|mmcblk)[^\s|;&]*|\\\\\.\\PhysicalDrive\d+)`
  if (
    new RegExp(String.raw`\b(?:mkfs(?:\.\w+)?|fdisk|parted)\b[^\n]*${rawDevice}`, 'i').test(
      normalized,
    )
  ) {
    addUnique(out.deny, 'raw disk/device destruction is never allowed')
  }
  if (new RegExp(String.raw`\bdd\b[^\n|;&]*\bof\s*=\s*${rawDevice}`, 'i').test(normalized)) {
    addUnique(out.deny, 'raw disk/device write is never allowed')
  }
  if (new RegExp(String.raw`(?:>|\bshred\b[^\n|;&]*)\s*${rawDevice}`, 'i').test(normalized)) {
    addUnique(out.deny, 'raw disk/device write is never allowed')
  }
  if (
    new RegExp(
      String.raw`\b(?:writeFileSync|writeFile|openSync|createWriteStream|open)\s*\([^\n]*${rawDevice}`,
      'i',
    ).test(normalized)
  ) {
    addUnique(out.deny, 'raw disk/device write is never allowed')
  }
  if (/\bdiskutil\s+(?:eraseDisk|partitionDisk|zeroDisk|secureErase)\b/i.test(normalized)) {
    addUnique(out.deny, 'raw disk/device destruction is never allowed')
  }
  if (
    /\b(?:Clear-Disk|Format-Volume)\b/i.test(normalized) ||
    /(?:^|[;&|])\s*format\s+[A-Za-z]:/i.test(normalized)
  ) {
    addUnique(out.deny, 'raw disk/device destruction is never allowed')
  }
}

function inspectPermissionBypass(command: string, out: MutableDecision): void {
  const normalized = normalizeShellCommandForAnalysis(command)
  const namesPermissionSurface =
    /\b(?:permission-gate|permission-policy|guarded[-_]?yolo|autoRunSandboxCommands|safetyExternalDenyThreshold|approval:respond)\b/i.test(
      normalized,
    )
  const mutatesNormalized =
    /(?:^|[;&|]\s*)(?:rm|mv|cp|sed\s+-i|perl\s+-pi|truncate|defaults\s+write|reg\s+add)\b|(?:>|\btee\b)|\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rename(?:Sync)?|truncate(?:Sync)?|write_text|write_bytes|rmtree|Set-Content|Out-File|Remove-Item)\b|\bopen\s*\([^)]*,\s*['"][wax+]/i.test(
      normalized,
    )
  const mutatesQuotedOpen = /\bopen\s*\([^)]*,\s*['"][wax+]/i.test(command)
  if (namesPermissionSurface && (mutatesNormalized || mutatesQuotedOpen)) {
    addUnique(out.deny, 'attempts to disable or rewrite the permission system are never allowed')
  }
}

function inspectLanguageDeletion(
  command: string,
  context: ShellHarmContext,
  out: MutableDecision,
): void {
  const pattern =
    /\b(?:rmSync|rmdirSync|removeSync|shutil\.rmtree|FileUtils\.rm_rf)\s*\(\s*(['"])([^'"]+)\1/gi
  for (const match of command.matchAll(pattern)) {
    const target = match[2]
    if (!target) continue
    const catastrophic = catastrophicTargetReason(target, context)
    if (catastrophic) addUnique(out.deny, catastrophic)
    else addUnique(out.prompt, 'recursive deletion from interpreter code requires confirmation')
  }
}

function inlineBody(argv: string[]): string | null {
  for (let index = 1; index < argv.length - 1; index += 1) {
    const arg = argv[index]
    if (arg === '-c' || arg === '-e' || arg === '--eval' || arg === '-Command') {
      return argv[index + 1] ?? null
    }
  }
  return null
}

function scriptOperand(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    if (SCRIPT_EXTENSIONS.test(arg)) return arg
  }
  const head = argv[0]
  if (head && head.includes('/') && !isAbsolute(head)) return head
  return null
}

function inspectInterpreter(
  argv: string[],
  context: ShellHarmContext,
  out: MutableDecision,
  depth: number,
  seenScripts: Set<string>,
): void {
  const executable = basename(argv[0] ?? '').toLowerCase()
  if (!CODE_INTERPRETERS.has(executable) && !(argv[0] ?? '').includes('/')) return

  const inline = inlineBody(argv)
  if (inline !== null) {
    if (depth >= MAX_SCRIPT_DEPTH) {
      addUnique(out.prompt, 'nested inline interpreter code could not be fully inspected')
      return
    }
    mergeDecision(out, assess(inline, context, depth + 1, seenScripts))
    return
  }

  const operand = scriptOperand(argv)
  if (!operand) return
  const resolved = expandPathToken(operand, context)
  if (seenScripts.has(resolved)) return
  seenScripts.add(resolved)
  const contents = context.readScript?.(resolved) ?? null
  if (contents === null || depth >= MAX_SCRIPT_DEPTH) {
    addUnique(out.prompt, `script contents could not be inspected safely: ${operand}`)
    return
  }
  mergeDecision(
    out,
    assess(contents, { ...context, workspaceRoot: dirname(resolved) }, depth + 1, seenScripts),
  )
}

function inspectObviousCatastrophe(command: string, out: MutableDecision): void {
  const normalized = normalizeShellCommandForAnalysis(command)
  if (/:\(\)\s*\{\s*:\|:&\s*}\s*;/.test(normalized)) {
    addUnique(out.deny, 'fork bomb is never allowed')
  }
  if (/\b(?:shutdown|reboot|halt|poweroff)\b/i.test(normalized)) {
    addUnique(out.deny, 'host shutdown or reboot is never allowed')
  }
  if (
    /\b(?:killall|pkill)\b[^\n|;&]*(?:-9|SIGKILL)[^\n|;&]*(?:launchd|systemd|electron|copse)/i.test(
      normalized,
    )
  ) {
    addUnique(out.deny, 'attempts to kill the host or permission process are never allowed')
  }
}

function mergeDecision(out: MutableDecision, decision: ShellHarmDecision): void {
  const target =
    decision.action === 'deny' ? out.deny : decision.action === 'prompt' ? out.prompt : null
  if (!target) return
  for (const reason of decision.reasons) addUnique(target, reason)
}

function assess(
  command: string,
  context: ShellHarmContext,
  depth: number,
  seenScripts: Set<string>,
): ShellHarmDecision {
  const out: MutableDecision = { deny: [], prompt: [] }
  const inspectableCommand = command.replace(/^#![^\r\n]*(?:\r?\n|$)/, '')
  const commandForParsing = inspectableCommand
    .replace(/\$(?:\{HOME\}|HOME)(?=$|[\s/\\])/g, JSON.stringify(context.homeDir))
    .replace(
      /\$(?:\{PWD\}|PWD)(?=$|[\s/\\])/g,
      JSON.stringify(context.workspaceRoot ?? context.homeDir),
    )
    .replace(/\$env:USERPROFILE(?=$|[\s/\\])/gi, JSON.stringify(context.homeDir))
    .replace(/\$USERPROFILE(?=$|[\s/\\])/gi, JSON.stringify(context.homeDir))
    .replace(/%(?:USERPROFILE|HOMEPATH)%(?=$|[\s/\\])/gi, JSON.stringify(context.homeDir))
    .replace(/%CD%(?=$|[\s/\\])/gi, JSON.stringify(context.workspaceRoot ?? context.homeDir))
  inspectRawDevice(inspectableCommand, out)
  inspectPermissionBypass(inspectableCommand, out)
  inspectLanguageDeletion(inspectableCommand, context, out)
  inspectObviousCatastrophe(inspectableCommand, out)

  const segments = [
    ...commandSegments(commandForParsing),
    ...rawDeletionSegments(commandForParsing),
  ]
  for (const segment of segments) {
    const argv = unwrapCommand(segment)
    if (argv.length === 0) continue
    inspectDeletion(argv, context, out)
    inspectInterpreter(argv, context, out, depth, seenScripts)
  }

  for (const body of substitutionBodies(inspectableCommand)) {
    if (depth >= MAX_SCRIPT_DEPTH) {
      addUnique(out.prompt, 'nested command substitution could not be fully inspected')
      break
    }
    mergeDecision(out, assess(body, context, depth + 1, seenScripts))
  }
  for (const body of embeddedProcessBodies(inspectableCommand)) {
    if (depth >= MAX_SCRIPT_DEPTH) {
      addUnique(out.prompt, 'nested child-process code could not be fully inspected')
      break
    }
    mergeDecision(out, assess(body, context, depth + 1, seenScripts))
  }

  for (const reason of dangerousInSandboxReasons(inspectableCommand)) addUnique(out.prompt, reason)
  if (/\|\s*(?:sh|bash|zsh|python3?|node|ruby|perl|pwsh|powershell)\b/i.test(inspectableCommand)) {
    addUnique(out.prompt, 'piping output into an interpreter requires confirmation')
  }
  if (
    /\$(?:\{|[A-Za-z_])|%[A-Za-z_][A-Za-z0-9_]*%/.test(inspectableCommand) &&
    /\b(?:rm|del|rmdir|remove-item|dd|mkfs|shred)\b/i.test(inspectableCommand)
  ) {
    addUnique(out.prompt, 'dynamic path or command expansion prevents complete harm analysis')
  }

  if (out.deny.length > 0) return { action: 'deny', reasons: out.deny }
  if (out.prompt.length > 0) return { action: 'prompt', reasons: out.prompt }
  return { action: 'allow', reasons: ['no deterministic harmful-command signals detected'] }
}

/**
 * Host-owned deterministic harm gate for Guarded YOLO. It is deliberately
 * independent of scope/classifier output: a model, hook, trust rule, or routing
 * hint cannot downgrade its prompt/deny result.
 */
export function assessShellHarm(command: string, context: ShellHarmContext): ShellHarmDecision {
  return assess(command, context, 0, new Set<string>())
}

import { dirname, isAbsolute, parse as parsePath, resolve, sep, win32 } from 'node:path'
import {
  CODE_INTERPRETERS,
  SCRIPT_EXTENSIONS,
  commandName,
  inlineCodeBody,
  shellSegments,
  unwrapWrappers,
} from './shell-argv.ts'
import {
  REASON_FIND_DELETE,
  REASON_RECURSIVE_DELETE,
  dangerousInSandboxReasons,
  normalizeShellCommandForAnalysis,
} from './shell-scope.ts'

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

/**
 * Home- and cwd-references across sh, PowerShell, and cmd. One table, because it
 * is applied twice — once per path token ({@link expandPathToken}) and once over
 * the whole command line before lexing ({@link substitutePathVariables}) — and
 * two copies had drifted: `$PWD` resolved to the empty string in one and to the
 * home directory in the other, so with no workspace root `rm -rf $PWD` denied
 * with the reason "targets home root", which was not true.
 */
function pathVariables(context: ShellHarmContext): Array<{ re: RegExp; value: string }> {
  const cwd = context.workspaceRoot ?? process.cwd()
  return [
    { re: /\$(?:\{HOME\}|HOME)(?=$|[\s/\\])/g, value: context.homeDir },
    { re: /\$(?:\{PWD\}|PWD)(?=$|[\s/\\])/g, value: cwd },
    { re: /\$env:USERPROFILE(?=$|[\s/\\])/gi, value: context.homeDir },
    { re: /\$USERPROFILE(?=$|[\s/\\])/gi, value: context.homeDir },
    { re: /%(?:USERPROFILE|HOMEPATH)%(?=$|[\s/\\])/gi, value: context.homeDir },
    { re: /%CD%(?=$|[\s/\\])/gi, value: cwd },
  ]
}

/**
 * Rewrite path variables in a whole command line before lexing, quoting each
 * substitution so an expanded Windows path survives the lexer as one token.
 */
function substitutePathVariables(command: string, context: ShellHarmContext): string {
  let result = command
  for (const { re, value } of pathVariables(context)) {
    result = result.replace(re, JSON.stringify(value))
  }
  return result
}

function expandPathToken(token: string, context: ShellHarmContext): string {
  let expanded = token.replace(/^~(?=$|[\\/])/, context.homeDir)
  for (const { re, value } of pathVariables(context)) expanded = expanded.replace(re, value)
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

/**
 * System trees whose loss bricks the host as surely as erasing `/`. Without
 * these, `rm -rf /etc` or `mv /usr /tmp` read as ordinary bounded work because
 * they are neither the filesystem root, the home directory, nor the workspace.
 */
const SYSTEM_ROOTS = [
  '/bin',
  '/boot',
  '/etc',
  '/lib',
  '/sbin',
  '/usr',
  '/var',
  '/System',
  '/Library',
  'C:\\Windows',
  'C:\\Program Files',
]

/**
 * What a destructive target turns out to be, kept structured rather than
 * pre-formatted. The three inspectors that reuse this check previously received a
 * finished English sentence and patched the verb back out of it with
 * `.replace('broad deletion', …)`, which left the wording of a security reason at
 * the mercy of string surgery.
 */
type CatastrophicScope =
  'filesystem root' | 'system tree' | 'home root' | 'workspace root' | 'drive root'

interface CatastrophicHit {
  scope: CatastrophicScope
  target: string
}

function catastrophicTarget(target: string, context: ShellHarmContext): CatastrophicHit | null {
  const resolved = expandPathToken(destructiveTargetBase(target), context)
  const root = isWindowsPath(resolved) ? win32.parse(resolved).root : parsePath(resolved).root
  if (resolved.toLowerCase() === root.toLowerCase()) return { scope: 'filesystem root', target }
  for (const systemRoot of SYSTEM_ROOTS) {
    if (isAtOrAbove(resolved, systemRoot)) return { scope: 'system tree', target }
  }
  if (isAtOrAbove(resolved, context.homeDir)) return { scope: 'home root', target }
  if (context.workspaceRoot && isAtOrAbove(resolved, context.workspaceRoot)) {
    return { scope: 'workspace root', target }
  }
  return null
}

function catastrophicReason(verb: string, hit: CatastrophicHit): string {
  return `${verb} targets ${hit.scope}: ${hit.target}`
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
  const command = commandName(argv[0])
  const args = argv.slice(1)
  if (command === 'rm' && hasRecursiveForce(args)) {
    let flagged = false
    for (const target of nonOptionArgs(args)) {
      const hit = catastrophicTarget(target, context)
      if (hit) {
        addUnique(out.deny, catastrophicReason('broad deletion', hit))
        flagged = true
      }
    }
    // Worded exactly as shell-scope's fuzzy net words it, so a command both see
    // reports the signal once rather than twice.
    if (!flagged) addUnique(out.prompt, REASON_RECURSIVE_DELETE)
    return
  }

  if (command === 'find' && args.includes('-delete')) {
    const target = args.find((arg) => !arg.startsWith('-')) ?? '.'
    const hit = catastrophicTarget(target, context)
    if (hit) addUnique(out.deny, catastrophicReason('broad deletion', hit))
    else addUnique(out.prompt, REASON_FIND_DELETE)
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
    let flagged = false
    for (const target of args.filter((arg) => !/^[/-]/.test(arg))) {
      const hit: CatastrophicHit | null = /^[A-Za-z]:[\\/]?$/.test(target)
        ? { scope: 'drive root', target }
        : catastrophicTarget(target, context)
      if (hit) {
        addUnique(out.deny, catastrophicReason('broad deletion', hit))
        flagged = true
      }
    }
    if (!flagged) addUnique(out.prompt, 'recursive deletion requires confirmation')
  }
}

const RECURSIVE_FLAG = /^(?:-[A-Za-z]*R[A-Za-z]*|--recursive)$/

/**
 * Ownership and permission destruction. `chown -R nobody /` or `chmod -R 000 ~`
 * deletes nothing but renders the tree unusable — equivalent broad impact to
 * erasure, so it earns the same verdict.
 */
function inspectOwnershipChange(
  argv: string[],
  context: ShellHarmContext,
  out: MutableDecision,
): void {
  const command = commandName(argv[0])
  if (command !== 'chmod' && command !== 'chown' && command !== 'chgrp') return
  const args = argv.slice(1)
  if (!args.some((arg) => RECURSIVE_FLAG.test(arg))) return
  // chmod/chown take a mode/owner operand before the paths; drop it.
  const operands = nonOptionArgs(args).slice(1)
  let flagged = false
  for (const target of operands) {
    const hit = catastrophicTarget(target, context)
    if (hit) {
      addUnique(out.deny, catastrophicReason(`recursive ${command}`, hit))
      flagged = true
    }
  }
  if (!flagged) addUnique(out.prompt, `recursive ${command} requires confirmation`)
}

/**
 * Relocation is erasure by another name: `mv ~ /tmp/gone` leaves nothing at the
 * original path. Every argument except the destination is a source.
 */
function inspectRelocation(argv: string[], context: ShellHarmContext, out: MutableDecision): void {
  const command = commandName(argv[0])
  if (command !== 'mv' && command !== 'move' && command !== 'move-item') return
  const operands = nonOptionArgs(argv.slice(1))
  if (operands.length < 2) return
  for (const source of operands.slice(0, -1)) {
    const hit = catastrophicTarget(source, context)
    if (hit) addUnique(out.deny, catastrophicReason('relocation', hit))
  }
}

/** Overwrite/hijack of an existing path: dd onto a regular file, symlink swap. */
function inspectOverwrite(argv: string[], context: ShellHarmContext, out: MutableDecision): void {
  const command = commandName(argv[0])
  if (command === 'dd') {
    const output = argv.slice(1).find((arg) => /^of=/i.test(arg))
    if (output) {
      const target = output.slice(3)
      const hit = catastrophicTarget(target, context)
      if (hit) addUnique(out.deny, catastrophicReason('dd overwrite', hit))
      else addUnique(out.prompt, `dd overwrites an existing path: ${target}`)
    }
    return
  }
  if (command === 'ln' && argv.slice(1).some((arg) => /^-[A-Za-z]*f/.test(arg))) {
    addUnique(out.prompt, 'forced symlink replaces an existing path')
    return
  }
  if (command === 'crontab' && argv.slice(1).some((arg) => arg === '-r')) {
    addUnique(out.prompt, 'crontab -r removes all scheduled jobs')
  }
}

const RAW_DEVICE = String.raw`(?:/dev/(?:disk|rdisk|sd|nvme|mmcblk)[^\s|;&]*|\\\\\.\\PhysicalDrive\d+)`

/** Hoisted: these were rebuilt on every call, at every recursion depth. */
const RAW_DEVICE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: new RegExp(String.raw`\b(?:mkfs(?:\.\w+)?|fdisk|parted)\b[^\n]*${RAW_DEVICE}`, 'i'),
    reason: 'raw disk/device destruction is never allowed',
  },
  {
    re: new RegExp(String.raw`\bdd\b[^\n|;&]*\bof\s*=\s*${RAW_DEVICE}`, 'i'),
    reason: 'raw disk/device write is never allowed',
  },
  {
    re: new RegExp(String.raw`(?:>|\bshred\b[^\n|;&]*)\s*${RAW_DEVICE}`, 'i'),
    reason: 'raw disk/device write is never allowed',
  },
  {
    re: new RegExp(
      String.raw`\b(?:writeFileSync|writeFile|openSync|createWriteStream|open)\s*\([^\n]*${RAW_DEVICE}`,
      'i',
    ),
    reason: 'raw disk/device write is never allowed',
  },
  {
    re: /\bdiskutil\s+(?:eraseDisk|partitionDisk|zeroDisk|secureErase)\b/i,
    reason: 'raw disk/device destruction is never allowed',
  },
  {
    re: /\b(?:Clear-Disk|Format-Volume)\b/i,
    reason: 'raw disk/device destruction is never allowed',
  },
  {
    re: /(?:^|[;&|])\s*format\s+[A-Za-z]:/i,
    reason: 'raw disk/device destruction is never allowed',
  },
]

function inspectRawDevice(normalized: string, out: MutableDecision): void {
  for (const { re, reason } of RAW_DEVICE_PATTERNS) {
    if (re.test(normalized)) addUnique(out.deny, reason)
  }
}

function inspectPermissionBypass(command: string, normalized: string, out: MutableDecision): void {
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
    const hit = catastrophicTarget(target, context)
    if (hit) addUnique(out.deny, catastrophicReason('broad deletion', hit))
    else addUnique(out.prompt, 'recursive deletion from interpreter code requires confirmation')
  }
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
  if (!CODE_INTERPRETERS.has(commandName(argv[0])) && !(argv[0] ?? '').includes('/')) return

  const inline = inlineCodeBody(argv)
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

function inspectObviousCatastrophe(normalized: string, out: MutableDecision): void {
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
  const normalized = normalizeShellCommandForAnalysis(inspectableCommand)

  inspectRawDevice(normalized, out)
  inspectPermissionBypass(inspectableCommand, normalized, out)
  inspectLanguageDeletion(inspectableCommand, context, out)
  inspectObviousCatastrophe(normalized, out)

  for (const segment of shellSegments(substitutePathVariables(inspectableCommand, context))) {
    const argv = unwrapWrappers(segment)
    if (argv.length === 0) continue
    inspectDeletion(argv, context, out)
    inspectOwnershipChange(argv, context, out)
    inspectRelocation(argv, context, out)
    inspectOverwrite(argv, context, out)
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

  // The fuzzy regex net shared with standard mode. It overlaps the token-based
  // inspectors above deliberately — it reaches forms the lexers cannot — and the
  // overlapping reasons are worded identically so they dedupe instead of
  // reporting the same fact twice. Pipe-to-interpreter used to be re-implemented
  // here as well, which is why every piped command carried two near-identical
  // reasons; the shared pattern now covers pwsh/powershell too.
  for (const reason of dangerousInSandboxReasons(inspectableCommand)) addUnique(out.prompt, reason)
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

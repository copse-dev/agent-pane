import { dirname, isAbsolute, parse as parsePath, resolve, sep, win32 } from 'node:path'
import {
  CODE_INTERPRETERS,
  SCRIPT_EXTENSIONS,
  SHELL_LANGUAGE_INTERPRETERS,
  commandName,
  inlineCodeBody,
  shellRedirects,
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

/**
 * Tokens whose value is substituted by another tool at run time — `xargs -I{}`
 * and `find -exec … {}`. They are not paths, and resolving them lexically made
 * `{}` come out as the workspace root: `find . -name '*.tmp' | xargs -I{} rm -rf {}`
 * was hard-DENIED as a workspace wipe, with no approval path, for a routine
 * cleanup. Unknown at analysis time is a prompt, not a deny.
 */
function isRunTimePlaceholder(target: string): boolean {
  return target.includes('{}') || target === '%'
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
  if (isRunTimePlaceholder(target)) return null
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

    // Backticks are command substitution too. Leaving them out meant
    // `echo \`rm -rf /\`` never had its body assessed — shell-scope has always
    // flagged backticks, this gate did not.
    if (char === '`') {
      const close = command.indexOf('`', index + 1)
      if (close < 0) continue
      bodies.push(command.slice(index + 1, close))
      index = close
      continue
    }

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

/**
 * `rm -r` deletes a tree with or without `-f` — `-f` only suppresses prompts for
 * write-protected files and missing operands. Requiring both meant `rm -r /` and
 * `rm -r ~` fell through to a generic prompt instead of a hard deny.
 */
function hasRecursive(args: string[]): boolean {
  return args.some(
    (arg) => arg.startsWith('-') && (/^--recursive$/.test(arg) || /^-[A-Za-z]*[rR]/.test(arg)),
  )
}

function nonOptionArgs(args: string[]): string[] {
  const separator = args.indexOf('--')
  if (separator >= 0) return args.slice(separator + 1).filter(Boolean)
  return args.filter((arg) => arg.length > 0 && !arg.startsWith('-'))
}

function inspectDeletion(argv: string[], context: ShellHarmContext, out: MutableDecision): void {
  const command = commandName(argv[0])
  const args = argv.slice(1)
  if (command === 'rm' && hasRecursive(args)) {
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
  const posixOwnership = command === 'chmod' || command === 'chown' || command === 'chgrp'
  // `chattr -R +i /` makes every file immutable: nothing is deleted and nothing can
  // be changed again, including by the user. Same broad impact as `chmod -R 000 /`.
  // `takeown`/`icacls` are the Windows equivalents of recursive chown/chmod.
  const windowsOwnership = command === 'takeown' || command === 'icacls'
  if (!posixOwnership && command !== 'chattr' && !windowsOwnership) return
  const args = argv.slice(1)
  const recursive = windowsOwnership
    ? args.some((arg) => /^[/-][rt]$/i.test(arg))
    : args.some((arg) => RECURSIVE_FLAG.test(arg))
  if (!recursive) return
  // chmod/chown/chattr take a mode/owner/attribute operand before the paths; drop
  // it. takeown/icacls name their path with `/f <path>` or as the first operand.
  const operands =
    posixOwnership || command === 'chattr' ? nonOptionArgs(args).slice(1) : nonOptionArgs(args)
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
  const args = argv.slice(1)
  const operands = nonOptionArgs(args)
  if (operands.length < 2) return
  // `mv -t DEST SRC…` puts the destination first, so the last operand is a source,
  // not the target. Reading it positionally let `mv -t /tmp/gone ~` through.
  const explicitTarget = args.some((arg) => /^(?:-t|--target-directory)/.test(arg))
  const sources = explicitTarget ? operands.slice(1) : operands.slice(0, -1)
  const destination = explicitTarget ? operands[0] : operands[operands.length - 1]
  let flagged = false
  for (const source of sources) {
    const hit = catastrophicTarget(source, context)
    if (hit) {
      addUnique(out.deny, catastrophicReason('relocation', hit))
      flagged = true
    }
  }
  if (flagged) return
  // Moving a tree out from under its own root erases it from that location just as
  // `rm -rf` would, and `rm -rf src` prompts — so this should not stay silent.
  // Moves that stay inside the workspace are ordinary renames.
  if (destination === undefined || isRunTimePlaceholder(destination)) return
  const destinationInside = isInsideWorkspace(destination, context)
  for (const source of sources) {
    if (isRunTimePlaceholder(source)) continue
    const sensitive = sensitiveWriteReason(source, context)
    if (sensitive !== null) {
      addUnique(out.prompt, `relocation moves a sensitive path away: ${source}`)
      continue
    }
    if (isInsideWorkspace(source, context) && !destinationInside) {
      addUnique(out.prompt, `relocation moves ${source} out of the workspace`)
    }
  }
}

function isInsideWorkspace(target: string, context: ShellHarmContext): boolean {
  const root = context.workspaceRoot
  if (!root) return false
  const resolved = expandPathToken(destructiveTargetBase(target), context)
  return isAtOrAbove(root, resolved)
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

/**
 * Whole-disk destruction that names no `/dev/` node in a form the patterns above
 * recognise, or names one only as a bare operand. `wipefs -a /dev/sda` erases
 * every filesystem signature on the device; `cryptsetup luksFormat` replaces the
 * header, which discards the key slots and with them all the data.
 */
const DEVICE_DESTRUCTION_VERBS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bwipefs\b/i, reason: 'wipefs erases filesystem signatures' },
  { re: /\bblkdiscard\b/i, reason: 'blkdiscard discards every block on the device' },
  {
    re: /\bsgdisk\b[^\n|;&]*--zap(?:-all)?\b/i,
    reason: 'sgdisk --zap-all destroys the partition table',
  },
  {
    re: /\bcryptsetup\b[^\n|;&]*\bluksFormat\b/i,
    reason: 'luksFormat replaces the LUKS header and discards all key slots',
  },
  { re: /\bhdparm\b[^\n|;&]*--security-erase\b/i, reason: 'hdparm security-erase wipes the drive' },
  { re: /\bnvme\s+format\b/i, reason: 'nvme format wipes the namespace' },
  { re: /\bbadblocks\b[^\n|;&]*\s-w\b/i, reason: 'badblocks -w overwrites every block' },
]

function inspectDeviceDestruction(normalized: string, out: MutableDecision): void {
  for (const { re, reason } of DEVICE_DESTRUCTION_VERBS) {
    if (re.test(normalized)) addUnique(out.deny, `${reason} — never allowed`)
  }
}

/**
 * Destruction of the copies you would restore *from*. This is the signature move
 * of ransomware and the one mistake with no undo: every other entry in this file
 * costs you data you might still have a backup of.
 */
const BACKUP_DESTRUCTION: Array<{ re: RegExp; reason: string }> = [
  { re: /\bvssadmin\b[^\n|;&]*\bdelete\s+shadows\b/i, reason: 'deletes Windows shadow copies' },
  { re: /\bwbadmin\b[^\n|;&]*\bdelete\b/i, reason: 'deletes Windows backup catalog/backups' },
  {
    re: /\bDelete-VolumeShadowCopy\b|\bGet-WmiObject\b[^\n]*Win32_ShadowCopy[^\n]*\bDelete\b/i,
    reason: 'deletes Windows shadow copies',
  },
  {
    re: /\btmutil\s+(?:delete|destroybackup|disable)\b/i,
    reason: 'deletes or disables Time Machine backups',
  },
  { re: /\bbcdedit\b[^\n|;&]*\brecoveryenabled\s+No\b/i, reason: 'disables Windows recovery' },
  {
    re: /\bjournalctl\b[^\n|;&]*--vacuum-(?:time|size|files)\b/i,
    reason: 'discards system journal history',
  },
]

/**
 * Turning off the protections that would stop the next command. Not destructive
 * in itself, which is exactly why it does not belong on the auto-run path: its
 * whole purpose is to make something else possible.
 */
const SECURITY_CONTROL_DISABLING: Array<{ re: RegExp; reason: string }> = [
  { re: /\bcsrutil\s+disable\b/i, reason: 'disables macOS System Integrity Protection' },
  {
    re: /\bspctl\b[^\n|;&]*(?:--master-disable|--global-disable)\b/i,
    reason: 'disables macOS Gatekeeper',
  },
  { re: /\bsetenforce\s+0\b/i, reason: 'puts SELinux into permissive mode' },
  {
    re: /\b(?:systemctl|service)\b[^\n|;&]*\b(?:stop|disable)\b[^\n|;&]*\b(?:firewalld|ufw|apparmor|auditd)\b/i,
    reason: 'stops a host security service',
  },
  { re: /\bufw\s+disable\b/i, reason: 'disables the host firewall' },
  {
    re: /\bSet-MpPreference\b[^\n|;&]*-Disable\w*/i,
    reason: 'disables Microsoft Defender protection',
  },
  {
    re: /\bAdd-MpPreference\b[^\n|;&]*-ExclusionPath\b/i,
    reason: 'adds a Microsoft Defender scan exclusion',
  },
  {
    re: /\bnetsh\s+advfirewall\b[^\n|;&]*\bstate\s+off\b/i,
    reason: 'disables the Windows firewall',
  },
]

/**
 * Removing the account you are logged in as, or the registry hive the OS boots
 * from. Neither deletes a file the path inspectors would recognise.
 */
const ACCOUNT_AND_REGISTRY_DESTRUCTION: Array<{ re: RegExp; reason: string }> = [
  { re: /\buserdel\b/i, reason: 'userdel removes a user account' },
  { re: /\bdscl\b[^\n|;&]*\s-delete\s+\/Users\b/i, reason: 'dscl -delete removes a macOS account' },
  { re: /\bpasswd\s+-d\b/i, reason: 'passwd -d clears an account password' },
  {
    // No trailing \b: normalizeShellCommandForAnalysis strips the backslash
    // separators, so `HKLM\SOFTWARE` arrives here as `HKLMSOFTWARE`.
    re: /\breg\s+delete\s+(?:HKLM|HKEY_LOCAL_MACHINE|HKCU|HKEY_CURRENT_USER)/i,
    reason: 'reg delete removes a registry hive subtree',
  },
  {
    re: /\bRemove-Item\b[^\n|;&]*\bHK(?:LM|CU):/i,
    reason: 'Remove-Item on a registry hive removes system configuration',
  },
]

function inspectProtectionRemoval(normalized: string, out: MutableDecision): void {
  for (const { re, reason } of BACKUP_DESTRUCTION) {
    if (re.test(normalized)) addUnique(out.deny, `${reason} — never allowed`)
  }
  for (const { re, reason } of SECURITY_CONTROL_DISABLING) {
    if (re.test(normalized)) addUnique(out.deny, `${reason} — never allowed`)
  }
  for (const { re, reason } of ACCOUNT_AND_REGISTRY_DESTRUCTION) {
    if (re.test(normalized)) addUnique(out.deny, `${reason} — never allowed`)
  }
}

/**
 * Paths whose loss or replacement hands over future execution or credentials.
 * These are not *catastrophic* in the at-or-above-a-boundary sense — they are
 * single files — so they need naming.
 */
const SENSITIVE_HOME_PATHS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.gitconfig',
]

/**
 * System files where *any* write hands over the machine, so append is no safer
 * than truncate: one line in `sudoers` is passwordless root, and an edit to
 * `shadow`/`passwd` is an account takeover.
 */
const CREDENTIAL_SYSTEM_FILES = [
  '/etc/sudoers',
  '/etc/sudoers.d',
  '/etc/shadow',
  '/etc/passwd',
  '/etc/group',
  '/etc/pam.d',
  '/etc/ssh/sshd_config',
  '/root/.ssh',
]

function credentialSystemFile(resolved: string): string | null {
  for (const path of CREDENTIAL_SYSTEM_FILES) {
    if (isAtOrAbove(path, resolved)) return path
  }
  return null
}

function sensitiveWriteReason(target: string, context: ShellHarmContext): string | null {
  if (isRunTimePlaceholder(target)) return null
  const resolved = expandPathToken(destructiveTargetBase(target), context)
  const credential = credentialSystemFile(resolved)
  if (credential !== null) return `writes host credential file ${credential}`
  for (const systemRoot of SYSTEM_ROOTS) {
    if (isAtOrAbove(systemRoot, resolved)) return `writes inside system tree ${systemRoot}`
  }
  for (const entry of SENSITIVE_HOME_PATHS) {
    const sensitive = isWindowsPath(context.homeDir)
      ? win32.join(context.homeDir, entry)
      : `${context.homeDir}/${entry}`
    if (isAtOrAbove(sensitive, resolved)) return `writes credential/startup path ${entry}`
  }
  return null
}

/**
 * A redirect is the shell's plainest destructive verb and it has no command name,
 * so no argv inspector sees it: `echo "" > /etc/passwd` erases the password file
 * with nothing but `echo` in argv. Truncation of a system file is unrecoverable
 * in-place, so it is denied; appending, and touching credential/startup files,
 * prompts. In-workspace and `/tmp` writes stay routine.
 */
function inspectRedirects(command: string, context: ShellHarmContext, out: MutableDecision): void {
  for (const { target, truncates } of shellRedirects(command)) {
    const reason = sensitiveWriteReason(target, context)
    if (reason === null) continue
    const catastrophic = catastrophicTarget(target, context)
    if (catastrophic) {
      addUnique(out.deny, catastrophicReason('redirect', catastrophic))
      continue
    }
    if (reason.startsWith('writes host credential file')) {
      addUnique(out.deny, `redirect ${reason}: ${target}`)
      continue
    }
    if (truncates && reason.startsWith('writes inside system tree')) {
      addUnique(out.deny, `truncating redirect ${reason}: ${target}`)
      continue
    }
    addUnique(out.prompt, `redirect ${reason}: ${target}`)
  }
}

/**
 * Commands that write a path given as an ordinary argument rather than through a
 * redirect. `cp /dev/null ~/.ssh/id_rsa` destroys a key with no deletion verb and
 * no `>` for the redirect inspector to see.
 */
const ARGUMENT_WRITERS = new Set(['tee', 'sponge', 'cp', 'install', 'ln', 'mv', 'dd', 'touch'])

function inspectArgumentWrites(
  argv: string[],
  context: ShellHarmContext,
  out: MutableDecision,
): void {
  const command = commandName(argv[0])
  if (!ARGUMENT_WRITERS.has(command)) return
  const operands = nonOptionArgs(argv.slice(1))
  // For the copy/move/link family only the last operand is the destination; for
  // `tee`/`touch` every operand is written.
  const written =
    command === 'tee' || command === 'sponge' || command === 'touch' ? operands : operands.slice(-1)
  for (const target of written) {
    const reason = sensitiveWriteReason(target, context)
    if (reason === null) continue
    if (reason.startsWith('writes host credential file')) {
      addUnique(out.deny, `${command} ${reason}: ${target}`)
      continue
    }
    addUnique(out.prompt, `${command} ${reason}: ${target}`)
  }
}

/**
 * `rsync --delete` makes the destination match the source by removing everything
 * the source does not have — a deletion verb whose name contains no hint of one.
 */
function inspectMirrorDeletion(
  argv: string[],
  context: ShellHarmContext,
  out: MutableDecision,
): void {
  if (commandName(argv[0]) !== 'rsync') return
  if (!argv.slice(1).some((arg) => /^--delete(?:-\w+)?$/.test(arg))) return
  const destination = nonOptionArgs(argv.slice(1)).at(-1)
  if (destination === undefined) return
  const hit = catastrophicTarget(destination, context)
  if (hit) addUnique(out.deny, catastrophicReason('rsync --delete mirror', hit))
  else addUnique(out.prompt, `rsync --delete removes files under ${destination}`)
}

/**
 * Signals that take out the whole session rather than one process. `kill -9 -1`
 * targets every process the user owns — including the app holding this very
 * permission prompt — and `kill -9 1` targets init.
 */
function inspectProcessKill(argv: string[], out: MutableDecision): void {
  const command = commandName(argv[0])
  if (command === 'kill') {
    for (const arg of argv.slice(1)) {
      if (arg === '-1' || arg === '1' || /^-\d{2,}$/.test(arg)) {
        addUnique(out.deny, 'killing every process in a process group or init is never allowed')
        return
      }
    }
    return
  }
  if (command !== 'pkill' && command !== 'killall') return
  const args = argv.slice(1)
  if (args.some((arg) => /^(?:-u|--user|-U|--uid)$/.test(arg) || /^-u\S/.test(arg))) {
    addUnique(out.deny, 'killing every process owned by a user is never allowed')
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

/**
 * Recursive-deletion calls in interpreter code. The verb list covers Node, Python
 * and Ruby; `fs.promises.rm` and `rimraf` were previously absent, as was any call
 * whose argument is not a quoted literal — and a non-literal argument produced no
 * signal at all, so `fs.rmSync(process.env.HOME, {recursive: true})` was silently
 * allowed. An argument we cannot resolve is now a prompt.
 */
const LANGUAGE_DELETION_VERBS =
  'rmSync|rmdirSync|removeSync|rmtree|rm_rf|remove_entry|removedirs|unlinkSync|unlink|promises\\s*\\.\\s*rm|rimraf\\s*\\.\\s*sync|rimraf'

/**
 * `require('fs').promises.rm(…)` and `require('rimraf').sync(…)` put a quoted
 * module name between the receiver and the verb, which broke a naive
 * `fs.promises.rm` match. Unwrapping the require/import first makes both read as
 * ordinary member access.
 */
function unwrapModuleRequires(command: string): string {
  return command.replace(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g, '$1')
}

function inspectLanguageDeletion(
  command: string,
  context: ShellHarmContext,
  out: MutableDecision,
): void {
  const source = unwrapModuleRequires(command)
  const flagTarget = (target: string | undefined, unresolved: string): void => {
    if (target === undefined) {
      addUnique(out.prompt, unresolved)
      return
    }
    const hit = catastrophicTarget(target, context)
    if (hit) addUnique(out.deny, catastrophicReason('broad deletion', hit))
    else addUnique(out.prompt, 'recursive deletion from interpreter code requires confirmation')
  }

  const call = new RegExp(String.raw`\b(?:${LANGUAGE_DELETION_VERBS})\b[\s(]*([^)]*)`, 'gi')
  for (const match of source.matchAll(call)) {
    const literal = /(['"])([^'"]+)\1/.exec((match[1] ?? '').trim())
    flagTarget(
      literal?.[2],
      'recursive deletion from interpreter code with an unresolved target requires confirmation',
    )
  }

  // `pathlib.Path('/etc/hosts').unlink()` carries its target in the constructor,
  // so the verb itself has no argument to read.
  const pathObject = /\bPath\s*\(\s*(['"])([^'"]+)\1\s*\)\s*\.\s*(?:unlink|rmdir)\b/gi
  for (const match of source.matchAll(pathObject)) flagTarget(match[2], '')
}

/**
 * `find … -exec <cmd> {} +` runs an arbitrary command per match. The payload sits
 * inside `find`'s own argv, so no segment split reaches it.
 */
function findExecPayloads(argv: string[]): string[][] {
  if (commandName(argv[0]) !== 'find') return []
  const payloads: string[][] = []
  let current: string[] | null = null
  for (const arg of argv.slice(1)) {
    if (arg === '-exec' || arg === '-execdir' || arg === '-ok' || arg === '-okdir') {
      if (current && current.length > 0) payloads.push(current)
      current = []
      continue
    }
    if (current === null) continue
    if (arg === ';' || arg === '+' || arg === '\\;') {
      if (current.length > 0) payloads.push(current)
      current = null
      continue
    }
    current.push(arg)
  }
  if (current && current.length > 0) payloads.push(current)
  return payloads
}

/** The script an interpreter was handed, from its arguments only. */
function interpreterScriptOperand(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    if (SCRIPT_EXTENSIONS.test(arg)) return arg
  }
  return null
}

/** `https://…`, `file://…` — a locator, not a path this host can execute. */
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//

/**
 * Characters that mark a token as a pattern or a fragment of code rather than a
 * filename: glob and brace metacharacters, interpolation, and the punctuation a
 * lexer leaves attached when it runs over source it does not understand.
 */
const NON_PATH_CHARACTERS = /[*?[\]{}$`()<>|;&=,'"]/

/**
 * Whether a token could name a script on disk. Carrying a slash is not enough —
 * `https://eslint.style/rules/indent`, `@typescript-eslint/no-unused-vars`,
 * `tests/e2e/**`, `dist/`, and `` `../messages/${name}.js` `` all carry one, and
 * every one of them was being read as "a workspace-relative script the shell
 * executes". Each miss cost a `script contents could not be inspected safely`
 * line, so a single prompt could carry dozens of them and bury the command the
 * user was actually being asked to approve.
 */
function isExecutablePathShape(token: string): boolean {
  if (URI_SCHEME.test(token)) return false
  // A scoped package or a lint-rule id. No executable path starts with `@`.
  if (token.startsWith('@')) return false
  // A directory cannot be executed, and the shell does not try.
  if (token.endsWith('/')) return false
  return !NON_PATH_CHARACTERS.test(token)
}

/**
 * The workspace-relative file argv[0] itself names, when the shell executes it
 * directly (`./deploy.sh`, `bin/build`). Absolute paths are excluded: they are
 * installed binaries, not agent-authored scripts.
 */
function directExecutionOperand(argv: string[]): string | null {
  const head = argv[0]
  if (head && head.includes('/') && !isAbsolute(head) && isExecutablePathShape(head)) return head
  return null
}

/**
 * How a piece of inspected text should be read. {@link assess} lexes its input
 * as a shell command line, which is right for a command, a `sh -c` body, or a
 * shell script — and wrong for the contents of `cleanup.js`, where the lexer
 * splits JavaScript on `(`, `;`, `|`, and newlines and hands every clause to the
 * argv inspectors as a command nobody wrote.
 */
type SourceLanguage = 'shell' | 'code'

/** A shebang naming one of the shells whose command language we can lex. */
const SHELL_SHEBANG = new RegExp(
  String.raw`^#![^\r\n]*\b(?:${[...SHELL_LANGUAGE_INTERPRETERS].join('|')})\b`,
)

const SHEBANG_LINE = /^#![^\r\n]*/

/** Suffixes that name a source language which is not shell. */
const CODE_SCRIPT_EXTENSION = /\.(?:js|cjs|mjs|ts|mts|cts|py|rb|pl)$/i

/**
 * How to read a script file the gate has just loaded, when no interpreter on the
 * command line already answered it. The shebang wins because it is what the
 * kernel obeys; the suffix decides the rest. An unrecognised file is read as
 * shell — that is what a shell does with a file that has no shebang, and it is
 * the stricter of the two readings.
 */
function scriptLanguage(contents: string, operand: string): SourceLanguage {
  const shebang = SHEBANG_LINE.exec(contents)?.[0]
  if (shebang !== undefined) return SHELL_SHEBANG.test(shebang) ? 'shell' : 'code'
  return CODE_SCRIPT_EXTENSION.test(operand) ? 'code' : 'shell'
}

function inspectInterpreter(
  argv: string[],
  context: ShellHarmContext,
  out: MutableDecision,
  depth: number,
  seenScripts: Set<string>,
): void {
  const head = commandName(argv[0])
  const isInterpreter = CODE_INTERPRETERS.has(head)
  const directExecution = directExecutionOperand(argv)
  // Only an interpreter's *arguments* can name a script. Scanning every command's
  // arguments meant any absolute-path invocation with a script-shaped argument
  // prompted spuriously: `/usr/bin/git add build.sh` reported "script contents
  // could not be inspected safely: build.sh".
  if (!isInterpreter && directExecution === null) return

  // `bash -c '…'` and `bash deploy.sh` hand over shell; `node -e '…'` and
  // `node cleanup.js` hand over JavaScript. Same shape, different language.
  const interpreterLanguage: SourceLanguage = SHELL_LANGUAGE_INTERPRETERS.has(head)
    ? 'shell'
    : 'code'

  const inline = isInterpreter ? inlineCodeBody(argv) : null
  if (inline !== null) {
    if (depth >= MAX_SCRIPT_DEPTH) {
      addUnique(out.prompt, 'nested inline interpreter code could not be fully inspected')
      return
    }
    mergeDecision(out, assess(inline, context, depth + 1, seenScripts, interpreterLanguage))
    return
  }

  const operand = isInterpreter
    ? (interpreterScriptOperand(argv) ?? directExecution)
    : directExecution
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
    assess(
      contents,
      { ...context, workspaceRoot: dirname(resolved) },
      depth + 1,
      seenScripts,
      isInterpreter ? interpreterLanguage : scriptLanguage(contents, operand),
    ),
  )
}

function inspectObviousCatastrophe(normalized: string, out: MutableDecision): void {
  if (/:\(\)\s*\{\s*:\|:&\s*}\s*;/.test(normalized)) {
    addUnique(out.deny, 'fork bomb is never allowed')
  }
  if (
    /\b(?:shutdown|reboot|halt|poweroff)\b/i.test(normalized) ||
    /\b(?:Stop-Computer|Restart-Computer)\b/i.test(normalized)
  ) {
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

/**
 * Version-control operations that discard history or remote state. Kept here
 * rather than in shell-scope's shared `DANGEROUS_IN_SANDBOX_PATTERNS` on purpose:
 * these are new signals, and adding them to the shared list would make standard
 * mode start prompting for local git work it auto-runs today. Guarded YOLO is the
 * mode that asked for the coverage, so Guarded YOLO is where it applies.
 */
const DESTRUCTIVE_VCS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\bgit\s+(?:-c\s+\S+\s+|--?\S+\s+)*push\b[^\n|;&]*(?:--force\b(?!-with-lease)|(?:^|\s)-f(?:\s|$))/i,
    reason: 'git push --force overwrites remote history',
  },
  {
    re: /\bgit\s+(?:-c\s+\S+\s+|--?\S+\s+)*push\b[^\n|;&]*\s:\S/i,
    reason: 'git push with a colon refspec deletes a remote branch',
  },
  {
    re: /\bgit\s+(?:-c\s+\S+\s+|--?\S+\s+)*push\b[^\n|;&]*--delete\b/i,
    reason: 'git push --delete removes a remote ref',
  },
  {
    re: /\bgit\s+branch\s+(?:-D|--delete\s+--force)\b/i,
    reason: 'git branch -D discards an unmerged branch',
  },
  { re: /\bgit\s+reflog\s+expire\b/i, reason: 'git reflog expire discards the recovery log' },
  { re: /\bgit\s+update-ref\s+-d\b/i, reason: 'git update-ref -d deletes a ref' },
  { re: /\bgit\s+filter-branch\b/i, reason: 'git filter-branch rewrites history' },
  { re: /\bgit\s+stash\s+(?:clear|drop)\b/i, reason: 'git stash clear/drop discards stashed work' },
  // `git checkout -- .` is already covered by the shared list; this is the form
  // without the `--` separator, which discards the same changes.
  { re: /\bgit\s+checkout\s+\.(?:\s|$)/i, reason: 'git checkout . discards local changes' },
  {
    re: /\bgit\s+gc\b[^\n|;&]*--prune=(?:now|all)\b/i,
    reason: 'git gc --prune=now drops unreachable objects',
  },
]

function inspectDestructiveVcs(normalized: string, out: MutableDecision): void {
  for (const { re, reason } of DESTRUCTIVE_VCS) {
    if (re.test(normalized)) addUnique(out.prompt, reason)
  }
}

function mergeDecision(out: MutableDecision, decision: ShellHarmDecision): void {
  const target =
    decision.action === 'deny' ? out.deny : decision.action === 'prompt' ? out.prompt : null
  if (!target) return
  for (const reason of decision.reasons) addUnique(target, reason)
}

/**
 * Everything that depends on the text being a shell command line: redirects,
 * per-segment argv inspection, and the payloads shell syntax carries (`find
 * -exec`, `eval`, `$(…)`, backticks).
 *
 * Runs only over shell. Over JavaScript or Python the lexer produces a stream of
 * invented commands — a `require()` call becomes a segment whose head is the
 * module specifier, a template literal becomes a command substitution — and
 * every one of them is noise, because source code keeps its real commands inside
 * string literals, where the text-level inspectors read them instead.
 */
function inspectCommandLine(
  command: string,
  context: ShellHarmContext,
  out: MutableDecision,
  depth: number,
  seenScripts: Set<string>,
): void {
  const expanded = substitutePathVariables(command, context)
  inspectRedirects(expanded, context, out)

  const nestedCommands: string[][] = []
  for (const segment of shellSegments(expanded)) {
    const argv = unwrapWrappers(segment)
    if (argv.length === 0) continue
    inspectDeletion(argv, context, out)
    inspectOwnershipChange(argv, context, out)
    inspectRelocation(argv, context, out)
    inspectOverwrite(argv, context, out)
    inspectArgumentWrites(argv, context, out)
    inspectMirrorDeletion(argv, context, out)
    inspectProcessKill(argv, out)
    inspectInterpreter(argv, context, out, depth, seenScripts)
    nestedCommands.push(...findExecPayloads(argv))
    // `eval "rm -rf /"` hands a string to the shell. Unlike the pass-through
    // wrappers, its argument is code, not argv, so it has to be re-assessed.
    if (commandName(argv[0]) === 'eval' && argv.length > 1) {
      nestedCommands.push(argv.slice(1))
    }
  }

  for (const nested of nestedCommands) {
    if (depth >= MAX_SCRIPT_DEPTH) {
      addUnique(out.prompt, 'nested command payload could not be fully inspected')
      break
    }
    mergeDecision(out, assess(nested.join(' '), context, depth + 1, seenScripts, 'shell'))
  }

  for (const body of substitutionBodies(command)) {
    if (depth >= MAX_SCRIPT_DEPTH) {
      addUnique(out.prompt, 'nested command substitution could not be fully inspected')
      break
    }
    mergeDecision(out, assess(body, context, depth + 1, seenScripts, 'shell'))
  }
}

function assess(
  command: string,
  context: ShellHarmContext,
  depth: number,
  seenScripts: Set<string>,
  language: SourceLanguage,
): ShellHarmDecision {
  const out: MutableDecision = { deny: [], prompt: [] }
  const inspectableCommand = command.replace(/^#![^\r\n]*(?:\r?\n|$)/, '')
  const normalized = normalizeShellCommandForAnalysis(inspectableCommand)

  // Text-level inspectors. These are regex matchers over the source, not shell
  // lexing, so they read a raw-device write or a recursive delete the same in
  // JavaScript as in sh — which is what lets the gate stop lexing code as shell
  // without losing the signal that mattered.
  inspectRawDevice(normalized, out)
  inspectDeviceDestruction(normalized, out)
  inspectProtectionRemoval(normalized, out)
  inspectPermissionBypass(inspectableCommand, normalized, out)
  inspectLanguageDeletion(inspectableCommand, context, out)
  inspectObviousCatastrophe(normalized, out)
  inspectDestructiveVcs(normalized, out)

  if (language === 'shell') {
    inspectCommandLine(inspectableCommand, context, out, depth, seenScripts)
  }

  // `exec`/`system`/`popen` take a shell string whatever language calls them, so
  // their bodies are re-assessed as shell even inside code.
  for (const body of embeddedProcessBodies(inspectableCommand)) {
    if (depth >= MAX_SCRIPT_DEPTH) {
      addUnique(out.prompt, 'nested child-process code could not be fully inspected')
      break
    }
    mergeDecision(out, assess(body, context, depth + 1, seenScripts, 'shell'))
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
  return assess(command, context, 0, new Set<string>(), 'shell')
}

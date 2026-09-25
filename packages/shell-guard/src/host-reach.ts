import { join } from 'node:path'
import { commandName, shellSegments, unwrapWrappers } from './shell-argv.ts'
import { dangerousInSandboxReasons } from './shell-scope.ts'
import { normalizeSshHost } from './trusted-ssh-hosts.ts'

/**
 * Effects that reach past this machine's project without deleting anything, so
 * none of the destructive inspectors in `shell-harm.ts` sees them: running code
 * on another machine, exposing a secret, driving the desktop or other people's
 * processes, and fetching code to run. Guarded YOLO let every one of these run
 * unprompted (the escalation-review eval found 24 of 36 ask-level commands in
 * real history). Each returns a one-time confirmation, never a hard deny.
 */

export interface HostReachContext {
  workspaceRoot: string | null
  /**
   * Hosts (or `~/.ssh/config` aliases) the user trusts to receive commands and
   * files, lower-case. `ssh`/`scp`/`rsync`/`sftp` to any other host prompts.
   */
  trustedSshHosts?: readonly string[]
  /** Whether a path exists; lets `npx <tool>` run a project dependency's binary. */
  pathExists?: (path: string) => boolean
}

// ---------------------------------------------------------------------------
// Other machines
// ---------------------------------------------------------------------------

/** OpenSSH client options that take a separate value. */
const SSH_VALUE_FLAGS = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split('').map((l) => `-${l}`))

/**
 * Options that make the client run a *local* command or read a config that can:
 * `-o ProxyCommand=…` executes on this machine before any host is contacted.
 */
const SSH_LOCAL_EXECUTION =
  /^(?:proxycommand|localcommand|permitlocalcommand|knownhostscommand|match)\b/i

/** `user@host`, `ssh://user@host:22/path` → `host`. */
function sshDestinationHost(destination: string): string {
  let rest = destination.replace(/^ssh:\/\//i, '')
  rest = rest.slice(rest.lastIndexOf('@') + 1)
  if (rest.startsWith('[')) return normalizeSshHost(rest.slice(1, rest.indexOf(']')))
  return normalizeSshHost(rest.split(/[:/]/)[0] ?? '')
}

/** `host:path` / `user@host:path` / `host::module`, but not `C:\x`, `./a:b` or `/a:b`. */
function remoteOperandHost(operand: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(operand) || operand.startsWith('/') || operand.startsWith('.'))
    return null
  const colon = operand.indexOf(':')
  const slash = operand.indexOf('/')
  if (colon <= 0 || (slash !== -1 && slash < colon)) return null
  return sshDestinationHost(operand.slice(0, colon))
}

interface SshInvocation {
  hosts: string[]
  /** The command the remote shell runs, when one is given. */
  remoteCommand: string | null
  localExecution: boolean
}

function parseSshClient(head: string, args: readonly string[]): SshInvocation {
  const hosts: string[] = []
  const operands: string[] = []
  let localExecution = false
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? ''
    if (!token.startsWith('-') || token === '-') {
      operands.push(token)
      continue
    }
    // `-oProxyCommand=…`, `-J jump`, `-F cfg`: the value may be attached.
    const flag = token.slice(0, 2)
    if (!SSH_VALUE_FLAGS.has(flag)) continue
    const value = token.length > 2 ? token.slice(2) : (args[++i] ?? '')
    if (flag === '-o' && SSH_LOCAL_EXECUTION.test(value.replace(/^\s+/, ''))) localExecution = true
    if (flag === '-F') localExecution = true
    if (flag === '-J') for (const jump of value.split(',')) hosts.push(sshDestinationHost(jump))
    // rsync's `-e`/`--rsh` names the transport program itself.
    if (head === 'rsync' && flag === '-e') localExecution = true
  }
  if (head === 'ssh' || head === 'sftp' || head === 'mosh' || head === 'autossh') {
    const [destination, ...remote] = operands
    if (destination !== undefined) hosts.push(sshDestinationHost(destination))
    return {
      hosts,
      remoteCommand: head === 'ssh' && remote.length > 0 ? remote.join(' ') : null,
      localExecution,
    }
  }
  for (const operand of operands) {
    const host = remoteOperandHost(operand)
    if (host) hosts.push(host)
  }
  return { hosts, remoteCommand: null, localExecution }
}

const SSH_CLIENTS = new Set(['ssh', 'scp', 'sftp', 'rsync', 'mosh', 'autossh'])

function remoteReasons(head: string, args: readonly string[], context: HostReachContext): string[] {
  if (head === 'rsync' && args.some((arg) => arg === '--rsh' || arg.startsWith('--rsh='))) {
    return ['rsync runs a custom remote-shell program (--rsh)']
  }
  const invocation = parseSshClient(head, args)
  const reasons: string[] = []
  if (invocation.localExecution) {
    reasons.push(`${head} runs a local command from its options or a custom config`)
  }
  const trusted = new Set((context.trustedSshHosts ?? []).map(normalizeSshHost))
  const untrusted = [...new Set(invocation.hosts)].filter((host) => host && !trusted.has(host))
  if (untrusted.length > 0) {
    reasons.push(
      head === 'ssh' || head === 'mosh' || head === 'autossh'
        ? `runs commands on another machine (${untrusted.join(', ')})`
        : `copies files to or from another machine (${untrusted.join(', ')})`,
    )
  }
  // A trusted host still gets the destructive-pattern net over what it is told to run.
  if (invocation.remoteCommand !== null && untrusted.length === 0) {
    for (const reason of dangerousInSandboxReasons(invocation.remoteCommand)) {
      reasons.push(`on ${invocation.hosts.join(', ')}: ${reason}`)
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const SECRET_NAME =
  /(?:TOKEN|SECRET|PASSW(?:OR)?D|PASS|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|COOKIE|SESSION)/i

/** Programs that send their arguments somewhere else. */
const NETWORK_HEADS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'nc', 'ncat', 'socat'])

/** `$NAME` / `${NAME}` references in raw text; the lexers expand them away. */
const VARIABLE_REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g

function secretReasons(rawArgv: readonly string[], argv: readonly string[]): string[] {
  const head = commandName(argv[0])
  // `env` with nothing to run prints the whole environment.
  if (commandName(rawArgv[0]) === 'env' && argv.length === 0) {
    return ['prints every environment variable, which may include secrets']
  }
  if (head === 'printenv') {
    const names = argv.slice(1).filter((arg) => !arg.startsWith('-'))
    if (names.length === 0) return ['prints every environment variable, which may include secrets']
    const secret = names.filter((name) => SECRET_NAME.test(name))
    if (secret.length > 0) return [`prints a secret-looking variable (${secret.join(', ')})`]
  }
  // Listing forms only: `set -x` (tracing) and `export FOO=1` print nothing.
  const listing =
    (head === 'set' && argv.length === 1) ||
    (head === 'export' && argv.slice(1).every((arg) => arg === '-p')) ||
    (head === 'declare' && argv.slice(1).every((arg) => /^-[px]+$/.test(arg)))
  if (listing) return ['prints every environment variable, which may include secrets']
  if (head === 'gh' && argv[1] === 'auth' && argv[2] === 'token') return ['prints a GitHub token']
  if (head === 'security' && /^find-(?:generic|internet)-password$/.test(argv[1] ?? '')) {
    return ['reads a password from the keychain']
  }
  return []
}

/**
 * A secret-named variable on the command line of a program that sends it
 * elsewhere: `curl -H "Authorization: Bearer ${GITHUB_TOKEN}" https://…`. Read
 * from the raw text, because both lexers expand `$NAME` to nothing.
 */
function secretOverNetworkReasons(command: string): string[] {
  const heads = shellSegments(command).map((argv) => commandName(unwrapWrappers(argv)[0]))
  if (!heads.some((head) => NETWORK_HEADS.has(head))) return []
  const names = [...command.matchAll(VARIABLE_REFERENCE)]
    .map((match) => match[1] ?? '')
    .filter((name) => SECRET_NAME.test(name))
  return names.length > 0
    ? [`sends a secret-looking variable over the network (${[...new Set(names)].join(', ')})`]
    : []
}

// ---------------------------------------------------------------------------
// The desktop and other processes
// ---------------------------------------------------------------------------

const LAUNCHCTL_READS = new Set([
  'list',
  'print',
  'print-cache',
  'print-disabled',
  'version',
  'help',
  'blame',
  'procinfo',
  'dumpstate',
  'managerpid',
  'manageruid',
  'managername',
])
const SYSTEMCTL_READS = /^(?:status|show|cat|list-[\w-]+|is-[\w-]+|help)$/

function hostControlReasons(argv: readonly string[]): string[] {
  const head = commandName(argv[0])
  const sub = argv.slice(1).find((arg) => !arg.startsWith('-')) ?? ''
  switch (head) {
    case 'pkill':
    case 'killall': {
      // A path or a multi-word command line (`pkill -f "node scripts/watch"`)
      // names the agent's own process; a bare name (`pkill -f vite`, `killall
      // Finder`) matches whatever else the user is running under that name.
      const patterns = argv.slice(1).filter((arg) => !arg.startsWith('-'))
      const broad = patterns.length === 0 || patterns.some((p) => !/[\s/]/.test(p))
      return broad
        ? [`${head} kills every process with that name, not only ones this agent started`]
        : []
    }
    case 'launchctl':
      return LAUNCHCTL_READS.has(sub) ? [] : ['changes launchd services (launchctl)']
    case 'systemctl':
      return SYSTEMCTL_READS.test(sub) ? [] : ['changes system services (systemctl)']
    case 'crontab':
      return argv.includes('-l') ? [] : ['changes scheduled jobs (crontab)']
    case 'defaults':
      return /^(?:write|delete|import|rename)$/.test(sub)
        ? ['changes macOS preferences (defaults)']
        : []
    case 'screencapture':
      return ["captures the user's screen"]
    case 'osascript':
      return ['scripts other applications (osascript)']
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// Code fetched at run time
// ---------------------------------------------------------------------------

/** Runners that always download what they run. */
function alwaysDownloads(argv: readonly string[]): string | null {
  const head = commandName(argv[0])
  const sub = argv[1] ?? ''
  if ((head === 'pnpm' || head === 'yarn') && sub === 'dlx') return `${head} dlx`
  if (head === 'bun' && sub === 'x') return 'bun x'
  if (head === 'bunx' || head === 'uvx') return head
  if (head === 'pipx' && sub === 'run') return 'pipx run'
  return null
}

/** `npx <name>`, `npm exec <name>`, `pnpx <name>`: the package they would run. */
function npxPackage(argv: readonly string[]): { name: string; explicit: boolean } | null {
  const head = commandName(argv[0])
  let args: readonly string[]
  if (head === 'npx' || head === 'pnpx') args = argv.slice(1)
  else if (head === 'npm' && (argv[1] === 'exec' || argv[1] === 'x')) args = argv.slice(2)
  else return null
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? ''
    if (token === '-p' || token === '--package' || token.startsWith('--package=')) {
      return {
        name: token.includes('=') ? token.slice(token.indexOf('=') + 1) : (args[i + 1] ?? ''),
        explicit: true,
      }
    }
    if (token.startsWith('-')) continue
    return { name: token, explicit: false }
  }
  return null
}

function fetchedCodeReasons(argv: readonly string[], context: HostReachContext): string[] {
  const runner = alwaysDownloads(argv)
  if (runner) return [`${runner} downloads and runs a package`]
  const pkg = npxPackage(argv)
  // The line-splitting fallback lexer leaves `npx \` of a continued line with a
  // lone backslash for a package; the shell-quote segment sees the real name.
  if (!pkg || !/^[@\w]/.test(pkg.name)) return []
  // npx runs a project dependency's own binary when one is installed; anything
  // else (or a package named with -p/--package, or a versioned spec) is fetched.
  const bin = pkg.name.replace(/^@[^/]+\//, '')
  const local =
    !pkg.explicit &&
    /^(?:@[\w.-]+\/)?[\w.-]+$/.test(pkg.name) &&
    context.workspaceRoot !== null &&
    context.pathExists?.(join(context.workspaceRoot, 'node_modules', '.bin', bin)) === true
  return local
    ? []
    : [`downloads and runs a package that is not a project dependency (${pkg.name})`]
}

// ---------------------------------------------------------------------------

/** Every host-reach reason for a shell command line, deduplicated. */
export function hostReachReasons(command: string, context: HostReachContext): string[] {
  const reasons = new Set<string>(secretOverNetworkReasons(command))
  for (const rawArgv of shellSegments(command)) {
    const argv = unwrapWrappers(rawArgv)
    const head = commandName(argv[0])
    const found = [
      ...(SSH_CLIENTS.has(head) ? remoteReasons(head, argv.slice(1), context) : []),
      ...secretReasons(rawArgv, argv),
      ...hostControlReasons(argv),
      ...fetchedCodeReasons(argv, context),
    ]
    for (const reason of found) reasons.add(reason)
  }
  return [...reasons]
}

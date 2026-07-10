/**
 * Safe-install detection + Socket Firewall wrapping for the `run_shell` tool.
 *
 * The agent can emit package-manager commands (npm/pnpm/yarn/pip/uv/cargo/npx).
 * Run raw, these fetch and execute arbitrary third-party code with the user's
 * privileges — the npm-style supply-chain risk. When we detect an install, the
 * whole command is run once through Socket Firewall (`sfw`), which proxies the
 * package manager and blocks confirmed-malicious packages (and malicious
 * transitive deps). Rather than rewriting the command, we wrap the shell:
 *
 *     sfw /bin/sh -c '<original command>'
 *
 * so any package manager the command invokes inherits the firewall proxy — no
 * brittle per-command string surgery, and aliases / `$()` inside the command
 * can't dodge it. For JS managers we additionally set `npm_config_ignore_scripts`
 * in the environment to block install lifecycle scripts (see shell-tool).
 *
 * Like `shell-scope.ts`, detection is a best-effort heuristic, not a parser: it
 * only flags a segment it can confidently classify as a supported install.
 * Command substitution / unusual quoting can evade detection.
 */

import { normalizeShellCommandForAnalysis } from './shell-scope.ts'

// Split on top-level shell operators so each segment can be classified on its own.
// Quotes/substitution are not honoured (see file note).
const SEGMENT_RE = /(?:&&|\|\||;|\|)/

// Leading `VAR=val` assignments and any run of `sudo` / `eval` command words,
// stripped before we read the command word. `eval npm install` (and, after quote
// normalization, `eval "npm install"`) would otherwise hide the manager token
// behind the eval builtin. (#581)
const PREFIX_RE = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)|sudo|eval)\s+)*/

const NPM_INSTALL_VERBS = new Set(['install', 'i', 'add', 'ci', 'update', 'up'])
const PNPM_INSTALL_VERBS = new Set(['install', 'i', 'add', 'update', 'up'])
const YARN_INSTALL_VERBS = new Set(['install', 'add', 'up', 'upgrade'])
const CARGO_VERBS = new Set(['install', 'add', 'fetch', 'update'])

interface SegmentSpec {
  manager: 'npm' | 'pnpm' | 'yarn' | 'pip' | 'uv' | 'cargo' | 'npx'
  /** npm/pnpm/yarn — honour `npm_config_ignore_scripts` to block lifecycle scripts. */
  jsManager: boolean
  /** npx — fetch-and-run without adding packages to the project. */
  ephemeralRunner: boolean
}

function classify(tokens: string[]): SegmentSpec | null {
  const [t0, t1] = tokens
  switch (t0) {
    case 'npm':
      return t1 && NPM_INSTALL_VERBS.has(t1)
        ? { manager: 'npm', jsManager: true, ephemeralRunner: false }
        : null
    case 'pnpm':
      // A bare `pnpm` defaults to `install`.
      return !t1 || PNPM_INSTALL_VERBS.has(t1)
        ? { manager: 'pnpm', jsManager: true, ephemeralRunner: false }
        : null
    case 'yarn':
      // A bare `yarn` defaults to `install`.
      return !t1 || YARN_INSTALL_VERBS.has(t1)
        ? { manager: 'yarn', jsManager: true, ephemeralRunner: false }
        : null
    case 'npx':
      return { manager: 'npx', jsManager: false, ephemeralRunner: true }
    case 'pip':
    case 'pip3':
      return t1 === 'install' ? { manager: 'pip', jsManager: false, ephemeralRunner: false } : null
    case 'python':
    case 'python3':
      return t1 === '-m' && tokens[2] === 'pip' && tokens[3] === 'install'
        ? { manager: 'pip', jsManager: false, ephemeralRunner: false }
        : null
    case 'uv':
      if (t1 === 'add' || t1 === 'sync')
        return { manager: 'uv', jsManager: false, ephemeralRunner: false }
      if (t1 === 'pip' && tokens[2] === 'install')
        return { manager: 'uv', jsManager: false, ephemeralRunner: false }
      return null
    case 'cargo':
      return t1 && CARGO_VERBS.has(t1)
        ? { manager: 'cargo', jsManager: false, ephemeralRunner: false }
        : null
    default:
      return null
  }
}

function classifySegment(rawSegment: string): SegmentSpec | null {
  const body = rawSegment.replace(PREFIX_RE, '')
  const tokens = body.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  if (tokens[0] === 'sfw') return null // already wrapped
  return classify(tokens)
}

export interface InstallDetection {
  /** True when any command segment is a recognised package install. */
  isInstall: boolean
  /** True for ephemeral runners (npx) that may fetch and run without adding project deps. */
  isEphemeralRunner: boolean
  /** True when an npm/pnpm/yarn install was detected (drives `npm_config_ignore_scripts`). */
  jsManager: boolean
}

/** Detect whether a shell command performs a package install. */
export function detectPackageInstall(command: string): InstallDetection {
  let isInstall = false
  let isEphemeralRunner = false
  let jsManager = false
  // Undo the cheap quote/backslash obfuscation the shell collapses away (`n""pm`,
  // `n\pm` → `npm`) before tokenizing, so a package-manager token can't be hidden
  // from the whitespace splitter. Detection only — the untouched original command
  // is what actually runs (and is wrapped). (#581)
  const normalized = normalizeShellCommandForAnalysis(command)
  for (const segment of normalized.split(SEGMENT_RE)) {
    const spec = classifySegment(segment)
    if (!spec) continue
    isInstall = true
    if (spec.ephemeralRunner) isEphemeralRunner = true
    if (spec.jsManager) jsManager = true
  }
  return { isInstall, isEphemeralRunner, jsManager }
}

/** POSIX single-quote a string so it survives intact as one shell word. */
export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export interface ShellInvocation {
  /** Shell executable, e.g. `/bin/sh` or `cmd`. */
  path: string
  /** The "run this command string" flag, e.g. `-c` or `/c`. */
  cArg: string
}

/**
 * Wrap a command so it runs through Socket Firewall: `sfw <shell> <cArg> <quoted command>`.
 * The package manager invoked inside the command inherits the firewall proxy.
 */
export function wrapWithSocketFirewall(
  command: string,
  shell: ShellInvocation,
  quote: (value: string) => string = posixQuote,
): string {
  return `sfw ${shell.path} ${shell.cArg} ${quote(command)}`
}

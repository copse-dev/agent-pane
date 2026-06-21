/**
 * Safe-install rewriting for the `run_shell` tool.
 *
 * The agent can emit package-manager commands (npm/pnpm/yarn/pip/uv/cargo/npx).
 * Run raw, these fetch and execute arbitrary third-party code with the user's
 * privileges — the npm-style supply-chain risk. This module detects those
 * commands and rewrites them to:
 *   1. run through Socket Firewall (`sfw`), which proxies the package manager
 *      and blocks confirmed-malicious packages (and malicious transitive deps);
 *   2. block install lifecycle scripts via `--ignore-scripts` (JS managers);
 *   3. pin to the lockfile (`npm install` → `npm ci`, pnpm `--frozen-lockfile`).
 *
 * Like `shell-scope.ts`, the detection is a best-effort heuristic, not a parser:
 * it only rewrites a command segment it can confidently classify as a supported
 * install invocation, and leaves everything else byte-for-byte untouched. The
 * `sfw` wrapper itself is the real safety boundary; the flags are defense in
 * depth. Command substitution / unusual quoting can evade detection.
 */

export interface SafeInstallContext {
  /** Lockfile basenames present in the workspace root (e.g. "package-lock.json"). */
  lockfiles: ReadonlySet<string>
}

export interface InstallPlan {
  /** True when at least one segment was a recognised package install. */
  isInstall: boolean
  /** The original command when `isInstall` is false, otherwise the rewritten one. */
  command: string
  /** Human-readable description of each transform applied. */
  notes: string[]
}

// Split on top-level shell operators, keeping the separators so the command can
// be reassembled verbatim. Quotes/substitution are not honoured (see file note).
const SEGMENT_RE = /(\s*(?:&&|\|\||;|\|)\s*)/

// Leading `VAR=val` assignments and an optional `sudo`, which must stay in front
// of the `sfw` wrapper we inject.
const PREFIX_RE = /^((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+)*(?:sudo\s+)?)/

const NPM_INSTALL_VERBS = new Set(['install', 'i', 'add', 'ci', 'update', 'up'])
const PNPM_INSTALL_VERBS = new Set(['install', 'i', 'add', 'update', 'up'])
const YARN_INSTALL_VERBS = new Set(['install', 'add', 'up', 'upgrade'])
const CARGO_VERBS = new Set(['install', 'add', 'fetch', 'update'])

interface SegmentSpec {
  manager: 'npm' | 'pnpm' | 'yarn' | 'pip' | 'uv' | 'cargo' | 'npx'
  /** True for managers where `--ignore-scripts` blocks lifecycle scripts. */
  blocksScripts: boolean
}

function classify(tokens: string[]): SegmentSpec | null {
  const [t0, t1] = tokens
  switch (t0) {
    case 'npm':
      return t1 && NPM_INSTALL_VERBS.has(t1) ? { manager: 'npm', blocksScripts: true } : null
    case 'pnpm':
      // A bare `pnpm` defaults to `install`.
      return !t1 || PNPM_INSTALL_VERBS.has(t1) ? { manager: 'pnpm', blocksScripts: true } : null
    case 'yarn':
      // A bare `yarn` defaults to `install`.
      return !t1 || YARN_INSTALL_VERBS.has(t1) ? { manager: 'yarn', blocksScripts: true } : null
    case 'npx':
      return { manager: 'npx', blocksScripts: false }
    case 'pip':
    case 'pip3':
      return t1 === 'install' ? { manager: 'pip', blocksScripts: false } : null
    case 'python':
    case 'python3':
      return t1 === '-m' && tokens[2] === 'pip' && tokens[3] === 'install'
        ? { manager: 'pip', blocksScripts: false }
        : null
    case 'uv':
      if (t1 === 'add' || t1 === 'sync') return { manager: 'uv', blocksScripts: false }
      if (t1 === 'pip' && tokens[2] === 'install') return { manager: 'uv', blocksScripts: false }
      return null
    case 'cargo':
      return t1 && CARGO_VERBS.has(t1) ? { manager: 'cargo', blocksScripts: false } : null
    default:
      return null
  }
}

function rewriteSegment(
  rawSegment: string,
  ctx: SafeInstallContext,
): { text: string; notes: string[] } | null {
  if (!rawSegment.trim()) return null

  const prefix = rawSegment.match(PREFIX_RE)?.[0] ?? ''
  const body = rawSegment.slice(prefix.length)
  const tokens = body.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  if (tokens[0] === 'sfw') return null // already wrapped

  const spec = classify(tokens)
  if (!spec) return null

  const notes: string[] = []
  let newBody = body.replace(/\s+$/, '')
  // Appending flags is only safe when the segment has no redirection that the
  // flags would land behind. Prefixing `sfw` is always safe.
  const hasRedirection = /[<>]/.test(body)
  const hasPackageArgs = tokens.slice(2).some((t) => !t.startsWith('-'))

  // 1. Lockfile pinning.
  if (
    spec.manager === 'npm' &&
    (tokens[1] === 'install' || tokens[1] === 'i') &&
    !hasPackageArgs &&
    (ctx.lockfiles.has('package-lock.json') || ctx.lockfiles.has('npm-shrinkwrap.json'))
  ) {
    newBody = newBody.replace(/^(npm\s+)(install|i)\b/, '$1ci')
    notes.push('pinned to lockfile via `npm ci`')
  } else if (
    spec.manager === 'pnpm' &&
    !hasPackageArgs &&
    !hasRedirection &&
    ctx.lockfiles.has('pnpm-lock.yaml') &&
    !/--frozen-lockfile\b/.test(newBody)
  ) {
    newBody = `${newBody} --frozen-lockfile`
    notes.push('pinned to lockfile via --frozen-lockfile')
  }

  // 2. Block install lifecycle scripts.
  if (spec.blocksScripts && !hasRedirection && !/--ignore-scripts\b/.test(newBody)) {
    newBody = `${newBody} --ignore-scripts`
    notes.push('blocked lifecycle scripts via --ignore-scripts')
  }

  // 3. Wrap with Socket Firewall — the real supply-chain boundary.
  newBody = `sfw ${newBody}`
  notes.push('scanned by Socket Firewall (sfw)')

  return { text: prefix + newBody, notes }
}

/**
 * Detect package-install commands and return a hardened rewrite. When no segment
 * is a recognised install, `isInstall` is false and `command` is returned as-is.
 */
export function rewriteInstallCommand(command: string, ctx: SafeInstallContext): InstallPlan {
  const parts = command.split(SEGMENT_RE)
  const notes: string[] = []
  let isInstall = false

  // Even indices are command segments; odd indices are the separators between them.
  for (let i = 0; i < parts.length; i += 2) {
    const segment = parts[i]
    if (segment === undefined) continue
    const rewritten = rewriteSegment(segment, ctx)
    if (!rewritten) continue
    parts[i] = rewritten.text
    isInstall = true
    for (const note of rewritten.notes) if (!notes.includes(note)) notes.push(note)
  }

  return { isInstall, command: isInstall ? parts.join('') : command, notes }
}

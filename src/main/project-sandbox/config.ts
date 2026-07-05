import { accessSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { getSetting } from '../services/storage/settings.ts'
import { getChatStoreRoot } from '../services/workspace.ts'
import {
  WEB_ALLOWED_ORIGINS_SETTING,
  sandboxAllowedDomainsFromOrigins,
  webAllowedOriginsWithDefaults,
} from '../services/security/web-origin-policy.ts'

/**
 * Resolve the workspace root to its canonical, symlink-free path.
 *
 * macOS seatbelt enforces filesystem rules against the kernel's canonical path,
 * but `resolve()` leaves symlinks intact. Temp workspaces live under
 * `/var/folders/...`, where `/var` is a symlink to `/private/var`; without
 * canonicalization the allow/deny rules say `/var/folders/...` while the kernel
 * sees `/private/var/folders/...`, so writes to `.git` during `git commit` are
 * denied as EPERM. `realpathSync` collapses the symlink so the rules match.
 *
 * Falls back to `resolve()` when the path can't be canonicalized (e.g. it does
 * not exist yet), preserving prior behaviour.
 */
function canonicalizeWorkspaceRoot(workspaceRoot: string): string {
  const resolved = resolve(workspaceRoot)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

/** Mirrors ASRT macOS mandatory write denies, resolved against the workspace root. */
const DANGEROUS_CONFIG_FILENAMES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
] as const

const DANGEROUS_CONFIG_DIR_NAMES = [
  '.vscode',
  '.idea',
  '.claude/commands',
  '.claude/agents',
] as const

export function workspaceMandatoryWriteDenyPaths(workspaceRoot: string): string[] {
  const root = canonicalizeWorkspaceRoot(workspaceRoot)
  const denyPaths: string[] = []
  for (const fileName of DANGEROUS_CONFIG_FILENAMES) {
    denyPaths.push(join(root, fileName))
    denyPaths.push(`**/${fileName}`)
  }
  for (const dirName of DANGEROUS_CONFIG_DIR_NAMES) {
    denyPaths.push(join(root, dirName))
    denyPaths.push(`**/${dirName}/**`)
  }
  denyPaths.push(join(root, '.git/hooks'))
  denyPaths.push('**/.git/hooks/**')
  return [...new Set(denyPaths)]
}

/**
 * User-level git config files git reads on every invocation. They live under
 * the home directory, which the workspace overlay otherwise denies. macOS
 * seatbelt denials surface as EPERM ("Operation not permitted"), which git
 * treats as fatal (exit 128) — so these must stay readable or every git command
 * fails. A more-specific allowRead overrides the broad home denyRead.
 */
function gitConfigReadPaths(): string[] {
  const home = homedir()
  return [
    join(home, '.gitconfig'),
    join(home, '.config/git/**'),
    join(home, '.gitignore'),
    join(home, '.gitignore_global'),
  ]
}

/**
 * A workspace-owned scratch directory the sandbox permits writes to, used to
 * redirect $TMPDIR away from the system temp dir.
 *
 * Commands that write to the OS temp dir (`/tmp`, `$TMPDIR`, `/var/folders/...`)
 * get blocked by the workspace-scoped seatbelt, whose only writable roots are the
 * project and this dir (issue #481). Routing temp writes here keeps them on the
 * allow-list without widening it to all of `/tmp`. Lives under `~/.copse/` next
 * to the memories store rather than inside the repo so scratch files never dirty
 * the user's working tree.
 */
export function workspaceTmpDir(): string {
  return join(homedir(), '.copse', 'workspace', 'tmp')
}

/**
 * Create {@link workspaceTmpDir} if missing and return it. Best-effort: returns
 * the path even if creation fails (e.g. read-only home) so callers can still set
 * $TMPDIR — the spawn just falls back to the system temp dir as before.
 */
export function ensureWorkspaceTmpDir(): string {
  const dir = workspaceTmpDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // Best-effort: a missing dir only means the redirect is a no-op this run.
  }
  return dir
}

function sandboxAllowedDomainsFromSettings(): string[] {
  return sandboxAllowedDomainsFromOrigins(
    webAllowedOriginsWithDefaults(getSetting<string[] | null>(WEB_ALLOWED_ORIGINS_SETTING, null)),
  )
}

export function sandboxNetworkConfig(
  allowedOrigins: readonly string[] | null | undefined = null,
): NonNullable<SandboxRuntimeConfig['network']> {
  const allowedDomains =
    allowedOrigins === null
      ? sandboxAllowedDomainsFromSettings()
      : sandboxAllowedDomainsFromOrigins(webAllowedOriginsWithDefaults(allowedOrigins))
  return {
    allowedDomains,
    deniedDomains: [],
    allowLocalBinding: allowedDomains.some((domain) =>
      ['localhost', '127.0.0.1', '::1'].includes(domain),
    ),
  }
}

/**
 * Network policy for the AUTO-RUN, sandbox-contained spawn path.
 *
 * Commands that auto-run without user approval reach the seatbelt only via
 * {@link workspaceSandboxOverlay} (commands the user explicitly approves for
 * network/outside-workspace access run fully UNSANDBOXED, never through this
 * overlay). The classifier/system prompt presents these contained commands as
 * "Network: denied", so the contained policy must actually deny network: no
 * allowed domains and no local socket binding. This closes the exfiltration
 * gap (M6) where an auto-run command could still reach a DuckDuckGo subdomain
 * or a local listener with no prompt.
 */
export function containedSandboxNetworkConfig(): NonNullable<SandboxRuntimeConfig['network']> {
  return {
    allowedDomains: [],
    deniedDomains: [],
    allowLocalBinding: false,
  }
}

/** Base ASRT config; workspace-specific paths are passed per spawn via `customConfig`. */
export function baseSandboxConfig(): SandboxRuntimeConfig {
  return {
    network: containedSandboxNetworkConfig(),
    filesystem: {
      denyRead: [],
      allowWrite: [],
      denyWrite: [],
      allowGitConfig: true,
    },
  }
}

/** Resolve Node/npm toolchain paths so sandboxed shells can run `npm test`, etc. */
export function resolveNodeToolchainAllowRead(env: NodeJS.ProcessEnv = process.env): string[] {
  const pathVar = env['PATH'] ?? ''
  const dirs = pathVar.split(':').filter(Boolean)
  const allow = new Set<string>()

  for (const dir of dirs) {
    let nodePath: string
    try {
      nodePath = resolve(dir, 'node')
      accessSync(nodePath)
    } catch {
      continue
    }

    allow.add(nodePath)
    const binDir = dirname(nodePath)
    allow.add(binDir)
    allow.add(`${binDir}/**`)

    // nvm/fnm layout: .../versions/node/vX.Y.Z/bin/node — npm lives under ../lib.
    const versionRoot = dirname(binDir)
    if (versionRoot !== binDir) {
      allow.add(versionRoot)
      allow.add(`${versionRoot}/**`)
    }
  }

  return [...allow]
}

/** Paths the bundled sandbox-fs worker must read to exec under ASRT (outside the workspace). */
export function electronRuntimeAllowReadPaths(): string[] {
  let exec = resolve(process.execPath)
  try {
    exec = realpathSync.native(exec)
  } catch {
    // Keep resolve() result when the binary is not stat-able yet.
  }
  const paths = [exec, dirname(exec), `${dirname(exec)}/**`]
  if (process.platform === 'darwin' && exec.includes('.app/')) {
    const [appPrefix] = exec.split('.app/')
    const appRoot = `${appPrefix ?? exec}.app`
    try {
      const realAppRoot = realpathSync.native(resolve(appRoot))
      paths.push(realAppRoot, `${realAppRoot}/**`)
      const macOsDir = join(realAppRoot, 'Contents', 'MacOS')
      if (statSync(macOsDir).isDirectory()) {
        paths.push(macOsDir, `${macOsDir}/**`)
      }
    } catch {
      paths.push(resolve(appRoot), `${resolve(appRoot)}/**`)
    }
  }
  return [...new Set(paths)]
}

/** Workspace seatbelt rules plus read access for the fs worker script and Electron runtime. */
export function fsWorkerSandboxOverlay(
  workspaceRoot: string,
  workerJsPath: string,
): Partial<SandboxRuntimeConfig> {
  const workspace = workspaceSandboxOverlay(workspaceRoot)
  const workerDir = dirname(resolve(workerJsPath))
  const fs = workspace.filesystem
  if (!fs) {
    throw new Error('workspaceSandboxOverlay must define a filesystem config')
  }
  const allowRead = [
    ...new Set([
      ...(fs.allowRead ?? []),
      workerDir,
      `${workerDir}/**`,
      ...electronRuntimeAllowReadPaths(),
    ]),
  ]
  return {
    ...workspace,
    filesystem: {
      denyRead: fs.denyRead,
      allowWrite: fs.allowWrite,
      denyWrite: fs.denyWrite,
      allowGitConfig: fs.allowGitConfig,
      allowRead,
    },
  }
}

/**
 * Seatbelt overlay for an external ACP agent process (issue #590): the same
 * workspace-scoped filesystem rules native auto-run commands get, with two
 * agent-specific relaxations the contained profile can't afford to make:
 *
 * - **Network** is an allowlist of the agent's own endpoints instead of a full
 *   deny — the agent runs its model loop in-process and must reach its LLM/auth
 *   APIs. No local binding: the agent talks to Copse over stdio, not sockets.
 * - **Home dirs** the agent needs for its own config/credentials/state
 *   (e.g. `~/.claude`) are re-allowed for read *and* write; everything else
 *   under home stays denied, and the mandatory write-deny list (git hooks,
 *   shell rc files, …) still applies inside the workspace.
 */
/**
 * Expand a `scratchPaths` template to the concrete paths the seatbelt must
 * allow: `${uid}` becomes the numeric user id, and paths under the macOS
 * symlinked roots (`/tmp`, `/var`, `/etc` → `/private/...`) are emitted in
 * both spellings — the kernel enforces against the canonical path, while the
 * agent may write either.
 */
export function expandScratchPath(template: string): string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const path = template.replace('${uid}', String(uid))
  const paths = [path]
  const symlinkedRoot = /^\/(tmp|var|etc)(\/|$)/.exec(path)
  if (symlinkedRoot) paths.push(`/private${path}`)
  return paths
}

export function acpAgentSandboxOverlay(
  workspaceRoot: string,
  sandbox: { allowedDomains: string[]; homeDirs?: string[]; scratchPaths?: string[] },
  opts?: {
    /**
     * Also allow loopback traffic — required when the turn runs the native-tool
     * MCP bridge (#602), which the agent reaches at `http://127.0.0.1:<port>`.
     */
    allowLocalhost?: boolean
  },
): Partial<SandboxRuntimeConfig> {
  const base = workspaceSandboxOverlay(workspaceRoot)
  const fs = base.filesystem
  if (!fs) throw new Error('workspaceSandboxOverlay must define a filesystem config')
  const home = homedir()
  const homePaths = (sandbox.homeDirs ?? []).flatMap((rel) => {
    const abs = join(home, rel)
    return [abs, `${abs}/**`]
  })
  const scratchPaths = (sandbox.scratchPaths ?? [])
    .flatMap(expandScratchPath)
    .flatMap((abs) => [abs, `${abs}/**`])
  homePaths.push(...scratchPaths)
  const localDomains = opts?.allowLocalhost ? ['localhost', '127.0.0.1', '::1'] : []
  return {
    ...base,
    network: {
      allowedDomains: [...sandbox.allowedDomains, ...localDomains],
      deniedDomains: [],
      allowLocalBinding: opts?.allowLocalhost === true,
    },
    filesystem: {
      ...fs,
      allowRead: [...new Set([...(fs.allowRead ?? []), ...homePaths])],
      allowWrite: [...new Set([...fs.allowWrite, ...homePaths])],
    },
  }
}

/** Loopback hostnames a local dev server binds/serves on. */
const LOOPBACK_DOMAINS = ['localhost', '127.0.0.1', '::1'] as const

/**
 * Seatbelt overlay for a user-approved **loopback-binding background process**
 * (issue #691) — e.g. a local dev server.
 *
 * Same workspace-scoped filesystem rules as {@link workspaceSandboxOverlay},
 * with one deliberate relaxation: `allowLocalBinding: true` plus loopback-only
 * allowed domains, so the process can `listen()` on `localhost`/`127.0.0.1` and
 * be reached by the built-in browser. No public domains are added — this widens
 * the sandbox to loopback binding only, never to the open network. Only used
 * under an explicit per-workspace grant (see the permission gate), never for
 * auto-run commands.
 */
export function portBindingSandboxOverlay(workspaceRoot: string): Partial<SandboxRuntimeConfig> {
  const base = workspaceSandboxOverlay(workspaceRoot)
  return {
    ...base,
    network: {
      allowedDomains: [...LOOPBACK_DOMAINS],
      deniedDomains: [],
      allowLocalBinding: true,
    },
  }
}

/**
 * Read-only seatbelt overlay for the `read` routing tier (see
 * `services/security/command-routing.ts`). Identical filesystem *reads* to
 * {@link workspaceSandboxOverlay} — the workspace, toolchain, and git config —
 * but with **no writable roots except the scratch tmp dir** the toolchain itself
 * needs. Network stays denied. Used to run known read-only commands (`ls`, `cat`,
 * …) with strictly less privilege than the default write overlay: the seatbelt,
 * not just static analysis, enforces that they cannot mutate the tree.
 *
 * The tmp dir remains writable because build/inspection tools routinely stage
 * scratch files via `$TMPDIR`; denying it would break otherwise read-only tools
 * without adding a workspace-write capability. The mandatory config-file and
 * git-hook write-deny list still applies on top.
 */
export function readonlySandboxOverlay(workspaceRoot: string): Partial<SandboxRuntimeConfig> {
  const base = workspaceSandboxOverlay(workspaceRoot)
  const fs = base.filesystem
  if (!fs) throw new Error('workspaceSandboxOverlay must define a filesystem config')
  const tmpDir = ensureWorkspaceTmpDir()
  return {
    ...base,
    filesystem: {
      ...fs,
      // Drop the workspace roots from allowWrite; keep only the scratch tmp dir.
      allowWrite: [tmpDir, `${tmpDir}/**`],
    },
  }
}

export function workspaceSandboxOverlay(workspaceRoot: string): Partial<SandboxRuntimeConfig> {
  const root = canonicalizeWorkspaceRoot(workspaceRoot)
  const toolchainRead = resolveNodeToolchainAllowRead()
  // A workspace-owned scratch dir so commands writing to $TMPDIR stay on the
  // allow-list instead of hitting the system /tmp deny (issue #481). Created
  // here (best-effort) so the path the seatbelt allows actually exists; spawn
  // points $TMPDIR at it. Falls under the home denyRead, so it must be
  // re-allowed for both read and write.
  const tmpDir = ensureWorkspaceTmpDir()
  // Read-only mount of the chat store (#644) so seatbelt-confined read tools
  // (rg for search_code / recursive list_dir) can open past-thread files. It
  // lives under $HOME, so `denyRead: [homedir()]` would block it without this
  // more-specific allow. NOT added to allowWrite — the sandbox denies chat-store
  // writes too, matching the workspace-only path guards.
  const chatStore = getChatStoreRoot()
  const chatStoreRead = chatStore ? [chatStore, `${chatStore}/**`] : []
  return {
    // Auto-run, sandbox-contained commands get NO network (see
    // containedSandboxNetworkConfig); only user-approved commands run with
    // network, and those run fully unsandboxed rather than through this overlay.
    network: containedSandboxNetworkConfig(),
    filesystem: {
      // Deny home reads, re-allow only this project plus the user's git config
      // files (ASRT deny-then-allow; a more-specific allow overrides the deny).
      denyRead: [homedir()],
      allowRead: [
        root,
        `${root}/**`,
        tmpDir,
        `${tmpDir}/**`,
        ...toolchainRead,
        ...gitConfigReadPaths(),
        ...chatStoreRead,
      ],
      allowWrite: [root, `${root}/**`, tmpDir, `${tmpDir}/**`],
      denyWrite: workspaceMandatoryWriteDenyPaths(root),
      allowGitConfig: true,
    },
  }
}

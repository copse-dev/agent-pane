import { accessSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { getApplySeccompBinaryPath } from '@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js'
import { expandScratchPath } from '@shared/acp-scratch-paths.ts'
import { getSetting } from '../services/storage/settings.ts'
import { copseWorkspaceTmpDir } from '../services/storage/copse-paths.ts'
import { sanctionedAgentScratchEntries } from './agent-scratch-roots.ts'
import { canonicalizePathCached } from './canonical-path-cache.ts'
import {
  getChatStoreRootSync,
  getInternalWorkspaceRootRegistration,
  type InternalWorkspaceRootRegistration,
} from '../services/workspace.ts'
import { activeThreadReadRoots } from '../services/security/thread-read-roots.ts'
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
  return canonicalizePathCached(workspaceRoot)
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
  '.cursor/agents',
  '.copse/agents',
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
 * Deny the existing siblings around a nested execution root without masking
 * the whole checkout tree.
 *
 * ASRT's Linux backend implements a directory read deny with a tmpfs mount.
 * Denying `${checkoutRoot}/**` therefore hides the checkout and re-binds the
 * nested execution root on top. A later mandatory deny for a missing file such
 * as `.gitconfig` then cannot create its bind-mount target and bubblewrap
 * refuses to start. Enumerating siblings preserves the same read boundary while
 * leaving the ancestor chain mounted normally. The overlay is rebuilt for every
 * command, and only the execution root is writable, so a sandboxed command
 * cannot create a new sibling between enumeration and execution.
 */
function nestedCheckoutSiblingDenyPaths(checkoutRoot: string, executionRoot: string): string[] {
  const relativeRoot = relative(checkoutRoot, executionRoot)
  const segments = relativeRoot.split(sep).filter(Boolean)
  if (segments.length === 0 || relativeRoot.startsWith(`..${sep}`) || relativeRoot === '..') {
    return []
  }

  const denyPaths: string[] = []
  let cursor = checkoutRoot
  for (const segment of segments) {
    try {
      for (const entry of readdirSync(cursor, { withFileTypes: true })) {
        if (entry.name === segment || (cursor === checkoutRoot && entry.name === '.git')) continue
        const sibling = join(cursor, entry.name)
        denyPaths.push(sibling, `${sibling}/**`)
      }
    } catch {
      // Fail closed if the checkout changes or becomes unreadable while the
      // overlay is being built. This is the former broad-deny behaviour.
      return [`${checkoutRoot}/**`]
    }
    cursor = join(cursor, segment)
  }
  return [...new Set(denyPaths)]
}

/**
 * Whether a bare directory entry (no `/**`) in `allowRead` is safe to emit.
 *
 * macOS seatbelt is rule-based: a literal directory allow grants a listing of
 * that directory and nothing below it, and cannot disturb any other rule. ASRT's
 * Linux backend instead realizes an allowRead entry under a read-denied region
 * as a `--ro-bind` of that path, mounted AFTER the write binds — so a read entry
 * that is an ancestor of a writable path shadows the write bind and turns it
 * read-only (see the linked-worktree test: "Rebinding either ancestor here would
 * make the validated gitDir read-only again"). Listing-only entries are
 * therefore emitted everywhere except Linux, where the loss is only that `ls`
 * of that one directory fails while everything beneath it stays readable.
 */
function listingOnlyDirEntriesSupported(): boolean {
  return process.platform !== 'linux'
}

/**
 * Upper bound on the entries {@link readOnlyTreeExcluding} may add. A carve-out
 * chain through a directory holding hundreds of unregistered entries (a stale
 * `.claude/worktrees/`) would otherwise grow ASRT's inline seatbelt profile past
 * ARG_MAX, the same failure `uncoveredSiblingDenyPaths` guards against. Past
 * the cap the remaining chain directories are simply not opened: fail closed,
 * never a broader rule.
 */
const MAX_TREE_READ_ENTRIES = 400

/**
 * `allowRead` entries that expose `root` read-only EXCEPT the `carveOuts`
 * beneath it, without ever naming an ancestor of a carve-out with a `/**` rule.
 *
 * Every top-level child that is not on a carve-out's path gets `child` plus
 * `child/**`. A directory on the path to a carve-out is opened and its own
 * children handled the same way, so the carve-out itself (a sibling worktree,
 * the thread's own worktree, the shared `.git`) is never covered by any rule
 * and keeps whatever policy the rest of the overlay gives it. Directories on
 * such a path get a listing-only entry where the platform allows one
 * ({@link listingOnlyDirEntriesSupported}).
 *
 * A broad `${root}/**` would be simpler but wrong on both platforms: on macOS
 * a nested sibling's deny would rely on ASRT's late re-emission for every
 * shape, and on Linux the resulting `--ro-bind` of `root` would shadow the
 * write binds for `root/.git/objects` and a worktree nested under `root`.
 *
 * The tree is enumerated fresh for every spawn (like
 * {@link nestedCheckoutSiblingDenyPaths}); an unreadable directory yields no
 * entries at all rather than a guess.
 */
export function readOnlyTreeExcluding(root: string, carveOuts: readonly string[]): string[] {
  const carved = new Set<string>()
  const chainDirs = new Set<string>()
  for (const carveOut of carveOuts) {
    const rel = relative(root, carveOut)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue
    carved.add(rel)
    const segments = rel.split(sep)
    for (let i = 1; i < segments.length; i++) chainDirs.add(segments.slice(0, i).join(sep))
  }
  const listable = listingOnlyDirEntriesSupported()
  const paths: string[] = listable ? [root] : []
  const visit = (dirRel: string): boolean => {
    let entries
    try {
      entries = readdirSync(dirRel ? join(root, dirRel) : root, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      const rel = dirRel ? join(dirRel, entry.name) : entry.name
      if (carved.has(rel)) continue
      const abs = join(root, rel)
      if (chainDirs.has(rel)) {
        if (listable) paths.push(abs)
        if (paths.length >= MAX_TREE_READ_ENTRIES) continue
        if (!visit(rel)) return false
        continue
      }
      paths.push(abs)
      if (entry.isDirectory()) paths.push(`${abs}/**`)
    }
    return true
  }
  if (!visit('')) return []
  return [...new Set(paths)]
}

/**
 * Read-only view of the shared primary checkout for a linked-worktree thread.
 *
 * SECURITY TRADE-OFF. The primary working tree is the user's own checkout and
 * routinely holds uncommitted work. A thread running in a linked worktree
 * previously could not read it at all (`denyRead`), which is the strictest
 * reading but broke the tooling a worktree-based thread exists for: from the
 * worktree, `git worktree list --porcelain` reported only the primary with a
 * zero HEAD and no linked entries, and `git -C <primary> …` died with "Unable
 * to read current working directory" (reconcile-worktrees post-mortem,
 * 2026-09-09). Reading the primary is what such a thread needs — comparing
 * against `main`, listing worktrees, reading a config file the worktree does
 * not carry — and a read of the user's own project by the user's own agent is
 * the same exposure the thread already has to every committed file through
 * the shared object store. Writes are a different matter: a worktree thread
 * that could edit the primary would be editing the user's uncommitted work
 * behind their back, so the primary is NOT added to `allowWrite` (the write
 * policy is allow-list based on every platform, so nothing more is needed to
 * deny it) and its `.git` keeps the existing config/hooks write denies.
 *
 * Carved out of the read view, so they keep their own policy:
 * - the shared `.git` (`commonGitDir`): the narrow admin paths git needs are
 *   allowed individually by the caller — a wholesale read of the common
 *   directory would, on Linux, ro-bind over the per-worktree write binds;
 * - the thread's own checkout when it is nested inside the primary
 *   (`<primary>/.claude/worktrees/<thread>`): already writable via its own
 *   rules, and a read-only bind over its ancestor would shadow that;
 * - every registered sibling worktree nested inside the primary: another
 *   thread's in-progress work stays unreadable, exactly as it is outside the
 *   primary via `uncoveredSiblingDenyPaths`.
 */
export function primaryCheckoutReadPaths(
  internalRoot: InternalWorkspaceRootRegistration,
): string[] {
  const primary = internalRoot.primaryCheckoutRoot
  if (!primary || primary === internalRoot.root || primary === internalRoot.checkoutRoot) return []
  return readOnlyTreeExcluding(primary, [
    internalRoot.commonGitDir,
    internalRoot.checkoutRoot,
    ...internalRoot.siblingRoots,
  ])
}

/**
 * `allowRead` entries for the roots the active thread has been granted — the
 * directories of skills it invoked (`thread-read-roots.ts`). Reads only; the
 * shell-scope classifier waives the same roots for read-only commands, so a
 * command that names one auto-runs inside the seatbelt and must then succeed.
 *
 * Both the discovered spelling and the realpath are emitted: the kernel
 * enforces against the canonical path, and a symlinked `~/.codex/skills/x`
 * would otherwise be allowed by the classifier and denied by the seatbelt.
 * No ancestor traversal entries are added — ASRT already allows directory
 * metadata reads once any deny exists, which is all component-by-component
 * path resolution needs, and an ancestor entry is exactly the Linux
 * write-shadowing hazard {@link listingOnlyDirEntriesSupported} describes.
 */
export function threadReadRootAllowEntries(): string[] {
  const entries = new Set<string>()
  for (const root of activeThreadReadRoots()) {
    for (const spelling of new Set([root.path, root.canonical])) {
      entries.add(spelling)
      if (root.isDirectory) entries.add(`${spelling}/**`)
    }
  }
  return [...entries]
}

/**
 * Deny linked checkouts that are not already covered by the broad home-read deny.
 *
 * A busy repository can have hundreds of linked worktrees. Repeating every
 * home-contained sibling in both denyRead and denyWrite makes ASRT's inline
 * macOS Seatbelt profile grow past ARG_MAX even though `denyRead: [homedir()]`
 * already blocks those paths and the write policy is allow-list based. Keep
 * explicit rules only for external siblings, which need their own read deny.
 */
export function uncoveredSiblingDenyPaths(
  siblingRoots: readonly string[],
  broadReadDenyRoot: string = homedir(),
): string[] {
  const denyRoot = canonicalizeWorkspaceRoot(broadReadDenyRoot)
  return siblingRoots.flatMap((siblingRoot) => {
    const sibling = canonicalizeWorkspaceRoot(siblingRoot)
    const rel = relative(denyRoot, sibling)
    const covered = rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
    return covered ? [] : [sibling, `${sibling}/**`]
  })
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
  return copseWorkspaceTmpDir()
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

/** ASRT native helpers that must remain executable inside a denied home tree. */
export function sandboxRuntimeHelperAllowReadPaths(
  seccompPath: string | null = process.platform === 'linux' ? getApplySeccompBinaryPath() : null,
): string[] {
  if (!seccompPath) return []
  const helper = resolve(seccompPath)
  const helperDir = dirname(helper)
  // Re-allow only this architecture directory. The rest of sandbox-runtime
  // and node_modules stay hidden by the broad home deny.
  return [helper, helperDir, `${helperDir}/**`]
}

/** Paths bundled workers and ASRT itself must read from inside a denied home tree. */
export function electronRuntimeAllowReadPaths(
  execPath: string = process.execPath,
  seccompPath: string | null = process.platform === 'linux' ? getApplySeccompBinaryPath() : null,
): string[] {
  const invokedExec = resolve(execPath)
  let canonicalExec = invokedExec
  try {
    canonicalExec = realpathSync.native(invokedExec)
  } catch {
    // Keep resolve() result when the binary is not stat-able yet.
  }

  // Linux bubblewrap hides broad denyRead roots with tmpfs mounts and then
  // re-binds allowRead paths. Preserve the path used to invoke Electron as
  // well as its realpath: pnpm installs expose Electron through a symlink, and
  // re-binding only the target leaves the symlink spelling absent inside the
  // mount namespace. macOS resolves filesystem policy against canonical paths,
  // but retaining both spellings is harmless and keeps the contract uniform.
  const paths: string[] = []
  for (const exec of new Set([invokedExec, canonicalExec])) {
    paths.push(exec, dirname(exec), `${dirname(exec)}/**`)
    if (process.platform === 'darwin' && exec.includes('.app/')) {
      const [appPrefix] = exec.split('.app/')
      const appRoot = `${appPrefix ?? exec}.app`
      try {
        const realAppRoot = realpathSync.native(resolve(appRoot))
        paths.push(appRoot, `${appRoot}/**`, realAppRoot, `${realAppRoot}/**`)
        const macOsDir = join(realAppRoot, 'Contents', 'MacOS')
        if (statSync(macOsDir).isDirectory()) {
          paths.push(macOsDir, `${macOsDir}/**`)
        }
      } catch {
        paths.push(resolve(appRoot), `${resolve(appRoot)}/**`)
      }
    }
  }
  // ASRT resolves apply-seccomp before constructing the bubblewrap command,
  // then invokes that absolute path *inside* the mount namespace. A broad
  // denyRead on $HOME hides pnpm's sandbox-runtime package unless this native
  // helper is rebound alongside the worker. Re-allow only its architecture
  // directory; the rest of node_modules remains hidden.
  paths.push(...sandboxRuntimeHelperAllowReadPaths(seccompPath))
  return [...new Set(paths)]
}

/** Workspace rules plus access for the fs worker script and Electron runtime. */
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
 * Preserve workspace read confinement without creating Linux write-deny mount
 * points. Read-only commands cannot mutate the checkout, so an empty write
 * allow-list already provides the required boundary; retaining denyWrite would
 * make bubblewrap materialize protected dotfiles that commands such as
 * `git status` then report as untracked during their own execution.
 */
export function readOnlyWorkspaceSandboxOverlay(
  workspaceRoot: string,
): Partial<SandboxRuntimeConfig> {
  const workspace = workspaceSandboxOverlay(workspaceRoot)
  const fs = workspace.filesystem
  if (!fs) throw new Error('workspaceSandboxOverlay must define a filesystem config')
  return {
    ...workspace,
    filesystem: {
      ...fs,
      allowWrite: [],
      denyWrite: [],
    },
  }
}

/**
 * Read-only overlay for the persistent fs server.
 *
 * Linux bwrap materializes non-existent mandatory write-deny paths (such as
 * .bashrc and .vscode) in the real checkout. A long-lived writable worker keeps
 * those mount points alive for the whole app session, so Git reports them as
 * untracked. Writes use a short-lived worker with {@link fsWorkerSandboxOverlay};
 * the persistent server only needs reads and therefore needs no write mounts.
 */
export function fsServerSandboxOverlay(
  workspaceRoot: string,
  workerJsPath: string,
): Partial<SandboxRuntimeConfig> {
  const worker = fsWorkerSandboxOverlay(workspaceRoot, workerJsPath)
  const fs = worker.filesystem
  if (!fs) throw new Error('fsWorkerSandboxOverlay must define a filesystem config')
  return {
    ...worker,
    filesystem: {
      ...fs,
      allowWrite: [],
      denyWrite: [],
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
 * Re-exported so the seatbelt's own callers keep importing it from here; the
 * implementation lives in a renderer- and eval-safe shared leaf, which the
 * shell-scope classifier also reads so the two cannot drift.
 */
export { expandScratchPath } from '@shared/acp-scratch-paths.ts'

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
  const configuredHomePaths = (sandbox.homeDirs ?? []).flatMap((rel) => {
    const abs = join(home, rel)
    return [abs, `${abs}/**`]
  })
  // macOS Keychain lookup from a sandboxed process needs metadata access to
  // the home directory node before it can resolve credentials stored by tools
  // such as Claude Code. Re-allow only the literal parent — never `home/**` —
  // whenever an agent declares home-scoped state. Without this, the narrower
  // `.claude` allowance is insufficient and `claude auth status` fails EPERM.
  const homeReadPaths = configuredHomePaths.length > 0 ? [home, ...configuredHomePaths] : []
  const scratchPaths = (sandbox.scratchPaths ?? [])
    .flatMap(expandScratchPath)
    .flatMap((abs) => [abs, `${abs}/**`])
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
      allowRead: [...new Set([...(fs.allowRead ?? []), ...homeReadPaths, ...scratchPaths])],
      allowWrite: [...new Set([...fs.allowWrite, ...configuredHomePaths, ...scratchPaths])],
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
 * Canonicalize a granted read target the way {@link canonicalizeWorkspaceRoot}
 * canonicalizes the workspace root: seatbelt matches the kernel's symlink-free
 * path, so `~/foo` on a symlinked home (or a `/tmp/...` target) must be spelled
 * the way the kernel sees it or the allow rule silently never matches.
 *
 * A target that does not exist — a glob such as `~/notes/*.md`, or a file the
 * command is about to discover is absent — cannot be realpath'd, so the parent
 * is canonicalized instead and the leaf re-joined.
 */
function canonicalizeReadTarget(target: string): string {
  const resolved = resolve(target)
  try {
    return realpathSync.native(resolved)
  } catch {
    // Leaf missing: canonicalize the deepest existing ancestor instead.
  }
  try {
    return join(realpathSync.native(dirname(resolved)), basename(resolved))
  } catch {
    return resolved
  }
}

/**
 * Every directory between a granted target and the filesystem root.
 *
 * macOS seatbelt resolves a path component by component, so reading
 * `~/notes/todo.md` needs metadata access to `~/notes` and to `$HOME` itself —
 * the broad `denyRead: [homedir()]` otherwise stops the walk before the
 * more-specific leaf allow is ever consulted. Emitted as literal directory
 * paths with no `/**`, so this grants traversal (and a listing of the named
 * directories) without exposing any sibling subtree's contents — the same
 * narrow shape `worktreeDiscoveryRead` uses for git's repository probe.
 */
function readTargetTraversalPaths(canonicalTarget: string): string[] {
  const paths: string[] = []
  let cursor = dirname(canonicalTarget)
  while (cursor !== dirname(cursor)) {
    paths.push(cursor)
    cursor = dirname(cursor)
  }
  return paths
}

function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Seatbelt overlay for a command the user approved through the **read-access
 * question** (`read-outside-project.ts`): the workspace rules with exactly the
 * granted paths added to `allowRead`.
 *
 * Without this, approving "Allow read access outside of the project?" still ran
 * the command fully UNSANDBOXED — the command names a path outside the
 * workspace, so `shellRunsOutsideSandbox` routes it out, and the read grant only
 * silenced the prompt. That handed the command writes and network the prompt
 * explicitly promised it was not granting. This overlay is the containment that
 * makes the prompt's wording true: reads of the named paths, and nothing else.
 *
 * Deliberately one axis only, mirroring {@link portBindingSandboxOverlay}:
 * `allowRead` gains the granted targets, their ancestor directories (needed for
 * path traversal), and `${target}/**` for a target that is a directory. Network
 * stays on the contained deny-all, `allowWrite`/`denyWrite` are untouched, and
 * the mandatory write denies still apply. Credential and whole-home targets
 * never reach here: `sensitiveTargetReason`/`breadthBlocker` refuse them at
 * eligibility time, before a grant exists.
 *
 * Built fresh per spawn, so a relaxation can never outlive the one command whose
 * own targets earned it.
 */
export function readAllowedSandboxOverlay(
  workspaceRoot: string,
  readTargets: readonly string[],
): Partial<SandboxRuntimeConfig> {
  const base = workspaceSandboxOverlay(workspaceRoot)
  const fs = base.filesystem
  if (!fs) throw new Error('workspaceSandboxOverlay must define a filesystem config')

  const grantedRead: string[] = []
  for (const target of readTargets) {
    // Fail closed: a relative target means the caller resolved nothing, and
    // guessing a base here could widen a path the analysis never approved.
    if (!isAbsolute(target)) continue
    const canonical = canonicalizeReadTarget(target)
    grantedRead.push(canonical)
    if (isDirectoryPath(canonical)) grantedRead.push(`${canonical}/**`)
    grantedRead.push(...readTargetTraversalPaths(canonical))
  }
  if (grantedRead.length === 0) return base

  return {
    ...base,
    filesystem: {
      ...fs,
      allowRead: [...new Set([...(fs.allowRead ?? []), ...grantedRead])],
    },
  }
}

export function workspaceSandboxOverlay(workspaceRoot: string): Partial<SandboxRuntimeConfig> {
  const root = canonicalizeWorkspaceRoot(workspaceRoot)
  const internalRoot = getInternalWorkspaceRootRegistration(root)
  const toolchainRead = resolveNodeToolchainAllowRead()
  const sandboxRuntimeRead = sandboxRuntimeHelperAllowReadPaths()
  // A workspace-owned scratch dir so commands writing to $TMPDIR stay on the
  // allow-list instead of hitting the system /tmp deny (issue #481). Created
  // here (best-effort) so the path the seatbelt allows actually exists; spawn
  // points $TMPDIR at it. Falls under the home denyRead, so it must be
  // re-allowed for both read and write.
  const tmpDir = ensureWorkspaceTmpDir()
  // Scratch dirs a configured ACP agent hardcodes (see `agent-scratch-roots.ts`).
  // Allowed for every contained command, not only the declaring agent's own
  // process, because `shell-scope.ts` waives the same entries when it classifies
  // a command: a path that stops prompting must also stop EPERMing.
  const agentScratch = sanctionedAgentScratchEntries().flatMap((entry) => [entry, `${entry}/**`])
  // Read-only mount of the chat store (#644) so seatbelt-confined read tools
  // (rg for search_code / recursive list_dir) can open past-thread files. It
  // lives under $HOME, so `denyRead: [homedir()]` would block it without this
  // more-specific allow. NOT added to allowWrite — the sandbox denies chat-store
  // writes too, matching the workspace-only path guards.
  const chatStore = getChatStoreRootSync()
  const chatStoreRead = chatStore ? [chatStore, `${chatStore}/**`] : []
  // Git discovers a repository by probing `.git` while walking from cwd toward
  // the checkout top-level. A project may itself be a monorepo subdirectory, so
  // allow metadata reads on each ancestor directory without recursively exposing
  // sibling project content.
  const worktreeDiscoveryRead: string[] = []
  if (internalRoot) {
    let cursor = internalRoot.root
    while (cursor !== internalRoot.checkoutRoot) {
      cursor = dirname(cursor)
      worktreeDiscoveryRead.push(cursor)
    }
  }
  // Linked worktrees keep their index/HEAD in a per-worktree admin directory
  // and share objects/refs with the parent repository. These paths come only
  // from a main-process-validated internal-root registration. Do not allow the
  // common directory wholesale: sibling worktree admin state, hooks, and config
  // remain outside the writable surface.
  const gitAdminRead = internalRoot
    ? [
        join(internalRoot.checkoutRoot, '.git'),
        internalRoot.gitDir,
        `${internalRoot.gitDir}/**`,
        join(internalRoot.commonGitDir, 'objects/**'),
        join(internalRoot.commonGitDir, 'refs/**'),
        join(internalRoot.commonGitDir, 'logs/**'),
        join(internalRoot.commonGitDir, 'info/**'),
        join(internalRoot.commonGitDir, 'config'),
        join(internalRoot.commonGitDir, 'packed-refs'),
        join(internalRoot.commonGitDir, 'shallow'),
        // The primary checkout's own state, read-only: its HEAD (without it
        // `git worktree list` reported the primary at 0000000), its index (so
        // `git -C <primary> status/diff` work — the refresh write fails
        // silently), and the admin dir of every registered sibling so the
        // worktree list is complete. Their working trees stay denied.
        join(internalRoot.commonGitDir, 'HEAD'),
        join(internalRoot.commonGitDir, 'ORIG_HEAD'),
        join(internalRoot.commonGitDir, 'FETCH_HEAD'),
        join(internalRoot.commonGitDir, 'index'),
        join(internalRoot.commonGitDir, 'description'),
        ...internalRoot.siblingGitDirs.flatMap((dir) => [dir, `${dir}/**`]),
        // Listing `worktrees/` is what lets git enumerate them; a bare entry
        // for the ancestor of the writable per-worktree dir is only safe where
        // it cannot shadow that write bind.
        ...(listingOnlyDirEntriesSupported() ? [join(internalRoot.commonGitDir, 'worktrees')] : []),
      ]
    : []
  const gitAdminWrite = internalRoot
    ? [
        internalRoot.gitDir,
        `${internalRoot.gitDir}/**`,
        join(internalRoot.commonGitDir, 'objects/**'),
        join(internalRoot.commonGitDir, 'refs/**'),
        join(internalRoot.commonGitDir, 'logs/**'),
        join(internalRoot.commonGitDir, 'packed-refs'),
      ]
    : []
  const siblingDeny = internalRoot ? uncoveredSiblingDenyPaths(internalRoot.siblingRoots) : []
  // The shared primary checkout is readable (never writable) from a linked
  // worktree — see primaryCheckoutReadPaths for the trade-off. The entries are
  // per-child allows with the shared `.git`, the thread's own nested worktree,
  // and nested sibling worktrees carved out, so under $HOME the home deny
  // still covers those, and outside $HOME `siblingDeny` above does. Sibling
  // packages inside a nested worktree checkout are handled separately below.
  const primaryCheckoutRead = internalRoot ? primaryCheckoutReadPaths(internalRoot) : []
  // Nested execution root (e.g. `worktree/packages/app` under `worktree`):
  // deny siblings at every level of the ancestor chain. Do not broadly deny
  // `${checkoutRoot}/**`: Linux ASRT realizes that as a tmpfs and can no longer
  // materialize mandatory deny mounts inside the re-bound execution root.
  const nestedCheckoutDeny =
    internalRoot && internalRoot.root !== internalRoot.checkoutRoot
      ? nestedCheckoutSiblingDenyPaths(internalRoot.checkoutRoot, internalRoot.root)
      : []
  const gitAdminDenyWrite = internalRoot
    ? [
        join(internalRoot.commonGitDir, 'config'),
        join(internalRoot.commonGitDir, 'hooks'),
        join(internalRoot.commonGitDir, 'hooks/**'),
      ]
    : []
  return {
    // Auto-run, sandbox-contained commands get NO network (see
    // containedSandboxNetworkConfig); only user-approved commands run with
    // network, and those run fully unsandboxed rather than through this overlay.
    network: containedSandboxNetworkConfig(),
    filesystem: {
      // Deny home reads, re-allow only this project plus the user's git config
      // files (ASRT deny-then-allow; a more-specific allow overrides the deny).
      denyRead: [homedir(), ...siblingDeny, ...nestedCheckoutDeny],
      allowRead: [
        root,
        `${root}/**`,
        tmpDir,
        `${tmpDir}/**`,
        ...toolchainRead,
        ...sandboxRuntimeRead,
        ...gitConfigReadPaths(),
        ...chatStoreRead,
        ...worktreeDiscoveryRead,
        ...gitAdminRead,
        ...primaryCheckoutRead,
        ...agentScratch,
        // Read-only roots the active thread earned (invoked skill directories).
        ...threadReadRootAllowEntries(),
      ],
      allowWrite: [root, `${root}/**`, tmpDir, `${tmpDir}/**`, ...gitAdminWrite, ...agentScratch],
      denyWrite: [...workspaceMandatoryWriteDenyPaths(root), ...siblingDeny, ...gitAdminDenyWrite],
      allowGitConfig: true,
    },
  }
}

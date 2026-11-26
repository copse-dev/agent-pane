import { realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { readSmallGitFile, resolveGitCommonDir, resolveGitDirs } from './git-remotes.ts'
import { pinnedRemotes, pinRemotes } from './remote-pins.ts'

/**
 * What a per-command network scope needs to know about the repository a contained
 * `git` or `gh` command will run in (`network-scoped-shell.ts`): where each
 * configured remote points, and whether the repository's own config could make git
 * run a program while it holds that remote's egress.
 *
 * Read straight from the config files, for the reason `git-remotes.ts` gives:
 * spawning git inside the permission gate is both a latency cost and a place
 * repository config could execute.
 *
 * In a registered Copse worktree contained commands cannot write the common
 * `config`, `config.worktree` or `hooks/` (`gitAdminDenyWrite` in
 * `project-sandbox/config.ts`). In a shared checkout they can write `.git/config`
 * (only `.git/hooks` is a mandatory deny), so there these facts are a preflight
 * that a background task could race. What holds at run time is the overrides
 * `scopedNetworkEnv` passes in the environment. A nested repository a contained
 * command created has no protection at all, so {@link readRepoNetworkFacts}
 * refuses an execution root whose `.git` does not lead to the project's own
 * common directory.
 */

const MAX_CONFIG_BYTES = 1024 * 1024

export interface RemoteUrls {
  url: string | null
  pushUrl: string | null
}

export interface RepoNetworkFacts {
  remotes: ReadonlyMap<string, RemoteUrls>
  /**
   * Repository config entries that name a program or pull in another file. Any one
   * makes git able to run code the facts cannot vouch for, so the scope is refused.
   */
  unsafeConfig: readonly string[]
  /** `core.hooksPath`, or the default hooks directory, is somewhere contained commands write. */
  workspaceHooks: boolean
  /**
   * The hooks directory git would use, when it is write-protected: an absolute
   * `core.hooksPath` outside every writable root, or the repository's own
   * `hooks/` (a mandatory write-deny). Null when unknown. A push passes it back
   * to git at execution time, so a later config edit cannot move it.
   */
  hooksPath: string | null
  /**
   * Configured remotes a scope may not use, with the reason: their URLs differ
   * from the ones recorded outside the sandbox ({@link vouchForRemotes}).
   */
  unvouchedRemotes?: ReadonlyMap<string, string>
}

/** Forges whose remotes may be recorded on first sight, before the user re-trusts the workspace. */
const WELL_KNOWN_FORGES: ReadonlySet<string> = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
])

interface ConfigEntry {
  /** Lower-cased `section.subsection.key`, subsection case kept as git does. */
  key: string
  value: string
}

const SECTION = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)$/
const ENTRY = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/

function unquote(raw: string): string {
  let out = ''
  let quoted = false
  for (let index = 0; index < raw.length; index++) {
    const ch = raw.charAt(index)
    if (ch === '\\') {
      const next = raw.charAt(++index)
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next
      continue
    }
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && (ch === '#' || ch === ';')) break
    out += ch
  }
  return out.trim()
}

/** A deliberately small git-config reader: sections, keys and values, no includes. */
export function parseGitConfig(text: string): ConfigEntry[] {
  const entries: ConfigEntry[] = []
  let section: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine
    const header = SECTION.exec(line)
    if (header) {
      const name = (header[1] ?? '').toLowerCase()
      const sub = header[2]
      // `[remote.origin]` is the deprecated spelling of `[remote "origin"]`.
      section = sub !== undefined ? `${name}.${sub.replace(/\\(.)/g, '$1')}` : name
      line = header[3] ?? ''
      if (!line.trim()) continue
    }
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    if (section === null) continue
    const entry = ENTRY.exec(trimmed)
    if (!entry) continue
    entries.push({
      key: `${section}.${(entry[1] ?? '').toLowerCase()}`,
      value: entry[2] === undefined ? 'true' : unquote(entry[2]),
    })
  }
  return entries
}

/** Last segment of a dotted key, and the section it belongs to. */
function splitKey(key: string): { section: string; name: string; sub: string | null } {
  const first = key.indexOf('.')
  const last = key.lastIndexOf('.')
  const section = key.slice(0, first)
  const name = key.slice(last + 1)
  const sub = last > first ? key.slice(first + 1, last) : null
  return { section, name, sub }
}

/** The filter driver commands `git lfs install` writes; any other driver refuses the scope. */
const GIT_LFS_FILTERS: ReadonlySet<string> = new Set([
  'git-lfs clean -- %f',
  'git-lfs smudge -- %f',
  'git-lfs smudge --skip -- %f',
  'git-lfs filter-process',
  'git-lfs filter-process --skip',
])

function unsafeEntry(entry: ConfigEntry): string | null {
  const { section, name, sub } = splitKey(entry.key)
  const value = entry.value
  if (section === 'include' || section === 'includeif') return 'includes another config file'
  if (section === 'core') {
    if (['sshcommand', 'askpass', 'gitproxy', 'editor', 'pager'].includes(name)) {
      return `core.${name} names a program`
    }
    if (name === 'fsmonitor' && !/^(?:true|false|0|1|yes|no|on|off)$/i.test(value)) {
      return 'core.fsmonitor names a program'
    }
    return null
  }
  if (section === 'credential' && name === 'helper') {
    // Built-in helper names (`store`, `osxkeychain`) resolve to git's own
    // `git-credential-*` programs; a `!` snippet or a path runs anything.
    return value === '' || /^[A-Za-z0-9-]+$/.test(value) ? null : 'credential.helper runs a command'
  }
  if (section === 'gpg' && name === 'program') return 'gpg program configured'
  if (section === 'protocol' && name === 'allow') return 'protocol allow-list changed'
  // Neither can leave the scope's allowlist, but both make the host the plan
  // names differ from the host git actually contacts.
  if (section === 'url' && (name === 'insteadof' || name === 'pushinsteadof')) {
    return 'url rewrite configured'
  }
  if (section === 'http' && name === 'proxy') return 'http.proxy configured'
  if (section === 'remote' && ['uploadpack', 'receivepack', 'vcs', 'proxy'].includes(name)) {
    return `remote.${name} names a program or proxy`
  }
  if (section === 'filter' && ['clean', 'smudge', 'process'].includes(name)) {
    // A plain program name can still be `sh scripts/x.sh`; only git-lfs's own
    // driver commands are known to run nothing from the repository.
    return GIT_LFS_FILTERS.has(value.replace(/\s+/g, ' ').trim())
      ? null
      : `filter.${sub ?? ''} runs a command`
  }
  if (section === 'diff' && ['command', 'textconv'].includes(name)) return 'diff driver configured'
  if (section === 'merge' && name === 'driver') return 'merge driver configured'
  if (section === 'sequence' && name === 'editor') return 'sequence.editor names a program'
  return null
}

function urlHost(url: string | null): string | null {
  if (url === null) return null
  const match =
    /^(?:https|ssh|git\+ssh|ssh\+git):\/\/(?:[^@/\s]+@)?([^/:\s]+)/i.exec(url.trim()) ??
    /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/\/)/.exec(url.trim())
  return match?.[1]?.toLowerCase() ?? null
}

function sameUrls(a: RemoteUrls, b: RemoteUrls): boolean {
  return a.url === b.url && a.pushUrl === b.pushUrl
}

/**
 * Keep only the remotes whose URLs match the record kept outside the sandbox
 * (`remote-pins.ts`). With no record yet, the well-known-forge remotes are
 * recorded now and every other one is left out until the workspace is trusted
 * again, since the config may already carry a contained command's edits.
 */
export function vouchForRemotes(facts: RepoNetworkFacts, commonDir: string): RepoNetworkFacts {
  let pins = pinnedRemotes(commonDir)
  if (pins === null) {
    const firstSight = new Map(
      [...facts.remotes].filter(([, urls]) =>
        [urls.url, urls.pushUrl].every((url) => {
          const host = urlHost(url)
          return url === null || (host !== null && WELL_KNOWN_FORGES.has(host))
        }),
      ),
    )
    pinRemotes(commonDir, firstSight)
    pins = firstSight
  }
  const remotes = new Map<string, RemoteUrls>()
  const unvouched = new Map<string, string>()
  for (const [name, urls] of facts.remotes) {
    const pinned = pins.get(name)
    if (pinned && sameUrls(pinned, urls)) remotes.set(name, urls)
    else
      unvouched.set(
        name,
        pinned
          ? `remote ${name} changed since the workspace was trusted`
          : `remote ${name} was not recorded when the workspace was trusted`,
      )
  }
  return { ...facts, remotes, unvouchedRemotes: unvouched }
}

/**
 * Record the remotes of the repository at `root` as the user trusts it. Called
 * from `setWorkspaceTrusted`; a root that is not a repository records nothing.
 */
export function pinRemotesAtTrust(root: string): void {
  const dirs = resolveGitDirs(root)
  if (!dirs) return
  const shared = readSmallFile(join(dirs.commonDir, 'config'))
  if (shared === null) return
  pinRemotes(canonical(dirs.commonDir), repoNetworkFactsFromConfig(shared, [root]).remotes)
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep)
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

function readSmallFile(path: string): string | null {
  return readSmallGitFile(path, MAX_CONFIG_BYTES)
}

/** Derive facts from already-read config text. Pure; exported for tests. */
export function repoNetworkFactsFromConfig(
  configText: string,
  workspaceRoots: readonly string[],
  defaultHooksDir: string | null = null,
): RepoNetworkFacts {
  const remotes = new Map<string, RemoteUrls>()
  const unsafe = new Set<string>()
  let workspaceHooks = false
  let configuredHooks: string | null = null
  for (const entry of parseGitConfig(configText)) {
    const reason = unsafeEntry(entry)
    if (reason) unsafe.add(reason)
    const { section, name, sub } = splitKey(entry.key)
    if (section === 'remote' && sub !== null && (name === 'url' || name === 'pushurl')) {
      const current = remotes.get(sub) ?? { url: null, pushUrl: null }
      // Like git, the first `url` is the fetch URL; the first `pushurl` wins too.
      if (name === 'url' && current.url === null) current.url = entry.value
      if (name === 'pushurl' && current.pushUrl === null) current.pushUrl = entry.value
      remotes.set(sub, current)
    }
    // Like git, the last `core.hooksPath` wins.
    if (section === 'core' && name === 'hookspath') configuredHooks = entry.value
  }
  const within = (path: string): boolean =>
    workspaceRoots.some((root) => isWithin(resolve(path), root) || isWithin(canonical(path), root))
  let hooksPath: string | null = null
  if (configuredHooks !== null) {
    if (!isAbsolute(configuredHooks) || within(configuredHooks)) workspaceHooks = true
    else hooksPath = configuredHooks
  } else if (defaultHooksDir !== null) {
    // `<git dir>/hooks` is a mandatory write-deny wherever it is named
    // `.git/hooks`; any other spelling counts only outside the writable roots.
    if (/[\\/]\.git[\\/]hooks$/.test(defaultHooksDir) || !within(defaultHooksDir)) {
      hooksPath = defaultHooksDir
    } else workspaceHooks = true
  }
  return { remotes, unsafeConfig: [...unsafe], workspaceHooks, hooksPath }
}

/** Whether `extensions.worktreeConfig` is on in a config text. */
function worktreeConfigEnabled(configText: string): boolean {
  for (const entry of parseGitConfig(configText)) {
    if (entry.key !== 'extensions.worktreeconfig') continue
    return !/^(?:false|0|no|off)$/i.test(entry.value)
  }
  return false
}

/**
 * Facts for the repository a command at `executionRoot` would use, or null when that
 * is not the project's own protected repository: no `.git` at the execution root
 * (git would discover whatever repository a contained command planted above or
 * below it), or one whose common directory differs from the project's.
 *
 * With `extensions.worktreeConfig` on, git also reads the worktree's own
 * `config.worktree`, which lives in its git dir. That layer is judged like the
 * shared config, but only when contained commands cannot write it: the primary
 * checkout's (inside the protected common dir), or a registered Copse worktree's,
 * whose sandbox profile denies writes to it. `protectedWorktreeGitDir` names the
 * latter; any other linked worktree's layer cannot be vouched for, so it refuses.
 */
export function readRepoNetworkFacts(
  executionRoot: string,
  projectRoot: string | null,
  protectedWorktreeGitDir: string | null = null,
  extraWritableRoots: readonly string[] = [],
): RepoNetworkFacts | null {
  const dirs = resolveGitDirs(executionRoot)
  if (!dirs) return null
  const { gitDir, commonDir } = dirs
  if (projectRoot !== null) {
    const projectCommon = resolveGitCommonDir(projectRoot)
    if (!projectCommon || canonical(projectCommon) !== canonical(commonDir)) return null
  }
  const shared = readSmallFile(join(commonDir, 'config'))
  if (shared === null) return null
  const texts = [shared]
  const linked = canonical(gitDir) !== canonical(commonDir)
  let unprotectedLayer = false
  if (worktreeConfigEnabled(shared)) {
    if (!linked) {
      texts.push(readSmallFile(join(commonDir, 'config.worktree')) ?? '')
    } else if (
      protectedWorktreeGitDir !== null &&
      canonical(protectedWorktreeGitDir) === canonical(gitDir)
    ) {
      texts.push(readSmallFile(join(gitDir, 'config.worktree')) ?? '')
    } else {
      unprotectedLayer = true
    }
  }
  const roots = [
    ...new Set([
      executionRoot,
      canonical(executionRoot),
      ...(projectRoot ? [projectRoot, canonical(projectRoot)] : []),
      // Temp directories: contained commands write there too, so a hooks
      // directory inside one is as plantable as one in the workspace.
      ...extraWritableRoots.flatMap((root) => [root, canonical(root)]),
    ]),
  ]
  const facts = vouchForRemotes(
    repoNetworkFactsFromConfig(texts.join('\n'), roots, canonical(join(commonDir, 'hooks'))),
    canonical(commonDir),
  )
  return unprotectedLayer
    ? {
        ...facts,
        unsafeConfig: [...facts.unsafeConfig, 'per-worktree config is not write-protected'],
      }
    : facts
}

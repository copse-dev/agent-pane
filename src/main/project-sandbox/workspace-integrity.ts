/**
 * Snapshot-and-compare integrity checks around contained commands.
 *
 * A contained command can write anywhere in its workspace, and some workspace
 * files configure programs that run later outside the sandbox: a coding
 * agent's hooks and permission settings, Copse's own project hooks, the
 * repository's git config (`core.fsmonitor`, `core.hooksPath`, `alias.*`,
 * filter drivers …), submodule hooks. ASRT's mandatory write denies cover only
 * some of them, and on Linux bubblewrap can deny only paths that already exist.
 *
 * So the local runtime snapshots those files before each contained command
 * starts and compares them when it ends. Only paths the command's own write
 * policy lets it write are guarded: a change anywhere else cannot be the
 * command's, so it is never touched. A change to an agent or hook file is
 * reverted. A git config change is reverted only when it adds, changes or
 * removes an entry that can start a program or repoint a remote
 * (`git-config-policy.ts`), and only those keys are put back, so upstream
 * tracking, `git remote add`, `git lfs install` and anything else written
 * alongside keep working. The revert itself runs under the same sandbox write
 * policy (`workspace-integrity-restore.ts`). Each revert is reported to the
 * registered sink (the decision log) and to the command's own result.
 *
 * A change that could not be reverted stays in the baseline as a difference:
 * every later check tries again, and an unsandboxed agent command in that
 * workspace is refused until it is undone.
 *
 * Overlapping contained commands in one workspace share one baseline, and an
 * unsandboxed launch first checks every workspace that still has a contained
 * command running, so a long-lived background task cannot leave a change in
 * place for an approved command Copse launches to pick up. Nothing watches the
 * files while the task runs: the user's own tools (an IDE polling git, direnv
 * on `cd`) can run a planted change before the check.
 */
import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { Stats } from 'node:fs'
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isPathWithin } from '@copse/std/path-containment.ts'
import type {
  ExecutionRuntime,
  RuntimeExecRequest,
  RuntimeExecution,
} from '../services/execution-runtime/runtime.ts'
import {
  addedRemoteNames,
  changedExecutableGitConfigKeys,
  executableGitConfigEntries,
  parseGitConfigList,
  type GitConfigEntry,
} from './git-config-policy.ts'
import { applyRestoreSteps, type RestoreStep } from './workspace-integrity-restore.ts'
import { repositoryPaths } from './worktree-config.ts'

/**
 * Workspace files that configure an agent, a hook, Copse itself, or a shell
 * hook that runs on `cd` in the user's own terminal (direnv, mise), relative
 * to the workspace.
 */
export const GUARDED_AGENT_CONFIG_FILES = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.cursor/mcp.json',
  '.cursor/hooks.json',
  '.cursor/cli.json',
  '.cursor/environment.json',
  '.gemini/settings.json',
  '.qwen/settings.json',
  '.copse/hooks.json',
  '.copse/worktree-preparation.json',
  '.envrc',
  'mise.toml',
  '.mise.toml',
  'mise.local.toml',
  '.mise.local.toml',
  '.config/mise.toml',
  '.config/mise/config.toml',
  '.config/mise/config.local.toml',
  'mise/config.toml',
  '.mise/config.toml',
] as const

/**
 * Workspace directories whose whole contents configure an agent or hook.
 * Instruction-only directories (rules, skills) are left to the agents: they
 * start no program by themselves, and agents are often asked to write them.
 */
export const GUARDED_AGENT_CONFIG_DIRS = [
  '.claude/hooks',
  '.codex',
  '.cursor/hooks',
  '.config/mise/conf.d',
  'mise/conf.d',
  '.mise/conf.d',
] as const

/** Larger files are compared by metadata only and cannot be restored. */
const MAX_RESTORABLE_BYTES = 1024 * 1024
/**
 * Entries listed per guarded directory tree. Every name is listed, so a new
 * file cannot hide behind filler; past this many the tree counts as changed
 * and is rebuilt from the baseline.
 */
const MAX_TREE_ENTRIES = 20_000
/** File bytes read per guarded tree; files past it are compared by metadata. */
const MAX_TREE_BYTES = 16 * 1024 * 1024
/** Submodule nesting followed under `.git/modules`. */
const MAX_MODULE_DEPTH = 4

type Comparator = 'bytes' | 'git-config'

interface Target {
  readonly path: string
  readonly comparator: Comparator
  /** Record the whole tree under a directory. */
  readonly tree: boolean
  /** Ignore these basenames inside the tree (`*.sample` hooks never run). */
  readonly ignoreSamples?: boolean
}

type EntryState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'dir' }
  | { readonly kind: 'symlink'; readonly target: string }
  | {
      readonly kind: 'file'
      readonly signature: string
      readonly mode: number
      readonly bytes: Buffer | null
    }
  | { readonly kind: 'other' }

interface Entry {
  readonly state: EntryState
  readonly comparator: Comparator
  /** A directory a guarded path sits under; only a redirect of it matters. */
  readonly ancestor: boolean
}

interface Snapshot {
  readonly root: string
  readonly targets: readonly Target[]
  readonly entries: ReadonlyMap<string, Entry>
  /** Tree targets with more than {@link MAX_TREE_ENTRIES} entries. */
  readonly overflowed: ReadonlySet<string>
}

/**
 * The write rules a contained command ran under, as ASRT reads them: a plain
 * path covers itself and everything below it, and `*`, `**` and `?` are globs.
 */
export interface WritePolicy {
  readonly allowWrite: readonly string[]
  readonly denyWrite: readonly string[]
}

export type IntegrityChange = 'added' | 'modified' | 'removed' | 'redirected'

export interface IntegrityFinding {
  /** Relative to the workspace when inside it, else absolute. */
  readonly path: string
  readonly change: IntegrityChange
  /** For git config: the keys whose program-starting or remote-URL entries changed. */
  readonly keys?: readonly string[]
  readonly restored: boolean
}

export interface IntegrityReport {
  readonly workspace: string
  readonly findings: readonly IntegrityFinding[]
}

export interface IntegrityOwner {
  readonly projectId: string
  readonly threadId: string
}

export type WorkspaceIntegritySink = (report: IntegrityReport, owner: IntegrityOwner | null) => void

let registeredSink: WorkspaceIntegritySink | null = null

/** Register where reverted changes are reported; until then they are only logged. */
export function setWorkspaceIntegritySink(sink: WorkspaceIntegritySink | null): void {
  registeredSink = sink
}

/** Applies revert steps for one workspace; one result per step. */
export type WorkspaceIntegrityRestorer = (
  root: string,
  steps: readonly RestoreStep[],
) => Promise<boolean[]>

const inProcessRestorer: WorkspaceIntegrityRestorer = (_root, steps) => applyRestoreSteps(steps)
let restorer: WorkspaceIntegrityRestorer = inProcessRestorer

/**
 * Register how reverts are applied. The app registers the sandboxed fs worker,
 * so a revert is confined like the command it undoes; `null` restores the
 * in-process default.
 */
export function setWorkspaceIntegrityRestorer(next: WorkspaceIntegrityRestorer | null): void {
  restorer = next ?? inProcessRestorer
}

// ---------------------------------------------------------------------------
// Write policy

function hasGlob(pattern: string): boolean {
  return /[*?[]/.test(pattern)
}

function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index)
    if (char === '*' && pattern.charAt(index + 1) === '*') {
      index += 1
      if (pattern.charAt(index + 1) === '/') {
        index += 1
        source += '(?:.*/)?'
      } else {
        source += '.*'
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

function policyMatches(pattern: string, path: string): boolean {
  if (!hasGlob(pattern)) return isPathWithin(pattern, path)
  return globToRegExp(pattern).test(path)
}

/** Whether a command under `policy` may write `path`. Without a policy, anything. */
export function isWritableUnder(policy: WritePolicy | null, path: string): boolean {
  if (!policy) return true
  if (!policy.allowWrite.some((pattern) => policyMatches(pattern, path))) return false
  return !policy.denyWrite.some((pattern) => policyMatches(pattern, path))
}

/**
 * Whether the command could have changed `target`. A denied path that is
 * missing still counts on Linux, where bubblewrap can deny only paths that
 * exist (a contained `git init` creates `.git/hooks`).
 */
async function guardable(policy: WritePolicy | null, target: Target): Promise<boolean> {
  if (isWritableUnder(policy, target.path)) return true
  if (!policy || process.platform !== 'linux') return false
  if (!policy.allowWrite.some((pattern) => policyMatches(pattern, target.path))) return false
  return (await lstatOrNull(target.path)) === null
}

// ---------------------------------------------------------------------------
// Reading state

const MISSING: EntryState = { kind: 'missing' }

interface CachedFile {
  readonly signature: string
  readonly bytes: Buffer | null
  gitConfig?: GitConfigEntry[] | null
}

/** File contents by path, reused while the file's metadata is unchanged. */
const fileCache = new Map<string, CachedFile>()

function signatureOf(stats: Stats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs, stats.mode].join(':')
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

async function stateOf(
  path: string,
  stats: Stats | null,
  budget?: { bytes: number },
): Promise<EntryState> {
  if (!stats) return MISSING
  if (stats.isDirectory()) return { kind: 'dir' }
  if (stats.isSymbolicLink()) {
    try {
      return { kind: 'symlink', target: await readlink(path) }
    } catch {
      return { kind: 'other' }
    }
  }
  if (!stats.isFile()) return { kind: 'other' }
  const signature = signatureOf(stats)
  const cached = fileCache.get(path)
  if (cached?.signature === signature) {
    return { kind: 'file', signature, mode: stats.mode & 0o7777, bytes: cached.bytes }
  }
  if (budget && budget.bytes < stats.size) {
    // Over the tree's byte budget: compared by metadata, not cached.
    return { kind: 'file', signature, mode: stats.mode & 0o7777, bytes: null }
  }
  let bytes: Buffer | null = null
  if (stats.size <= MAX_RESTORABLE_BYTES) {
    try {
      bytes = await readFile(path)
      if (budget) budget.bytes -= bytes.length
    } catch {
      bytes = null
    }
  }
  fileCache.set(path, { signature, bytes })
  return { kind: 'file', signature, mode: stats.mode & 0o7777, bytes }
}

const gitEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CEILING_DIRECTORIES: tmpdir(),
  LC_ALL: 'C',
})

/**
 * Parse config bytes with git itself, so a file git reads one way cannot be
 * read another way here. Reading config starts no program. `null` when git
 * rejects the file.
 */
export function parseGitConfigBytes(bytes: Buffer): Promise<GitConfigEntry[] | null> {
  if (bytes.length === 0) return Promise.resolve([])
  return new Promise((resolvePromise) => {
    const child = execFile(
      'git',
      ['config', '--file', '-', '--no-includes', '--null', '--list'],
      { cwd: tmpdir(), env: gitEnv(), timeout: 10_000, maxBuffer: 8 * MAX_RESTORABLE_BYTES },
      (error, stdout) => {
        resolvePromise(error ? null : parseGitConfigList(stdout))
      },
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(bytes)
  })
}

async function gitConfigOf(path: string, state: EntryState): Promise<GitConfigEntry[] | null> {
  if (state.kind === 'missing') return []
  if (state.kind !== 'file' || state.bytes === null) return null
  const cached = fileCache.get(path)
  if (cached?.signature === state.signature && cached.gitConfig !== undefined) {
    return cached.gitConfig
  }
  const entries = await parseGitConfigBytes(state.bytes)
  if (cached?.signature === state.signature) cached.gitConfig = entries
  return entries
}

// ---------------------------------------------------------------------------
// Targets

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

async function isRealDirectory(path: string): Promise<boolean> {
  return (await lstatOrNull(path))?.isDirectory() === true
}

/** Config, hooks and nested submodule administration under one git directory. */
async function gitAdminTargets(adminDir: string, depth: number): Promise<Target[]> {
  const targets: Target[] = [
    { path: join(adminDir, 'config'), comparator: 'git-config', tree: false },
    { path: join(adminDir, 'config.worktree'), comparator: 'git-config', tree: false },
    { path: join(adminDir, 'hooks'), comparator: 'bytes', tree: true, ignoreSamples: true },
  ]
  for (const child of ['worktrees', 'modules']) {
    // Never follow a symlink out of the administration directory.
    if (!(await isRealDirectory(join(adminDir, child)))) continue
    let names: string[]
    try {
      names = await readdir(join(adminDir, child))
    } catch {
      continue
    }
    for (const name of names.sort()) {
      if (!(await isRealDirectory(join(adminDir, child, name)))) continue
      if (child === 'worktrees') {
        targets.push({
          path: join(adminDir, child, name, 'config.worktree'),
          comparator: 'git-config',
          tree: false,
        })
      } else if (depth < MAX_MODULE_DEPTH) {
        targets.push(...(await gitAdminTargets(join(adminDir, child, name), depth + 1)))
      }
    }
  }
  return targets
}

/**
 * Files that configured includes and hook directories add: a contained command
 * can rewrite an included file or a hook inside the workspace without touching
 * `.git/config` itself.
 */
async function derivedGitTargets(
  configPath: string,
  checkout: string,
  root: string,
): Promise<Target[]> {
  const state = await stateOf(configPath, await lstatOrNull(configPath))
  if (state.kind !== 'file' || state.bytes === null) return []
  if (!/include|hookspath/i.test(state.bytes.toString('latin1'))) return []
  const entries = (await gitConfigOf(configPath, state)) ?? []
  const targets: Target[] = []
  for (const entry of entries) {
    if (!entry.value) continue
    const key = entry.key.toLowerCase()
    if (key === 'include.path' || (key.startsWith('includeif.') && key.endsWith('.path'))) {
      const path = resolve(dirname(configPath), expandHome(entry.value))
      if (isPathWithin(root, path)) targets.push({ path, comparator: 'git-config', tree: false })
    } else if (key === 'core.hookspath') {
      const path = resolve(checkout, expandHome(entry.value))
      if (isPathWithin(root, path)) targets.push({ path, comparator: 'bytes', tree: true })
    }
  }
  return targets
}

/** direnv's default file for `dotenv` with no argument. */
const DIRENV_DEFAULT_DOTENV = '.env'

/**
 * Files the workspace `.envrc` loads into the user's shell: `dotenv` and
 * `dotenv_if_exists` export their variables (`GIT_SSH_COMMAND`,
 * `PROMPT_COMMAND`, `LD_PRELOAD` …), and `source_env` and `source_up`-style
 * helpers run them as shell. direnv approves `.envrc` by content, not these.
 */
export function direnvLoadedFiles(envrc: string): string[] {
  const files: string[] = []
  for (const line of envrc.split('\n')) {
    const match =
      /^\s*(dotenv|dotenv_if_exists|source_env|source_env_if_exists)\b\s*([^\s;#&|]*)/.exec(line)
    if (!match) continue
    const argument = (match[2] ?? '').replace(/^["']|["']$/g, '')
    if (argument === '') {
      if (match[1]?.startsWith('dotenv') === true) files.push(DIRENV_DEFAULT_DOTENV)
      continue
    }
    if (!argument.includes('$')) files.push(argument)
  }
  return files
}

async function direnvTargets(root: string): Promise<Target[]> {
  let envrc: string
  try {
    envrc = await readFile(join(root, '.envrc'), 'utf8')
  } catch {
    return []
  }
  return direnvLoadedFiles(envrc)
    .map((file) => resolve(root, expandHome(file)))
    .filter((path) => isPathWithin(root, path, { allowSelf: false }))
    .map((path): Target => ({ path, comparator: 'bytes', tree: false }))
}

/**
 * What to guard in `root`. `derive` adds the include files and hook directory
 * the current git config names; a check passes `false` and reuses the
 * baseline's, so a newly configured `core.hooksPath` cannot make Copse treat
 * an existing tracked directory as new and delete it.
 */
async function guardTargets(
  root: string,
  derive: boolean,
  policy: WritePolicy | null,
): Promise<Target[]> {
  const targets = await candidateTargets(root, derive)
  const kept: Target[] = []
  for (const target of targets) if (await guardable(policy, target)) kept.push(target)
  return kept
}

async function candidateTargets(root: string, derive: boolean): Promise<Target[]> {
  const targets: Target[] = [
    ...GUARDED_AGENT_CONFIG_FILES.map((path): Target => ({
      path: join(root, path),
      comparator: 'bytes',
      tree: false,
    })),
    ...GUARDED_AGENT_CONFIG_DIRS.map((path): Target => ({
      path: join(root, path),
      comparator: 'bytes',
      tree: true,
    })),
    ...(derive ? await direnvTargets(root) : []),
  ]
  const repository = await repositoryPaths(root).catch(() => null)
  if (!repository) {
    // No repository yet: a contained `git init` must not leave one with a
    // program-starting config behind either.
    targets.push(...(await gitAdminTargets(join(root, '.git'), 0)))
    return dedupeTargets(targets)
  }
  const dotGit = join(repository.checkout, '.git')
  if (repository.gitDir !== dotGit && isPathWithin(root, dotGit)) {
    // A linked worktree's pointer file: redirecting it swaps in another config.
    targets.push({ path: dotGit, comparator: 'bytes', tree: false })
  }
  // Canonical, like the sandbox's own write rules, so the policy check sees the
  // path the kernel does.
  const gitDir = await canonicalRoot(repository.gitDir)
  const commonDir = await canonicalRoot(repository.commonDir)
  targets.push(...(await gitAdminTargets(gitDir, 0)))
  if (commonDir !== gitDir) targets.push(...(await gitAdminTargets(commonDir, 0)))
  if (!derive) return dedupeTargets(targets)
  for (const config of [join(commonDir, 'config'), join(gitDir, 'config.worktree')]) {
    targets.push(...(await derivedGitTargets(config, repository.checkout, root)))
  }
  return dedupeTargets(targets)
}

function dedupeTargets(targets: readonly Target[]): Target[] {
  const byPath = new Map<string, Target>()
  for (const target of targets) {
    const existing = byPath.get(target.path)
    if (!existing || (target.tree && !existing.tree)) byPath.set(target.path, target)
  }
  return [...byPath.values()]
}

/** Directories between `anchor` and `path`, exclusive of both. */
function ancestorsBetween(anchor: string, path: string): string[] {
  const rel = relative(anchor, path)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return []
  const parts = rel.split(sep)
  const out: string[] = []
  for (let index = 1; index < parts.length; index += 1) {
    out.push(join(anchor, ...parts.slice(0, index)))
  }
  return out
}

function anchorFor(root: string, path: string): string {
  if (isPathWithin(root, path)) return root
  // Git administration outside the workspace: anchor at the directory that
  // holds `config`, so `modules/<name>` components are still checked.
  const marker = `${sep}modules${sep}`
  const index = path.indexOf(marker)
  return index >= 0 ? path.slice(0, index) : dirname(path)
}

interface TreeBudget {
  entries: number
  bytes: number
  overflowed: boolean
}

async function walkTree(
  dir: string,
  target: Target,
  entries: Map<string, Entry>,
  budget: TreeBudget,
): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names.sort()) {
    if (target.ignoreSamples === true && name.endsWith('.sample')) continue
    if (budget.entries <= 0) {
      budget.overflowed = true
      return
    }
    budget.entries -= 1
    const path = join(dir, name)
    const stats = await lstatOrNull(path)
    entries.set(path, {
      state: await stateOf(path, stats, budget),
      comparator: 'bytes',
      ancestor: false,
    })
    if (stats?.isDirectory()) await walkTree(path, target, entries, budget)
    if (budget.overflowed) return
  }
}

/**
 * Record every guarded path. A baseline derives its targets from the current
 * config; a check takes the baseline's targets plus any new git administration
 * (a new submodule), so what the command configured never widens the check.
 */
async function takeSnapshot(
  root: string,
  policy: WritePolicy | null,
  baselineTargets?: readonly Target[],
): Promise<Snapshot> {
  const targets = dedupeTargets([
    ...(await guardTargets(root, baselineTargets === undefined, policy)),
    ...(baselineTargets ?? []),
  ])
  const entries = new Map<string, Entry>()
  const overflowed = new Set<string>()
  for (const target of targets) {
    for (const ancestor of ancestorsBetween(anchorFor(root, target.path), target.path)) {
      if (entries.has(ancestor)) continue
      entries.set(ancestor, {
        state: await stateOf(ancestor, await lstatOrNull(ancestor)),
        comparator: 'bytes',
        ancestor: true,
      })
    }
    const stats = await lstatOrNull(target.path)
    entries.set(target.path, {
      state: await stateOf(target.path, stats),
      comparator: target.comparator,
      ancestor: false,
    })
    if (target.tree && stats?.isDirectory()) {
      const budget: TreeBudget = {
        entries: MAX_TREE_ENTRIES,
        bytes: MAX_TREE_BYTES,
        overflowed: false,
      }
      await walkTree(target.path, target, entries, budget)
      if (budget.overflowed) overflowed.add(target.path)
    }
  }
  return { root, targets, entries, overflowed }
}

// ---------------------------------------------------------------------------
// Comparing

function sameState(a: EntryState, b: EntryState): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'symlink' && b.kind === 'symlink') return a.target === b.target
  if (a.kind === 'file' && b.kind === 'file') {
    if (a.bytes !== null && b.bytes !== null) return a.mode === b.mode && a.bytes.equals(b.bytes)
    return a.signature === b.signature
  }
  return true
}

interface Change {
  readonly path: string
  readonly before: Entry
  readonly after: Entry
  readonly change: IntegrityChange
  readonly keys?: readonly string[]
  /** An overflowing tree: remove it and recreate the baseline's entries. */
  readonly rebuild?: boolean
}

function changeKind(before: EntryState, after: EntryState): IntegrityChange {
  if (before.kind === 'missing') return 'added'
  if (after.kind === 'missing') return 'removed'
  if (after.kind === 'symlink' || before.kind === 'symlink') return 'redirected'
  return 'modified'
}

async function gitConfigChange(
  path: string,
  before: EntryState,
  after: EntryState,
): Promise<readonly string[] | null> {
  const [a, b] = await Promise.all([gitConfigOf(path, before), gitConfigOf(path, after)])
  // Unreadable or rejected config on either side: treat as a change.
  if (a === null || b === null) return [UNPARSED]
  const added = addedRemoteNames(a, b)
  const left = executableGitConfigEntries(a, added)
  const right = executableGitConfigEntries(b, added)
  if (JSON.stringify(left) === JSON.stringify(right)) return null
  return changedExecutableGitConfigKeys(a, b)
}

const UNPARSED = '(unparsed)'

function isStrictlyWithin(parent: string, path: string): boolean {
  return isPathWithin(parent, path, { allowSelf: false })
}

async function diffSnapshots(baseline: Snapshot, current: Snapshot): Promise<Change[]> {
  const rebuilt = [...new Set([...baseline.overflowed, ...current.overflowed])]
  const paths = new Set([...baseline.entries.keys(), ...current.entries.keys()])
  const changes: Change[] = []
  for (const path of rebuilt) {
    const before = baseline.entries.get(path)
    const after = current.entries.get(path)
    const template = before ?? after
    if (!template) continue
    changes.push({
      path,
      before: before ?? { ...template, state: MISSING },
      after: after ?? { ...template, state: MISSING },
      change: 'modified',
      rebuild: true,
    })
  }
  for (const path of paths) {
    if (rebuilt.some((tree) => isPathWithin(tree, path))) continue
    const beforeEntry = baseline.entries.get(path)
    const afterEntry = current.entries.get(path)
    const template = beforeEntry ?? afterEntry
    if (!template) continue
    const before: Entry = beforeEntry ?? { ...template, state: MISSING }
    const after: Entry = afterEntry ?? { ...template, state: MISSING }
    if (sameState(before.state, after.state)) continue
    if (before.ancestor || after.ancestor) {
      // A directory appearing or disappearing only matters through the
      // guarded paths under it; a redirect replaces what they resolve to.
      const kinds = new Set([before.state.kind, after.state.kind])
      if ([...kinds].every((kind) => kind === 'dir' || kind === 'missing')) continue
      changes.push({ path, before, after, change: 'redirected' })
      continue
    }
    if (
      template.comparator === 'git-config' &&
      (before.state.kind === 'file' || before.state.kind === 'missing') &&
      (after.state.kind === 'file' || after.state.kind === 'missing')
    ) {
      const keys = await gitConfigChange(path, before.state, after.state)
      if (keys === null) continue
      changes.push({ path, before, after, change: changeKind(before.state, after.state), keys })
      continue
    }
    changes.push({ path, before, after, change: changeKind(before.state, after.state) })
  }
  // A guarded directory that appeared empty (or with only `*.sample` hooks, as
  // `git init` leaves them) configures nothing.
  const trees = new Set(current.targets.filter((target) => target.tree).map((t) => t.path))
  return changes.filter(
    (change) =>
      !(
        trees.has(change.path) &&
        change.rebuild !== true &&
        change.before.state.kind === 'missing' &&
        change.after.state.kind === 'dir' &&
        !changes.some((other) => isStrictlyWithin(change.path, other.path))
      ),
  )
}

// ---------------------------------------------------------------------------
// Restoring

function runGit(args: readonly string[]): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile('git', [...args], { cwd: tmpdir(), env: gitEnv(), timeout: 10_000 }, (error) => {
      // `--unset-all` of a key that is not there exits 5: nothing to undo.
      resolvePromise(error === null || (typeof error.code === 'number' && error.code === 5))
    })
  })
}

/**
 * The current config with only the changed program-starting keys put back as
 * the baseline had them, so whatever else was written alongside (by the
 * command or by the user) stays. Edited by git itself in a private temp file.
 * `null` when it cannot be done, and the whole baseline file is restored.
 */
async function revertGitConfigKeys(
  before: readonly GitConfigEntry[],
  currentBytes: Buffer,
  keys: readonly string[],
): Promise<Buffer | null> {
  if (keys.includes(UNPARSED)) return null
  const dir = await mkdtemp(join(tmpdir(), 'copse-integrity-'))
  try {
    const file = join(dir, 'config')
    await writeFile(file, currentBytes, { mode: 0o600 })
    for (const key of keys) {
      if (!(await runGit(['config', '--file', file, '--unset-all', key]))) return null
      for (const entry of before) {
        if (entry.key !== key) continue
        if (!(await runGit(['config', '--file', file, '--add', key, entry.value ?? 'true']))) {
          return null
        }
      }
    }
    const bytes = await readFile(file)
    // Only trust the edit when git now reads the same programs as before.
    const after = await parseGitConfigBytes(bytes)
    if (after === null) return null
    const added = addedRemoteNames(before, after)
    const same =
      JSON.stringify(executableGitConfigEntries(before, added)) ===
      JSON.stringify(executableGitConfigEntries(after, added))
    return same ? bytes : null
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The step that puts `path` back to `state`; `null` when it cannot be. */
function stepFor(anchor: string, path: string, state: EntryState): RestoreStep | null {
  switch (state.kind) {
    case 'missing':
      return { op: 'remove', anchor, path }
    case 'dir':
      return { op: 'mkdir', anchor, path }
    case 'symlink':
      return { op: 'symlink', anchor, path, target: state.target }
    case 'file':
      return state.bytes === null
        ? null
        : { op: 'write', anchor, path, data: state.bytes.toString('base64'), mode: state.mode }
    case 'other':
      return null
  }
}

function depth(path: string): number {
  return path.split(sep).length
}

/** The `.git` administration directory itself was replaced: never fabricate one. */
function isRepositoryMarker(path: string): boolean {
  return basename(path) === '.git'
}

interface PlannedStep {
  readonly step: RestoreStep
  /** The changes this step's success counts toward. */
  readonly change: string
}

async function stepsForLeaf(
  root: string,
  change: Change,
  baseline: Snapshot,
): Promise<PlannedStep[] | null> {
  const anchor = anchorFor(root, change.path)
  if (change.rebuild === true) {
    // Remove the tree, then recreate what the baseline recorded, shallowest first.
    if (baseline.overflowed.has(change.path)) return null
    const steps: PlannedStep[] = [
      { step: { op: 'remove', anchor, path: change.path }, change: change.path },
    ]
    const recorded = [...baseline.entries.entries()]
      .filter(([path]) => isPathWithin(change.path, path))
      .sort(([a], [b]) => depth(a) - depth(b))
    for (const [path, entry] of recorded) {
      if (entry.state.kind === 'missing') continue
      const step = stepFor(anchor, path, entry.state)
      if (!step) return null
      steps.push({ step, change: change.path })
    }
    return steps
  }
  const { before, after } = change
  if (
    change.keys &&
    before.state.kind === 'file' &&
    after.state.kind === 'file' &&
    before.state.bytes !== null &&
    after.state.bytes !== null
  ) {
    const entries = await gitConfigOf(change.path, before.state)
    const merged = entries
      ? await revertGitConfigKeys(entries, after.state.bytes, change.keys)
      : null
    if (merged) {
      return [
        {
          step: {
            op: 'write',
            anchor,
            path: change.path,
            data: merged.toString('base64'),
            mode: after.state.mode,
          },
          change: change.path,
        },
      ]
    }
  }
  const step = stepFor(anchor, change.path, before.state)
  return step ? [{ step, change: change.path }] : null
}

async function restoreChanges(
  root: string,
  changes: readonly Change[],
  baseline: Snapshot,
): Promise<Map<string, boolean>> {
  const restored = new Map<string, boolean>()
  const planned: PlannedStep[] = []
  const abandoned: string[] = []
  const ordered = [...changes].sort((a, b) => depth(a.path) - depth(b.path))
  // Ancestors first, so later steps never act through a planted symlink.
  for (const change of ordered.filter((item) => item.before.ancestor || item.after.ancestor)) {
    const anchor = anchorFor(root, change.path)
    if (isRepositoryMarker(change.path) && change.before.state.kind === 'dir') {
      // Remove the replacement (a gitdir pointer to another config) but do
      // not invent an empty `.git`: git would then search parent directories.
      planned.push({ step: { op: 'remove', anchor, path: change.path }, change: change.path })
      abandoned.push(change.path)
      restored.set(change.path, false)
      continue
    }
    const step = stepFor(anchor, change.path, change.before.state)
    if (step) planned.push({ step, change: change.path })
    else restored.set(change.path, false)
  }
  const leaves = ordered.filter((item) => !item.before.ancestor && !item.after.ancestor)
  // Removals deepest first, then restores shallowest first.
  const removals = leaves
    .filter((item) => item.before.state.kind === 'missing' && item.rebuild !== true)
    .sort((a, b) => depth(b.path) - depth(a.path))
  const restores = leaves.filter(
    (item) => item.before.state.kind !== 'missing' || item.rebuild === true,
  )
  for (const change of [...removals, ...restores]) {
    if (abandoned.some((dir) => isStrictlyWithin(dir, change.path))) {
      restored.set(change.path, false)
      continue
    }
    const steps = await stepsForLeaf(root, change, baseline)
    if (steps) planned.push(...steps)
    else restored.set(change.path, false)
  }
  const results = await restorer(
    root,
    planned.map((item) => item.step),
  ).catch(() => planned.map(() => false))
  planned.forEach((item, index) => {
    const ok = results[index] === true
    restored.set(item.change, (restored.get(item.change) ?? true) && ok)
  })
  // A change none of whose steps ran (an unrestorable state) is already false.
  return restored
}

function displayPath(root: string, path: string): string {
  return isPathWithin(root, path) ? relative(root, path) || '.' : path
}

/** Collapse a tree's per-entry changes into the guarded path they belong to. */
function findingsFor(
  snapshot: Snapshot,
  changes: readonly Change[],
  restored: ReadonlyMap<string, boolean>,
): IntegrityFinding[] {
  const groups = new Map<string, { change: IntegrityChange; keys: string[]; restored: boolean }>()
  for (const change of changes) {
    const owner =
      snapshot.targets.find((target) => target.tree && isStrictlyWithin(target.path, change.path))
        ?.path ?? change.path
    const group = groups.get(owner)
    const ok = restored.get(change.path) === true
    if (!group) {
      groups.set(owner, {
        change: owner === change.path ? change.change : 'modified',
        keys: [...(change.keys ?? [])],
        restored: ok,
      })
    } else {
      // The guarded path's own change names the finding; its contents only add detail.
      if (owner === change.path) group.change = change.change
      group.keys.push(...(change.keys ?? []))
      group.restored = group.restored && ok
    }
  }
  return [...groups.entries()]
    .map(([path, group]) => ({
      path: displayPath(snapshot.root, path),
      change: group.change,
      ...(group.keys.length > 0 ? { keys: [...new Set(group.keys)].sort() } : {}),
      restored: group.restored,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

// ---------------------------------------------------------------------------
// Guards

interface Guard {
  baseline: Snapshot
  readonly policy: WritePolicy | null
  leases: number
  /** Findings the last check could not revert; the guard lives until they are gone. */
  unresolved: readonly IntegrityFinding[]
}

const guards = new Map<string, Guard>()
const queues = new Map<string, Promise<unknown>>()

function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(operation, operation)
  const settled = next.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, settled)
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
  return next
}

async function canonicalRoot(cwd: string): Promise<string> {
  try {
    return await realpath(cwd)
  } catch {
    return resolve(cwd)
  }
}

/**
 * The next baseline: the workspace as it is now, except that every change
 * that was not reverted keeps its old baseline state, so the next check finds
 * it again instead of accepting it.
 */
function keepUnrestored(
  fresh: Snapshot,
  baseline: Snapshot,
  unrestored: readonly string[],
): Snapshot {
  if (unrestored.length === 0) return fresh
  const entries = new Map(fresh.entries)
  for (const path of unrestored) {
    for (const key of [...entries.keys()]) {
      if (isPathWithin(path, key) && !baseline.entries.has(key)) entries.delete(key)
    }
    for (const [key, entry] of baseline.entries) {
      if (isPathWithin(path, key)) entries.set(key, entry)
    }
  }
  const overflowed = new Set(
    [...fresh.overflowed].filter((tree) => !unrestored.some((path) => isPathWithin(path, tree))),
  )
  for (const tree of baseline.overflowed) overflowed.add(tree)
  return { ...fresh, entries, overflowed }
}

/** Compare against the baseline, revert what must not stay, and take a new baseline. */
async function checkGuard(root: string, guard: Guard): Promise<IntegrityReport> {
  const current = await takeSnapshot(root, guard.policy, guard.baseline.targets)
  const changes = await diffSnapshots(guard.baseline, current)
  if (changes.length === 0) {
    guard.baseline = current
    guard.unresolved = []
    return { workspace: root, findings: [] }
  }
  const restored = await restoreChanges(root, changes, guard.baseline)
  const findings = findingsFor(guard.baseline, changes, restored)
  const unrestored = changes
    .filter((change) => restored.get(change.path) !== true)
    .map((change) => change.path)
  // While something is unresolved, keep the baseline's targets: a config that
  // could not be reverted must not decide what is guarded.
  const fresh =
    unrestored.length === 0
      ? await takeSnapshot(root, guard.policy)
      : await takeSnapshot(root, guard.policy, guard.baseline.targets)
  guard.baseline = keepUnrestored(fresh, guard.baseline, unrestored)
  guard.unresolved = findings.filter((finding) => !finding.restored)
  return { workspace: root, findings }
}

function report(result: IntegrityReport, owner: IntegrityOwner | null): void {
  if (result.findings.length === 0) return
  console.warn('[workspace-integrity] reverted contained changes', {
    workspace: result.workspace,
    findings: result.findings,
  })
  try {
    registeredSink?.(result, owner)
  } catch {
    // Reporting never fails the command it describes.
  }
}

function releaseLease(root: string, guard: Guard): void {
  guard.leases -= 1
  if (guard.leases <= 0 && guard.unresolved.length === 0 && guards.get(root) === guard) {
    guards.delete(root)
  }
}

export interface IntegrityLease {
  /** Check the workspace now that the command has ended. Idempotent. */
  readonly end: () => Promise<IntegrityReport>
}

/**
 * Start guarding `cwd` for one contained command. `policy` is the write policy
 * the command runs under; only paths it allows are guarded.
 */
export async function beginContainedRun(
  cwd: string,
  owner: IntegrityOwner | null,
  policy: WritePolicy | null = null,
): Promise<IntegrityLease> {
  const root = await canonicalRoot(cwd)
  await serialized(root, async () => {
    const existing = guards.get(root)
    if (existing) {
      existing.leases += 1
      return
    }
    guards.set(root, {
      baseline: await takeSnapshot(root, policy),
      policy,
      leases: 1,
      unresolved: [],
    })
  })
  let ended: Promise<IntegrityReport> | null = null
  return {
    end: (): Promise<IntegrityReport> => {
      ended ??= serialized(root, async () => {
        const guard = guards.get(root)
        if (!guard) return { workspace: root, findings: [] }
        try {
          return await checkGuard(root, guard)
        } finally {
          releaseLease(root, guard)
        }
      }).then(
        (result) => {
          report(result, owner)
          return result
        },
        (error: unknown) => {
          console.warn('[workspace-integrity] check failed', { workspace: root, error })
          return { workspace: root, findings: [] }
        },
      )
      return ended
    },
  }
}

/**
 * Check every workspace that still has a contained command running, or a
 * change that could not be reverted. Called before an unsandboxed launch,
 * which could otherwise run a program a still-running contained task just
 * configured.
 */
export async function checkRunningContainedWorkspaces(
  owner: IntegrityOwner | null,
): Promise<IntegrityReport[]> {
  const results: IntegrityReport[] = []
  for (const root of [...guards.keys()]) {
    try {
      const result = await serialized(root, async () => {
        const guard = guards.get(root)
        if (!guard) return { workspace: root, findings: [] }
        const checked = await checkGuard(root, guard)
        if (guard.leases <= 0 && guard.unresolved.length === 0) guards.delete(root)
        return checked
      })
      report(result, owner)
      results.push(result)
    } catch (error) {
      console.warn('[workspace-integrity] check failed', { workspace: root, error })
    }
  }
  return results
}

/** One line per finding, for the command's result and the audit trail. */
export function describeIntegrityFindings(findings: readonly IntegrityFinding[]): string[] {
  return findings.map((finding) => {
    const keys = finding.keys && finding.keys.length > 0 ? ` (${finding.keys.join(', ')})` : ''
    const outcome = finding.restored ? 'reverted' : 'could not be reverted'
    return `${finding.path}: ${finding.change}${keys}, ${outcome}`
  })
}

/** The note appended to a contained command's output when something was reverted. */
export function integrityNoteForCommand(result: IntegrityReport | null): string {
  if (!result || result.findings.length === 0) return ''
  const unresolved = result.findings.some((finding) => !finding.restored)
  return [
    '',
    '[Copse] This sandboxed command changed files that configure programs run outside the sandbox. Copse undid those changes:',
    ...describeIntegrityFindings(result.findings).map((line) => `- ${line}`),
    ...(unresolved
      ? [
          'Copse will not run commands outside the sandbox in this workspace until the changes it could not revert are undone. Tell the user which files are affected.',
        ]
      : []),
    'If this change is intended, ask the user to make it or to approve running the command outside the sandbox.',
  ].join('\n')
}

/** Thrown instead of an unsandboxed launch in a workspace with an unreverted change. */
export class UnresolvedWorkspaceIntegrityError extends Error {
  readonly report: IntegrityReport

  constructor(result: IntegrityReport) {
    const lines = describeIntegrityFindings(result.findings.filter((finding) => !finding.restored))
    super(
      [
        `Copse did not run this command outside the sandbox: a sandboxed command in ${result.workspace} changed configuration that runs outside the sandbox, and Copse could not undo it:`,
        ...lines.map((line) => `- ${line}`),
        'Undo or review these changes, then try again.',
      ].join('\n'),
    )
    this.name = 'UnresolvedWorkspaceIntegrityError'
    this.report = result
  }
}

function overlaps(a: string, b: string): boolean {
  return isPathWithin(a, b) || isPathWithin(b, a)
}

// ---------------------------------------------------------------------------
// Runtime wrapper

const outcomes = new WeakMap<ChildProcess, Promise<IntegrityReport>>()

/** The integrity check of a contained child, settled after it closes. */
export function workspaceIntegrityOutcome(child: ChildProcess): Promise<IntegrityReport> | null {
  return outcomes.get(child) ?? null
}

export interface WorkspaceIntegrityDependencies {
  /** Whether this request will run inside the OS sandbox. */
  readonly isContained: (request: RuntimeExecRequest) => boolean
  readonly owner: () => IntegrityOwner | null
  /** The write policy a contained request runs under; `null` guards everything. */
  readonly writePolicy?: (request: RuntimeExecRequest) => WritePolicy | null
}

/** Wrap the local runtime so every contained execution is snapshot and checked. */
export function withWorkspaceIntegrity(
  runtime: ExecutionRuntime,
  dependencies: WorkspaceIntegrityDependencies,
): ExecutionRuntime {
  return {
    kind: runtime.kind,
    capabilities: (request) => runtime.capabilities(request),
    stop: () => runtime.stop(),
    exec: async (request): Promise<RuntimeExecution> => {
      const owner = dependencies.owner()
      if (!dependencies.isContained(request)) {
        const reports = await checkRunningContainedWorkspaces(owner)
        const cwd = await canonicalRoot(request.cwd)
        const blocking = reports.find(
          (result) =>
            result.findings.some((finding) => !finding.restored) && overlaps(result.workspace, cwd),
        )
        if (blocking) throw new UnresolvedWorkspaceIntegrityError(blocking)
        return runtime.exec(request)
      }
      const lease = await beginContainedRun(
        request.cwd,
        owner,
        dependencies.writePolicy?.(request) ?? null,
      )
      let execution: RuntimeExecution
      try {
        execution = await runtime.exec(request)
      } catch (error) {
        await lease.end()
        throw error
      }
      const { child } = execution
      outcomes.set(
        child,
        new Promise((resolveOutcome) => {
          child.once('close', () => {
            resolveOutcome(lease.end())
          })
          child.once('error', () => {
            // An error without a pid means the process never started.
            if (child.pid === undefined) resolveOutcome(lease.end())
          })
        }),
      )
      return execution
    },
  }
}

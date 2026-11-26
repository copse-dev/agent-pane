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
 * starts and compares them when it ends. A change to an agent or hook file is
 * reverted. A git config change is reverted only when it adds, changes or
 * removes an entry that can start a program or repoint a remote (`git-config-policy.ts`), so
 * upstream tracking, `git remote add` and `git lfs install` keep working. Each
 * revert is reported to the registered sink (the decision log) and to the
 * command's own result.
 *
 * Overlapping contained commands in one workspace share one baseline, and an
 * unsandboxed launch first checks every workspace that still has a contained
 * command running, so a long-lived background task cannot leave a change in
 * place for an approved host command to pick up.
 */
import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { Stats } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
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
] as const

/**
 * Workspace directories whose whole contents configure an agent or hook.
 * Instruction-only directories (rules, skills) are left to the agents: they
 * start no program by themselves, and agents are often asked to write them.
 */
export const GUARDED_AGENT_CONFIG_DIRS = ['.claude/hooks', '.codex', '.cursor/hooks'] as const

/** Larger files are compared by metadata only and cannot be restored. */
const MAX_RESTORABLE_BYTES = 1024 * 1024
/** Entries recorded per guarded directory tree. */
const MAX_TREE_ENTRIES = 2000
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

async function stateOf(path: string, stats: Stats | null): Promise<EntryState> {
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
  let bytes: Buffer | null = null
  if (stats.size <= MAX_RESTORABLE_BYTES) {
    try {
      bytes = await readFile(path)
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

/** Config, hooks and nested submodule administration under one git directory. */
async function gitAdminTargets(adminDir: string, depth: number): Promise<Target[]> {
  const targets: Target[] = [
    { path: join(adminDir, 'config'), comparator: 'git-config', tree: false },
    { path: join(adminDir, 'config.worktree'), comparator: 'git-config', tree: false },
    { path: join(adminDir, 'hooks'), comparator: 'bytes', tree: true, ignoreSamples: true },
  ]
  for (const child of ['worktrees', 'modules']) {
    let names: string[]
    try {
      names = await readdir(join(adminDir, child))
    } catch {
      continue
    }
    for (const name of names.sort()) {
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
async function guardTargets(root: string, derive: boolean): Promise<Target[]> {
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
  targets.push(...(await gitAdminTargets(repository.gitDir, 0)))
  if (repository.commonDir !== repository.gitDir) {
    targets.push(...(await gitAdminTargets(repository.commonDir, 0)))
  }
  if (!derive) return dedupeTargets(targets)
  for (const config of [
    join(repository.commonDir, 'config'),
    join(repository.gitDir, 'config.worktree'),
  ]) {
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

async function walkTree(
  dir: string,
  target: Target,
  entries: Map<string, Entry>,
  budget: { remaining: number },
): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names.sort()) {
    if (budget.remaining <= 0) return
    if (target.ignoreSamples === true && name.endsWith('.sample')) continue
    const path = join(dir, name)
    const stats = await lstatOrNull(path)
    budget.remaining -= 1
    entries.set(path, { state: await stateOf(path, stats), comparator: 'bytes', ancestor: false })
    if (stats?.isDirectory()) await walkTree(path, target, entries, budget)
  }
}

/**
 * Record every guarded path. A baseline derives its targets from the current
 * config; a check takes the baseline's targets plus any new git administration
 * (a new submodule), so what the command configured never widens the check.
 */
async function takeSnapshot(root: string, baselineTargets?: readonly Target[]): Promise<Snapshot> {
  const targets = dedupeTargets([
    ...(await guardTargets(root, baselineTargets === undefined)),
    ...(baselineTargets ?? []),
  ])
  const entries = new Map<string, Entry>()
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
      await walkTree(target.path, target, entries, { remaining: MAX_TREE_ENTRIES })
    }
  }
  return { root, targets, entries }
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
  if (a === null || b === null) return ['(unparsed)']
  const added = addedRemoteNames(a, b)
  const left = executableGitConfigEntries(a, added)
  const right = executableGitConfigEntries(b, added)
  if (JSON.stringify(left) === JSON.stringify(right)) return null
  return changedExecutableGitConfigKeys(a, b)
}

async function diffSnapshots(baseline: Snapshot, current: Snapshot): Promise<Change[]> {
  const paths = new Set([...baseline.entries.keys(), ...current.entries.keys()])
  const changes: Change[] = []
  for (const path of paths) {
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
  return changes
}

// ---------------------------------------------------------------------------
// Restoring

async function writeAtomically(path: string, bytes: Buffer, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.copse-restore-${String(process.pid)}`)
  await rm(temp, { force: true, recursive: true })
  await writeFile(temp, bytes, { mode })
  await chmod(temp, mode)
  const existing = await lstatOrNull(path)
  if (existing?.isDirectory()) await rm(path, { recursive: true, force: true })
  // rename replaces a symlink itself, never the file it points at.
  await rename(temp, path)
}

async function restoreState(path: string, state: EntryState): Promise<boolean> {
  switch (state.kind) {
    case 'missing':
      await rm(path, { recursive: true, force: true })
      return true
    case 'dir': {
      const existing = await lstatOrNull(path)
      if (existing?.isDirectory()) return true
      if (existing) await rm(path, { recursive: true, force: true })
      await mkdir(path, { recursive: true })
      return true
    }
    case 'symlink':
      await rm(path, { recursive: true, force: true })
      await mkdir(dirname(path), { recursive: true })
      await symlink(state.target, path)
      return true
    case 'file':
      if (state.bytes === null) return false
      await writeAtomically(path, state.bytes, state.mode)
      return true
    case 'other':
      return false
  }
}

function depth(path: string): number {
  return path.split(sep).length
}

/** The `.git` administration directory itself was replaced: never fabricate one. */
function isRepositoryMarker(path: string): boolean {
  return basename(path) === '.git'
}

async function restoreChanges(changes: readonly Change[]): Promise<Map<string, boolean>> {
  const restored = new Map<string, boolean>()
  const abandoned: string[] = []
  const ordered = [...changes].sort((a, b) => depth(a.path) - depth(b.path))
  // Ancestors first, so later writes cannot follow a planted symlink.
  for (const change of ordered.filter((item) => item.before.ancestor || item.after.ancestor)) {
    try {
      if (isRepositoryMarker(change.path) && change.before.state.kind === 'dir') {
        // Remove the replacement (a gitdir pointer to another config) but do
        // not invent an empty `.git`: git would then search parent directories.
        await rm(change.path, { recursive: true, force: true })
        abandoned.push(change.path)
        restored.set(change.path, false)
        continue
      }
      restored.set(change.path, await restoreState(change.path, change.before.state))
    } catch {
      restored.set(change.path, false)
    }
  }
  const leaves = ordered.filter((item) => !item.before.ancestor && !item.after.ancestor)
  // Removals deepest first, then restores shallowest first.
  const removals = leaves
    .filter((item) => item.before.state.kind === 'missing')
    .sort((a, b) => depth(b.path) - depth(a.path))
  const restores = leaves.filter((item) => item.before.state.kind !== 'missing')
  for (const change of [...removals, ...restores]) {
    if (abandoned.some((dir) => isPathWithin(dir, change.path, { allowSelf: false }))) {
      restored.set(change.path, false)
      continue
    }
    try {
      restored.set(change.path, await restoreState(change.path, change.before.state))
    } catch {
      restored.set(change.path, false)
    }
  }
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
      snapshot.targets.find(
        (target) => target.tree && isPathWithin(target.path, change.path, { allowSelf: false }),
      )?.path ?? change.path
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
  leases: number
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

/** Compare against the baseline, revert what must not stay, and take a new baseline. */
async function checkGuard(root: string, guard: Guard): Promise<IntegrityReport> {
  const current = await takeSnapshot(root, guard.baseline.targets)
  const changes = await diffSnapshots(guard.baseline, current)
  if (changes.length === 0) {
    guard.baseline = current
    return { workspace: root, findings: [] }
  }
  const restored = await restoreChanges(changes)
  const findings = findingsFor(guard.baseline, changes, restored)
  guard.baseline = await takeSnapshot(root)
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

export interface IntegrityLease {
  /** Check the workspace now that the command has ended. Idempotent. */
  readonly end: () => Promise<IntegrityReport>
}

/** Start guarding `cwd` for one contained command. */
export async function beginContainedRun(
  cwd: string,
  owner: IntegrityOwner | null,
): Promise<IntegrityLease> {
  const root = await canonicalRoot(cwd)
  await serialized(root, async () => {
    const existing = guards.get(root)
    if (existing) {
      existing.leases += 1
      return
    }
    guards.set(root, { baseline: await takeSnapshot(root), leases: 1 })
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
          guard.leases -= 1
          if (guard.leases <= 0) guards.delete(root)
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
 * Check every workspace that still has a contained command running. Called
 * before an unsandboxed launch, which could otherwise run a program a
 * still-running contained task just configured.
 */
export async function checkRunningContainedWorkspaces(
  owner: IntegrityOwner | null,
): Promise<IntegrityReport[]> {
  const results: IntegrityReport[] = []
  for (const root of [...guards.keys()]) {
    try {
      const result = await serialized(root, async () => {
        const guard = guards.get(root)
        return guard ? checkGuard(root, guard) : { workspace: root, findings: [] }
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
    const outcome = finding.restored ? 'reverted' : 'could not be fully reverted'
    return `${finding.path}: ${finding.change}${keys}, ${outcome}`
  })
}

/** The note appended to a contained command's output when something was reverted. */
export function integrityNoteForCommand(result: IntegrityReport | null): string {
  if (!result || result.findings.length === 0) return ''
  return [
    '',
    '[Copse] This sandboxed command changed files that configure programs run outside the sandbox. Copse undid those changes:',
    ...describeIntegrityFindings(result.findings).map((line) => `- ${line}`),
    'If this change is intended, ask the user to make it or to approve running the command outside the sandbox.',
  ].join('\n')
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
        await checkRunningContainedWorkspaces(owner)
        return runtime.exec(request)
      }
      const lease = await beginContainedRun(request.cwd, owner)
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

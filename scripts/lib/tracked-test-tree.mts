import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'

type TrackedFile = { index: string; worktree: string }
export type TrackedTestTree = Map<string, TrackedFile>

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0)
    throw new Error(
      `[run-tests] cannot inspect tracked files: ${result.stderr || (result.error?.message ?? 'Git did not complete')}`,
    )
  return result.stdout
}

/** Git's stage listing omits intent-to-add, including for empty blobs. */
function intentToAddPaths(root: string): Set<string> {
  function cachedDiff(visibility: string): Map<string, string> {
    const fields = git(root, [
      'diff',
      '--cached',
      '--raw',
      '--no-abbrev',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--no-relative',
      '-z',
      visibility,
    ]).split('\0')
    const records = new Map<string, string>()
    for (let offset = 0; offset < fields.length - 1; offset += 2) {
      const record = fields[offset]
      const path = fields[offset + 1]
      if (!record?.startsWith(':') || !path)
        throw new Error('[run-tests] malformed Git cached diff entry')
      records.set(path, record)
    }
    return records
  }
  // Only intent-to-add entries differ between these views. Compare raw records,
  // since a nonempty committed path appears in both views with different state.
  const visible = cachedDiff('--ita-visible-in-index')
  const invisible = cachedDiff('--ita-invisible-in-index')
  return new Set(
    [...new Set([...visible.keys(), ...invisible.keys()])].filter(
      (path) => visible.get(path) !== invisible.get(path),
    ),
  )
}

async function worktreeContent(root: string, path: string, gitlink: boolean): Promise<string> {
  try {
    const file = join(root, path)
    const details = await lstat(file)
    if (details.isSymbolicLink()) return `symlink:${await readlink(file)}`
    if (details.isDirectory()) {
      if (!gitlink) return 'directory'
      const nestedRoot = git(file, ['rev-parse', '--show-toplevel']).trim()
      if ((await realpath(nestedRoot)) !== (await realpath(file))) return 'uninitialized-gitlink'
      // Gitlinks are nested checkouts: cover their tracked content as well as HEAD.
      const tree = await captureTrackedTestTree(file)
      return JSON.stringify([git(file, ['rev-parse', 'HEAD']), [...tree]])
    }
    if (!details.isFile()) return `special:${String(details.mode & 0o170000)}`
    const hash = createHash('sha256')
      .update(await readFile(file))
      .digest('hex')
    return `file:${String(details.mode & 0o111)}:${hash}`
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'missing'
    throw error
  }
}

/** Capture content, not just dirty paths: pre-existing edits must stay unchanged. */
export async function captureTrackedTestTree(root: string): Promise<TrackedTestTree> {
  const indexed = new Map<string, string[]>()
  // The -v tag includes skip-worktree and assume-unchanged state (lowercase).
  // These bits can hide later changes from Git, even when stage/blob stay equal.
  for (const entry of git(root, ['ls-files', '--stage', '-v', '-z']).split('\0')) {
    if (!entry) continue
    const separator = entry.indexOf('\t')
    if (separator < 0) throw new Error('[run-tests] malformed Git index entry')
    const path = entry.slice(separator + 1)
    const stages = indexed.get(path) ?? []
    stages.push(entry.slice(0, separator))
    indexed.set(path, stages)
  }
  const intent = intentToAddPaths(root)
  const snapshot: TrackedTestTree = new Map()
  const entries = [...indexed]
  // Bound reads while retaining deterministic Git index order. Serial reads
  // add filesystem round trips for every source file, even in tiny subsets.
  for (let offset = 0; offset < entries.length; offset += 16) {
    const batch = entries.slice(offset, offset + 16)
    const contents = await Promise.all(
      batch.map(([path, stages]) =>
        worktreeContent(
          root,
          path,
          stages.some((stage) => stage.slice(2).startsWith('160000 ')),
        ),
      ),
    )
    for (const [index, [path, stages]] of batch.entries()) {
      const worktree = contents[index]
      if (worktree === undefined) throw new Error('[run-tests] incomplete tracked-file capture')
      snapshot.set(path, {
        index: `${stages.join('\n')}${intent.has(path) ? '\nintent-to-add' : ''}`,
        worktree,
      })
    }
  }
  return snapshot
}

/** Existing opt-in update commands may rewrite only their named golden file. */
export function intentionalTestUpdates(env: NodeJS.ProcessEnv): Set<string> {
  const paths = new Set<string>()
  if (env['UPDATE_GATE_REPLAY'] === '1')
    paths.add('benchmarks/escalation-review/testset/gate-replay.jsonl')
  if (env['UPDATE_HOOK_PAYLOAD_SNAPSHOTS'] === '1')
    paths.add('src/main/services/hooks/__snapshots__/wire-payloads.json')
  return paths
}

export function changedTrackedTestFiles(
  before: TrackedTestTree,
  after: TrackedTestTree,
  intentionalUpdates: ReadonlySet<string> = new Set(),
): string[] {
  const changed: string[] = []
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(path)
    const current = after.get(path)
    if (old?.index !== current?.index) changed.push(`${JSON.stringify(path)} (index)`)
    else if (old?.worktree !== current?.worktree) {
      const updateAllowed =
        intentionalUpdates.has(path) &&
        old?.worktree.startsWith('file:') &&
        current?.worktree.startsWith('file:') &&
        old.worktree.split(':')[1] === current.worktree.split(':')[1]
      if (!updateAllowed) changed.push(`${JSON.stringify(path)} (worktree)`)
    }
  }
  return changed.sort()
}

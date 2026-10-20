import { randomUUID } from 'node:crypto'
import type { CommandResult } from './exec/command-runner.ts'
import {
  fetchFromOriginOnHost,
  originBranchRef,
  type ProjectGit,
  type ScratchFetchRef,
} from './default-branch-fetch.ts'

/**
 * `git_fetch`: refresh remote-tracking refs from the project's `origin`.
 *
 * The agent names branches (or `refs/pull/<n>/head`), never a remote, URL,
 * refspec or option. Copse maps each name to a fixed destination under
 * `refs/remotes/origin/`, then reuses the background default-branch fetch
 * (default-branch-fetch.ts): the network step runs on the host in a scratch
 * repository that never reads the project's `.git/config`, and a sandboxed
 * local fetch copies the tips into the project. Local branches, HEAD, the
 * index and the working tree are never touched.
 */

export const GIT_FETCH_MAX_REFS = 20

const PULL_REF = /^refs\/pull\/([1-9]\d{0,9})\/head$/

/**
 * A branch name `git check-ref-format --branch` would accept, minus anything
 * that could read as a ref path, option, URL or revision expression.
 */
export function isFetchableBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false
  if (name === 'HEAD' || name === '@' || name.startsWith('refs/')) return false
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.'))
    return false
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false
  for (const char of name) {
    const code = char.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(char)) return false
  }
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
}

/** Map agent names to fixed origin refs, or explain the first refusal. */
export function parseFetchTargets(
  names: readonly string[],
): { ok: true; refs: ScratchFetchRef[] } | { ok: false; error: string } {
  if (names.length === 0) return { ok: false, error: 'Name at least one branch.' }
  if (names.length > GIT_FETCH_MAX_REFS)
    return { ok: false, error: `Fetch at most ${String(GIT_FETCH_MAX_REFS)} refs at a time.` }
  const refs = new Map<string, ScratchFetchRef>()
  for (const name of names) {
    const pull = PULL_REF.exec(name)
    let ref: ScratchFetchRef
    if (pull?.[1]) {
      ref = { source: name, destination: `refs/remotes/origin/pr/${pull[1]}` }
    } else if (isFetchableBranchName(name)) {
      ref = originBranchRef(name)
    } else {
      return {
        ok: false,
        error: `"${name}" is not a branch name. Pass branch names (e.g. "main") or refs/pull/<n>/head; remotes, URLs, refspecs and options are not accepted.`,
      }
    }
    // A branch named `pr/<n>` and `refs/pull/<n>/head` share a destination.
    // Refuse rather than let argument order decide which source lands there.
    const existing = refs.get(ref.destination)
    if (existing && existing.source !== ref.source)
      return {
        ok: false,
        error: `${existing.source} and ${ref.source} would both update ${ref.destination}; fetch them in separate calls.`,
      }
    refs.set(ref.destination, ref)
  }
  return { ok: true, refs: [...refs.values()] }
}

async function tips(
  root: string,
  refs: readonly ScratchFetchRef[],
  projectGit: ProjectGit,
): Promise<(string | null)[]> {
  const results = await Promise.all(
    refs.map(({ destination }) =>
      projectGit(root, ['rev-parse', '--verify', '--quiet', `${destination}^{commit}`]),
    ),
  )
  return results.map((result) => (result.code === 0 ? result.stdout.trim() : null))
}

function describeFailure(result: CommandResult): string {
  const detail = result.stderr.trim().slice(0, 2000)
  return detail || `git exited with code ${String(result.code)}`
}

/**
 * Fetch `names` from `projectRoot`'s origin and report each destination ref's
 * SHA, or why nothing was fetched.
 */
export async function fetchOriginRefs(
  projectRoot: string,
  names: readonly string[],
  projectGit: ProjectGit,
  fetchFromOrigin: typeof fetchFromOriginOnHost = fetchFromOriginOnHost,
): Promise<string> {
  const parsed = parseFetchTargets(names)
  if (!parsed.ok) return `git_fetch refused: ${parsed.error}`
  const { refs } = parsed
  const before = await tips(projectRoot, refs, projectGit)
  // A per-call scratch: the hourly default-branch refresh, or another
  // git_fetch, may be fetching for this project at the same time.
  const result = await fetchFromOrigin(
    projectRoot,
    refs,
    projectGit,
    `-fetch-${randomUUID().slice(0, 8)}`,
  )
  if (result === null)
    return (
      'git_fetch only fetches from an origin with an https://, ssh:// or user@host: URL. ' +
      'This project has no such origin; use run_shell `git fetch` instead.'
    )
  if (result.code !== 0) return `git_fetch failed: ${describeFailure(result)}`
  const after = await tips(projectRoot, refs, projectGit)
  const lines = refs.map(({ source, destination }, index) => {
    const tip = after[index] ?? '(missing)'
    const old = before[index]
    const change =
      old === null || old === undefined ? 'new' : old === tip ? 'unchanged' : `was ${old}`
    return `${destination} ${tip} (${change}; from origin ${source})`
  })
  return `Fetched from origin:\n${lines.join('\n')}`
}

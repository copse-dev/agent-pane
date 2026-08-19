/**
 * Pure scale-guard policy for workspace indexing (#795).
 *
 * Decides independently whether semantic indexing and recursive watching may
 * run for a workspace, based on file-index scale evidence and (when available)
 * nested-repository observations. Text/regex search is never gated here.
 *
 * Caps are conservative defaults derived from #796 observations (DuckDuckGo
 * stayed manageable around ~109k paths after gitignore excludes; WPT-scale
 * ~100k tracked nested corpora overwhelm the shared gortex daemon). Replace
 * with checked-in benchmark baselines when milestone-2 review lands.
 */

export type IndexWorkMode = 'full' | 'limited' | 'skipped'

export type IndexPolicyOverride = 'default' | 'force' | 'never'

export type DiscoveryConfidence = 'complete' | 'partial' | 'failed'

export interface NestedRepoObservation {
  /** Workspace-relative path to the nested repo root ('' for the selected root). */
  relativePath: string
  trackedPathCount: number
  trackedByteEstimate: number | null
}

export interface WorkspaceIndexPolicyInput {
  pathCount: number
  byteEstimate: number | null
  nestedRepos: readonly NestedRepoObservation[]
  override: IndexPolicyOverride
  discoveryConfidence: DiscoveryConfidence
  /**
   * Whether `pathCount` is a floor rather than a total, because the listing
   * subprocess overflowed its output cap and the rest of the tree was dropped.
   */
  listingTruncated: boolean
}

export interface WorkspaceIndexPolicy {
  semantic: IndexWorkMode
  watch: IndexWorkMode
  reasons: string[]
  /**
   * Workspace-relative anchored exclude prefixes for oversized child repos.
   * Applied by a later #795 slice before `gortex track`; never includes ''.
   */
  suggestedExcludes: string[]
}

/**
 * Global path ceiling. Above this, keep text search and refuse unbounded
 * semantic indexing / recursive watching.
 */
export const WORKSPACE_INDEX_PATH_CAP = 100_000

/** Global tracked-byte ceiling (2 GiB). */
export const WORKSPACE_INDEX_BYTE_CAP = 2 * 1024 * 1024 * 1024

/**
 * Per nested (non-root) repository path ceiling. Oversized children yield
 * `limited` plus a suggested anchored exclude — never the selected root.
 */
export const NESTED_REPO_PATH_CAP = 50_000

/** Per nested-repo byte ceiling (512 MiB). */
export const NESTED_REPO_BYTE_CAP = 512 * 1024 * 1024

function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

function nestedExceedsCap(repo: NestedRepoObservation): boolean {
  if (repo.trackedPathCount >= NESTED_REPO_PATH_CAP) return true
  return repo.trackedByteEstimate !== null && repo.trackedByteEstimate >= NESTED_REPO_BYTE_CAP
}

function nestedExcludePrefix(relativePath: string): string {
  return relativePath.endsWith('/') ? relativePath : `${relativePath}/`
}

/**
 * Pure decision function for semantic indexing + recursive watch (#795).
 *
 * - `force` always allows full work (user override / tests).
 * - `never` always skips both.
 * - Global path/byte caps → `skipped` (hard refuse).
 * - A truncated listing → `skipped`: the count is a floor, not a total.
 * - Oversized nested child repos → `limited` + suggested excludes (root never excluded).
 * - Missing scale evidence (`pathCount === 0` and no byte estimate) with
 *   `partial`/`failed` discovery → `skipped` (do not treat "listing failed" as
 *   a tiny workspace and fail open into full semantic/watch work).
 * - Incomplete discovery with real path/byte evidence under the global cap does
 *   not invent a skip; the global cap remains the safety net.
 */
export function decideWorkspaceIndexPolicy(input: WorkspaceIndexPolicyInput): WorkspaceIndexPolicy {
  if (input.override === 'force') {
    return {
      semantic: 'full',
      watch: 'full',
      reasons: ['Override forces full indexing'],
      suggestedExcludes: [],
    }
  }
  if (input.override === 'never') {
    return {
      semantic: 'skipped',
      watch: 'skipped',
      reasons: ['Override disables semantic indexing and recursive watching'],
      suggestedExcludes: [],
    }
  }

  const reasons: string[] = []
  const suggestedExcludes: string[] = []
  const discoveryIncomplete =
    input.discoveryConfidence === 'partial' || input.discoveryConfidence === 'failed'
  const hasScaleEvidence = input.pathCount > 0 || input.byteEstimate !== null

  if (discoveryIncomplete && !hasScaleEvidence) {
    return {
      semantic: 'skipped',
      watch: 'skipped',
      reasons: [
        'Scale discovery failed; refusing semantic indexing until path evidence is available',
      ],
      suggestedExcludes: [],
    }
  }

  // A truncated listing carries no usable upper bound. The capture stops at a
  // fixed byte budget, so an oversized checkout reports whatever fraction fit —
  // a measured 124,597-path checkout came back as 61,735 and cleared the 100k
  // cap, after which `gortex track` walked all of it and got SIGKILLed at the
  // wait ceiling on every file-change burst. Same principle as failed discovery
  // above: absence of evidence is not evidence of a small workspace.
  if (input.listingTruncated) {
    return {
      semantic: 'skipped',
      watch: 'skipped',
      reasons: [
        `Workspace file listing overflowed its capture limit at ${formatCount(input.pathCount)} paths; the real size is unknown`,
      ],
      suggestedExcludes: [],
    }
  }

  if (input.pathCount >= WORKSPACE_INDEX_PATH_CAP) {
    reasons.push(
      `Workspace has ${formatCount(input.pathCount)} indexed paths (cap ${formatCount(WORKSPACE_INDEX_PATH_CAP)})`,
    )
  }
  if (input.byteEstimate !== null && input.byteEstimate >= WORKSPACE_INDEX_BYTE_CAP) {
    reasons.push(
      `Workspace tracks ~${formatCount(input.byteEstimate)} bytes (cap ${formatCount(WORKSPACE_INDEX_BYTE_CAP)})`,
    )
  }

  if (reasons.length > 0) {
    if (discoveryIncomplete) {
      reasons.push('Scale evidence is incomplete; applying the global safety cap')
    }
    return {
      semantic: 'skipped',
      watch: 'skipped',
      reasons,
      suggestedExcludes: [],
    }
  }

  for (const repo of input.nestedRepos) {
    if (repo.relativePath === '') continue
    if (!nestedExceedsCap(repo)) continue
    const prefix = nestedExcludePrefix(repo.relativePath)
    suggestedExcludes.push(prefix)
    const sizeBits: string[] = [`${formatCount(repo.trackedPathCount)} paths`]
    if (repo.trackedByteEstimate !== null) {
      sizeBits.push(`~${formatCount(repo.trackedByteEstimate)} bytes`)
    }
    reasons.push(`Nested repository ${repo.relativePath} is oversized (${sizeBits.join(', ')})`)
  }

  if (suggestedExcludes.length > 0) {
    return {
      semantic: 'limited',
      watch: 'limited',
      reasons,
      suggestedExcludes,
    }
  }

  return {
    semantic: 'full',
    watch: 'full',
    reasons: [],
    suggestedExcludes: [],
  }
}

/** Whether the policy permits starting semantic track/update work. */
export function policyAllowsSemantic(policy: WorkspaceIndexPolicy): boolean {
  return policy.semantic === 'full'
}

/** Whether the policy permits starting a recursive workspace watcher. */
export function policyAllowsWatch(policy: WorkspaceIndexPolicy): boolean {
  return policy.watch === 'full'
}

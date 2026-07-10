/** A repository's allowed merge methods, as reported by the GitHub API. */
export interface RepoMergeConfig {
  squash?: boolean
  merge?: boolean
  rebase?: boolean
}

export type AutoMergeStrategy = 'squash' | 'merge' | 'rebase'

/**
 * Pick an auto-merge strategy from the repo's allowed methods, preferring
 * squash → merge → rebase (copse's ordering). Returns null when the repo
 * permits none — enabling auto-merge would just error. When the config is
 * unknown (empty object, e.g. the settings call failed) we optimistically
 * default to squash, since it is GitHub's most common default.
 */
export function chooseAutoMergeStrategy(config: RepoMergeConfig): AutoMergeStrategy | null {
  const known =
    config.squash !== undefined || config.merge !== undefined || config.rebase !== undefined
  if (!known) return 'squash'
  if (config.squash) return 'squash'
  if (config.merge) return 'merge'
  if (config.rebase) return 'rebase'
  return null
}

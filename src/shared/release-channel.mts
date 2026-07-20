export type ReleaseChannel = 'stable' | 'beta'
export type UpdateChannel = 'latest' | 'beta'
export type GitHubReleaseType = 'release' | 'prerelease'
export interface AutoUpdatePolicy {
  channel: UpdateChannel
  allowPrerelease: boolean
  allowDowngrade: false
}

const numericIdentifier = '(?:0|[1-9]\\d*)'
const stableVersion = new RegExp(
  `^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}$`,
)
const betaVersion = new RegExp(
  `^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}-beta\\.${numericIdentifier}$`,
)

/**
 * Classify the only two version forms supported by the public distribution.
 * Fail closed so an alpha, RC, or malformed tag cannot enter either channel.
 */
export function getReleaseChannel(version: string): ReleaseChannel {
  if (stableVersion.test(version)) return 'stable'
  if (betaVersion.test(version)) return 'beta'
  throw new Error(
    `Unsupported release version ${JSON.stringify(version)}; expected X.Y.Z or X.Y.Z-beta.N`,
  )
}

export function getUpdateChannel(version: string): UpdateChannel {
  return getReleaseChannel(version) === 'stable' ? 'latest' : 'beta'
}

export function getAutoUpdatePolicy(version: string): AutoUpdatePolicy {
  const channel = getUpdateChannel(version)
  return {
    channel,
    allowPrerelease: channel === 'beta',
    allowDowngrade: false,
  }
}

/**
 * Metadata files that must be attached to this release. Stable releases also
 * refresh the beta feed so beta installations can advance to stable.
 */
export function getPublishedUpdateChannels(version: string): UpdateChannel[] {
  return getReleaseChannel(version) === 'stable' ? ['latest', 'beta'] : ['beta']
}

export function getGitHubReleaseType(version: string): GitHubReleaseType {
  return getReleaseChannel(version) === 'stable' ? 'release' : 'prerelease'
}

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

/**
 * Order two supported release versions: negative when `a` is older, zero when
 * equal, positive when newer. Betas order numerically (beta.10 after beta.9),
 * and a stable X.Y.Z follows every beta of the same X.Y.Z. Throws on any shape
 * the classifier rejects.
 */
export function compareReleaseVersions(a: string, b: string): number {
  const left = parseReleaseVersion(a)
  const right = parseReleaseVersion(b)
  for (let i = 0; i < 3; i++) {
    const delta = (left.core[i] ?? 0) - (right.core[i] ?? 0)
    if (delta !== 0) return delta
  }
  if (left.beta === right.beta) return 0
  if (left.beta === null) return 1
  if (right.beta === null) return -1
  return left.beta - right.beta
}

export interface ParsedReleaseVersion {
  /** Major, minor, patch. */
  core: [number, number, number]
  /** The beta number, or null for a stable version. */
  beta: number | null
}

export function parseReleaseVersion(version: string): ParsedReleaseVersion {
  getReleaseChannel(version)
  const [core = '', beta] = version.split('-beta.')
  const [major = 0, minor = 0, patch = 0] = core.split('.').map(Number)
  return { core: [major, minor, patch], beta: beta === undefined ? null : Number(beta) }
}

/**
 * Marks where the generated release body's changelog begins. Everything above
 * it is per-release boilerplate (channel, minimum macOS, architectures) that
 * the in-app update prompt leaves out when it lists every missed version.
 * An HTML comment, so it is invisible on the published GitHub Release.
 */
export const RELEASE_NOTES_CHANGELOG_MARKER = '<!-- copse:changelog -->'

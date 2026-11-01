import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_STABLE_SOAK_HOURS,
  fallbackLatestStable,
  feedProblems,
  haltProblems,
  parseRelease,
  parseUpdateFeed,
  promotionProblems,
  requiredReleaseAssets,
  type PublishedRelease,
} from './release-promotion.mts'

const now = new Date('2026-11-10T12:00:00Z')

function release(tag: string, overrides: Partial<PublishedRelease> = {}): PublishedRelease {
  const version = tag.slice(1)
  return {
    tag,
    draft: false,
    prerelease: true,
    publishedAt: '2026-11-06T12:00:00Z',
    assets: requiredReleaseAssets(version),
    ...overrides,
  }
}

describe('parseRelease', () => {
  it('reads the GitHub REST fields promotion needs', () => {
    assert.deepEqual(
      parseRelease({
        tag_name: 'v0.1.0',
        draft: false,
        prerelease: true,
        published_at: '2026-11-06T12:00:00Z',
        assets: [{ name: 'SHA256SUMS', size: 10 }],
        body: 'ignored',
      }),
      {
        tag: 'v0.1.0',
        draft: false,
        prerelease: true,
        publishedAt: '2026-11-06T12:00:00Z',
        assets: ['SHA256SUMS'],
      },
    )
  })

  it('accepts a draft with no publication time and rejects a malformed release', () => {
    const draft = parseRelease({
      tag_name: 'v0.1.0',
      draft: true,
      prerelease: false,
      published_at: null,
      assets: [],
    })
    assert.equal(draft.publishedAt, null)
    assert.throws(() => parseRelease({ tag_name: 'v0.1.0', draft: 'no', assets: [] }))
  })
})

describe('requiredReleaseAssets', () => {
  it('requires both feeds for stable and only the beta feed for a beta', () => {
    assert.ok(requiredReleaseAssets('0.1.0').includes('latest-mac.yml'))
    assert.ok(requiredReleaseAssets('0.1.0').includes('beta-mac.yml'))
    assert.ok(!requiredReleaseAssets('0.1.0-beta.3').includes('latest-mac.yml'))
    assert.ok(requiredReleaseAssets('0.1.0').includes('Copse-0.1.0-x64.zip.blockmap'))
  })
})

describe('promotionProblems', () => {
  const check = (
    candidate: PublishedRelease,
    latestStable: PublishedRelease | null = null,
    soakHours = DEFAULT_STABLE_SOAK_HOURS,
  ): string[] => promotionProblems({ release: candidate, latestStable, now, soakHours })

  it('accepts a complete stable candidate that has soaked on the beta channel', () => {
    assert.deepEqual(check(release('v0.1.0')), [])
    const previous = release('v0.1.0', { prerelease: false })
    assert.deepEqual(check(release('v0.1.1'), previous), [])
  })

  it('never promotes a beta, which is a different build from any stable', () => {
    assert.match(check(release('v0.1.0-beta.16')).join('\n'), /only an X\.Y\.Z stable candidate/)
  })

  it('refuses a halted, already-promoted, or incomplete release', () => {
    assert.match(check(release('v0.1.0', { draft: true })).join('\n'), /is a draft/)
    assert.match(check(release('v0.1.0', { prerelease: false })).join('\n'), /already a stable/)
    const assets = requiredReleaseAssets('0.1.0').filter((name) => name !== 'latest-mac.yml')
    assert.match(check(release('v0.1.0', { assets })).join('\n'), /has no latest-mac\.yml/)
  })

  it('requires the soak, and will not lower it below the floor', () => {
    const fresh = release('v0.1.0', { publishedAt: '2026-11-10T00:00:00Z' })
    assert.match(check(fresh).join('\n'), /12\.0 of the required 72 hours/)
    assert.deepEqual(check(fresh, null, 12), ['The soak must be at least 24 hours'])
    assert.deepEqual(
      check(release('v0.1.0', { publishedAt: '2026-11-09T12:00:00Z' }), null, 24),
      [],
    )
  })

  it('never makes an older or equal stable the latest', () => {
    const latest = release('v0.2.0', { prerelease: false })
    assert.match(check(release('v0.1.5'), latest).join('\n'), /not newer than the current stable/)
  })
})

describe('haltProblems', () => {
  it('halts any published supported release and refuses a draft', () => {
    assert.deepEqual(haltProblems(release('v0.1.0-beta.16')), [])
    assert.deepEqual(haltProblems(release('v0.1.0', { prerelease: false })), [])
    assert.deepEqual(haltProblems(release('v0.1.0', { draft: true })), [
      'v0.1.0 is already a draft',
    ])
    assert.match(haltProblems(release('v0.1.0', { tag: 'nightly' })).join(''), /not a supported/)
  })
})

describe('fallbackLatestStable', () => {
  it('chooses the newest remaining published stable release', () => {
    const releases = [
      release('v0.1.2', { prerelease: false }),
      release('v0.1.1', { prerelease: false }),
      release('v0.1.3-beta.1'),
      release('v0.1.0', { prerelease: false }),
      release('v0.1.1-beta.2', { prerelease: false }),
    ]
    assert.equal(fallbackLatestStable(releases, 'v0.1.2'), 'v0.1.1')
  })

  it('skips drafts and stable candidates, and may find nothing', () => {
    const releases = [
      release('v0.1.0', { prerelease: false }),
      release('v0.1.1', { prerelease: false, draft: true }),
      release('v0.1.2'),
    ]
    assert.equal(fallbackLatestStable(releases, 'v0.1.3'), 'v0.1.0')
    assert.equal(fallbackLatestStable(releases, 'v0.1.0'), null)
  })
})

describe('update feed verification', () => {
  const feedText = [
    'version: 0.1.0',
    'files:',
    '  - url: Copse-0.1.0-x64.zip',
    '    sha512: xzip',
    '    size: 10',
    '  - url: Copse-0.1.0-arm64.zip',
    '    sha512: azip',
    '    size: 11',
    '  - url: Copse-0.1.0-x64.dmg',
    '    sha512: xdmg',
    '    size: 12',
    '  - url: Copse-0.1.0-arm64.dmg',
    '    sha512: admg',
    '    size: 13',
    'path: Copse-0.1.0-x64.zip',
    'sha512: xzip',
    "releaseDate: '2026-11-06T12:00:00.000Z'",
    '',
  ].join('\n')
  const actual = new Map([
    ['Copse-0.1.0-x64.zip', { sha512: 'xzip', size: 10 }],
    ['Copse-0.1.0-arm64.zip', { sha512: 'azip', size: 11 }],
    ['Copse-0.1.0-x64.dmg', { sha512: 'xdmg', size: 12 }],
    ['Copse-0.1.0-arm64.dmg', { sha512: 'admg', size: 13 }],
  ])

  it('parses the assembled feed shape', () => {
    const feed = parseUpdateFeed(feedText)
    assert.equal(feed.version, '0.1.0')
    assert.deepEqual(
      feed.files.map((file) => file.url),
      ['Copse-0.1.0-x64.zip', 'Copse-0.1.0-arm64.zip', 'Copse-0.1.0-x64.dmg', 'Copse-0.1.0-arm64.dmg'],
    )
    assert.throws(() => parseUpdateFeed('files: []\n'), /no version/)
  })

  it('accepts a feed that describes exactly the published bytes', () => {
    assert.deepEqual(feedProblems('latest-mac.yml', parseUpdateFeed(feedText), '0.1.0', actual), [])
  })

  it('rejects a wrong version, a changed file, or a missing architecture', () => {
    const feed = parseUpdateFeed(feedText)
    assert.match(feedProblems('f', feed, '0.1.1', actual).join('\n'), /names 0\.1\.0, not 0\.1\.1/)
    const changed = new Map(actual).set('Copse-0.1.0-arm64.zip', { sha512: 'other', size: 11 })
    assert.match(feedProblems('f', feed, '0.1.0', changed).join('\n'), /does not match/)
    const noArm = parseUpdateFeed(
      feedText.replace(/ {2}- url: Copse-0\.1\.0-arm64\.zip\n.*\n.*\n/, ''),
    )
    assert.match(
      feedProblems('f', noArm, '0.1.0', actual).join('\n'),
      /omits Copse-0\.1\.0-arm64\.zip/,
    )
    // A feed of only the zips would leave the direct-download DMGs unchecked.
    const zipsOnly = parseUpdateFeed(feedText.replace(/ {2}- url: \S+\.dmg\n.*\n.*\n/g, ''))
    const missing = feedProblems('f', zipsOnly, '0.1.0', actual)
    assert.deepEqual(missing, ['f omits Copse-0.1.0-arm64.dmg', 'f omits Copse-0.1.0-x64.dmg'])
  })
})

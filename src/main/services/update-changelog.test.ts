import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RELEASE_NOTES_CHANGELOG_MARKER } from '../../shared/release-channel.mts'
import {
  fetchUpdateChangelog,
  releaseBodyChangelog,
  selectUpdateChangelog,
} from './update-changelog.ts'

function release(
  tag: string,
  body: string | null,
  flags: { prerelease?: boolean; draft?: boolean } = {},
): { tag_name: string; body: string | null; draft: boolean; prerelease: boolean } {
  return {
    tag_name: tag,
    body,
    draft: flags.draft ?? false,
    prerelease: flags.prerelease ?? tag.includes('-beta.'),
  }
}

const generated = (version: string, notes: string): string =>
  [
    `Built from copse-dev/agent-pane@abc123 (tag v${version}).`,
    '',
    `Copse ${version} — beta channel.`,
    '',
    '- Requires macOS 26 or newer.',
    '- Updates are served from the `beta` feed.',
    '',
    RELEASE_NOTES_CHANGELOG_MARKER,
    '',
    notes,
    '',
  ].join('\n')

describe('releaseBodyChangelog', () => {
  it('keeps only what follows the changelog marker', () => {
    assert.equal(releaseBodyChangelog(generated('0.1.0-beta.9', '- Fixed it.')), '- Fixed it.')
  })

  it('keeps known issues added after publication, which follow the notes', () => {
    const body = `${generated('0.1.0-beta.9', '- Fixed it.')}\n## Known issues\n\n- One.\n`
    assert.match(releaseBodyChangelog(body), /## Known issues/)
  })

  it('strips the boilerplate from bodies published before the marker existed', () => {
    const legacy = generated('0.1.0-beta.8', '- Old fix.').replace(
      `${RELEASE_NOTES_CHANGELOG_MARKER}\n\n`,
      '',
    )
    assert.equal(releaseBodyChangelog(legacy), '- Old fix.')
  })

  it('leaves a hand-written body alone', () => {
    assert.equal(
      releaseBodyChangelog('Hand-written notes.\n\n- Item.'),
      'Hand-written notes.\n\n- Item.',
    )
  })
})

describe('selectUpdateChangelog', () => {
  const releases = [
    release('v0.2.0-beta.1', generated('0.2.0-beta.1', '- Too new.')),
    release('v0.1.0', 'Stable.', { prerelease: false }),
    release('v0.1.0-beta.10', generated('0.1.0-beta.10', '- Ten.')),
    release('v0.1.0-beta.9', generated('0.1.0-beta.9', '- Nine.')),
    release('v0.1.0-beta.11', null, { draft: true }),
    release('v0.1.0-beta.8', generated('0.1.0-beta.8', '- Current.')),
    release('nightly', 'Not a release version.'),
  ]

  it('lists versions after the current one up to the update, newest first', () => {
    const entries = selectUpdateChangelog(releases, {
      currentVersion: '0.1.0-beta.8',
      latestVersion: '0.1.0',
      includePrereleases: true,
    })
    assert.deepEqual(
      entries.map((e) => e.version),
      ['0.1.0', '0.1.0-beta.10', '0.1.0-beta.9'],
    )
    assert.equal(entries[1]?.notes, '- Ten.')
  })

  it('never lists beta notes to a stable client', () => {
    const entries = selectUpdateChangelog(
      [...releases, release('v0.0.9', 'Older stable.', { prerelease: false })],
      { currentVersion: '0.0.9', latestVersion: '0.1.0', includePrereleases: false },
    )
    assert.deepEqual(
      entries.map((e) => e.version),
      ['0.1.0'],
    )
  })

  it('caps a very long gap at the newest releases', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      release(`v0.1.0-beta.${String(i + 1)}`, `- ${String(i + 1)}.`),
    )
    const entries = selectUpdateChangelog(many, {
      currentVersion: '0.1.0-beta.1',
      latestVersion: '0.1.0-beta.30',
      includePrereleases: true,
    })
    assert.equal(entries.length, 12)
    assert.equal(entries[0]?.version, '0.1.0-beta.30')
  })
})

describe('fetchUpdateChangelog', () => {
  const options = {
    currentVersion: '0.1.0-beta.8',
    latestVersion: '0.1.0-beta.9',
    includePrereleases: true,
  }

  it('decodes the public releases API', async () => {
    const body = JSON.stringify([release('v0.1.0-beta.9', generated('0.1.0-beta.9', '- Nine.'))])
    const entries = await fetchUpdateChangelog(options, () => Promise.resolve(new Response(body)))
    assert.deepEqual(entries, [{ version: '0.1.0-beta.9', notes: '- Nine.' }])
  })

  it('falls back to no changelog on an error status, bad JSON, or a network failure', async () => {
    assert.deepEqual(
      await fetchUpdateChangelog(options, () =>
        Promise.resolve(new Response('rate limited', { status: 403 })),
      ),
      [],
    )
    assert.deepEqual(
      await fetchUpdateChangelog(options, () => Promise.resolve(new Response('{"not":"a list"}'))),
      [],
    )
    assert.deepEqual(
      await fetchUpdateChangelog(options, () => Promise.reject(new Error('offline'))),
      [],
    )
  })
})

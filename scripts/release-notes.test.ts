import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractUnreleasedSection, renderReleaseNotes } from './release-notes.mts'

const changelog = [
  '# Changelog and release notes',
  '',
  'Preamble that is not part of any release.',
  '',
  '## Unreleased',
  '',
  '- Fixed the thing.',
  '- Fixed the other thing.',
  '',
  '## Release-note process',
  '',
  'Boilerplate that must never reach a release body.',
  '',
].join('\n')

describe('extractUnreleasedSection', () => {
  it('returns only the Unreleased body', () => {
    assert.equal(
      extractUnreleasedSection(changelog),
      '- Fixed the thing.\n- Fixed the other thing.',
    )
  })

  it('runs to end of file when nothing follows Unreleased', () => {
    const trailing = ['# Changelog', '', '## Unreleased', '', '- Only entry.', ''].join('\n')
    assert.equal(extractUnreleasedSection(trailing), '- Only entry.')
  })

  it('fails closed when the section is missing', () => {
    assert.throws(
      () => extractUnreleasedSection('# Changelog\n\n## 1.0.0\n\n- Old.\n'),
      /no "## Unreleased" section/,
    )
  })

  it('fails closed when the section is empty', () => {
    // An empty section means the version bump was promoted without notes. The
    // publisher must stop rather than ship a release body of boilerplate.
    assert.throws(
      () => extractUnreleasedSection('# Changelog\n\n## Unreleased\n\n## 1.0.0\n\n- Old.\n'),
      /"Unreleased" section is empty/,
    )
  })
})

describe('renderReleaseNotes', () => {
  it('states the beta channel, its feed, and the stable advance for a beta version', () => {
    const notes = renderReleaseNotes('0.1.0-beta.1', changelog)
    assert.match(notes, /^Copse 0\.1\.0-beta\.1 — beta channel\.$/m)
    assert.match(notes, /`beta` feed/)
    assert.match(notes, /may advance to a newer stable release/)
    assert.match(notes, /- Fixed the thing\./)
  })

  it('states the latest feed and never offers beta builds to stable', () => {
    const notes = renderReleaseNotes('1.2.3', changelog)
    assert.match(notes, /^Copse 1\.2\.3 — stable channel\.$/m)
    assert.match(notes, /`latest` feed/)
    assert.match(notes, /never offered a beta build/)
  })

  it('records the supported macOS version and both architectures', () => {
    const notes = renderReleaseNotes('1.2.3', changelog)
    assert.match(notes, /macOS 26 or newer/)
    assert.match(notes, /`arm64`/)
    assert.match(notes, /`x64`/)
  })

  it('rejects a version shape neither channel supports', () => {
    // getReleaseChannel is the shared classifier; an alpha/RC must not be able
    // to produce notes any more than it can produce a channel.
    assert.throws(() => renderReleaseNotes('1.2.3-rc.1', changelog), /Unsupported release version/)
  })
})

describe('the repository CHANGELOG', () => {
  it('can produce release notes as it stands', () => {
    // The publisher generates notes from this file at release time; a broken or
    // emptied Unreleased section should fail here, not after notarization.
    const notes = renderReleaseNotes('0.0.0-beta.0', readFileSync(resolve('CHANGELOG.md'), 'utf8'))
    assert.ok(notes.length > 200, 'expected a non-trivial release body')
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractReleaseSection, renderReleaseNotes, splitChangelog } from './release-notes.mts'

const changelog = [
  '# Changelog and release notes',
  '',
  'Preamble that is not part of any release.',
  '',
  '## Unreleased',
  '',
  '- Work for the next release.',
  '',
  '## 0.1.0-beta.1',
  '',
  '- Fixed the thing.',
  '- Fixed the other thing.',
  '',
  '## Release-note process',
  '',
  'Boilerplate that must never reach a release body.',
  '',
].join('\n')

describe('splitChangelog', () => {
  it('is lossless and names each section by its heading', () => {
    const { preamble, sections } = splitChangelog(changelog)
    assert.equal(preamble + sections.map((s) => s.text).join(''), changelog)
    assert.deepEqual(
      sections.map((s) => s.name),
      ['Unreleased', '0.1.0-beta.1', 'Release-note process'],
    )
  })

  it('does not treat a deeper heading as a section boundary', () => {
    const nested = '## Unreleased\n\n### Unreleased\n\n- Entry.\n'
    assert.deepEqual(
      splitChangelog(nested).sections.map((s) => s.name),
      ['Unreleased'],
    )
  })
})

describe('extractReleaseSection', () => {
  it('returns only the body of the requested version', () => {
    assert.equal(
      extractReleaseSection(changelog, '0.1.0-beta.1'),
      '- Fixed the thing.\n- Fixed the other thing.',
    )
  })

  it('never publishes the in-progress Unreleased notes', () => {
    assert.doesNotMatch(extractReleaseSection(changelog, '0.1.0-beta.1'), /next release/)
  })

  it('does not match a version that only shares a prefix', () => {
    // beta.1 and beta.10 must never be confused for one another.
    const later = changelog.replace('## 0.1.0-beta.1\n', '## 0.1.0-beta.10\n')
    assert.throws(() => extractReleaseSection(later, '0.1.0-beta.1'), /no "## 0\.1\.0-beta\.1"/)
  })

  it('runs to end of file when nothing follows the section', () => {
    const trailing = ['# Changelog', '', '## 1.0.0', '', '- Only entry.', ''].join('\n')
    assert.equal(extractReleaseSection(trailing, '1.0.0'), '- Only entry.')
  })

  it('fails closed when the version has no section', () => {
    // A hand-edited package.json that skipped release-bump would otherwise
    // publish whatever happened to be in Unreleased.
    assert.throws(() => extractReleaseSection(changelog, '0.1.0-beta.2'), /release-bump\.mts/)
  })

  it('fails closed when the section is empty', () => {
    assert.throws(
      () => extractReleaseSection('# Changelog\n\n## 1.0.0\n\n## Process\n', '1.0.0'),
      /"## 1\.0\.0" section is empty/,
    )
  })
})

describe('renderReleaseNotes', () => {
  const stable = changelog.replace('## 0.1.0-beta.1\n', '## 1.2.3\n')

  it('states the beta channel, its feed, and the stable advance for a beta version', () => {
    const notes = renderReleaseNotes('0.1.0-beta.1', changelog)
    assert.match(notes, /^Copse 0\.1\.0-beta\.1 — beta channel\.$/m)
    assert.match(notes, /`beta` feed/)
    assert.match(notes, /may advance to a newer stable release/)
    assert.match(notes, /- Fixed the thing\./)
  })

  it('states the latest feed and never offers beta builds to stable', () => {
    const notes = renderReleaseNotes('1.2.3', stable)
    assert.match(notes, /^Copse 1\.2\.3 — stable channel\.$/m)
    assert.match(notes, /`latest` feed/)
    assert.match(notes, /never offered a beta build/)
  })

  it('records the supported macOS version and both architectures', () => {
    const notes = renderReleaseNotes('1.2.3', stable)
    assert.match(notes, /macOS 26 or newer/)
    assert.match(notes, /`arm64`/)
    assert.match(notes, /`x64`/)
  })

  it('rejects a version shape neither channel supports', () => {
    // getReleaseChannel is the shared classifier; an alpha/RC must not be able
    // to produce notes any more than it can produce a channel.
    const rc = changelog.replace('## 0.1.0-beta.1\n', '## 1.2.3-rc.1\n')
    assert.throws(() => renderReleaseNotes('1.2.3-rc.1', rc), /Unsupported release version/)
  })
})

describe('the repository CHANGELOG', () => {
  it('produces release notes for the package version once it has been bumped', () => {
    // The release jobs generate notes from this file at the tagged commit; a
    // broken section should fail here, not after notarization. Versions released
    // before notes were kept per version have no section and nothing to check.
    const repoChangelog = readFileSync(resolve('CHANGELOG.md'), 'utf8')
    const pkg = readFileSync(resolve('package.json'), 'utf8')
    const version = /^ {2}"version": "([^"]+)"/m.exec(pkg)?.[1]
    assert.ok(version !== undefined, 'package.json has a top-level version')
    if (!splitChangelog(repoChangelog).sections.some((s) => s.name === version)) return
    const notes = renderReleaseNotes(version, repoChangelog)
    assert.ok(notes.length > 200, 'expected a non-trivial release body')
  })
})

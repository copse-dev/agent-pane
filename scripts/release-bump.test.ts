import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  compareVersions,
  hasUnreleasedNotes,
  nextBetaVersion,
  setPackageVersion,
  stampChangelog,
} from './release-bump.mts'
import { extractReleaseSection, findSectionBody, renderReleaseNotes } from './release-notes.mts'

const changelog = [
  '# Changelog and release notes',
  '',
  'Preamble.',
  '',
  '## Unreleased',
  '',
  '- New this week.',
  '',
  '## 0.1.0-beta.9',
  '',
  '- Shipped last week.',
  '',
  '## Release-note process',
  '',
  'Process text.',
  '',
].join('\n')

describe('nextBetaVersion', () => {
  it('increments the beta number', () => {
    assert.equal(nextBetaVersion('0.1.0-beta.9'), '0.1.0-beta.10')
  })

  it('starts the next patch after a stable release, never cutting stable itself', () => {
    assert.equal(nextBetaVersion('0.1.0'), '0.1.1-beta.1')
  })

  it('rejects a version shape neither channel supports', () => {
    assert.throws(() => nextBetaVersion('0.1.0-rc.1'), /Unsupported release version/)
  })
})

describe('compareVersions', () => {
  it('orders betas numerically, not lexically', () => {
    assert.ok(compareVersions('0.1.0-beta.10', '0.1.0-beta.9') > 0)
  })

  it('orders a stable release after every beta of the same version', () => {
    assert.ok(compareVersions('0.1.0', '0.1.0-beta.99') > 0)
    assert.ok(compareVersions('0.1.0-beta.1', '0.1.0') < 0)
  })

  it('orders by major, minor, then patch', () => {
    assert.ok(compareVersions('1.0.0-beta.1', '0.9.9') > 0)
    assert.ok(compareVersions('0.2.0', '0.10.0') < 0)
    assert.equal(compareVersions('0.1.0-beta.3', '0.1.0-beta.3'), 0)
  })
})

describe('stampChangelog', () => {
  const stamped = stampChangelog(changelog, '0.1.0-beta.10')

  it('moves the Unreleased notes under the new version', () => {
    assert.equal(extractReleaseSection(stamped, '0.1.0-beta.10'), '- New this week.')
  })

  it('opens an empty Unreleased section above the release', () => {
    assert.equal(findSectionBody(stamped, 'Unreleased'), '')
    assert.ok(stamped.indexOf('## Unreleased') < stamped.indexOf('## 0.1.0-beta.10'))
    assert.equal(hasUnreleasedNotes(stamped), false)
  })

  it('drops the previous release, which GitHub Releases already records', () => {
    assert.equal(findSectionBody(stamped, '0.1.0-beta.9'), undefined)
    assert.doesNotMatch(stamped, /Shipped last week/)
  })

  it('keeps the preamble and non-release sections intact', () => {
    assert.ok(stamped.startsWith('# Changelog and release notes\n\nPreamble.\n\n'))
    assert.equal(findSectionBody(stamped, 'Release-note process'), 'Process text.')
  })

  it('refuses to cut a release with no notes', () => {
    // The scheduled bump skips an empty week; a person forcing one must write notes.
    assert.throws(() => stampChangelog(stamped, '0.1.0-beta.11'), /nothing to release/)
  })

  it('refuses a version that already has a section', () => {
    assert.throws(() => stampChangelog(changelog, '0.1.0-beta.9'), /already has/)
  })

  it('requires an Unreleased heading', () => {
    assert.throws(
      () => hasUnreleasedNotes('# Changelog\n\n## 1.0.0\n\n- Old.\n'),
      /no "## Unreleased"/,
    )
  })
})

describe('setPackageVersion', () => {
  it('replaces only the top-level version and keeps the formatting', () => {
    const pkg =
      '{\n  "name": "copse",\n  "version": "0.1.0-beta.9",\n  "engines": {\n    "version": "x"\n  }\n}\n'
    assert.equal(
      setPackageVersion(pkg, '0.1.0-beta.10'),
      pkg.replace('"0.1.0-beta.9"', '"0.1.0-beta.10"'),
    )
  })
})

describe('the repository CHANGELOG and package.json', () => {
  it('can be bumped to the next beta and still produce release notes', () => {
    // The scheduled workflow runs exactly this against main; a CHANGELOG shape
    // it cannot stamp should fail in unit tests, not in a Monday-morning job.
    const repoChangelog = readFileSync(resolve('CHANGELOG.md'), 'utf8')
    const pkg = readFileSync(resolve('package.json'), 'utf8')
    const version = /^ {2}"version": "([^"]+)"/m.exec(pkg)?.[1]
    assert.ok(version !== undefined, 'package.json has a top-level version')
    const next = nextBetaVersion(version)
    assert.match(
      setPackageVersion(pkg, next),
      new RegExp(`"version": "${next.replaceAll('.', '\\.')}"`),
    )
    if (!hasUnreleasedNotes(repoChangelog)) return
    const notes = renderReleaseNotes(next, stampChangelog(repoChangelog, next))
    assert.ok(notes.length > 200, 'expected a non-trivial release body')
  })
})

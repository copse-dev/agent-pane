import { readFileSync } from 'node:fs'
import {
  RELEASE_NOTES_CHANGELOG_MARKER,
  getReleaseChannel,
  getUpdateChannel,
} from '../src/shared/release-channel.mts'

/**
 * Render the GitHub Release body for a version from its `## <version>` section
 * in `CHANGELOG.md`.
 *
 * `gh release create` refuses to run without notes when it has no TTY, so the
 * publisher needs a body from somewhere. Generating it from the commit log
 * (`--generate-notes`) would publish raw commit subjects; the release checklist
 * asks for notes drawn from `CHANGELOG.md` and for the channel, minimum macOS
 * version, and architecture coverage to be stated on the release itself. Doing
 * both here keeps the published notes and the changelog from drifting.
 *
 * Work in progress accumulates under `## Unreleased`; the version bump
 * (`scripts/release-bump.mts`) renames that section to the version it releases,
 * so the notes are fixed at the promoted commit while `Unreleased` keeps
 * collecting the next release's changes.
 */

export const UNRELEASED = 'Unreleased'

export interface ChangelogSection {
  /** The heading text after `## `. */
  name: string
  /** The whole section, heading line included, exactly as it appears. */
  text: string
}

/**
 * Split a changelog at its `## ` headings without losing a byte:
 * `preamble + sections.map((s) => s.text).join('')` is the input.
 */
export function splitChangelog(changelog: string): {
  preamble: string
  sections: ChangelogSection[]
} {
  const [preamble = '', ...chunks] = changelog.split(/^(?=## )/m)
  if (preamble.startsWith('## ')) {
    // No preamble: the first chunk is itself a section.
    chunks.unshift(preamble)
    return { preamble: '', sections: chunks.map(toSection) }
  }
  return { preamble, sections: chunks.map(toSection) }
}

function toSection(text: string): ChangelogSection {
  const newline = text.indexOf('\n')
  const heading = newline === -1 ? text : text.slice(0, newline)
  return { name: heading.slice('## '.length).trim(), text }
}

/** The trimmed body under `## <name>`, or undefined when there is no such heading. */
export function findSectionBody(changelog: string, name: string): string | undefined {
  const section = splitChangelog(changelog).sections.find((s) => s.name === name)
  if (section === undefined) return undefined
  const newline = section.text.indexOf('\n')
  return newline === -1 ? '' : section.text.slice(newline + 1).trim()
}

export function extractReleaseSection(changelog: string, version: string): string {
  const body = findSectionBody(changelog, version)
  if (body === undefined) {
    throw new Error(
      `CHANGELOG.md has no "## ${version}" section. The version bump moves the Unreleased ` +
        'notes under the version it releases; run `node scripts/release-bump.mts` rather than ' +
        'editing package.json by hand.',
    )
  }
  if (body === '') {
    throw new Error(
      `CHANGELOG.md's "## ${version}" section is empty. The published release is generated ` +
        'from it, so it must describe the release before the version reaches `release`.',
    )
  }
  return body
}

export function renderReleaseNotes(version: string, changelog: string): string {
  const channel = getReleaseChannel(version)
  const feed = getUpdateChannel(version)
  const advance =
    channel === 'stable'
      ? 'Stable installations update from this feed and are never offered a beta build.'
      : 'Beta installations update from this feed and may advance to a newer stable release.'
  return [
    `Copse ${version} — ${channel} channel.`,
    '',
    '- Requires macOS 26 or newer.',
    '- Download the `arm64` build for Apple Silicon or the `x64` build for Intel.',
    `- Updates are served from the \`${feed}\` feed. ${advance}`,
    '- Releases are forward-fix only; downgrade is not a supported rollback.',
    '',
    // The in-app update prompt lists every missed version's notes from here down.
    RELEASE_NOTES_CHANGELOG_MARKER,
    '',
    extractReleaseSection(changelog, version),
    '',
  ].join('\n')
}

export function packageVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    typeof parsed.version !== 'string'
  ) {
    throw new Error('package.json must contain a string version')
  }
  return parsed.version
}

function main(): void {
  const [version = packageVersion(), changelogPath, ...extra] = process.argv.slice(2)
  if (extra.length > 0) {
    throw new Error('Usage: node scripts/release-notes.mts [version] [changelog-path]')
  }
  const changelog = readFileSync(
    changelogPath ?? new URL('../CHANGELOG.md', import.meta.url),
    'utf8',
  )
  process.stdout.write(renderReleaseNotes(version, changelog))
}

// Importing this module for its pure helpers must not print or exit.
if (process.argv[1]?.endsWith('release-notes.mts') === true) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

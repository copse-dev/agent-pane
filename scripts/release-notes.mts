import { readFileSync } from 'node:fs'
import { getReleaseChannel, getUpdateChannel } from '../src/shared/release-channel.mts'

/**
 * Render the GitHub Release body for a version from `CHANGELOG.md`'s
 * `## Unreleased` section.
 *
 * `gh release create` refuses to run without notes when it has no TTY, so the
 * publisher needs a body from somewhere. Generating it from the commit log
 * (`--generate-notes`) would publish raw commit subjects; the release checklist
 * asks for notes drawn from `CHANGELOG.md` and for the channel, minimum macOS
 * version, and architecture coverage to be stated on the release itself. Doing
 * both here keeps the published notes and the changelog from drifting.
 */

const UNRELEASED_HEADING = '## Unreleased'

export function extractUnreleasedSection(changelog: string): string {
  const start = changelog.indexOf(`${UNRELEASED_HEADING}\n`)
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no ${JSON.stringify(UNRELEASED_HEADING)} section`)
  }
  const body = changelog.slice(start + UNRELEASED_HEADING.length)
  // Any following `## ` heading ends the section; without one it runs to EOF.
  const end = body.search(/^## /m)
  const section = (end === -1 ? body : body.slice(0, end)).trim()
  if (section === '') {
    throw new Error(
      'CHANGELOG.md\'s "Unreleased" section is empty. Write the release notes there before ' +
        'promoting the version bump — the published release is generated from it.',
    )
  }
  return section
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
    extractUnreleasedSection(changelog),
    '',
  ].join('\n')
}

function packageVersion(): string {
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

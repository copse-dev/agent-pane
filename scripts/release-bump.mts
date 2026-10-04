import { isDirectExecution } from './lib/direct-execution.mts'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  compareReleaseVersions,
  getReleaseChannel,
  parseReleaseVersion,
} from '../src/shared/release-channel.mts'
import {
  UNRELEASED,
  findSectionBody,
  packageVersion,
  splitChangelog,
  type ChangelogSection,
} from './release-notes.mts'

/**
 * Prepare a release on `main`: set `package.json` to the next version and move
 * `CHANGELOG.md`'s `Unreleased` notes under a `## <version>` heading, leaving a
 * fresh empty `Unreleased` above it.
 *
 * Promotion carries that commit to `release`, where `Cut release tag` sees the
 * new version and the release jobs read the notes from its section. The
 * previous version's section is dropped at the same time: the published GitHub
 * Release is the canonical record, so this file only ever holds the notes in
 * flight. `release-bump.yml` runs this weekly; a person runs it with an explicit
 * version to cut a stable release or jump a minor.
 *
 * `--carry-forward` is for cutting past a version that was never published,
 * usually because its release run failed. That version has no GitHub Release to
 * keep its notes, so they are folded into the new version's section instead of
 * dropped.
 */

/**
 * The version the scheduled cadence releases next. It only ever cuts betas:
 * after a stable X.Y.Z the next is X.Y.(Z+1)-beta.1, so promoting a build to
 * stable stays a deliberate, human-chosen version.
 */
export function nextBetaVersion(current: string): string {
  const {
    core: [major, minor, patch],
    beta,
  } = parseReleaseVersion(current)
  return beta === null
    ? `${[major, minor, patch + 1].join('.')}-beta.1`
    : `${[major, minor, patch].join('.')}-beta.${String(beta + 1)}`
}

function isReleaseVersion(name: string): boolean {
  try {
    getReleaseChannel(name)
    return true
  } catch {
    return false
  }
}

/** Whether `Unreleased` has anything to release. Throws when the heading is missing. */
export function hasUnreleasedNotes(changelog: string): boolean {
  const body = findSectionBody(changelog, UNRELEASED)
  if (body === undefined) throw new Error(`CHANGELOG.md has no "## ${UNRELEASED}" section`)
  return body !== ''
}

export interface StampOptions {
  /** Fold earlier version sections into the new one instead of dropping them. */
  carryForward?: boolean
}

/** The non-empty bodies of the version sections `carryForward` folds in, newest first. */
function carriedNotes(changelog: string): string[] {
  return splitChangelog(changelog)
    .sections.filter((s) => isReleaseVersion(s.name))
    .map((s) => findSectionBody(changelog, s.name) ?? '')
    .filter((body) => body !== '')
}

/** Whether a bump with these options would have anything to release. */
export function hasNotesToRelease(
  changelog: string,
  { carryForward = false }: StampOptions = {},
): boolean {
  return hasUnreleasedNotes(changelog) || (carryForward && carriedNotes(changelog).length > 0)
}

/**
 * Rename `Unreleased` to `version`, open a new empty `Unreleased` above it, and
 * drop every earlier version section, or fold their notes in below the
 * `Unreleased` notes when `carryForward` is set.
 */
export function stampChangelog(
  changelog: string,
  version: string,
  { carryForward = false }: StampOptions = {},
): string {
  getReleaseChannel(version)
  if (!hasNotesToRelease(changelog, { carryForward })) {
    throw new Error(`CHANGELOG.md's "${UNRELEASED}" section is empty; there is nothing to release.`)
  }
  const { preamble, sections } = splitChangelog(changelog)
  if (sections.some((s) => s.name === version)) {
    throw new Error(`CHANGELOG.md already has a "## ${version}" section`)
  }
  const carried = carryForward ? carriedNotes(changelog) : []
  const kept: ChangelogSection[] = []
  for (const section of sections) {
    if (section.name === UNRELEASED) {
      const notes = [findSectionBody(changelog, UNRELEASED) ?? '', ...carried].filter(
        (body) => body !== '',
      )
      kept.push(
        { name: UNRELEASED, text: `## ${UNRELEASED}\n\n` },
        carried.length === 0
          ? { name: version, text: section.text.replace(`## ${UNRELEASED}`, `## ${version}`) }
          : { name: version, text: `## ${version}\n\n${notes.join('\n\n')}\n\n` },
      )
    } else if (!isReleaseVersion(section.name)) {
      kept.push(section)
    }
  }
  return preamble + kept.map((s) => s.text).join('')
}

/** Replace the top-level `"version"` in package.json text, keeping its formatting. */
export function setPackageVersion(packageJson: string, version: string): string {
  const pattern = /^( {2}"version": )"[^"]*"/m
  if (!pattern.test(packageJson)) throw new Error('package.json has no top-level "version" line')
  return packageJson.replace(pattern, `$1${JSON.stringify(version)}`)
}

const USAGE = 'Usage: node scripts/release-bump.mts [--skip-if-empty] [--carry-forward] [version]'

function main(): void {
  let skipIfEmpty = false
  let carryForward = false
  let requested: string | undefined
  for (const arg of process.argv.slice(2)) {
    if (arg === '--skip-if-empty') skipIfEmpty = true
    else if (arg === '--carry-forward') carryForward = true
    else if (arg.startsWith('-') || requested !== undefined) throw new Error(USAGE)
    else requested = arg
  }

  const changelogUrl = new URL('../CHANGELOG.md', import.meta.url)
  const packageUrl = new URL('../package.json', import.meta.url)
  const changelog = readFileSync(changelogUrl, 'utf8')
  if (skipIfEmpty && !hasNotesToRelease(changelog, { carryForward })) {
    console.error(`CHANGELOG.md's "${UNRELEASED}" section is empty; nothing to release.`)
    return
  }

  const current = packageVersion()
  const next = requested ?? nextBetaVersion(current)
  if (compareReleaseVersions(next, current) <= 0) {
    throw new Error(`${next} is not newer than the current version ${current}`)
  }

  const stamped = stampChangelog(changelog, next, { carryForward })
  writeFileSync(packageUrl, setPackageVersion(readFileSync(packageUrl, 'utf8'), next))
  writeFileSync(changelogUrl, stamped)
  // stdout carries only the new version, so the workflow can tell a bump from a skip.
  process.stdout.write(`${next}\n`)
}

// Importing this module for its pure helpers must not print, write, or exit.
if (isDirectExecution(import.meta.url, 'release-bump')) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

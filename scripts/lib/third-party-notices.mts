/**
 * Keeps THIRD_PARTY_NOTICES.md in step with what the app ships.
 *
 * The generated licence report (`scripts/write-third-party-licenses.mts`)
 * carries every component's licence text. THIRD_PARTY_NOTICES.md records
 * something different: for each component whose licence is more than
 * attribution — copyleft, file-level copyleft, a dual licence Copse must elect
 * between — how Copse meets it. That record is only true while it matches the
 * shipped set, and it rots silently: an entry quotes a version that has since
 * been bumped, a new MPL package arrives in a bundle with no entry, a "not
 * shipped" claim stops being true. {@link findNoticeProblems} catches each.
 *
 * The file's machine-readable conventions:
 *
 * - An entry heading ends with the npm package name in parentheses:
 *   `## noVNC (@novnc/novnc)`. Headings without one (fonts, prose sections)
 *   are not linted.
 * - A `## Not shipped: …` heading lists, in parentheses, the packages it claims
 *   are absent: `(sharp, @img/sharp-libvips-*)`. A trailing `*` is a prefix.
 * - `Version X is bundled` / `Version X is shipped` in an entry is checked
 *   against the shipped version.
 * - An entry for a dual-licensed (`OR`) component must say which licence Copse
 *   elects, with the word "elects".
 */

/**
 * Licences whose only obligation is to pass on the copyright notice and licence
 * text (and, for Apache-2.0, any NOTICE file). The generated report does that
 * for every component, so these need no entry of their own.
 */
const ATTRIBUTION_ONLY_LICENSES: ReadonlySet<string> = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
  'Zlib',
])

/** The slice of a shipped component the lint reads. */
export interface ShippedComponent {
  name: string
  version: string
  /** The declared SPDX expression. */
  license: string
}

export interface NoticeEntry {
  heading: string
  /** The package the entry is about, from the heading's parentheses. */
  packageName: string
  /** The version the entry says ships, if it quotes one. */
  version: string | null
  body: string
}

export interface NotShippedClaim {
  heading: string
  /** Package names, or prefixes ending in `*`. */
  patterns: string[]
}

export interface ParsedNotices {
  entries: NoticeEntry[]
  notShipped: NotShippedClaim[]
}

const HEADING_RE = /^## (.+?)\s*$/gm
const TRAILING_PARENS_RE = /\(([^()]+)\)$/
const NOT_SHIPPED_RE = /^Not shipped:/i
const VERSION_RE = /\bVersion (\d+\.\d+\.\d+[\w.+-]*) is (?:bundled|shipped)\b/
const PACKAGE_NAME_RE = /^(?:@[\w.-]+\/)?[\w.-]+\*?$/

export function parseNotices(markdown: string): ParsedNotices {
  const headings = [...markdown.matchAll(HEADING_RE)]
  const entries: NoticeEntry[] = []
  const notShipped: NotShippedClaim[] = []
  headings.forEach((match, i) => {
    const heading = match[1] ?? ''
    const start = match.index + match[0].length
    const end = headings[i + 1]?.index ?? markdown.length
    const body = markdown.slice(start, end)
    const inner = TRAILING_PARENS_RE.exec(heading)?.[1]
    if (inner === undefined) return
    const names = inner.split(',').map((name) => name.trim())
    if (!names.every((name) => PACKAGE_NAME_RE.test(name))) return
    if (NOT_SHIPPED_RE.test(heading)) {
      notShipped.push({ heading, patterns: names })
      return
    }
    for (const packageName of names) {
      entries.push({ heading, packageName, version: VERSION_RE.exec(body)?.[1] ?? null, body })
    }
  })
  return { entries, notShipped }
}

function licenseIds(expression: string): string[] {
  return expression
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND|WITH)\s+|\s+/i)
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

/** True when the licence asks for more than attribution, or offers a choice. */
export function needsNoticeEntry(license: string): boolean {
  if (/\bOR\b/i.test(license)) return true
  return licenseIds(license).some((id) => !ATTRIBUTION_ONLY_LICENSES.has(id))
}

function matchesPattern(name: string, pattern: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern
}

export interface NoticeProblem {
  subject: string
  problem: string
}

/**
 * Every way THIRD_PARTY_NOTICES.md disagrees with `components`.
 *
 * `complete` says whether `components` is the whole shipped set. The build has
 * it (bundles plus node_modules plus vendored); a unit test without a build has
 * only the node_modules closure, so it cannot tell a bundled package from one
 * that no longer ships, and skips that one rule.
 */
export function findNoticeProblems(
  notices: ParsedNotices,
  components: readonly ShippedComponent[],
  options: { complete: boolean },
): NoticeProblem[] {
  const problems: NoticeProblem[] = []
  const byName = new Map<string, ShippedComponent[]>()
  for (const component of components) {
    byName.set(component.name, [...(byName.get(component.name) ?? []), component])
  }
  const entriesByName = new Map(notices.entries.map((entry) => [entry.packageName, entry]))

  for (const [name, shipped] of byName) {
    const needing = shipped.filter((component) => needsNoticeEntry(component.license))
    const first = needing[0]
    if (first === undefined) continue
    const entry = entriesByName.get(name)
    if (!entry) {
      problems.push({
        subject: `${name}@${first.version}`,
        problem: `ships under ${first.license} but THIRD_PARTY_NOTICES.md has no "## … (${name})" entry`,
      })
      continue
    }
    if (/\bOR\b/i.test(first.license) && !/\belects\b/i.test(entry.body)) {
      problems.push({
        subject: `${name}@${first.version}`,
        problem: `is dual-licensed (${first.license}); its entry must say which licence Copse elects`,
      })
    }
  }

  for (const entry of notices.entries) {
    const shipped = byName.get(entry.packageName) ?? []
    if (shipped.length === 0) {
      if (options.complete) {
        problems.push({
          subject: entry.packageName,
          problem: `has an entry ("## ${entry.heading}") but no longer ships`,
        })
      }
      continue
    }
    if (entry.version !== null && !shipped.some((c) => c.version === entry.version)) {
      problems.push({
        subject: entry.packageName,
        problem: `entry says version ${entry.version}, but ${shipped.map((c) => c.version).join(', ')} ships`,
      })
    }
  }

  for (const claim of notices.notShipped) {
    for (const pattern of claim.patterns) {
      for (const component of components) {
        if (matchesPattern(component.name, pattern)) {
          problems.push({
            subject: `${component.name}@${component.version}`,
            problem: `ships, but "## ${claim.heading}" says it does not`,
          })
        }
      }
    }
  }
  return problems
}

export function formatNoticeProblems(problems: readonly NoticeProblem[]): string {
  return (
    `THIRD_PARTY_NOTICES.md is out of date (${String(problems.length)} problem(s)):\n` +
    problems.map(({ subject, problem }) => `  ${subject}: ${problem}`).join('\n')
  )
}

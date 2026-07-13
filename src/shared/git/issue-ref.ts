/**
 * Normalized GitHub issue references for roadmap items (issue #556 follow-up).
 *
 * A roadmap item can be pinned to the issue it is meant to solve. The pin is
 * stored in the note's frontmatter as a short, human-readable ref rather than a
 * URL so the OKF file stays legible and survives a remote rename:
 *
 * - `#123`           — an issue in the workspace repo
 * - `owner/repo#123` — an issue elsewhere
 *
 * `parseIssueRef` accepts what people actually paste (`123`, `#123`,
 * `owner/repo#123`, or a full github.com issue URL) and canonicalizes it;
 * `issueRefToUrl` turns a stored ref back into a link, resolving `#123`
 * against the workspace's `owner/repo` slug at click time.
 */

const SHORT_REF = /^#?(\d+)$/
const FULL_REF = /^([\w.-]+\/[\w.-]+)#(\d+)$/
const ISSUE_URL = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)(?:[/?#].*)?$/

/** Canonicalize a pasted issue reference, or null when unrecognizable. */
export function parseIssueRef(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  const short = SHORT_REF.exec(raw)
  if (short) return `#${short[1] ?? ''}`
  const full = FULL_REF.exec(raw)
  if (full) return `${full[1] ?? ''}#${full[2] ?? ''}`
  const url = ISSUE_URL.exec(raw)
  if (url) return `${url[1] ?? ''}/${url[2] ?? ''}#${url[3] ?? ''}`
  return null
}

/**
 * URL for a stored ref. `repoSlug` (`owner/repo`) anchors short `#123` refs;
 * null when the ref is short and no slug is known (no remote → no link).
 */
export function issueRefToUrl(ref: string, repoSlug: string | null): string | null {
  const full = FULL_REF.exec(ref)
  if (full) return `https://github.com/${full[1] ?? ''}/issues/${full[2] ?? ''}`
  const short = SHORT_REF.exec(ref)
  if (short) return repoSlug ? `https://github.com/${repoSlug}/issues/${short[1] ?? ''}` : null
  return null
}

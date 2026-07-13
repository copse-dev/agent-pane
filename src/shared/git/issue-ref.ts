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
  const coords = resolveIssueRef(ref, repoSlug)
  return coords
    ? `https://github.com/${coords.owner}/${coords.repo}/issues/${String(coords.number)}`
    : null
}

/**
 * Owner/repo/number coordinates for a stored ref, anchoring short `#123` refs
 * on `repoSlug`; null when the ref is malformed or a short ref has no slug.
 */
export function resolveIssueRef(
  ref: string,
  repoSlug: string | null,
): { owner: string; repo: string; number: number } | null {
  const full = FULL_REF.exec(ref)
  if (full) {
    const [owner, repo] = (full[1] ?? '').split('/')
    if (!owner || !repo) return null
    return { owner, repo, number: Number(full[2]) }
  }
  const short = SHORT_REF.exec(ref)
  if (short && repoSlug) {
    const [owner, repo] = repoSlug.split('/')
    if (!owner || !repo) return null
    return { owner, repo, number: Number(short[1]) }
  }
  return null
}

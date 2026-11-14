const MAX_EXTERNAL_URL_CHARS = 2048

export interface ExternalLinkReview {
  href: string
  host: string
}

export function externalLinkConfirmationDetail(review: ExternalLinkReview): string {
  return `Destination: ${review.host}\n\nFull URL:\n${review.href}\n\nThis opens in your system browser outside Copse.`
}

/** Renderer URLs are untrusted data, including those produced by window.open. */
export function externalLinkReview(rawUrl: string): ExternalLinkReview | null {
  if (rawUrl.length > MAX_EXTERNAL_URL_CHARS || /[\u0000-\u001f\u007f]/.test(rawUrl)) return null
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  // The OS browser may parse a raw URL differently from this validator. Show
  // and open the same canonical URL produced by one parser.
  if (parsed.href.length > MAX_EXTERNAL_URL_CHARS) return null
  return { href: parsed.href, host: parsed.host }
}

/** Open only the exact URL the native confirmation reviewed. */
export async function openExternalWithConsent(
  rawUrl: string,
  confirm: (review: ExternalLinkReview) => Promise<boolean>,
  open: (href: string) => Promise<void>,
): Promise<boolean> {
  const review = externalLinkReview(rawUrl)
  if (!review || !(await confirm(review))) return false
  await open(review.href)
  return true
}

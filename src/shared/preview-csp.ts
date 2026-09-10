/** Additive CSP for local previews. Inline code is needed for self-contained artefacts. */
export const PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

/** First in the document: untrusted HTML cannot precede or relax this policy. */
export function securePreviewHtml(html: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">${html}`
}

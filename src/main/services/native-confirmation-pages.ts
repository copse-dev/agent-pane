/** Keep each OS alert readable while showing the entire main-owned action. */
export const NATIVE_CONFIRMATION_PAGE_CHARS = 4_000
export const NATIVE_CONFIRMATION_MAX_CHARS = 128_000

export function nativeConfirmationPages(detail: string): string[] {
  if (detail.length > NATIVE_CONFIRMATION_MAX_CHARS) {
    throw new Error('The requested action is too large to confirm safely')
  }
  if (detail.length === 0) return ['']
  const pages: string[] = []
  for (let start = 0; start < detail.length;) {
    let end = Math.min(start + NATIVE_CONFIRMATION_PAGE_CHARS, detail.length)
    const last = detail.charCodeAt(end - 1)
    const next = detail.charCodeAt(end)
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1
    pages.push(detail.slice(start, end))
    start = end
  }
  return pages
}

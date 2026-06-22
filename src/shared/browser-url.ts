/** Normalize user-entered text into a URL suitable for navigation. */
export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'about:blank'
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (
    /^[\w.-]+\.[a-z]{2,}(:\d+)?(\/|$|\?|#)/i.test(trimmed) ||
    /^localhost(:\d+)?(\/|$|\?|#)/i.test(trimmed)
  ) {
    return `https://${trimmed}`
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

/** Short label for a browser tab from a loaded URL. */
export function browserTabLabel(url: string, title?: string): string {
  const trimmedTitle = title?.trim()
  if (trimmedTitle && trimmedTitle !== 'about:blank') return trimmedTitle
  if (!url || url === 'about:blank') return 'New tab'
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'about:') return 'New tab'
    return parsed.hostname || url
  } catch {
    return url
  }
}

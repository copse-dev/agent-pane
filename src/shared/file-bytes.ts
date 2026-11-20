/**
 * Small filename/size helpers shared by every attachment kind (videos,
 * archives) and the tools that read them. They live here rather than beside one
 * media type so a second kind does not have to import from the first.
 */

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

/**
 * Keep a stored attachment name free of anything path-like. The name comes
 * from a renderer-supplied `File`, so it is untrusted input on the way to a
 * filesystem path even though the directory itself is ours. Caps the name at
 * 80 characters without cutting into the (lower-cased) extension, and returns
 * `fallback` when nothing safe is left.
 */
export function sanitizeStoredFileName(name: string, fallback: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '')
  const extension = fileExtension(safe)
  const stem = safe.slice(0, safe.length - extension.length)
  return stem.slice(0, 80 - extension.length) + extension || fallback
}

/** `1.4 MB` — used on composer chips, in model-facing notes, and in tool errors. */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
  if (bytes < 1024) return `${String(Math.round(bytes))} B`
  const units = ['KB', 'MB', 'GB']
  // Decide the unit from the rounded text so 1048575 bytes reads `1.0 MB`, not `1024 KB`.
  const render = (value: number): string =>
    value < 9.95 ? value.toFixed(1) : Math.round(value).toString()
  let value = bytes / 1024
  let unit = 0
  while (Number(render(value)) >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${render(value)} ${units[unit] ?? 'GB'}`
}

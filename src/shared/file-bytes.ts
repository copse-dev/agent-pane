/**
 * Small filename/size helpers shared by every attachment kind (videos,
 * archives) and the tools that read them. They live here rather than beside one
 * media type so a second kind does not have to import from the first.
 */

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

/** `1.4 MB` — used on composer chips, in model-facing notes, and in tool errors. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value).toString()} ${units[unit] ?? 'GB'}`
}

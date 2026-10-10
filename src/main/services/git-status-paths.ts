/** Paths out of `git status --porcelain=v1 -z`, with rename/copy sources folded in. */
export function changedPaths(raw: string): string[] {
  const out: string[] = []
  const entries = raw.split('\0').filter(Boolean)
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (!entry || entry.length < 4 || entry[2] !== ' ') continue
    const path = entry.slice(3)
    if (path) out.push(path)
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
      const source = entries[index + 1]
      if (source && !(source.length >= 3 && source[2] === ' ')) {
        out.push(source)
        index++
      }
    }
  }
  return [...new Set(out)]
}

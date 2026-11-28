/**
 * A native module that fails to load on macOS reports one dyld line packing the
 * file, every path dyld tried and why it rejected each:
 *
 *   Error: dlopen(<file>, 0x0001): tried: '<file>' (code signature in <…> '<file>' not valid for
 *   use in process: mapping process and mapped file (non-platform) have different Team IDs),
 *   '/System/Volumes/Preboot/Cryptexes/OS<file>' (no such file), …
 *
 * pnpm's install reporter cuts lines at the terminal width, so only the start of
 * that line survives. `describeDlopenFailures` restates each failure so every
 * reason starts a short line of its own.
 */

const DLOPEN_LINE = /dlopen\(([^,]+), \w+\): (.+)$/
// `'<path>' (<reason>)`, where a reason holds at most one level of parentheses.
const TRIED_ENTRY = /'([^']*)' \(((?:[^()]|\([^()]*\))*)\)/g

function reasonsFrom(detail: string): string[] {
  const reasons = new Set<string>()
  for (const [, tried = '', reason = ''] of detail.matchAll(TRIED_ENTRY)) {
    // dyld also looks in the OS cryptex and shared cache, which never hold an addon.
    if (reason.startsWith('no such file')) continue
    reasons.add(reason.replaceAll(` '${tried}'`, ''))
  }
  return reasons.size > 0 ? [...reasons] : [detail]
}

/** Lines restating every distinct dyld failure in `output`, or none when it has no such failure. */
export function describeDlopenFailures(output: string): string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const match = DLOPEN_LINE.exec(line)
    if (match === null || seen.has(match[0])) continue
    seen.add(match[0])
    const [, file = '', detail = ''] = match
    lines.push(`dlopen failed for ${file}`)
    for (const reason of reasonsFrom(detail)) {
      for (const part of reason.split(/(?<=:) /)) lines.push(`  ${part}`)
    }
  }
  return lines
}

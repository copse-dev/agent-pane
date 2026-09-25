// Parse TypeScript compiler diagnostics out of a typecheck's output, so a
// newly failing `tsc` becomes one finding per new diagnostic anchored at its
// file and line, rather than one finding per command. Both of tsc's line
// formats are recognised:
//
//   src/a.ts(12,5): error TS2322: Type 'x' is not assignable to type 'y'.
//   src/a.ts:12:5 - error TS2322: Type 'x' is not assignable to type 'y'.
//
// Everything else in the output (the `pretty` context lines, summaries) is
// ignored. A path may hold parentheses (Next.js route groups such as
// `app/(auth)/page.tsx`); the location suffix is what ends it. The parser is deliberately dumb: it never executes, never follows
// paths, and treats the text as data.

export interface TscDiagnostic {
  readonly path: string
  readonly line: number
  readonly column: number
  readonly code: string
  readonly message: string
}

const DIAGNOSTIC_PATTERN =
  /^(?<path>\S.*?)(?:\((?<line1>\d+),(?<col1>\d+)\):|:(?<line2>\d+):(?<col2>\d+) -) error (?<code>TS\d+): (?<message>.+)$/

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

export function parseTscDiagnostics(output: string): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = []
  for (const raw of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC_PATTERN.exec(stripAnsi(raw).trimEnd())
    const groups = match?.groups
    if (!groups) continue
    const line = Number.parseInt(groups['line1'] ?? groups['line2'] ?? '', 10)
    const column = Number.parseInt(groups['col1'] ?? groups['col2'] ?? '', 10)
    const path = groups['path']
    const code = groups['code']
    const message = groups['message']
    if (
      !Number.isFinite(line) ||
      !Number.isFinite(column) ||
      path === undefined ||
      code === undefined ||
      message === undefined
    ) {
      continue
    }
    diagnostics.push({
      path: path.replace(/\\/g, '/'),
      line,
      column,
      code,
      message: message.trim(),
    })
  }
  return diagnostics
}

/**
 * The key two diagnostics are compared on across base and head. Line and
 * column are left out on purpose: a diagnostic that merely moved is not new.
 */
export function diagnosticKey(diagnostic: TscDiagnostic): string {
  return `${diagnostic.path}\u0000${diagnostic.code}\u0000${diagnostic.message}`
}

/** Diagnostics present on head and absent (by {@link diagnosticKey}) on base. */
export function newDiagnostics(
  base: readonly TscDiagnostic[],
  head: readonly TscDiagnostic[],
): TscDiagnostic[] {
  const known = new Set(base.map(diagnosticKey))
  const seen = new Set<string>()
  const fresh: TscDiagnostic[] = []
  for (const diagnostic of head) {
    const key = diagnosticKey(diagnostic)
    if (known.has(key) || seen.has(key)) continue
    seen.add(key)
    fresh.push(diagnostic)
  }
  return fresh
}

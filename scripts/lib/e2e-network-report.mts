import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from './safe-json.mts'

/**
 * Summarise the outbound network guard's `[e2e-network-guard]` log lines
 * (tests/e2e/helpers/network-guard.ts) into one row per host, kind and process,
 * with the specs that produced it. CI prints this after every e2e shard.
 */

export const NETWORK_GUARD_PREFIX = '[e2e-network-guard] '

const GuardLine = z.object({
  spec: z.string().nullable(),
  test: z.string(),
  source: z.string(),
  process: z.string(),
  kind: z.string(),
  host: z.string(),
  port: z.number().nullable(),
  blocked: z.boolean(),
  detail: z.string().optional(),
  stack: z.array(z.string()).optional(),
})
type GuardLine = z.infer<typeof GuardLine>

const decodeGuardLine = decodeWithSchema(GuardLine)

export interface NetworkReportRow {
  host: string
  port: number | null
  kind: string
  process: string
  blocked: boolean
  count: number
  specs: string[]
  /** First initiator seen: a Node stack frame or Chromium's request detail. */
  initiator: string
}

/** Parse every guard line in `text`; other output and malformed lines are ignored. */
export function parseNetworkGuardLines(text: string): GuardLine[] {
  return text.split('\n').flatMap((line) => {
    const index = line.indexOf(NETWORK_GUARD_PREFIX)
    if (index === -1) return []
    const parsed = safeJsonParse(line.slice(index + NETWORK_GUARD_PREFIX.length), decodeGuardLine)
    return parsed ? [parsed] : []
  })
}

function specName(spec: string | null): string {
  if (spec === null) return '(unknown spec)'
  const match = /tests\/e2e\/[^/]+\.e2e\.ts$/.exec(spec)
  return match ? match[0] : spec
}

export function summariseNetworkGuard(lines: readonly GuardLine[]): NetworkReportRow[] {
  const rows = new Map<string, NetworkReportRow>()
  for (const line of lines) {
    // A hostname lookup and its connect describe one attempt; keep both, they name different layers.
    const key = [line.host, String(line.port), line.kind, line.process, String(line.blocked)].join(
      '\u0000',
    )
    const row = rows.get(key) ?? {
      host: line.host,
      port: line.port,
      kind: line.kind,
      process: line.process,
      blocked: line.blocked,
      count: 0,
      specs: [],
      initiator: line.stack?.[0] ?? line.detail ?? '',
    }
    row.count += 1
    const spec = specName(line.spec)
    if (!row.specs.includes(spec)) row.specs.push(spec)
    rows.set(key, row)
  }
  return [...rows.values()].sort(
    (a, b) => b.specs.length - a.specs.length || a.host.localeCompare(b.host),
  )
}

export function renderNetworkReport(rows: readonly NetworkReportRow[]): string {
  if (rows.length === 0) return 'No non-loopback network attempts were recorded.\n'
  const cell = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ')
  const lines = [
    '| Host | Kind | Process | Blocked | Count | Specs | First initiator |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows
      .map((row) =>
        [
          row.port === null ? row.host : `${row.host}:${String(row.port)}`,
          row.kind,
          row.process,
          row.blocked ? 'yes' : 'no',
          String(row.count),
          row.specs.length > 5
            ? `${row.specs.slice(0, 5).join(', ')} (+${String(row.specs.length - 5)} more)`
            : row.specs.join(', '),
          row.initiator.slice(0, 160),
        ]
          .map(cell)
          .join(' | '),
      )
      .map((line) => `| ${line} |`),
  ]
  return `${lines.join('\n')}\n`
}

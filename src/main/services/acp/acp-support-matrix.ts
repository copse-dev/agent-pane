import type { AcpCapabilityReport, AcpCapabilitySnapshot } from './acp-capability-probe.ts'
import type {
  AcpContinuityCwd,
  AcpContinuityMethod,
  AcpContinuitySnapshot,
  AcpContinuityTrial,
} from './acp-continuity-probe.ts'

/**
 * Render {@link AcpCapabilityReport}s into the two committed artifacts of the
 * Tier-1 ACP eval: a human-readable Markdown support matrix and a machine
 * JSON snapshot. Both are pure functions of the reports so they unit-test
 * without spawning anything.
 *
 * The matrix is capabilities-as-rows, agents-as-columns — the shape you read
 * down a column to see "what does Claude support" and across a row to compare
 * agents on one capability. Every row is a fact the ACP spec leaves OPTIONAL or
 * UNSTABLE, which is exactly why it has to be measured per agent+adapter rather
 * than assumed.
 */

const CELL = { yes: '✓', no: '·', unknown: '—' } as const

function boolCell(value: boolean): string {
  return value ? CELL.yes : CELL.no
}

interface Row {
  label: string
  /** Cell text per report (aligned with the reports array). Null → unknown/errored. */
  cell: (snapshot: AcpCapabilitySnapshot) => string
  /** Marks a capability the spec flags UNSTABLE / not-yet-standard. */
  unstable?: boolean
}

const ROWS: Row[] = [
  { label: 'Protocol version', cell: (s) => String(s.protocolVersion) },
  { label: 'Agent / adapter version', cell: (s) => s.agentInfo?.version ?? CELL.unknown },
  { label: 'Session load (resume prior)', cell: (s) => boolCell(s.loadSession) },
  { label: 'session/resume', cell: (s) => boolCell(s.sessionResume) },
  { label: 'session/list', cell: (s) => boolCell(s.sessionList) },
  { label: 'session/delete', cell: (s) => boolCell(s.sessionDelete) },
  { label: 'session/close', cell: (s) => boolCell(s.sessionClose) },
  { label: 'session/fork', cell: (s) => boolCell(s.sessionFork), unstable: true },
  { label: 'additionalDirectories', cell: (s) => boolCell(s.additionalDirectories) },
  { label: 'Prompt: image', cell: (s) => boolCell(s.promptImage) },
  { label: 'Prompt: audio', cell: (s) => boolCell(s.promptAudio) },
  { label: 'Prompt: embedded context', cell: (s) => boolCell(s.promptEmbeddedContext) },
  { label: 'MCP over http', cell: (s) => boolCell(s.mcpHttp) },
  { label: 'MCP over sse', cell: (s) => boolCell(s.mcpSse) },
  { label: 'MCP over acp', cell: (s) => boolCell(s.mcpAcp), unstable: true },
  { label: 'Session modes', cell: (s) => (s.modes ? String(s.modes.available.length) : CELL.no) },
  { label: 'Model selector (count)', cell: (s) => (s.models ? String(s.models.count) : CELL.no) },
  { label: 'Auth methods', cell: (s) => String(s.authMethods.length) },
  {
    // A lower bound, not a fact: agents register commands asynchronously (often
    // one MCP server at a time), so a fixed settle window samples a race. Marked
    // `≥` and footnoted so the count is never read as authoritative.
    label: 'Slash commands (on connect)',
    cell: (s) => (s.slashCommands.length > 0 ? `≥${String(s.slashCommands.length)}` : CELL.no),
  },
  {
    label: '_meta keys',
    cell: (s) => (s.metaKeys.length > 0 ? String(s.metaKeys.length) : CELL.no),
  },
]

/**
 * Observed-continuity rows, rendered only when a report carries the Tier-2
 * continuity trials (`--continuity`). These are what an agent DID across a
 * restart, not what it advertises: `✓` it remembered, `forgot` it accepted the
 * reattach and did not remember, `✗` it refused, `·` not advertised, `—` not
 * probed or inconclusive.
 */
function continuityOf(report: AcpCapabilityReport): AcpContinuitySnapshot | null {
  const continuity = report.continuity
  return continuity && 'trials' in continuity ? continuity : null
}

function trialOf(
  snapshot: AcpContinuitySnapshot,
  method: AcpContinuityMethod,
  cwd: AcpContinuityCwd,
): AcpContinuityTrial | undefined {
  return snapshot.trials.find((trial) => trial.method === method && trial.cwd === cwd)
}

function trialCell(trial: AcpContinuityTrial | undefined): string {
  if (!trial) return CELL.unknown
  switch (trial.outcome) {
    case 'recalled':
      // A new-cwd continuation must also hold across the next restart there.
      return trial.survivesSecondRestart === false ? '✓ (lost on 2nd restart)' : CELL.yes
    case 'forgot':
      return 'forgot'
    case 'rejected':
      return '✗'
    case 'unsupported':
      return CELL.no
    case 'error':
      return CELL.unknown
  }
}

/**
 * The capability a thread moving into its worktree needs: SOME method carried
 * the conversation into a new cwd and kept it there across a further restart.
 */
function resumeInNewCwdCell(snapshot: AcpContinuitySnapshot): string {
  const methods = (['load', 'resume'] as const).filter((method) => {
    const trial = trialOf(snapshot, method, 'new')
    return trial?.outcome === 'recalled' && trial.survivesSecondRestart !== false
  })
  if (methods.length > 0) return `${CELL.yes} ${methods.join(' + ')}`
  const tried = snapshot.trials.some(
    (trial) => trial.cwd === 'new' && trial.outcome !== 'unsupported',
  )
  return tried ? '✗' : CELL.no
}

const CONTINUITY_ROWS: { label: string; cell: (snapshot: AcpContinuitySnapshot) => string }[] = [
  { label: 'Resume in new cwd (observed)', cell: resumeInNewCwdCell },
  { label: 'Restart → session/load, same cwd', cell: (s) => trialCell(trialOf(s, 'load', 'same')) },
  { label: 'Restart → session/load, new cwd', cell: (s) => trialCell(trialOf(s, 'load', 'new')) },
  {
    label: 'Restart → session/resume, same cwd',
    cell: (s) => trialCell(trialOf(s, 'resume', 'same')),
  },
  {
    label: 'Restart → session/resume, new cwd',
    cell: (s) => trialCell(trialOf(s, 'resume', 'new')),
  },
]

function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|')
}

/** Render the Markdown support matrix for a set of probe reports. */
export function renderMatrixMarkdown(
  reports: readonly AcpCapabilityReport[],
  meta: { probedAt?: string; host?: string } = {},
): string {
  const lines: string[] = []
  lines.push('# ACP agent support matrix')
  lines.push('')
  lines.push('> Generated by `npm run probe:acp` (Tier-1 capability probe). Each cell is what the')
  lines.push(
    '> agent negotiated at `initialize` / `session/new` — no prompt is sent, so this reflects',
  )
  lines.push(
    '> advertised capabilities, not runtime behaviour. `✓` supported · `·` not advertised · `—` agent failed to probe.',
  )
  lines.push('')
  if (meta.probedAt) lines.push(`- Probed at: ${meta.probedAt}`)
  if (meta.host) lines.push(`- Host: ${meta.host}`)
  lines.push('')

  if (reports.length === 0) {
    lines.push('_No agents were probed. Install an ACP agent (see `npm run detect:acp`) first._')
    lines.push('')
    return lines.join('\n')
  }

  const header = ['Capability', ...reports.map((r) => escapePipes(r.title))]
  lines.push(`| ${header.join(' | ')} |`)
  lines.push(`| ${header.map(() => '---').join(' | ')} |`)

  for (const row of ROWS) {
    const label = row.unstable ? `${row.label} _(unstable)_` : row.label
    const cells = reports.map((report) =>
      report.ok && report.snapshot ? escapePipes(row.cell(report.snapshot)) : CELL.unknown,
    )
    lines.push(`| ${[label, ...cells].join(' | ')} |`)
  }
  if (reports.some((report) => report.continuity !== undefined)) {
    for (const row of CONTINUITY_ROWS) {
      const cells = reports.map((report) => {
        const continuity = continuityOf(report)
        return continuity ? escapePipes(row.cell(continuity)) : CELL.unknown
      })
      lines.push(`| ${[row.label, ...cells].join(' | ')} |`)
    }
  }
  lines.push('')
  if (reports.some((report) => report.continuity !== undefined)) {
    lines.push(
      '> The _Restart_ rows are observed, not advertised: `--continuity` restarts each agent, ' +
        'reattaches with that method, and asks for a codeword planted before the restart (this ' +
        'DOES spend tokens). `✓` remembered · `forgot` reattached without the conversation · ' +
        '`✗` refused · `·` not advertised · `—` not probed or inconclusive.',
    )
    lines.push('')
  }
  lines.push(
    '> `≥` on _Slash commands_ is a lower bound: agents register commands asynchronously ' +
      '(often one MCP server at a time), so the fixed settle window samples whatever has arrived. ' +
      'Widen it with `--settle <ms>` for a fuller count.',
  )
  lines.push('')

  // Per-agent detail: errors, model/mode/command/_meta lists that don't fit a cell.
  lines.push('## Details')
  lines.push('')
  for (const report of reports) {
    lines.push(`### ${report.title} (\`${report.agentId}\`)`)
    lines.push('')
    lines.push(`- Command: \`${[report.command, ...report.args].join(' ')}\``)
    if (!report.ok || !report.snapshot) {
      lines.push(`- **Probe failed:** ${report.error ?? 'unknown error'}`)
      lines.push('')
      continue
    }
    const s = report.snapshot
    if (s.agentInfo) {
      lines.push(`- Agent info: ${s.agentInfo.name} ${s.agentInfo.version}`)
    }
    if (s.protocolVersion !== report.requestedProtocolVersion) {
      lines.push(
        `- **Protocol negotiated down:** requested v${String(report.requestedProtocolVersion)}, agent settled on v${String(s.protocolVersion)}`,
      )
    }
    if (s.modes) {
      lines.push(`- Modes: ${s.modes.available.join(', ')} (current: ${s.modes.current})`)
    }
    if (s.models) {
      const sample = s.models.sample.join(', ')
      lines.push(
        `- Models: ${String(s.models.count)}${sample ? ` — ${sample}${s.models.count > s.models.sample.length ? ', …' : ''}` : ''}`,
      )
    }
    if (s.authMethods.length > 0) {
      lines.push(`- Auth methods: ${s.authMethods.map((m) => `${m.name} (${m.id})`).join(', ')}`)
    }
    if (s.slashCommands.length > 0) {
      lines.push(`- Slash commands on connect: ${s.slashCommands.join(', ')}`)
    }
    if (s.observedUpdateKinds.length > 0) {
      lines.push(`- Updates pushed on connect: ${s.observedUpdateKinds.join(', ')}`)
    }
    if (s.unstableCapabilities.length > 0) {
      lines.push(`- Unstable capabilities advertised: ${s.unstableCapabilities.join(', ')}`)
    }
    if (s.metaKeys.length > 0) {
      lines.push(`- \`_meta\` keys: ${s.metaKeys.map((k) => `\`${k}\``).join(', ')}`)
    }
    if (report.continuity && 'error' in report.continuity) {
      lines.push(`- **Continuity trials failed:** ${report.continuity.error}`)
    }
    for (const trial of continuityOf(report)?.trials ?? []) {
      if (trial.error) {
        lines.push(
          `- Continuity ${trial.method}/${trial.cwd}-cwd: ${trial.outcome} — ${trial.error}`,
        )
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}

/** The JSON snapshot shape: full, verbatim reports plus run metadata. */
export interface AcpSupportMatrixJson {
  generatedBy: string
  probedAt?: string
  host?: string
  reports: readonly AcpCapabilityReport[]
}

/** Build the machine-readable snapshot object (serialize with `JSON.stringify`). */
export function buildMatrixJson(
  reports: readonly AcpCapabilityReport[],
  meta: { probedAt?: string; host?: string } = {},
): AcpSupportMatrixJson {
  return {
    generatedBy: 'npm run probe:acp',
    ...(meta.probedAt ? { probedAt: meta.probedAt } : {}),
    ...(meta.host ? { host: meta.host } : {}),
    reports,
  }
}

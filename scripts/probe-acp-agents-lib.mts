import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { hostname, platform, release } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { KNOWN_ACP_AGENTS } from '../src/shared/acp-known-agents.ts'
import {
  probeAgentCapabilities,
  type AcpCapabilityReport,
} from '../src/main/services/acp/acp-capability-probe.ts'
import {
  buildMatrixJson,
  renderMatrixMarkdown,
} from '../src/main/services/acp/acp-support-matrix.ts'

/**
 * Tier-1 ACP eval runner (`npm run probe:acp`): probe the installed known ACP
 * agents (Claude, Codex, Cursor, Gemini, …), then write a Markdown support
 * matrix and a JSON snapshot and echo the matrix. No prompt is sent — this
 * records what each agent+adapter negotiates at connect time.
 *
 * Flags:
 *   --agent <id>   Probe only this catalog agent (repeatable). Default: all installed.
 *   --all          Also attempt agents not found on PATH (they show as failed).
 *   --out <path>   Basename for outputs; writes <path>.md and <path>.json.
 *                  Default: docs/acp-support-matrix
 *   --no-write     Print only; don't write files.
 *   --settle <ms>  Post-connect update drain window (default 750).
 */

const run = promisify(execFile)

interface Args {
  agents: string[]
  all: boolean
  out: string
  write: boolean
  settleMs: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    agents: [],
    all: false,
    out: 'docs/acp-support-matrix',
    write: true,
    settleMs: 750,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--agent') args.agents.push(argv[++i] ?? '')
    else if (flag === '--all') args.all = true
    else if (flag === '--no-write') args.write = false
    else if (flag === '--out') args.out = argv[++i] ?? args.out
    else if (flag === '--settle') args.settleMs = Number(argv[++i] ?? args.settleMs)
  }
  args.agents = args.agents.filter(Boolean)
  return args
}

async function resolveOnPath(command: string): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await run(finder, [command], { timeout: 4000 })
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0)
    return first ? first.trim() : null
  } catch {
    return null
  }
}

/** Build the env overlay for an agent from its declared env hints, if set. */
function envFor(envHints: readonly string[] | undefined): Record<string, string> | undefined {
  if (!envHints || envHints.length === 0) return undefined
  const env: Record<string, string> = {}
  for (const name of envHints) {
    const value = process.env[name]
    if (value) env[name] = value
  }
  return Object.keys(env).length > 0 ? env : undefined
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const cwd = process.cwd()

  const catalog = args.agents.length
    ? KNOWN_ACP_AGENTS.filter((a) => args.agents.includes(a.id))
    : KNOWN_ACP_AGENTS

  if (args.agents.length) {
    const unknown = args.agents.filter((id) => !KNOWN_ACP_AGENTS.some((a) => a.id === id))
    if (unknown.length) {
      console.warn(`Unknown agent id(s), skipping: ${unknown.join(', ')}`)
    }
  }

  const targets = await Promise.all(
    catalog.map(async (agent) => ({ agent, path: await resolveOnPath(agent.command) })),
  )

  const toProbe = args.all ? targets : targets.filter((t) => t.path !== null)

  if (toProbe.length === 0) {
    console.log('No known ACP agents found on PATH. Install one (see `npm run detect:acp`),')
    console.log('or pass --all to record them as unavailable in the matrix.')
    return
  }

  console.log(
    `Probing ${String(toProbe.length)} agent(s): ${toProbe.map((t) => t.agent.id).join(', ')}\n`,
  )

  const reports: AcpCapabilityReport[] = []
  for (const { agent, path } of toProbe) {
    process.stdout.write(`  ${agent.title} … `)
    if (path === null) {
      reports.push({
        agentId: agent.id,
        title: agent.title,
        command: agent.command,
        args: agent.args,
        ok: false,
        error: 'not installed (not on PATH)',
      })
      console.log('not installed')
      continue
    }
    const env = envFor(agent.envHints)
    const report = await probeAgentCapabilities(
      {
        agentId: agent.id,
        title: agent.title,
        command: agent.command,
        args: agent.args,
        ...(env ? { env } : {}),
        cwd,
      },
      { settleMs: args.settleMs },
    )
    reports.push(report)
    console.log(report.ok ? 'ok' : `failed (${report.error ?? 'unknown'})`)
  }

  const meta = {
    probedAt: new Date().toISOString(),
    host: `${platform()} ${release()} (${hostname()})`,
  }
  const markdown = renderMatrixMarkdown(reports, meta)
  const json = buildMatrixJson(reports, meta)

  console.log(`\n${markdown}`)

  if (args.write) {
    const mdPath = resolve(cwd, `${args.out}.md`)
    const jsonPath = resolve(cwd, `${args.out}.json`)
    await mkdir(dirname(mdPath), { recursive: true })
    await writeFile(mdPath, markdown, 'utf-8')
    await writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`, 'utf-8')
    console.log(`Wrote ${args.out}.md and ${args.out}.json`)
  }
}

await main()

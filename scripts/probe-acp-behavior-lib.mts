import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { hostname, platform, release } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { KNOWN_ACP_AGENTS } from '../src/shared/acp-known-agents.ts'
import {
  DEFAULT_BEHAVIOR_PROMPT,
  probeAgentBehavior,
  type AcpBehaviorReport,
} from '../src/main/services/acp/acp-behavior-probe.ts'
import {
  buildBehaviorMatrixJson,
  renderBehaviorMatrixMarkdown,
} from '../src/main/services/acp/acp-behavior-matrix.ts'

/**
 * Tier-2 ACP behavioural eval runner (`npm run probe:acp:behavior`): prompt
 * each installed known ACP agent once and record write routing, permission
 * payloads, and mid-turn `_meta`. Spends model tokens — opt-in only.
 *
 * Flags:
 *   --agent <id>   Probe only this catalog agent (repeatable). Default: all installed.
 *   --all          Also attempt agents not found on PATH (they show as failed).
 *   --out <path>   Basename for outputs; writes <path>.md and <path>.json.
 *                  Default: docs/acp-behavior-matrix
 *   --no-write     Print only; don't write files.
 *   --timeout <ms> Per-agent turn timeout (default 120000).
 *   --prompt <text> Override the default write-marker prompt.
 */

const run = promisify(execFile)

interface Args {
  agents: string[]
  all: boolean
  out: string
  write: boolean
  timeoutMs: number
  prompt: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    agents: [],
    all: false,
    out: 'docs/acp-behavior-matrix',
    write: true,
    timeoutMs: 120_000,
    prompt: DEFAULT_BEHAVIOR_PROMPT,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--agent') args.agents.push(argv[++i] ?? '')
    else if (flag === '--all') args.all = true
    else if (flag === '--no-write') args.write = false
    else if (flag === '--out') args.out = argv[++i] ?? args.out
    else if (flag === '--timeout') args.timeoutMs = Number(argv[++i] ?? args.timeoutMs)
    else if (flag === '--prompt') args.prompt = argv[++i] ?? args.prompt
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
    `Behaviour-probing ${String(toProbe.length)} agent(s): ${toProbe.map((t) => t.agent.id).join(', ')}`,
  )
  console.log(`Prompt: ${args.prompt.slice(0, 120)}${args.prompt.length > 120 ? '…' : ''}\n`)

  const reports: AcpBehaviorReport[] = []
  for (const { agent, path } of toProbe) {
    process.stdout.write(`  ${agent.title} … `)
    if (path === null) {
      reports.push({
        agentId: agent.id,
        title: agent.title,
        command: agent.command,
        args: agent.args,
        prompt: args.prompt,
        ok: false,
        error: 'not installed (not on PATH)',
      })
      console.log('not installed')
      continue
    }
    const env = envFor(agent.envHints)
    const report = await probeAgentBehavior(
      {
        agentId: agent.id,
        title: agent.title,
        command: agent.command,
        args: agent.args,
        ...(env ? { env } : {}),
        cwd,
      },
      { prompt: args.prompt, timeoutMs: args.timeoutMs },
    )
    reports.push(report)
    if (report.ok && report.snapshot) {
      console.log(`ok (${report.snapshot.writeRouting})`)
    } else {
      console.log(`failed (${report.error ?? 'unknown'})`)
    }
  }

  const meta = {
    probedAt: new Date().toISOString(),
    host: `${platform()} ${release()} (${hostname()})`,
  }
  const markdown = renderBehaviorMatrixMarkdown(reports, meta)
  const json = buildBehaviorMatrixJson(reports, meta)

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

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}

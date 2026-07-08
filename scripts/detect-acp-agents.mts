// Tiny, self-contained detector for ACP agents already on this device. Lists
// which known agents are installed (on PATH) and which are currently running,
// then prints a ready-to-paste `registeredAcpAgents` block for the installed
// ones.
//
//   node scripts/detect-acp-agents.mts        (or: npm run detect:acp)
//
// Standalone on purpose — no build step, runs anywhere with node. The catalog
// below mirrors src/shared/acp-known-agents.ts (the app's in-built "Detect"
// button uses that copy); keep the two in sync when adding agents.

import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

interface KnownAgent {
  id: string
  title: string
  command: string
  args: string[]
  envHints?: string[]
  install?: string
  setup?: string
  note?: string
}

const KNOWN_AGENTS: KnownAgent[] = [
  {
    id: 'gemini-cli',
    title: 'Gemini CLI',
    command: 'gemini',
    args: ['--experimental-acp'],
    envHints: ['GEMINI_API_KEY'],
    install: 'npm install -g @google/gemini-cli',
    setup: 'gemini',
    note: 'Sign in by running `gemini` once, or set GEMINI_API_KEY.',
  },
  {
    id: 'claude-agent-acp',
    title: 'Claude Agent (ACP)',
    command: 'claude-agent-acp',
    args: [],
    envHints: ['ANTHROPIC_API_KEY'],
    install: 'npm install -g @agentclientprotocol/claude-agent-acp',
    setup: 'claude setup-token',
    note: 'Claude Agent SDK over ACP. Auth with `claude setup-token` or ANTHROPIC_API_KEY.',
  },
  {
    id: 'claude-code-acp',
    title: 'Claude Code (ACP, Zed)',
    command: 'claude-code-acp',
    args: [],
    envHints: ['ANTHROPIC_API_KEY'],
    install: 'npm install -g @zed-industries/claude-code-acp',
    setup: 'claude setup-token',
    note: "Zed's Claude Code ACP adapter. Auth with `claude setup-token` or ANTHROPIC_API_KEY.",
  },
  {
    id: 'cursor',
    title: 'Cursor',
    command: 'cursor-agent',
    args: ['acp'],
    install: 'curl https://cursor.com/install | bash',
    setup: 'cursor-agent login',
    note: 'Cursor CLI as a native ACP server (`cursor-agent acp`). Sign in with `cursor-agent login`.',
  },
  {
    id: 'codex',
    title: 'Codex',
    command: 'codex-acp',
    args: [],
    envHints: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
    install: 'npm install -g @agentclientprotocol/codex-acp',
    setup: 'codex login',
    note: 'OpenAI Codex over ACP. Sign in with `codex login` (ChatGPT), or set CODEX_API_KEY.',
  },
]

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

async function runningCommands(): Promise<Set<string>> {
  if (process.platform === 'win32') return new Set()
  try {
    const { stdout } = await run('ps', ['-axww', '-o', 'args='], {
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    })
    const commands = new Set<string>()
    for (const line of stdout.split(/\r?\n/)) {
      const argv0 = line.trim().split(/\s+/)[0]
      if (argv0) commands.add(basename(argv0))
    }
    return commands
  } catch {
    return new Set()
  }
}

const running = await runningCommands()
const detected = await Promise.all(
  KNOWN_AGENTS.map(async (agent) => {
    const path = await resolveOnPath(agent.command)
    return { ...agent, installed: path !== null, path, running: running.has(agent.command) }
  }),
)

console.log('ACP agents on this device\n')
for (const agent of detected) {
  const mark = agent.installed ? '✓ installed' : '✗ not installed'
  const run = agent.running ? ', running now' : ''
  console.log(`${mark}${run}  ${agent.title}  (command: ${agent.command})`)
  if (agent.installed && agent.path) console.log(`    path:    ${agent.path}`)
  else if (agent.install) console.log(`    install: ${agent.install}`)
  if (agent.setup) console.log(`    sign in: ${agent.setup}`)
  if (agent.note) console.log(`    note:    ${agent.note}`)
}

const installed = detected.filter((agent) => agent.installed)
if (installed.length === 0) {
  console.log('\nNo known ACP agents found on PATH. Install one with the `install` command')
  console.log('above (the agent is a separate program, not bundled with Copse), then')
  console.log('authenticate with its `sign in` command. See docs/acp-agents.md.')
  process.exit(0)
}

const config = installed.map((agent) => ({
  id: agent.id,
  title: agent.title,
  command: agent.command,
  ...(agent.args.length ? { args: agent.args } : {}),
  ...(agent.envHints?.length
    ? { env: Object.fromEntries(agent.envHints.map((name) => [name, ''])) }
    : {}),
  enabled: true,
}))

console.log('\nAdd these to the `registeredAcpAgents` setting (fill in any env values):\n')
console.log(JSON.stringify(config, null, 2))
console.log('\nOr set them live from the app DevTools console:')
console.log(`  await window.api.settings.set('registeredAcpAgents', ${JSON.stringify(config)})`)

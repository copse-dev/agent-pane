import type { McpServerConfig } from '@shared/types/mcp.ts'

const CHILD_ENV_PREFIX = 'COPSE_PROJECT_MCP_CHILD_ENV_'

// The wrapper shell and sandbox launcher never see project-supplied variable
// names such as BASH_ENV, DYLD_INSERT_LIBRARIES or NODE_OPTIONS. They are
// decoded and applied only by this small Node process after the OS sandbox is
// already active. The server inherits the same stdio pipes, without a relay.
const PROJECT_MCP_LAUNCHER = `
const { spawn } = require('node:child_process')
const prefix = '${CHILD_ENV_PREFIX}'
const entries = Object.entries(process.env)
const base = entries.filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !key.startsWith(prefix))
const additions = entries.filter(([key]) => key.startsWith(prefix))
  .map(([key, value]) => [Buffer.from(key.slice(prefix.length), 'hex').toString('utf8'), value])
const child = spawn(process.argv[1], process.argv.slice(2), {
  env: Object.fromEntries([...base, ...additions]),
  stdio: 'inherit',
  shell: false,
})
child.on('error', (error) => { console.error(error); process.exitCode = 127 })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
`

export function projectMcpLauncher(cfg: McpServerConfig): {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
} {
  if (cfg.command === undefined) throw new Error('Project MCP server has no command')
  const env: NodeJS.ProcessEnv = {
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '',
    BASH_ENV: '',
    ENV: '',
    LD_PRELOAD: '',
    DYLD_INSERT_LIBRARIES: '',
  }
  for (const [key, value] of Object.entries(cfg.env ?? {})) {
    env[`${CHILD_ENV_PREFIX}${Buffer.from(key, 'utf8').toString('hex')}`] = value
  }
  return {
    command: process.execPath,
    args: ['-e', PROJECT_MCP_LAUNCHER, cfg.command, ...(cfg.args ?? [])],
    env,
  }
}

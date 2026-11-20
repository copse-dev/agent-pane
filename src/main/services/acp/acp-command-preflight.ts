import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { parseAcpModel } from '@shared/acp.ts'
import { isRecord } from '@shared/unknown-value.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { withSandboxShellPath } from '../../project-sandbox/sandbox-argv.ts'
import { getAcpAgent } from './acp-agent-registry.ts'
import { buildAcpAgentEnv } from './acp-client.ts'

/** Read-only executable lookup; uncertain platform/path cases keep normal startup. */
async function commandAvailable(command: string, env: NodeJS.ProcessEnv): Promise<boolean | null> {
  if (process.platform === 'win32') return null
  if (!isAbsolute(command) && command.includes('/')) return null
  const directories = (env['PATH'] ?? '/usr/bin:/bin').split(delimiter)
  const candidates = isAbsolute(command)
    ? [command]
    : directories.filter(isAbsolute).map((directory) => join(directory, command))
  let uncertain = !isAbsolute(command) && directories.some((directory) => !isAbsolute(directory))
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue
      await access(candidate, constants.X_OK)
      return true
    } catch (error) {
      if (!isRecord(error) || !['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(error['code']))) {
        uncertain = true
      }
    }
  }
  return uncertain ? null : false
}

interface CommandPreflightDependencies {
  getAgent?: (id: string) => AcpAgentConfig | null
  available?: typeof commandAvailable
}

/** No adapter process, credentials, network, or model request is needed for this check. */
export async function preflightLocalAcpModel(
  model: string | undefined,
  cwd: string,
  dependencies: CommandPreflightDependencies = {},
): Promise<void> {
  const id = model ? parseAcpModel(model) : null
  if (id === null) return
  const agent = (dependencies.getAgent ?? getAcpAgent)(id)
  const recovery = 'Open Settings → General → Models & agents to set it up, then retry.'
  if (!agent) throw new Error(`The selected coding agent is not enabled. ${recovery}`)
  const env = buildAcpAgentEnv({
    command: agent.command,
    cwd,
    ...(agent.env ? { env: agent.env } : {}),
  })
  const available = dependencies.available ?? commandAvailable
  // Sandboxed launch adds system shell paths. Reject only when neither launch
  // environment can resolve it; the original lookup preserves uncertain paths.
  if (
    (await available(agent.command, env)) === false &&
    (await available(agent.command, withSandboxShellPath(env))) === false
  ) {
    throw new Error(
      `${agent.title} cannot start because its configured command is missing or not executable. ${recovery}`,
    )
  }
}

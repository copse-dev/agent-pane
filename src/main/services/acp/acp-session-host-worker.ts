/**
 * Standalone host for one long-lived sandboxed ACP agent (phase 5 of
 * docs/plans/sandbox-network-scope-isolation.md).
 *
 * ASRT's network policy is a per-process singleton. This helper initializes its
 * own manager, spawns the real agent under that manager, and transparently
 * relays stdin/stdout. The Electron main process therefore retains the ACP
 * connection and all UI callbacks without sharing this agent's network scope.
 *
 * Must stay free of electron and node-pty imports so it can run as a plain Node
 * bundle. Diagnostics use stderr; stdout is reserved byte-for-byte for ACP.
 */
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { errorMessage } from '@shared/errors.ts'
import type { AcpAgentSandboxConfig } from '@shared/types/acp.ts'
import { isRecord, parseJsonUnknown } from '@shared/unknown-value.ts'
import { baseSandboxConfig } from '../../project-sandbox/config.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { spawnAcpAgentProcess, terminateAcpChild, type AcpAgentSpawnConfig } from './acp-client.ts'
import {
  ACP_SESSION_HOST_REQUEST_ENV,
  type AcpSessionHostMessage,
} from './acp-session-host-protocol.ts'

interface SessionHostRequest {
  config: AcpAgentSpawnConfig
  allowLocalhost: boolean
}

function send(message: AcpSessionHostMessage): void {
  if (process.send) process.send(message)
}

function readStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return result
}

function readStringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined
}

function readSandbox(value: unknown): AcpAgentSandboxConfig | undefined {
  if (!isRecord(value)) return undefined
  const allowedDomains = readStringList(value['allowedDomains'])
  if (!allowedDomains) return undefined
  const homeDirs = readStringList(value['homeDirs'])
  const scratchPaths = readStringList(value['scratchPaths'])
  return {
    allowedDomains,
    ...(homeDirs ? { homeDirs } : {}),
    ...(scratchPaths ? { scratchPaths } : {}),
  }
}

export function parseSessionHostRequest(raw: string): SessionHostRequest | null {
  let parsed: unknown
  try {
    parsed = parseJsonUnknown(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !isRecord(parsed['config'])) return null
  const input = parsed['config']
  const command = input['command']
  const cwd = input['cwd']
  const sandbox = readSandbox(input['sandbox'])
  if (typeof command !== 'string' || typeof cwd !== 'string' || !sandbox) return null
  const args = readStringList(input['args'])
  const env = readStringMap(input['env'])
  return {
    config: {
      command,
      cwd,
      sandbox,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
    },
    allowLocalhost: parsed['allowLocalhost'] === true,
  }
}

async function initHostSandbox(): Promise<void> {
  await SandboxManager.initialize(
    baseSandboxConfig(),
    ({ host, port }) => {
      send({ type: 'network-denial', host, ...(port !== undefined ? { port } : {}) })
      return Promise.resolve(false)
    },
    false,
  )
  setProjectSandboxEnabled(true)
}

function agentBaseEnv(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === ACP_SESSION_HOST_REQUEST_ENV || key === 'ELECTRON_RUN_AS_NODE') continue
    result[key] = value
  }
  return result
}

async function main(): Promise<void> {
  const request = parseSessionHostRequest(process.env[ACP_SESSION_HOST_REQUEST_ENV] ?? '')
  if (!request) {
    send({ type: 'error', error: 'invalid ACP session host request' })
    process.exitCode = 1
    return
  }
  try {
    await initHostSandbox()
  } catch (err) {
    send({ type: 'error', error: `ACP session host sandbox init failed: ${errorMessage(err)}` })
    process.exitCode = 1
    return
  }

  let child
  try {
    // Keep the agent in the host's process group: disposing the host then kills
    // the complete host + sandbox wrapper + agent tree with one group signal.
    child = await spawnAcpAgentProcess(request.config, {
      detached: false,
      allowLocalhost: request.allowLocalhost,
      // The host-only request contains a duplicate JSON copy of the config
      // (including explicitly configured credentials), and Electron-as-Node is
      // an implementation detail. Neither may leak into the real agent.
      baseEnv: agentBaseEnv(),
    })
  } catch (err) {
    send({ type: 'error', error: `ACP session host spawn failed: ${errorMessage(err)}` })
    await SandboxManager.reset().catch(() => {})
    process.exitCode = 1
    return
  }

  const stdin = child.stdin
  const stdout = child.stdout
  if (!stdin || !stdout) {
    send({ type: 'error', error: 'ACP session host agent has no stdio pipes' })
    terminateAcpChild(child)
    await SandboxManager.reset().catch(() => {})
    process.exitCode = 1
    return
  }

  let exiting = false
  const exitAfterReset = async (code: number): Promise<void> => {
    if (exiting) return
    exiting = true
    await SandboxManager.reset().catch(() => {})
    process.exit(code)
  }
  child.stderr?.pipe(process.stderr)
  process.stdin.pipe(stdin)
  stdout.pipe(process.stdout)
  process.stdin.once('end', () => {
    terminateAcpChild(child)
  })
  child.once('error', (err) => {
    console.error(`[acp-session-host] agent process error: ${errorMessage(err)}`)
    void exitAfterReset(1)
  })
  child.once('close', (code, signal) => {
    if (signal) console.error(`[acp-session-host] agent exited with signal ${signal}`)
    void exitAfterReset(code ?? (signal ? 1 : 0))
  })
  const stop = (): void => {
    terminateAcpChild(child)
    setTimeout(() => void exitAfterReset(0), 2_500)
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  send({ type: 'ready' })
}

if (process.env[ACP_SESSION_HOST_REQUEST_ENV] !== undefined) {
  void main().catch((err: unknown) => {
    send({ type: 'error', error: errorMessage(err) })
    process.exit(1)
  })
}

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { errorMessage } from '@shared/errors.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { recordNetworkDenial } from '../../project-sandbox/network-scope.ts'
import { detachForGroupKill } from '../../project-sandbox/sandbox-argv.ts'
import { terminateProcessTree } from '../exec/subprocess-kill.ts'
import type { AcpAgentSpawnConfig } from './acp-client.ts'
import {
  ACP_SESSION_HOST_REQUEST_ENV,
  type AcpSessionHostMessage,
} from './acp-session-host-protocol.ts'

/** Bound startup separately from the session's intentionally long lifetime. */
const SESSION_HOST_START_TIMEOUT_MS = 15_000

export function acpSessionHostWorkerPath(): string {
  return join(__dirname, 'acp-session-host-worker.js')
}

function readHostMessage(value: unknown): AcpSessionHostMessage | null {
  if (!isRecord(value)) return null
  const type = value['type']
  if (type === 'ready') return { type }
  if (type === 'error' && typeof value['error'] === 'string') {
    return { type, error: value['error'] }
  }
  if (type === 'network-denial' && typeof value['host'] === 'string') {
    const port = value['port']
    return {
      type,
      host: value['host'],
      ...(typeof port === 'number' ? { port } : {}),
    }
  }
  return null
}

/**
 * Spawn the transparent stdio host for one sandboxed, long-lived ACP session.
 *
 * The worker owns its own ASRT singleton and spawns the real agent inside it;
 * this process sees the worker as an ordinary ACP stdio child. Keeping the ACP
 * protocol in the main process preserves approvals, update streaming, session
 * pooling, and the native-tool bridge while isolating the process-global
 * network allowlist that motivated phase 5.
 */
export function spawnSandboxedAcpSessionHost(config: AcpAgentSpawnConfig): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    // The host only needs fields that affect spawning/confinement. MCP servers,
    // model choices and permission modes stay in the main-process ACP protocol.
    const request = {
      config: {
        command: config.command,
        cwd: config.cwd,
        ...(config.args ? { args: config.args } : {}),
        ...(config.env ? { env: config.env } : {}),
        ...(config.sandbox ? { sandbox: config.sandbox } : {}),
      },
      allowLocalhost: Boolean(config.nativeBridge),
    }
    const child = spawn(process.execPath, [acpSessionHostWorkerPath()], {
      cwd: config.cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        [ACP_SESSION_HOST_REQUEST_ENV]: JSON.stringify(request),
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: detachForGroupKill,
    })
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const fail = (err: unknown): void => {
      finish(() => {
        terminateProcessTree(child)
        reject(err instanceof Error ? err : new Error(errorMessage(err)))
      })
    }
    const timer = setTimeout(() => {
      fail(
        new Error(
          `ACP session host did not start within ${String(SESSION_HOST_START_TIMEOUT_MS)}ms`,
        ),
      )
    }, SESSION_HOST_START_TIMEOUT_MS)

    child.on('message', (value: unknown) => {
      const message = readHostMessage(value)
      if (!message) return
      if (message.type === 'network-denial') {
        recordNetworkDenial(message.host, message.port)
        console.warn(
          `[acp-session-host] network denied: ${message.host}:${String(message.port ?? '?')}`,
        )
        return
      }
      if (message.type === 'error') {
        fail(new Error(message.error))
        return
      }
      finish(() => {
        resolve(child)
      })
    })
    child.once('error', fail)
    child.once('close', (code, signal) => {
      fail(
        new Error(
          `ACP session host exited before startup (code ${String(code)}, signal ${String(signal)})`,
        ),
      )
    })
  })
}

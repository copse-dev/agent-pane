/**
 * Own ASRT for one approved loopback-binding background task. ASRT's proxy
 * allowlist is process-global, so the task must not share the main process's
 * manager with unrelated, already-running contained commands.
 *
 * The worker and its command stay in one process group. The parent's normal
 * background-task stop/timeout signal therefore reaches the complete tree.
 */
import { spawn } from 'node:child_process'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { errorMessage } from '@shared/errors.ts'
import { envForRendererChildProcess } from '../services/exec/child-process-env.ts'
import { baseSandboxConfig, ensureWorkspaceTmpDir } from './config.ts'
import { acquireSandboxNetworkScope } from './network-scope.ts'
import { isSpawnableWorkingDirectory } from './spawn-cwd.ts'
import {
  resolveSandboxShellExecutable,
  shellForSandboxWrap,
  withSandboxShellPath,
} from './sandbox-argv.ts'
import { sandboxTmpDirFor, withSandboxTmpEnv, withSandboxWrapTmpDir } from './tmp-env.ts'
import { parsePortBindingRequest, PORT_BINDING_REQUEST_ENV } from './port-binding-protocol.ts'

function send(message: unknown): void {
  if (process.send) process.send(message)
}

function sendBeforeExit(message: unknown): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, 1_000)
    try {
      process.send(message, () => {
        clearTimeout(timer)
        resolve()
      })
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

async function main(): Promise<void> {
  const request = parsePortBindingRequest(process.env[PORT_BINDING_REQUEST_ENV] ?? '')
  if (!request || !(await isSpawnableWorkingDirectory(request.cwd))) {
    throw new Error('Invalid loopback task request or missing working directory')
  }
  await SandboxManager.initialize(
    baseSandboxConfig(),
    ({ host, port }) => {
      send({ type: 'network-denial', host, ...(port === undefined ? {} : { port }) })
      return Promise.resolve(false)
    },
    false,
  )
  if (!SandboxManager.isSandboxingEnabled()) {
    throw new Error(
      'Cannot start this background task safely because workspace protection did not start',
    )
  }

  const overlay = request.overlay
  const network = overlay.network
  const release = acquireSandboxNetworkScope({
    domains: network.allowedDomains,
    allowLocalBinding: network.allowLocalBinding,
    label: `background task: ${request.command}`,
  })
  try {
    const tmpDir = sandboxTmpDirFor(overlay, ensureWorkspaceTmpDir())
    const { argv, env } = await withSandboxWrapTmpDir(tmpDir, () =>
      SandboxManager.wrapWithSandboxArgv(
        request.command,
        shellForSandboxWrap(),
        overlay,
        undefined,
        request.cwd,
        request.violationId ? { commandId: request.violationId } : undefined,
      ),
    )
    const file = argv[0]
    if (!file) throw new Error('Sandbox wrap produced no executable')
    // The host-only request may contain explicit tool credentials. The real
    // command receives only its selected environment, never that JSON envelope.
    const baseEnv: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(env)) {
      if (key === PORT_BINDING_REQUEST_ENV || key === 'ELECTRON_RUN_AS_NODE') continue
      baseEnv[key] = value
    }
    const child = spawn(resolveSandboxShellExecutable(file), argv.slice(1), {
      cwd: request.cwd,
      env: withSandboxShellPath(
        withSandboxTmpEnv({ ...envForRendererChildProcess(baseEnv), ...request.env }, tmpDir),
      ),
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: false,
    })
    let exiting = false
    const finish = async (code: number): Promise<void> => {
      if (exiting) return
      exiting = true
      let count = 0
      if (request.violationId) {
        try {
          count = SandboxManager.getSandboxViolationStore().getViolationsForCommand(
            request.violationId,
          ).length
        } catch {
          // Missing runner telemetry must not strand the hosted task or its proxy.
        }
      }
      await sendBeforeExit({ type: 'violations', count })
      try {
        SandboxManager.cleanupAfterCommand()
      } finally {
        release()
        await SandboxManager.reset().catch(() => {})
      }
      process.exit(code)
    }
    child.once('error', (error) => {
      console.error(`[port-binding-worker] command failed: ${errorMessage(error)}`)
      void finish(1)
    })
    child.once('close', (code, signal) => {
      void finish(code ?? (signal ? 1 : 0))
    })
    // Parent stop/timeout signals the entire process group. Retain the worker
    // until the wrapped command closes so cleanup and the violation report run.
    process.once('SIGTERM', () => {})
    process.once('SIGINT', () => {})
  } catch (error) {
    release()
    await SandboxManager.reset().catch(() => {})
    throw error
  }
}

if (process.env[PORT_BINDING_REQUEST_ENV] !== undefined) {
  void main().catch((error: unknown) => {
    console.error(`[port-binding-worker] ${errorMessage(error)}`)
    process.exitCode = 1
  })
}

import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { spawnInProjectSandbox } from '../../project-sandbox/spawn.ts'
import { workspaceSandboxOverlay } from '../../project-sandbox/config.ts'
import { terminateProcessTree } from '../exec/subprocess-kill.ts'

const CLOSE_GRACE_MS = 2_000

interface SandboxedStdioParams {
  command: string
  args: string[]
  cwd: string
  sandboxRoot: string
  env: NodeJS.ProcessEnv
}

function waitForClose(child: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      done(false)
    }, CLOSE_GRACE_MS)
    const onClose = (): void => {
      done(true)
    }
    const done = (closed: boolean): void => {
      clearTimeout(timer)
      child.off('close', onClose)
      resolve(closed)
    }
    child.once('close', onClose)
  })
}

/**
 * The SDK's stdio transport spawns directly. Project definitions may point at
 * scripts the renderer can edit after consent, so their child must instead be
 * born inside Copse's enforcing project sandbox.
 */
export class SandboxedStdioClientTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  readonly stderr = new PassThrough()
  private readonly readBuffer = new ReadBuffer()
  private child: ChildProcess | null = null
  private started = false
  private closed = false
  private readonly params: SandboxedStdioParams

  constructor(params: SandboxedStdioParams) {
    this.params = params
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Sandboxed stdio transport already started')
    this.started = true
    let resolveStart = (): void => undefined
    let rejectStart = (_error: Error): void => undefined
    const started = new Promise<void>((resolve, reject) => {
      resolveStart = resolve
      rejectStart = reject
    })
    const spawned = spawnInProjectSandbox(this.params.command, this.params.args, {
      cwd: this.params.cwd,
      env: this.params.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      requireSandbox: true,
      sandboxConfig: workspaceSandboxOverlay(this.params.sandboxRoot),
      onChildCreated: (child) => {
        this.child = child
        child.once('spawn', resolveStart)
        child.once('error', rejectStart)
        child.on('close', () => {
          if (this.child === child) this.child = null
          this.closed = true
          this.readBuffer.clear()
          this.onclose?.()
        })
        child.on('error', (error: Error) => this.onerror?.(error))
        child.stdin?.on('error', (error: Error) => this.onerror?.(error))
        child.stdout?.on('error', (error: Error) => this.onerror?.(error))
        child.stdout?.on('data', (chunk: Buffer) => {
          try {
            this.readBuffer.append(chunk)
            for (;;) {
              const message = this.readBuffer.readMessage()
              if (message === null) break
              this.onmessage?.(message)
            }
          } catch (error) {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)))
            void this.close()
          }
        })
        child.stderr?.pipe(this.stderr)
        if (this.closed) {
          const cancelEscalation = terminateProcessTree(child)
          child.once('close', cancelEscalation)
          child.once('exit', cancelEscalation)
        }
      },
    })
    await Promise.all([spawned, started])
    if (this.closed) throw new Error('Sandboxed stdio transport closed during startup')
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child
    if (!child?.stdin || this.closed) throw new Error('Sandboxed stdio transport is not connected')
    const serialized = serializeMessage(message)
    if (child.stdin.write(serialized)) return
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        child.stdin?.off('error', failed)
        child.stdin?.off('drain', drained)
        child.off('close', closed)
      }
      const drained = (): void => {
        done()
        resolve()
      }
      const failed = (error: Error): void => {
        done()
        reject(error)
      }
      const closed = (): void => {
        failed(new Error('Sandboxed stdio transport closed'))
      }
      child.stdin?.once('error', failed)
      child.stdin?.once('drain', drained)
      child.once('close', closed)
    })
  }

  async close(): Promise<void> {
    this.closed = true
    const child = this.child
    this.child = null
    if (!child) {
      this.readBuffer.clear()
      return
    }
    child.stdin?.end()
    if (!(await waitForClose(child))) {
      const cancelEscalation = terminateProcessTree(child)
      child.once('close', cancelEscalation)
      child.once('exit', cancelEscalation)
      await waitForClose(child)
    }
    this.readBuffer.clear()
  }
}

import type { SshExecResult } from '@shared/types/ssh-workspace.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SshExecOptions, SshTransport } from './transport.ts'

interface FakeExecScript {
  when: RegExp
  stdout?: string
  stderr?: string
  code?: number
  fileBytes?: Uint8Array
  sizeBytes?: number
}

interface FakeSshTransportHooks {
  onConnect?: () => void
  onDisconnect?: () => void
}

/** In-memory SSH transport for unit tests. */
export class FakeSshTransport implements SshTransport {
  private connected = false
  private nextForwardPort = 45_000
  readonly forwards = new Map<number, number>()
  readonly calls: Array<{
    kind: 'argv' | 'shell' | 'fetch' | 'size'
    command: string
    localPath?: string
    options?: SshExecOptions
  }> = []
  private readonly scripts: FakeExecScript[]
  private readonly hooks: FakeSshTransportHooks

  constructor(scripts: FakeExecScript[] = [], hooks: FakeSshTransportHooks = {}) {
    this.scripts = scripts
    this.hooks = hooks
  }

  isConnected(): boolean {
    return this.connected
  }

  async connect(): Promise<void> {
    this.connected = true
    this.hooks.onConnect?.()
    await Promise.resolve()
  }

  async disconnect(): Promise<void> {
    this.forwards.clear()
    this.connected = false
    this.hooks.onDisconnect?.()
    await Promise.resolve()
  }

  async openForward(remotePort: number): Promise<{ localPort: number }> {
    if (!this.connected) throw new Error('SSH transport is not connected')
    const localPort = this.nextForwardPort++
    this.forwards.set(localPort, remotePort)
    return Promise.resolve({ localPort })
  }

  async closeForward(localPort: number): Promise<void> {
    this.forwards.delete(localPort)
    await Promise.resolve()
  }

  async fetchFile(
    remotePath: string,
    localPath: string,
    options: SshExecOptions = {},
  ): Promise<void> {
    this.calls.push({ kind: 'fetch', command: remotePath, localPath, options })
    options.signal?.throwIfAborted()
    const script = this.findScript(remotePath)
    if (!script?.fileBytes) throw new Error(`no fake file for: ${remotePath}`)
    if (options.maxBytes !== undefined && script.fileBytes.byteLength > options.maxBytes) {
      throw new Error(`SSH file transfer exceeded the ${String(options.maxBytes)} byte limit`)
    }
    await mkdir(dirname(localPath), { recursive: true })
    await writeFile(localPath, script.fileBytes)
    options.signal?.throwIfAborted()
  }

  async sizeOf(remotePath: string, options: SshExecOptions = {}): Promise<number> {
    this.calls.push({ kind: 'size', command: remotePath, options })
    options.signal?.throwIfAborted()
    const script = this.findScript(remotePath)
    const size = script?.sizeBytes ?? script?.fileBytes?.byteLength
    if (size === undefined) throw new Error(`no fake file size for: ${remotePath}`)
    return Promise.resolve(size)
  }

  async execArgv(argv: string[], options: SshExecOptions = {}): Promise<SshExecResult> {
    const command = argv.join(' ')
    this.calls.push({ kind: 'argv', command, options })
    return Promise.resolve(this.match(command))
  }

  async execShell(command: string, options: SshExecOptions = {}): Promise<SshExecResult> {
    this.calls.push({ kind: 'shell', command, options })
    return Promise.resolve(this.match(command))
  }

  private match(command: string): SshExecResult {
    const script = this.findScript(command)
    if (script) {
      return {
        stdout: script.stdout ?? '',
        stderr: script.stderr ?? '',
        code: script.code ?? 0,
      }
    }
    return { stdout: '', stderr: `no fake script for: ${command}`, code: 127 }
  }

  private findScript(command: string): FakeExecScript | undefined {
    return this.scripts.find((script) => script.when.test(command))
  }
}

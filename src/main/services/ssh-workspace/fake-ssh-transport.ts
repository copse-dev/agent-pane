import type { SshExecResult } from '@shared/types/ssh-workspace.ts'
import type { SshExecOptions, SshTransport } from './transport.ts'

interface FakeExecScript {
  when: RegExp
  stdout?: string
  stderr?: string
  code?: number
}

interface FakeSshTransportHooks {
  onConnect?: () => void
  onDisconnect?: () => void
}

/** In-memory SSH transport for unit tests. */
export class FakeSshTransport implements SshTransport {
  private connected = false
  readonly calls: { kind: 'argv' | 'shell'; command: string; options?: SshExecOptions }[] = []
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
    this.connected = false
    this.hooks.onDisconnect?.()
    await Promise.resolve()
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
    for (const script of this.scripts) {
      if (script.when.test(command)) {
        return {
          stdout: script.stdout ?? '',
          stderr: script.stderr ?? '',
          code: script.code ?? 0,
        }
      }
    }
    return { stdout: '', stderr: `no fake script for: ${command}`, code: 127 }
  }
}

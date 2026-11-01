import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { LLMProvider } from '@shared/types'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'
import {
  appleDesktopProbeArgs,
  appleDesktopProbeShortfall,
} from '../../../../scripts/lib/apple-desktop-probe.mts'
import {
  APPLE_DESKTOP_BOOTSTRAP,
  APPLE_DESKTOP_MAX_CONTROLLER,
} from '../../../../scripts/lib/apple-desktop-bootstrap.mts'
import {
  readAppleDesktopPin,
  verifyAppleDesktopCreatedImage,
} from '../../../../scripts/lib/apple-desktop-pin.mts'
import { beginDesktopLease, forgetDesktopLease, DESKTOP_LEASE_LABEL } from './desktop-recovery.ts'
import { EgressLink } from '../container-runtime/egress-link.ts'
import { HostInference } from '../container-runtime/host-inference.ts'
import { HOST_INFERENCE_TARGET } from '../container-runtime/host-inference-wire.ts'
import type { DesktopInput, DesktopTransport } from './desktop-session.ts'

const exec = promisify(execFile)
const inferenceEvent = z
  .object({
    event: z.literal('inference-data'),
    data: z
      .string()
      .max(90_000)
      .regex(/^[a-zA-Z0-9+/]+={0,2}$/),
  })
  .strict()

/** Fixed engine, image, guest entry point and resource policy; no caller-supplied host paths. */
export class AppleDesktopTransport implements DesktopTransport {
  private child: ChildProcessWithoutNullStreams | undefined
  private creation: Promise<unknown> | undefined
  private leaseCreation: Promise<string> | undefined
  private revoked = false
  private link: EgressLink | undefined
  private inference: HostInference | undefined
  private readonly incoming = new PassThrough()
  private readonly name: string
  private readonly provider: (maximum: number) => Promise<LLMProvider>

  constructor(name: string, provider: (maximum: number) => Promise<LLMProvider>) {
    this.name = name
    this.provider = provider
  }

  private async command(args: string[], signal?: AbortSignal): Promise<string> {
    return (
      await exec('/usr/local/bin/container', args, {
        timeout: 30_000,
        maxBuffer: 256 * 1024,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
        ...(signal ? { signal } : {}),
      })
    ).stdout
  }

  private write(value: unknown): Promise<void> {
    if (this.revoked || !this.child) return Promise.reject(new Error('Desktop grant revoked'))
    return new Promise((resolve, reject) => {
      this.child?.stdin.write(JSON.stringify(value) + '\n', (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async start(
    onLine: (line: string) => void,
    onExit: (error: Error) => void,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    if (process.platform !== 'darwin' || process.arch !== 'arm64')
      throw new Error('Isolated Copse desktop requires Apple silicon macOS and Apple container')
    const bundle = await readFile(join(__dirname, 'apple-desktop-guest.cjs'))
    const controller = bundle.toString('base64') + '\n'
    if (Buffer.byteLength(controller) > APPLE_DESKTOP_MAX_CONTROLLER)
      throw new Error('Desktop controller exceeds its transfer limit')
    signal.throwIfAborted()
    const pin = await readAppleDesktopPin()
    const base = appleDesktopProbeArgs(this.name, 'copse-desktop:local')
    const entrypoint = base.indexOf('--entrypoint')
    signal.throwIfAborted()
    this.leaseCreation = beginDesktopLease(this.name)
    const nonce = await this.leaseCreation
    signal.throwIfAborted()
    this.creation = this.command(
      [
        ...base.slice(0, entrypoint),
        '--label',
        DESKTOP_LEASE_LABEL + '=' + nonce,
        '--env',
        'COPSE_DESKTOP_INFERENCE=1',
        '--interactive',
        '--entrypoint',
        '/usr/bin/setpriv',
        'copse-desktop:local',
        '--no-new-privs',
        '--',
        '/usr/local/bin/node',
        '-e',
        APPLE_DESKTOP_BOOTSTRAP,
      ],
      signal,
    )
    await this.creation
    signal.throwIfAborted()
    const inspection = await this.command(['inspect', this.name], signal)
    const shortfall = appleDesktopProbeShortfall(this.name, inspection)
    verifyAppleDesktopCreatedImage(inspection, pin)
    if (shortfall) throw new Error('Refusing desktop startup: ' + shortfall)
    signal.throwIfAborted()
    const child = spawn(
      '/usr/local/bin/container',
      ['start', '--attach', '--interactive', this.name],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        signal,
        killSignal: 'SIGKILL',
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      },
    )
    this.child = child
    this.inference = new HostInference({
      provider: this.provider,
      tokenCeiling: 100_000,
      wallClockMs: 15 * 60_000,
      signal,
    })
    const outgoing = new Writable({
      write: (chunk: Buffer, _encoding, done): void => {
        this.write({ action: 'inference-data', data: chunk.toString('base64') }).then(() => {
          done()
        }, done)
      },
    })
    const link = new EgressLink(this.incoming, outgoing, {
      onOpen: (id, target): void => {
        if (this.revoked || target !== HOST_INFERENCE_TARGET) {
          link.refuse(id, 'Only the approved parent model is available')
          return
        }
        void this.inference?.serve(link.accept(id)).catch(onExit)
      },
    })
    this.link = link
    let pending = ''
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384)
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.revoked) return
      pending += chunk
      let newline: number
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.length > 6 * 1024 * 1024) {
          onExit(new Error('Guest event exceeds the limit'))
          return
        }
        const inference = safeJsonParse(line, decodeWithSchema(inferenceEvent))
        if (inference) {
          if (!this.incoming.write(Buffer.from(inference.data, 'base64'))) child.stdout.pause()
        } else onLine(line)
      }
      if (pending.length > 6 * 1024 * 1024)
        onExit(new Error('Unterminated guest event exceeds the limit'))
    })
    this.incoming.on('drain', () => child.stdout.resume())
    child.once('error', onExit)
    child.stdin.on('error', onExit)
    child.once('close', (code) => {
      if (!this.revoked) onExit(new Error('Guest desktop exited ' + String(code) + ': ' + stderr))
    })
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(controller, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  send(request: DesktopInput): Promise<void> {
    return this.write(request)
  }

  revoke(): void {
    this.revoked = true
    this.inference?.stop()
    this.link?.close(undefined)
    this.incoming.destroy()
    this.child?.kill('SIGKILL')
  }

  async remove(): Promise<void> {
    // Even a cancelled create may have succeeded in the engine before its reply was lost.
    if (!this.creation) {
      if (this.leaseCreation) {
        await this.leaseCreation.catch(() => undefined)
        await forgetDesktopLease(this.name)
      }
      return
    }
    await this.creation.catch(() => undefined)
    await this.command(['delete', '--force', this.name])
    await forgetDesktopLease(this.name)
  }
}

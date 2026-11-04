import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'
import type { ThreadExecutionOwner } from '../thread-execution-context.ts'
import {
  APPLE_DESKTOP_MAX_PNG,
  appleDesktopRequestSchema,
} from '../../../../scripts/lib/apple-desktop-wire.mts'

export type DesktopInput = z.infer<typeof appleDesktopRequestSchema>
export const desktopEventSchema = z.discriminatedUnion('event', [
  z
    .object({
      event: z.literal('ready'),
      title: z.string().min(1).max(1000),
      width: z.literal(1280),
      height: z.literal(800),
    })
    .strict(),
  z
    .object({
      event: z.literal('screenshot'),
      png: z
        .string()
        .max(Math.ceil(APPLE_DESKTOP_MAX_PNG / 3) * 4)
        .regex(/^[a-zA-Z0-9+/]+={0,2}$/),
    })
    .strict(),
  z.object({ event: z.literal('input-complete') }).strict(),
  z.object({ event: z.literal('stopped') }).strict(),
])
type DesktopEvent = z.infer<typeof desktopEventSchema>

/** All effects are injected at the process boundary, including deletion after a lost create reply. */
export interface DesktopTransport {
  start(
    onLine: (line: string) => void,
    onExit: (error: Error) => void,
    signal: AbortSignal,
  ): Promise<void>
  send(request: DesktopInput): Promise<void>
  remove(): Promise<void>
  revoke(): void
}
interface PendingEvent {
  resolve: (event: DesktopEvent) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** One session has one authority owner and at most one outstanding guest operation. */
export class DesktopSession {
  readonly id = randomUUID()
  private readonly controller = new AbortController()
  private pending: PendingEvent | undefined
  private revoked = false
  private removal: Promise<void> | undefined
  private readonly timer: NodeJS.Timeout
  readonly owner: ThreadExecutionOwner
  private readonly transport: DesktopTransport
  private readonly parentSignal: AbortSignal
  private readonly onCleanupError: (error: unknown) => void
  private readonly onRemoved: () => void
  private readonly abort = (): void => {
    void this.stop().catch(this.onCleanupError)
  }

  constructor(
    owner: ThreadExecutionOwner,
    transport: DesktopTransport,
    parentSignal: AbortSignal,
    onCleanupError: (error: unknown) => void,
    onRemoved: () => void = () => {},
    lifetimeMs = 15 * 60_000,
  ) {
    this.owner = owner
    this.transport = transport
    this.parentSignal = parentSignal
    this.onCleanupError = onCleanupError
    this.onRemoved = onRemoved
    this.timer = setTimeout(this.abort, lifetimeMs)
    this.timer.unref()
    parentSignal.addEventListener('abort', this.abort, { once: true })
  }

  private assertOwner(owner: ThreadExecutionOwner): void {
    if (owner.projectId !== this.owner.projectId || owner.threadId !== this.owner.threadId)
      throw new Error('This desktop belongs to another thread')
  }

  private assertActive(): void {
    if (this.parentSignal.aborted || this.revoked) throw new Error('Desktop grant revoked')
  }

  private wait(timeoutMs: number): Promise<DesktopEvent> {
    if (this.pending) throw new Error('A desktop operation is already in progress')
    if (this.revoked || this.parentSignal.aborted) throw new Error('Desktop grant revoked')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('Desktop response timed out'))
      }, timeoutMs)
      this.pending = { resolve, reject, timer }
    })
  }

  private receive = (line: string): void => {
    if (this.revoked) return
    if (Buffer.byteLength(line) > 6 * 1024 * 1024) {
      this.fail(new Error('Guest desktop event exceeds the limit'))
      return
    }
    const event = safeJsonParse(line, decodeWithSchema(desktopEventSchema))
    const pending = this.pending
    if (!event || !pending) {
      this.fail(new Error('Unexpected guest desktop event'))
      return
    }
    this.pending = undefined
    clearTimeout(pending.timer)
    pending.resolve(event)
  }

  private fail = (error: Error): void => {
    const pending = this.pending
    this.pending = undefined
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    void this.stop().catch(this.onCleanupError)
  }

  async start(): Promise<string> {
    const ready = this.wait(60_000)
    // A transport can reject before its first event; attach a handler immediately.
    void ready.catch(() => undefined)
    try {
      await this.transport.start(this.receive, this.fail, this.controller.signal)
      this.assertActive()
      const event = await ready
      this.assertActive()
      if (event.event !== 'ready') throw new Error('Expected desktop readiness')
      return event.title
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async execute(owner: ThreadExecutionOwner, input: DesktopInput): Promise<Buffer | undefined> {
    this.assertOwner(owner)
    const request = appleDesktopRequestSchema.parse(input)
    if (request.action === 'stop') {
      await this.stop()
      return
    }
    const result = this.wait(20_000)
    void result.catch(() => undefined)
    try {
      await this.transport.send(request)
      const event = await result
      if (this.revoked || this.parentSignal.aborted) throw new Error('Desktop grant revoked')
      if (request.action !== 'screenshot') {
        if (event.event !== 'input-complete')
          throw new Error('Expected desktop input acknowledgement')
        return
      }
      if (event.event !== 'screenshot') throw new Error('Expected desktop screenshot')
      const png = Buffer.from(event.png, 'base64')
      if (
        png.length < 24 ||
        png.length > APPLE_DESKTOP_MAX_PNG ||
        !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        png.readUInt32BE(16) !== 1280 ||
        png.readUInt32BE(20) !== 800
      )
        throw new Error('Invalid guest desktop PNG')
      return png
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      await this.stop()
      throw error
    }
  }

  /** Authority ends synchronously; failed deletion is retryable and never reported as success. */
  stop(): Promise<void> {
    if (!this.revoked) {
      this.revoked = true
      clearTimeout(this.timer)
      this.parentSignal.removeEventListener('abort', this.abort)
      this.controller.abort()
      this.transport.revoke()
      const pending = this.pending
      this.pending = undefined
      if (pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Desktop grant revoked'))
      }
    }
    this.removal ??= this.transport
      .remove()
      .then(() => {
        this.onRemoved()
      })
      .catch((error: unknown) => {
        this.removal = undefined
        throw error
      })
    return this.removal
  }
}

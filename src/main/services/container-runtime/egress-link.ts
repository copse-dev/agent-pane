/**
 * The link between the guest's egress proxy and the host's broker
 * (`docs/plans/thread-in-container.md`, decision A8): many connections
 * multiplexed as frames over one byte stream in each direction.
 *
 * The byte stream is the container's own stdio. `docker create --interactive`
 * plus `docker start --attach --interactive` hands the host the guest's stdin
 * and stdout as pipes on every Docker backend there is; a unix socket in a
 * bind-mounted directory does not, because Docker Desktop's VirtioFS file
 * sharing cannot carry one into the VM (`connect ENOTSUP`). The guest's stdout
 * therefore belongs to the link, and the worker sends its log to stderr.
 *
 * One frame: `id u32 BE · type u8 · length u32 BE · payload`. Streams are
 * opened by the guest only (`OPEN host:port`), answered by the host with
 * `ACCEPT` or `REFUSE reason`, and then carry `DATA` both ways, `END` for a
 * half close, `RESET` (with an optional reason) for an abort. `PING`/`PONG` on
 * stream 0 is the liveness probe the worker sends before anything else.
 *
 * Flow control is the byte stream's own: a frame that does not fit is held
 * until the pipe drains, and a stream whose reader is slow pauses the whole
 * inbound side until it reads. Head-of-line blocking across a handful of
 * model-API connections is a fair price for having no window bookkeeping.
 *
 * Dependency-free: it lives in the worker bundle and must not widen the image.
 */
import { Duplex, type Readable } from 'node:stream'

export const FRAME = {
  OPEN: 1,
  ACCEPT: 2,
  REFUSE: 3,
  DATA: 4,
  END: 5,
  RESET: 6,
  PING: 7,
  PONG: 8,
} as const

export interface Frame {
  id: number
  type: number
  payload: Buffer
}

const HEADER_BYTES = 9
/** More than any client writes at once; a frame beyond it is a corrupt link. */
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
/** Split large writes so one stream cannot hold the pipe for long. */
const DATA_CHUNK_BYTES = 64 * 1024

export function encodeFrame(id: number, type: number, payload: Buffer | string = ''): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt32BE(id, 0)
  header.writeUInt8(type, 4)
  header.writeUInt32BE(body.length, 5)
  return body.length === 0 ? header : Buffer.concat([header, body])
}

/** Incremental frame parser: feed bytes in any split, get whole frames out. */
export class FrameReader {
  private pending: Buffer[] = []
  private pendingBytes = 0

  feed(chunk: Buffer): Frame[] {
    this.pending.push(chunk)
    this.pendingBytes += chunk.length
    const frames: Frame[] = []
    for (;;) {
      if (this.pendingBytes < HEADER_BYTES) break
      const head = this.peek(HEADER_BYTES)
      const length = head.readUInt32BE(5)
      if (length > MAX_PAYLOAD_BYTES) {
        throw new Error(`egress link frame too large: ${String(length)} bytes`)
      }
      if (this.pendingBytes < HEADER_BYTES + length) break
      const whole = this.take(HEADER_BYTES + length)
      frames.push({
        id: whole.readUInt32BE(0),
        type: whole.readUInt8(4),
        payload: whole.subarray(HEADER_BYTES),
      })
    }
    return frames
  }

  private peek(bytes: number): Buffer {
    const first = this.pending[0]
    if (first !== undefined && first.length >= bytes) return first
    const joined = Buffer.concat(this.pending)
    this.pending = [joined]
    return joined
  }

  private take(bytes: number): Buffer {
    const joined = this.peek(bytes)
    const out = joined.subarray(0, bytes)
    const rest = joined.subarray(bytes)
    this.pending = rest.length > 0 ? [rest] : []
    this.pendingBytes -= bytes
    return out
  }
}

interface LinkCore {
  send: (id: number, type: number, payload: Buffer | string, done?: (error?: Error) => void) => void
  stall: (id: number) => void
  unstall: (id: number) => void
  forget: (id: number) => void
}

/**
 * One multiplexed connection, as a Duplex either end can `pipe` like a socket.
 * Reading yields the peer's `DATA`; writing sends `DATA`; ending sends `END`;
 * destroying sends `RESET` unless both sides have already finished.
 */
export class MuxStream extends Duplex {
  readonly id: number
  private readonly link: LinkCore
  private remoteDone = false
  private localDone = false

  constructor(id: number, link: LinkCore) {
    super({ allowHalfOpen: true })
    this.id = id
    this.link = link
  }

  override _read(): void {
    this.link.unstall(this.id)
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error) => void): void {
    if (chunk.length <= DATA_CHUNK_BYTES) {
      this.link.send(this.id, FRAME.DATA, chunk, done)
      return
    }
    let offset = 0
    const next = (error?: Error): void => {
      if (error) {
        done(error)
        return
      }
      if (offset >= chunk.length) {
        done()
        return
      }
      const piece = chunk.subarray(offset, offset + DATA_CHUNK_BYTES)
      offset += piece.length
      this.link.send(this.id, FRAME.DATA, piece, next)
    }
    next()
  }

  override _final(done: (error?: Error) => void): void {
    this.localDone = true
    this.link.send(this.id, FRAME.END, '', done)
  }

  override _destroy(error: Error | null, done: (error: Error | null) => void): void {
    if (!(this.remoteDone && this.localDone)) {
      this.remoteDone = true
      this.localDone = true
      this.link.send(this.id, FRAME.RESET, error?.message ?? '')
    }
    this.link.forget(this.id)
    done(error)
  }

  /** A frame for this stream, from the link. */
  receive(frame: Frame): void {
    switch (frame.type) {
      case FRAME.DATA:
        if (this.remoteDone) return
        if (!this.push(frame.payload)) this.link.stall(this.id)
        return
      case FRAME.END:
        if (this.remoteDone) return
        this.remoteDone = true
        this.push(null)
        return
      case FRAME.RESET: {
        const reason = frame.payload.toString('utf8')
        this.remoteDone = true
        this.localDone = true
        this.destroy(reason.length > 0 ? new Error(reason) : undefined)
        return
      }
      default:
        return
    }
  }

  /** The peer is gone: finish without telling it anything. */
  severed(error: Error | undefined): void {
    this.remoteDone = true
    this.localDone = true
    this.destroy(error)
  }
}

export interface EgressLinkHandlers {
  /** Host side: the guest asked for `target` on stream `id`; answer with `accept` or `refuse`. */
  onOpen?: (id: number, target: string) => void
  /** Either side: the byte stream ended or failed; every stream has been severed. */
  onClose?: (error: Error | undefined) => void
}

export interface EgressLinkOutput {
  write: (chunk: Buffer) => boolean
  on: (event: 'drain' | 'error' | 'close', listener: (error?: Error) => void) => unknown
}

/** One end of the link: the guest opens streams, the host answers them. */
export class EgressLink implements LinkCore {
  private readonly input: Readable
  private readonly output: EgressLinkOutput
  private readonly handlers: EgressLinkHandlers
  private readonly reader = new FrameReader()
  private readonly streams = new Map<number, MuxStream>()
  private readonly opening = new Map<
    number,
    { resolve: (stream: MuxStream) => void; reject: (error: Error) => void }
  >()
  private readonly pings: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
  private readonly stalled = new Set<number>()
  private readonly waitingForDrain: Array<(error?: Error) => void> = []
  private nextId = 1
  private closed = false

  constructor(input: Readable, output: EgressLinkOutput, handlers: EgressLinkHandlers = {}) {
    this.input = input
    this.output = output
    this.handlers = handlers
    input.on('data', (chunk: Buffer) => {
      let frames: Frame[]
      try {
        frames = this.reader.feed(chunk)
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)))
        return
      }
      for (const frame of frames) this.dispatch(frame)
    })
    input.on('end', () => {
      this.close(undefined)
    })
    input.on('close', () => {
      this.close(undefined)
    })
    input.on('error', (error: Error) => {
      this.close(error)
    })
    output.on('error', (error?: Error) => {
      this.close(error)
    })
    output.on('close', () => {
      this.close(undefined)
    })
    output.on('drain', () => {
      const waiting = this.waitingForDrain.splice(0)
      for (const done of waiting) done()
    })
  }

  get isClosed(): boolean {
    return this.closed
  }

  // -- guest side ----------------------------------------------------------

  /** Ask the host for `host:port`; resolves once it accepted, rejects with its reason. */
  open(target: string): Promise<MuxStream> {
    return new Promise((resolveOpen, reject) => {
      if (this.closed) {
        reject(new Error('egress link is closed'))
        return
      }
      const id = this.nextId
      this.nextId += 1
      const stream = new MuxStream(id, this)
      this.streams.set(id, stream)
      this.opening.set(id, { resolve: resolveOpen, reject })
      this.send(id, FRAME.OPEN, target)
    })
  }

  /** Round trip on stream 0; rejects when the peer does not answer in time. */
  ping(timeoutMs = 5000): Promise<void> {
    return new Promise((resolvePing, reject) => {
      if (this.closed) {
        reject(new Error('egress link is closed'))
        return
      }
      const timer = setTimeout(() => {
        const index = this.pings.indexOf(entry)
        if (index !== -1) this.pings.splice(index, 1)
        reject(new Error(`no reply within ${String(timeoutMs)}ms`))
      }, timeoutMs)
      const entry = {
        resolve: (): void => {
          clearTimeout(timer)
          resolvePing()
        },
        reject: (error: Error): void => {
          clearTimeout(timer)
          reject(error)
        },
      }
      this.pings.push(entry)
      this.send(0, FRAME.PING, '')
    })
  }

  // -- host side -----------------------------------------------------------

  /** Admit the guest's request on `id`; the stream is ready to pipe. */
  accept(id: number): MuxStream {
    const stream = new MuxStream(id, this)
    this.streams.set(id, stream)
    this.send(id, FRAME.ACCEPT, '')
    return stream
  }

  refuse(id: number, reason: string): void {
    this.send(id, FRAME.REFUSE, reason)
  }

  // -- both ----------------------------------------------------------------

  send(id: number, type: number, payload: Buffer | string, done?: (error?: Error) => void): void {
    if (this.closed) {
      done?.(new Error('egress link is closed'))
      return
    }
    let ok: boolean
    try {
      ok = this.output.write(encodeFrame(id, type, payload))
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.close(failure)
      done?.(failure)
      return
    }
    if (done === undefined) return
    if (ok) done()
    else this.waitingForDrain.push(done)
  }

  stall(id: number): void {
    this.stalled.add(id)
    this.input.pause()
  }

  unstall(id: number): void {
    this.stalled.delete(id)
    if (this.stalled.size === 0 && !this.closed) this.input.resume()
  }

  forget(id: number): void {
    this.streams.delete(id)
    this.opening.delete(id)
    this.unstall(id)
  }

  /** Sever every stream and stop reading; the byte streams themselves are the caller's. */
  close(error: Error | undefined): void {
    if (this.closed) return
    this.closed = true
    const failure = error ?? new Error('egress link closed')
    for (const pending of this.opening.values()) pending.reject(failure)
    this.opening.clear()
    for (const pending of this.pings.splice(0)) pending.reject(failure)
    for (const done of this.waitingForDrain.splice(0)) done(failure)
    for (const stream of [...this.streams.values()]) stream.severed(error)
    this.streams.clear()
    this.stalled.clear()
    this.handlers.onClose?.(error)
  }

  private dispatch(frame: Frame): void {
    switch (frame.type) {
      case FRAME.OPEN: {
        const target = frame.payload.toString('utf8')
        if (this.handlers.onOpen) this.handlers.onOpen(frame.id, target)
        else this.refuse(frame.id, 'DENY no broker on this link')
        return
      }
      case FRAME.ACCEPT: {
        const pending = this.opening.get(frame.id)
        const stream = this.streams.get(frame.id)
        this.opening.delete(frame.id)
        if (pending && stream) pending.resolve(stream)
        return
      }
      case FRAME.REFUSE: {
        const pending = this.opening.get(frame.id)
        const stream = this.streams.get(frame.id)
        this.opening.delete(frame.id)
        this.streams.delete(frame.id)
        stream?.severed(undefined)
        pending?.reject(new Error(frame.payload.toString('utf8')))
        return
      }
      case FRAME.PING:
        this.send(0, FRAME.PONG, '')
        return
      case FRAME.PONG:
        this.pings.shift()?.resolve()
        return
      default:
        this.streams.get(frame.id)?.receive(frame)
    }
  }
}

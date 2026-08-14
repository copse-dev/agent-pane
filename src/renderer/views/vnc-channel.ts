import type { ApiClient } from '../../preload/api.d.ts'
import type { VncStatusEvent } from '@shared/types/vnc.ts'

interface VncMessageEvent {
  data: ArrayBuffer
}

interface VncCloseEvent {
  code: number
  reason: string
  wasClean: boolean
}

/** WebSocket-shaped raw channel consumed by noVNC's public RFB constructor. */
export class VncIpcChannel {
  binaryType = 'arraybuffer'
  protocol = ''
  readyState: number = WebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: VncMessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: VncCloseEvent) => void) | null = null

  readonly connectionId: string
  private readonly api: Pick<ApiClient, 'vnc'>

  constructor(connectionId: string, api: Pick<ApiClient, 'vnc'>) {
    this.connectionId = connectionId
    this.api = api
  }

  open(): void {
    if (this.readyState !== WebSocket.CONNECTING) return
    this.readyState = WebSocket.OPEN
    this.onopen?.(new Event('open'))
    this.api.vnc.start(this.connectionId)
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== WebSocket.OPEN) throw new Error('VNC channel is not open')
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    this.api.vnc.send(this.connectionId, Uint8Array.from(bytes))
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSING || this.readyState === WebSocket.CLOSED) {
      return
    }
    this.readyState = WebSocket.CLOSING
    void this.api.vnc.close(this.connectionId).catch((error: unknown) => {
      this.fail(error instanceof Error ? error.message : String(error))
    })
  }

  receive(bytes: Uint8Array): void {
    if (this.readyState !== WebSocket.OPEN) return
    const copy = Uint8Array.from(bytes)
    this.onmessage?.({ data: copy.buffer })
  }

  handleStatus(event: VncStatusEvent): void {
    if (event.id !== this.connectionId) return
    if (event.status === 'error') {
      this.fail(event.lastError ?? 'The VNC connection failed')
      return
    }
    if (event.status === 'closed') this.finishClose(true, '')
  }

  private fail(reason: string): void {
    this.onerror?.(new Event('error'))
    this.finishClose(false, reason)
  }

  private finishClose(wasClean: boolean, reason: string): void {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    this.onclose?.({ code: wasClean ? 1000 : 1006, reason, wasClean })
  }
}

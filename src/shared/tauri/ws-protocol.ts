/**
 * Wire protocol for the Tauri prototype's renderer ↔ sidecar bridge.
 *
 * Under Electron, the preload's `ipcRenderer` and main's `ipcMain` share an
 * in-process channel. Under the Tauri/Servo shell (see
 * docs/plans/tauri-servo-migration.md) the renderer runs in a Servo webview and
 * the main-process code runs in a plain Node sidecar, so the same traffic rides
 * a loopback WebSocket instead. This module defines the frames and the
 * serialization used on both ends; it must stay runnable in both the browser
 * bundle and the Node bundle (no `node:` imports, no DOM-only globals).
 *
 * Binary payloads (`vnc:data` chunks, attachment bytes) are tagged and carried
 * as base64 inside the JSON text frame. That costs ~33% on the VNC hot path;
 * if that ever matters, the upgrade path is side-channel binary WS frames —
 * the tag is the only thing that would change.
 */

import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { isRecord } from '@shared/unknown-value.mts'
import { z } from 'zod'

export type ClientFrame =
  | { t: 'hello'; winId: number; token: string }
  | { t: 'invoke'; id: number; channel: string; args: unknown[] }
  | { t: 'send'; channel: string; args: unknown[] }

export type ServerFrame =
  | { t: 'hello-ok' }
  | { t: 'result'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'event'; channel: string; args: unknown[] }

/**
 * Marker key for a binary leaf inside a frame's JSON. Chosen to be impossible
 * to collide with app payload keys (none of ours start with `$`).
 */
export const BIN_MARKER = '$copse-tauri-bin$'

/**
 * Marker for an `undefined` leaf. Electron's structured clone carries
 * `undefined` through IPC intact; JSON silently turns array elements into
 * `null` and drops object properties — which broke every invoke with an
 * optional trailing argument (`workspace.set(path, undefined)` arrived as
 * `[path, null]`, failed the handler's `z.string().optional()` guard, and
 * the renderer quarantined the project as missing).
 */
export const UNDEF_MARKER = '$copse-tauri-undefined$'

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Hand-rolled base64 rather than Buffer/btoa so the module is truly
// environment-agnostic (Buffer is Node-only; btoa is byte-hostile and
// deprecated in Node). Frames are small except VNC, which is prototype-grade
// anyway (see module doc).
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64_ALPHABET.charAt(a >> 2)
    out += B64_ALPHABET.charAt(((a & 0x03) << 4) | ((b ?? 0) >> 4))
    out += b === undefined ? '=' : B64_ALPHABET.charAt(((b & 0x0f) << 2) | ((c ?? 0) >> 6))
    out += b === undefined || c === undefined ? '=' : B64_ALPHABET.charAt(c & 0x3f)
  }
  return out
}

const B64_LOOKUP: Record<string, number> = {}
for (let i = 0; i < B64_ALPHABET.length; i++) {
  B64_LOOKUP[B64_ALPHABET.charAt(i)] = i
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let outIndex = 0
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_LOOKUP[clean.charAt(i)] ?? 0
    const b = B64_LOOKUP[clean.charAt(i + 1)] ?? 0
    const c = B64_LOOKUP[clean.charAt(i + 2)] ?? 0
    const d = B64_LOOKUP[clean.charAt(i + 3)] ?? 0
    out[outIndex++] = (a << 2) | (b >> 4)
    if (i + 2 < clean.length) out[outIndex++] = ((b & 0x0f) << 4) | (c >> 2)
    if (i + 3 < clean.length) out[outIndex++] = ((c & 0x03) << 6) | d
  }
  return out
}

export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return JSON.stringify(frame, (_key, value: unknown) => {
    if (value === undefined) return { [UNDEF_MARKER]: true }
    if (value instanceof Uint8Array) return { [BIN_MARKER]: toBase64(value) }
    if (value instanceof ArrayBuffer) return { [BIN_MARKER]: toBase64(new Uint8Array(value)) }
    return value
  })
}

function reviveBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveBinary)
  if (!isRecord(value)) return value
  if (value[UNDEF_MARKER] === true) return undefined
  const encoded = value[BIN_MARKER]
  if (typeof encoded === 'string') {
    if (
      encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    ) {
      throw new Error('invalid binary marker')
    }
    return fromBase64(encoded)
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, reviveBinary(entry)]))
}

const clientFrameSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    winId: z.number().int().positive(),
    token: z.string().length(64),
  }),
  z.object({
    t: z.literal('invoke'),
    id: z.number().int().nonnegative(),
    channel: z.string().min(1),
    args: z.array(z.unknown()),
  }),
  z.object({ t: z.literal('send'), channel: z.string().min(1), args: z.array(z.unknown()) }),
])

const serverFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello-ok') }),
  z.object({
    t: z.literal('result'),
    id: z.number().int().nonnegative(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({ t: z.literal('event'), channel: z.string().min(1), args: z.array(z.unknown()) }),
])

export function decodeClientFrame(text: string): ClientFrame {
  const frame = safeJsonParse(text, decodeWithSchema(clientFrameSchema))
  if (!frame) throw new Error('invalid client frame')
  if (frame.t === 'hello') return frame
  return { ...frame, args: frame.args.map(reviveBinary) }
}

export function decodeServerFrame(text: string): ServerFrame {
  const frame = safeJsonParse(text, decodeWithSchema(serverFrameSchema))
  if (!frame) throw new Error('invalid server frame')
  if (frame.t === 'hello-ok') return frame
  if (frame.t === 'event') return { ...frame, args: frame.args.map(reviveBinary) }
  return {
    t: frame.t,
    id: frame.id,
    ok: frame.ok,
    ...(frame.value === undefined ? {} : { value: reviveBinary(frame.value) }),
    ...(frame.error === undefined ? {} : { error: frame.error }),
  }
}

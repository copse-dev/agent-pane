/**
 * Keep one oversized renderer→main call from killing the renderer (#4445).
 *
 * An IPC call with very large arguments does not fail. Once they pass about
 * 1 GiB serialized, the serializer can ask for a buffer the allocator will not
 * give; Chromium then aborts the renderer process (SIGTRAP on macOS) and the
 * window reloads. Nothing in JavaScript can catch that, so the size is bounded
 * here, before the call.
 *
 * The preload is the one place that sees every call, which is also why this
 * patches `invoke` and `send` rather than each call site (see `perf-bridge.ts`).
 */

import {
  IPC_ARGUMENT_LIMIT_BYTES,
  IPC_ARGUMENT_REPORT_BYTES,
  IPC_LARGE_CALL_CHANNEL,
  type IpcLargeCallReport,
} from '@shared/ipc-size-limits.ts'

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>
type Send = (channel: string, ...args: unknown[]) => void

/**
 * Bytes allowed for one value's tag, length prefix and padding. The wire format
 * spends at most 9 on a number and 7 on a string's framing; the slack also
 * covers the integer key a sparse array writes beside each element.
 */
const VALUE_BYTES = 16
/** Begin and end tags plus the counts an object, array, Map or Set writes. */
const CONTAINER_BYTES = 32

interface Walk {
  bytes: number
  readonly limit: number
  /** Containers on the path to the value being visited, to stop at a cycle. */
  ancestors: Set<object> | null
}

/**
 * Upper bound on the structured-clone size of IPC arguments.
 *
 * It reads lengths, never contents, so the cost follows the number of values
 * rather than their bytes. A string counts two bytes per character because V8
 * may hold it either way and JavaScript cannot tell which. A value reachable by
 * two paths is counted on each, where the serializer would write a
 * back-reference. Both choices keep this an overestimate.
 *
 * The walk stops once the total passes `limit`, so a result above the limit
 * means only "more than `limit`", not the full size.
 */
export function estimateIpcArgumentBytes(args: readonly unknown[], limit: number): number {
  const walk: Walk = { bytes: 0, limit, ancestors: null }
  for (const arg of args) {
    if (walk.bytes > limit) break
    visit(arg, walk)
  }
  return walk.bytes
}

function visit(value: unknown, walk: Walk): void {
  switch (typeof value) {
    case 'string':
      walk.bytes += value.length * 2 + VALUE_BYTES
      return
    case 'object':
      if (value === null) walk.bytes += VALUE_BYTES
      else visitObject(value, walk)
      return
    case 'bigint':
      walk.bytes += Math.ceil(value.toString(16).length / 2) + VALUE_BYTES
      return
    default:
      // Numbers, booleans and undefined. A function or symbol cannot be cloned;
      // the real call reports that, so it only needs to be counted as present.
      walk.bytes += VALUE_BYTES
  }
}

function visitObject(value: object, walk: Walk): void {
  walk.bytes += CONTAINER_BYTES
  // `SharedArrayBuffer` is deliberately not named: the global is absent unless
  // the page is cross-origin isolated, and a reference to it would throw.
  if (value instanceof ArrayBuffer) {
    walk.bytes += value.byteLength
    return
  }
  if (ArrayBuffer.isView(value)) {
    // A view is written with its whole backing buffer, not just its window.
    walk.bytes += value.buffer.byteLength + CONTAINER_BYTES
    return
  }
  if (value instanceof Date) return
  if (value instanceof RegExp) {
    walk.bytes += (value.source.length + value.flags.length) * 2
    return
  }
  const ancestors = (walk.ancestors ??= new Set())
  // A cycle is written as a back-reference, already counted above.
  if (ancestors.has(value)) return
  ancestors.add(value)
  try {
    if (Array.isArray(value)) visitArray(value, walk)
    else if (value instanceof Map) visitMap(value, walk)
    else if (value instanceof Set) visitSet(value, walk)
    else visitProperties(value, walk)
  } finally {
    ancestors.delete(value)
  }
}

function visitArray(value: readonly unknown[], walk: Walk): void {
  let index = 0
  for (; index < value.length; index++) {
    if (walk.bytes > walk.limit) return
    const element = value[index]
    // A hole. V8 writes a holey array by its present keys only, so counting
    // every index would overstate a long sparse array and spin on its length.
    if (element === undefined && !Object.hasOwn(value, index)) break
    visit(element, walk)
  }
  if (index === value.length) return
  for (const key of Object.keys(value)) {
    if (walk.bytes > walk.limit) return
    const position = Number(key)
    if (Number.isInteger(position) && position < index) continue
    walk.bytes += key.length * 2 + VALUE_BYTES
    visit(Reflect.get(value, key), walk)
  }
}

function visitMap(value: ReadonlyMap<unknown, unknown>, walk: Walk): void {
  for (const [key, entry] of value) {
    if (walk.bytes > walk.limit) return
    visit(key, walk)
    visit(entry, walk)
  }
}

function visitSet(value: ReadonlySet<unknown>, walk: Walk): void {
  for (const entry of value) {
    if (walk.bytes > walk.limit) return
    visit(entry, walk)
  }
}

function visitProperties(value: object, walk: Walk): void {
  if (value instanceof Error) {
    // Written from these fields whether or not they are enumerable.
    walk.bytes += (value.name.length + value.message.length + (value.stack?.length ?? 0)) * 2
    if (Object.hasOwn(value, 'cause')) visit(value.cause, walk)
  }
  for (const key of Object.keys(value)) {
    if (walk.bytes > walk.limit) return
    walk.bytes += key.length * 2 + VALUE_BYTES
    visit(Reflect.get(value, key), walk)
  }
}

function megabytes(bytes: number): string {
  return `${String(Math.round(bytes / (1024 * 1024)))} MB`
}

/**
 * Wrap the raw `invoke` and `send` so a call over the limit is refused, and a
 * large one is named to main before it is sent. The report goes first because a
 * call that still takes the renderer down leaves no other trace of its channel.
 */
export function createIpcSizeGuard(raw: { invoke: Invoke; send: Send }): {
  invoke: Invoke
  send: Send
} {
  const refusal = (channel: string, args: readonly unknown[]): Error | null => {
    let bytes: number
    try {
      bytes = estimateIpcArgumentBytes(args, IPC_ARGUMENT_LIMIT_BYTES)
    } catch {
      // A value the estimate cannot walk (a throwing getter or proxy, runaway
      // nesting) is left to the real call, which reports it properly.
      return null
    }
    if (bytes < IPC_ARGUMENT_REPORT_BYTES) return null
    const refused = bytes > IPC_ARGUMENT_LIMIT_BYTES
    try {
      const report: IpcLargeCallReport = { channel, bytes, refused }
      raw.send(IPC_LARGE_CALL_CHANNEL, report)
    } catch {
      // A diagnostic must never break the call it describes.
    }
    if (!refused) return null
    return new Error(
      `Refused to send "${channel}" to the main process: its arguments are larger than ` +
        `${megabytes(IPC_ARGUMENT_LIMIT_BYTES)}. A call that size can crash this window.`,
    )
  }
  return {
    invoke: (channel, ...args): Promise<unknown> => {
      const error = refusal(channel, args)
      return error ? Promise.reject(error) : raw.invoke(channel, ...args)
    },
    send: (channel, ...args): void => {
      const error = refusal(channel, args)
      if (error) throw error
      raw.send(channel, ...args)
    },
  }
}

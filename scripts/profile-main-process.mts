#!/usr/bin/env node
// CPU-profile a running Copse main process (or any Node process) through its
// inspector, then close that inspector again.
//
// SIGUSR1 opens the inspector on 127.0.0.1:9229; it stays open until something
// in the target closes it. Closing it is the risky step. `Runtime.evaluate`
// compiles in the target's global scope, where `require` does not exist in
// either module format, and work deferred with `setImmediate` runs after the
// evaluate call has returned, so its errors are not reported back to us: they
// become the target's uncaught exception, and Copse quits on its first one.
// An ad-hoc `setImmediate(() => require('node:inspector').close())` shut a live
// Copse down exactly this way (`ReferenceError: require is not defined at
// Immediate.<anonymous> (<anonymous>:1:46)`). INSPECTOR_CLOSE_EXPRESSION loads
// the module from global scope and contains its own failure.
//
// Run:  node scripts/profile-main-process.mts --pid <pid> [--seconds 5] [--out file]

import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../packages/std/src/safe-json.ts'
import { isDirectExecution } from './lib/direct-execution.mts'

/**
 * Deferred so the target answers this evaluate before `close()` waits for the
 * session to disconnect; the caller disconnects as soon as the answer arrives.
 */
export const INSPECTOR_CLOSE_EXPRESSION =
  "setImmediate(() => { try { process.getBuiltinModule('node:inspector').close() } " +
  "catch (error) { console.warn('[profile-main-process] inspector close failed:', error) } })"

const targetsSchema = z.array(z.object({ webSocketDebuggerUrl: z.string().optional() }))
const replySchema = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
})
const evaluateResultSchema = z.object({
  exceptionDetails: z.object({ text: z.string() }).optional(),
})
const profileSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.number(),
      callFrame: z.object({ functionName: z.string(), url: z.string(), lineNumber: z.number() }),
    }),
  ),
  samples: z.array(z.number()),
  timeDeltas: z.array(z.number()),
})
export type CpuProfile = z.infer<typeof profileSchema>

/** Poll the inspector's target list until it names a debugger socket. */
export async function waitForInspectorUrl(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let detail = 'no inspector target'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
      })
      const url = safeJsonParse(await response.text(), decodeWithSchema(targetsSchema))?.find(
        (target) => target.webSocketDebuggerUrl,
      )?.webSocketDebuggerUrl
      if (url) return url
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Inspector on port ${port} did not become available: ${detail}`)
}

interface InspectorSession {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  close(): void
}

async function connectInspector(url: string): Promise<InspectorSession> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error(`Cannot connect to ${url}`)), {
      once: true,
    })
  })
  let nextId = 0
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    const reply = safeJsonParse(event.data, decodeWithSchema(replySchema))
    if (reply?.id === undefined) return
    const waiter = pending.get(reply.id)
    if (!waiter) return
    pending.delete(reply.id)
    if (reply.error) waiter.reject(new Error(reply.error.message))
    else waiter.resolve(reply.result)
  })
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('Inspector session closed'))
    pending.clear()
  })
  return {
    call: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      }),
    close: () => socket.close(),
  }
}

/**
 * Sample the target for `durationMs`, then close its inspector. The session is
 * always disconnected, and the close request is sent even if profiling fails.
 */
export async function profileInspector(url: string, durationMs: number): Promise<CpuProfile> {
  const session = await connectInspector(url)
  try {
    await session.call('Profiler.enable')
    await session.call('Profiler.start')
    await new Promise((resolve) => setTimeout(resolve, durationMs))
    const stopped = z.object({ profile: profileSchema }).parse(await session.call('Profiler.stop'))
    await session.call('Profiler.disable')
    return stopped.profile
  } finally {
    await closeInspector(session)
  }
}

/** Ask the target to close its inspector, then disconnect. Reports rather than throws. */
async function closeInspector(session: InspectorSession): Promise<void> {
  try {
    const evaluated = evaluateResultSchema.parse(
      await session.call('Runtime.evaluate', { expression: INSPECTOR_CLOSE_EXPRESSION }),
    )
    if (evaluated.exceptionDetails) {
      console.warn(`Inspector close was not scheduled: ${evaluated.exceptionDetails.text}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Inspector close was not requested: ${message}`)
  } finally {
    session.close()
  }
}

/** The `limit` frames with the most self time, heaviest first. */
export function summarizeProfile(profile: CpuProfile, limit: number): string[] {
  const selfMicros = new Map<number, number>()
  profile.samples.forEach((id, index) => {
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0))
  })
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  return [...selfMicros]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, micros]) => {
      const frame = nodes.get(id)?.callFrame
      const where = frame
        ? `${frame.functionName || '(anonymous)'} ${frame.url}:${frame.lineNumber + 1}`
        : `node ${id}`
      return `${(micros / 1000).toFixed(1)}ms ${where}`
    })
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      pid: { type: 'string' },
      port: { type: 'string', default: '9229' },
      seconds: { type: 'string', default: '5' },
      out: { type: 'string' },
    },
  })
  const pid = Number(values.pid)
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      'Usage: node scripts/profile-main-process.mts --pid <pid> [--seconds 5] [--out file]',
    )
  }
  process.kill(pid, 'SIGUSR1')
  const url = await waitForInspectorUrl(Number(values.port), 5000)
  const profile = await profileInspector(url, Number(values.seconds) * 1000)
  const out = values.out ?? join(tmpdir(), `copse-main-${pid}.cpuprofile`)
  await writeFile(out, JSON.stringify(profile))
  console.log(`Profile: ${out}`)
  for (const line of summarizeProfile(profile, 25)) console.log(line)
}

if (isDirectExecution(import.meta.url, 'profile-main-process')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

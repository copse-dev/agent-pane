#!/usr/bin/env node
// CPU-profile a running Copse main process (or any Node process) through its
// inspector, then close that inspector again.
//
// SIGUSR1 opens the inspector at the target's configured address (by default
// 127.0.0.1:9229); it stays open until something in the target closes it.
// Automatic activation requires Unix lsof with permission to inspect the PID;
// otherwise open the inspector manually before running this script. The script
// itself is a developer CLI, not part of the packaged application.
// Closing the inspector is the risky step. `Runtime.evaluate`
// compiles in the target's global scope, where `require` does not exist in
// either module format, and work deferred with `setImmediate` runs after the
// evaluate call has returned, so its errors are not reported back to us: they
// become the target's uncaught exception, and Copse quits on its first one.
// An ad-hoc `setImmediate(() => require('node:inspector').close())` shut a live
// Copse down exactly this way (`ReferenceError: require is not defined at
// Immediate.<anonymous> (<anonymous>:1:46)`). INSPECTOR_CLOSE_EXPRESSION loads
// the module from global scope and contains its own failure.
//
// Disconnecting is risky too. `inspector.close()` sends each connected session
// a WebSocket close frame; a client close frame arriving in the same inspector
// I/O turn makes Node send a second one, and the first write's callback frees
// the connection the second one still uses. The target then segfaults in
// `WsHandler::OnCloseFrameWritten` (seen on Node 24.22.1, intermittently and
// more often under CPU load). So once the close is scheduled, the target ends
// the session and this script only answers its close frame.
//
// Run:  node scripts/profile-main-process.mts --pid <pid> [--seconds 5] [--out file]

import childProcess from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { isDirectExecution } from './lib/direct-execution.mts'

/**
 * Deferred so the target answers this evaluate before `close()` ends the
 * session; the caller then waits for that end instead of disconnecting first.
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
const processIdentitySchema = z.object({
  result: z.object({ type: z.literal('number'), value: z.number().int().positive() }),
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

async function inspectorUrlAt(origin: string): Promise<string | null> {
  let response: Response
  try {
    response = await fetch(`${origin}/json/list`, {
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    })
  } catch (error) {
    if (
      error instanceof Error &&
      error.cause instanceof Error &&
      'code' in error.cause &&
      error.cause.code === 'ECONNREFUSED'
    )
      return null
    throw error
  }
  const url = safeJsonParse(await response.text(), decodeWithSchema(targetsSchema))?.find(
    (target) => target.webSocketDebuggerUrl,
  )?.webSocketDebuggerUrl
  if (!response.ok || !url) throw new Error(`${origin} does not serve a Node inspector`)
  const target = new URL(url)
  if (target.protocol !== 'ws:' || target.host !== new URL(origin).host) {
    throw new Error(`Inspector target does not belong to ${origin}`)
  }
  return url
}

/** Poll the inspector's target list until it names a debugger socket. */
export async function waitForInspectorUrl(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let detail = 'no inspector target'
  while (Date.now() < deadline) {
    try {
      const url = await inspectorUrlAt(`http://127.0.0.1:${String(port)}`)
      if (url) return url
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Inspector on port ${String(port)} did not become available: ${detail}`)
}

/** Read only TCP LISTEN records belonging to the PID, including a visible empty snapshot. */
export function targetListenerOrigins(output: string, pid: number): Set<string> {
  const origins = new Set<string>()
  let currentPid = 0
  let sawTargetFile = false
  let file: { protocol?: string; address?: string; state?: string } = {}
  const finishFile = (): void => {
    if (currentPid !== pid || file.protocol !== 'TCP' || file.state !== 'LISTEN') return
    const endpoint = /^(.*):(\d+)$/.exec(file.address ?? '')
    const address = endpoint?.[1]?.replace(/^\[/, '').replace(/\]$/, '')
    const port = Number(endpoint?.[2])
    if (!address || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Cannot parse a target TCP listener: ${JSON.stringify(file.address)}`)
    }
    const addresses =
      address === '*'
        ? ['127.0.0.1', '::1']
        : [address === '0.0.0.0' ? '127.0.0.1' : address === '::' ? '::1' : address]
    for (const address of addresses) {
      const family = isIP(address)
      if (family === 0) {
        throw new Error(
          `Target listener address is not a numeric local address: ${JSON.stringify(address)}`,
        )
      }
      const host = family === 6 ? `[${address}]` : address
      origins.add(new URL(`http://${host}:${String(port)}`).origin)
    }
  }
  // NUL fields keep an open file's name from fabricating p/f/P/n/T records.
  // lsof adds one newline between its process/file field sets even with -F0.
  for (const field of output.split('\0')) {
    const line = field.replace(/^\n/, '')
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p' || tag === 'f') {
      finishFile()
      file = {}
      if (tag === 'p') {
        currentPid = Number(value)
      } else if (currentPid === pid) sawTargetFile = true
    } else if (tag === 'P') file.protocol = value
    else if (tag === 'n') file.address = value
    else if (tag === 'T' && value.startsWith('ST=')) file.state = value.slice(3)
  }
  finishFile()
  if (!sawTargetFile) throw new Error(`Cannot inspect requested process ${String(pid)}`)
  return origins
}

/** Signal 0 delivers nothing; only ESRCH proves the PID is gone (EPERM means it exists). */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

function readTargetListenerOrigins(pid: number): Set<string> {
  if (process.platform === 'win32') {
    throw new Error(
      'Automatic inspector activation requires Unix lsof; open the inspector manually',
    )
  }
  try {
    // Do not filter to sockets: an inspectable process with no listeners still
    // has PID and file records. An empty/denied result must not authorize SIGUSR1.
    const output = childProcess.execFileSync('lsof', ['-nP', '-p', String(pid), '-F0pfPnT'], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return targetListenerOrigins(output, pid)
  } catch (cause) {
    // lsof exits 1 without output for a PID that no longer exists; say so
    // rather than blaming lsof for a target that crashed or quit.
    if (!processExists(pid)) throw new Error(`Process ${String(pid)} is not running`, { cause })
    throw new Error(
      `Cannot discover listeners for process ${String(pid)}; automatic activation requires readable Unix lsof output. Open its inspector manually`,
      { cause },
    )
  }
}

interface InspectorSession {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  /** Whether the target ended the connection within `timeoutMs`; sends nothing itself. */
  waitForDisconnect(timeoutMs: number): Promise<boolean>
  close(): void
}

/**
 * How long a target may take to run the scheduled close and end our session.
 * A busy main process delays the `setImmediate`; disconnecting first instead
 * risks the close-frame race described at the top of this file.
 */
const INSPECTOR_SHUTDOWN_TIMEOUT_MS = 5000

async function connectInspector(url: string): Promise<InspectorSession> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error(`Inspector connection timed out: ${url}`))
    }, 1000)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timeout)
        socket.close()
        reject(new Error(`Cannot connect to ${url}`))
      },
      {
        once: true,
      },
    )
  })
  let nextId = 0
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >()
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    const reply = safeJsonParse(event.data, decodeWithSchema(replySchema))
    if (reply?.id === undefined) return
    const waiter = pending.get(reply.id)
    if (!waiter) return
    pending.delete(reply.id)
    clearTimeout(waiter.timeout)
    if (reply.error) waiter.reject(new Error(reply.error.message))
    else waiter.resolve(reply.result)
  })
  const disconnected = new Promise<true>((resolve) => {
    socket.addEventListener('close', () => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timeout)
        waiter.reject(new Error('Inspector session closed'))
      }
      pending.clear()
      resolve(true)
    })
  })
  return {
    call: (method, params = {}): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = ++nextId
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Inspector request timed out: ${method}`))
        }, 1000)
        pending.set(id, { resolve, reject, timeout })
        try {
          socket.send(JSON.stringify({ id, method, params }))
        } catch (error) {
          clearTimeout(timeout)
          pending.delete(id)
          reject(
            error instanceof Error ? error : new Error('Inspector send failed', { cause: error }),
          )
        }
      }),
    waitForDisconnect: async (timeoutMs): Promise<boolean> => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          disconnected,
          new Promise<false>((resolve) => {
            timeout = setTimeout(() => {
              resolve(false)
            }, timeoutMs)
          }),
        ])
      } finally {
        clearTimeout(timeout)
      }
    },
    close: (): void => {
      socket.close()
    },
  }
}

async function verifyInspectorPid(session: InspectorSession, expectedPid: number): Promise<void> {
  const identity = processIdentitySchema.parse(
    await session.call('Runtime.evaluate', { expression: 'process.pid', returnByValue: true }),
  )
  if (identity.result.value !== expectedPid) {
    throw new Error(
      `Inspector belongs to process ${String(identity.result.value)}, not requested process ${String(expectedPid)}`,
    )
  }
}

/**
 * Sample the target for `durationMs`, then close its inspector. An optional PID
 * must match before profiling or closing; an unverified endpoint is only
 * disconnected. Verified targets are closed even if profiling fails.
 */
export async function profileInspector(
  url: string,
  durationMs: number,
  expectedPid?: number,
): Promise<CpuProfile> {
  const session = await connectInspector(url)
  // A port can belong to another Node process. Do not enable its profiler or
  // close its inspector until the endpoint proves it is the requested target.
  let canCloseInspector = expectedPid === undefined
  try {
    if (expectedPid !== undefined) {
      await verifyInspectorPid(session, expectedPid)
      canCloseInspector = true
    }
    await session.call('Profiler.enable')
    await session.call('Profiler.start')
    await new Promise((resolve) => setTimeout(resolve, durationMs))
    const stopped = z.object({ profile: profileSchema }).parse(await session.call('Profiler.stop'))
    await session.call('Profiler.disable')
    return stopped.profile
  } finally {
    if (canCloseInspector) await closeInspector(session)
    else session.close()
  }
}

/** A reset during shutdown is inconclusive; require a refused connection before the same deadline. */
async function waitForInspectorClosed(origin: string): Promise<void> {
  const deadline = Date.now() + 1000
  let lastError: unknown
  for (;;) {
    try {
      if ((await inspectorUrlAt(origin)) === null) return
    } catch (error) {
      // Closing the listener can reset a pooled HTTP connection before a fresh
      // connection observes ECONNREFUSED. A reset alone does not prove closure.
      lastError = error
    }
    if (Date.now() >= deadline) {
      throw new Error(`Inspector did not close: ${origin}`, { cause: lastError })
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function closeOpenedInspectors(pid: number, before: ReadonlySet<string>): Promise<void> {
  const failures: unknown[] = []
  for (const origin of readTargetListenerOrigins(pid)) {
    if (before.has(origin)) continue
    try {
      const url = await inspectorUrlAt(origin)
      if (!url) continue
      const session = await connectInspector(url)
      try {
        await verifyInspectorPid(session, pid)
        await closeInspector(session)
      } finally {
        session.close()
      }
      await waitForInspectorClosed(origin)
    } catch (error) {
      // A different new server must not prevent cleanup of the inspector.
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Could not verify cleanup of every new target listener')
  }
}

/** Profile a PID, cleaning any inspector our SIGUSR1 opens, even on another port. */
export async function profileProcess(
  pid: number,
  port: number,
  durationMs: number,
): Promise<CpuProfile> {
  // A live endpoint may belong to another process. Verify it without first
  // opening an additional inspector on the requested PID.
  const url = await inspectorUrlAt(`http://127.0.0.1:${String(port)}`)
  if (url) return profileInspector(url, durationMs, pid)
  const before = readTargetListenerOrigins(pid)
  process.kill(pid, 'SIGUSR1')
  try {
    return await profileInspector(await waitForInspectorUrl(port, 5000), durationMs, pid)
  } catch (error) {
    try {
      await closeOpenedInspectors(pid, before)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Inspector activation failed and cleanup could not be confirmed for process ${String(pid)}; its inspector may still be open`,
        { cause: cleanupError },
      )
    }
    throw error
  }
}

/** Ask the target to close its inspector and let it end the session; disconnect on failure. */
async function closeInspector(session: InspectorSession): Promise<void> {
  try {
    const evaluated = evaluateResultSchema.parse(
      await session.call('Runtime.evaluate', { expression: INSPECTOR_CLOSE_EXPRESSION }),
    )
    if (evaluated.exceptionDetails) {
      throw new Error(`Inspector close was not scheduled: ${evaluated.exceptionDetails.text}`)
    }
    // Sending our own close frame now would race the target's (see the top of
    // this file). Callers that must prove closure probe the endpoint afterwards.
    await session.waitForDisconnect(INSPECTOR_SHUTDOWN_TIMEOUT_MS)
  } finally {
    session.close()
  }
}

const failureFactsSchema = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  status: z.number().nullable().optional(),
  signal: z.string().nullable().optional(),
})

/**
 * Every message in an error tree, one indented line each: `cause` chains and
 * AggregateError members included at any depth, with exit status, signal and
 * code where a child process or socket error carries them. The outermost line
 * stays the fail-safe summary; the deepest lines name what actually failed.
 */
export function describeError(error: unknown): string {
  const lines: string[] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number, label: string): void => {
    const indent = '  '.repeat(depth)
    if (seen.has(value)) {
      lines.push(`${indent}${label}(shown above)`)
      return
    }
    seen.add(value)
    if (!(value instanceof Error)) {
      lines.push(`${indent}${label}${String(value)}`)
      return
    }
    const facts = failureFactsSchema.safeParse(value).data
    const annotations = [
      facts?.status == null ? '' : `exit status ${String(facts.status)}`,
      facts?.signal == null ? '' : `signal ${facts.signal}`,
      facts?.code === undefined ? '' : `code ${String(facts.code)}`,
    ].filter(Boolean)
    const [first, ...rest] = `${value.name}: ${value.message}`.split('\n')
    const suffix = annotations.length > 0 ? ` (${annotations.join(', ')})` : ''
    lines.push(
      `${indent}${label}${first ?? ''}${suffix}`,
      ...rest.map((line) => `${indent}  ${line}`),
    )
    const members: unknown[] = value instanceof AggregateError ? value.errors : []
    members.forEach((member, index) => {
      visit(member, depth + 1, `[${String(index + 1)}/${String(members.length)}] `)
    })
    if (value.cause !== undefined && !members.includes(value.cause)) {
      visit(value.cause, depth + 1, 'caused by: ')
    }
  }
  visit(error, 0, '')
  return lines.join('\n')
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
        ? `${frame.functionName || '(anonymous)'} ${frame.url}:${String(frame.lineNumber + 1)}`
        : `node ${String(id)}`
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
  const port = Number(values.port)
  const durationMs = Number(values.seconds) * 1000
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      'Usage: node scripts/profile-main-process.mts --pid <pid> [--seconds 5] [--out file]',
    )
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Inspector port must be an integer between 1 and 65535')
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('Profile duration must be a positive number of seconds')
  }
  const profile = await profileProcess(pid, port, durationMs)
  const out = values.out ?? join(tmpdir(), `copse-main-${String(pid)}.cpuprofile`)
  await writeFile(out, JSON.stringify(profile))
  console.log(`Profile: ${out}`)
  for (const line of summarizeProfile(profile, 25)) console.log(line)
}

if (isDirectExecution(import.meta.url, 'profile-main-process')) {
  main().catch((error: unknown) => {
    // Print every nested cause: the primary fail-safe warning comes first, and
    // the deepest line names the failure behind it.
    console.error(describeError(error))
    process.exitCode = 1
  })
}

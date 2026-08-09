import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isRecord } from '@shared/unknown-value.ts'
import type { AcpWireSink } from './acp-wire-tap.ts'
import { getThreadExecutionContext } from '../thread-execution-context.ts'
import { getActiveProjectId } from '../workspace.ts'
import { findThreadOwners, threadDirectoryPath } from '../thread-store.ts'

/**
 * Opt-in **ACP wire trace** — an unredacted, append-only record of everything an
 * external ACP agent sends us, written beside the thread's `events.jsonl`.
 *
 * Why this exists: external adapters (Cursor especially) surface MCP tool calls
 * in Copse as a bare `MCP: tool`, and nothing on Copse's side can tell us
 * whether the adapter never sent a usable label or whether we discarded one.
 * Two layers of loss sit between the wire and the UI:
 *
 * 1. The ACP SDK validates `session/update` params with `z.object(...)`, which
 *    **strips every key ACP's schema does not model** — a vendor extension
 *    field, or anything else non-standard, is already gone by the time
 *    `session-update-adapter.ts` runs. (`_meta` and the programmatic `name` are
 *    both modelled as of SDK 1.3.0, so those two do survive the parse.)
 * 2. `sessionUpdateToStreamChunk` then normalizes what is left into Copse's
 *    `StreamChunk` vocabulary, dropping whatever has no counterpart — notably,
 *    it derives the displayed tool name from `title` alone and never reads the
 *    parsed `name`, which is one candidate explanation for a bare `MCP: tool`.
 *
 * The trace therefore taps the **transport**, not the parsed update: it records
 * each JSON-RPC message exactly as `ndJsonStream` parsed it off the agent's
 * stdout, before any schema validation or normalization. What lands in
 * `acp-debug.jsonl` is byte-for-byte what the adapter said. The tap itself is
 * `acp-wire-tap.ts` — kept separate because `acp-client.ts` bundles into the
 * standalone probe worker and must not reach the thread store, as this module
 * does.
 *
 * ## Enabling it
 *
 * Off unless `COPSE_DEBUG_ACP_UPDATES=1` is set in the environment Copse itself
 * runs in. When it is off, nothing here serializes, opens, or creates anything —
 * {@link createAcpWireTrace} returns `null`, and `tapAcpWireStream(stream, null)`
 * hands back the caller's own stream untouched, so the transport is identical to
 * the untraced path.
 *
 * ## The trace is NOT redacted — on purpose
 *
 * A wire trace whose fields were filtered could not answer the question it
 * exists to answer, so `acp-debug.jsonl` keeps every payload verbatim. That
 * includes prompts, source code, absolute paths, shell commands and their
 * output, tool arguments, and any secret an agent happened to put in one — e.g.
 * an MCP server's bearer token echoed back in `rawInput`. Treat the file as
 * sensitive: read it before sharing, and prefer a scratch project when
 * reproducing against a real workspace. Never enable the flag by default.
 *
 * ## Where it lands, and why it survives
 *
 * `<chat store>/<projectId>/<threadId>/acp-debug.jsonl` — the thread's own
 * filesystem-native directory, so "Export thread folder (ZIP)" carries it out
 * with the rest of the thread. Nothing else in the thread model touches it: the
 * spine rewrite in `thread-store.ts` prunes only the content directories
 * (`messages/`, `blobs/`, `subagents/`), so a full thread save leaves a
 * root-level sidecar alone, and thread loading only ever reads `meta.json` and
 * `events.jsonl`, so replay ignores it.
 */

/** Line-format version stamped on every record. Bump when the shape changes. */
export const ACP_WIRE_TRACE_VERSION = 1

/** Env flag that turns tracing on. Anything but exactly `1` leaves it off. */
export const ACP_WIRE_TRACE_ENV = 'COPSE_DEBUG_ACP_UPDATES'

/** Diagnostic file name, written beside `events.jsonl` in the thread directory. */
export const ACP_WIRE_TRACE_FILE = 'acp-debug.jsonl'

/**
 * Record kinds. `session` is the local header line written when a trace opens;
 * everything else classifies one inbound JSON-RPC message by its wire shape.
 */
export type AcpWireRecordType =
  'session' | 'request' | 'notification' | 'response' | 'batch' | 'unknown'

/** A sink that appends to one thread's `acp-debug.jsonl`. */
export interface AcpWireTrace extends AcpWireSink {
  /** Absolute path of the file this trace appends to. */
  readonly path: string
}

export interface AcpWireTraceTarget {
  threadId: string
  /**
   * Owning project store id. Omit it and {@link createAcpWireTrace} resolves the
   * owner itself — see {@link resolveTraceProjectId}.
   */
  projectId?: string | undefined
  /** Agent spawn identity, recorded on the header line for provenance. */
  agent?: { command: string; args?: readonly string[] | undefined } | undefined
}

export function isAcpWireTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ACP_WIRE_TRACE_ENV] === '1'
}

/**
 * Which project store owns the thread we are about to trace.
 *
 * An explicit `projectId` wins. Otherwise the **thread directory on disk** is
 * the authority: `findThreadOwners` looks for the store that actually holds
 * this thread's `meta.json`, which is right even for a background thread in a
 * project the user is not currently looking at. Only when that is ambiguous
 * (zero owners for a thread whose first save has not landed, or the same id in
 * two stores) do we fall back to the running turn's execution context and then
 * the active project — the resolution other `threadId`-only writers use.
 */
async function resolveTraceProjectId(target: AcpWireTraceTarget): Promise<string | null> {
  if (target.projectId) return target.projectId
  const owners = await findThreadOwners(target.threadId).catch(() => [])
  if (owners.length === 1) return owners[0] ?? null
  return getThreadExecutionContext()?.projectId ?? getActiveProjectId()
}

// --- Ordered append-only writer ---------------------------------------------
//
// Records are buffered per file and flushed on a per-path promise chain, so
// lines land in the order `record()` saw them no matter how many sessions,
// turns, or between-turn updates are writing at once. Appends are O_APPEND, so
// a second Copse process tracing the same thread interleaves whole lines rather
// than corrupting them.

const buffers = new Map<string, string[]>()
const chains = new Map<string, Promise<void>>()
const warnedPaths = new Set<string>()

function appendTraceLine(path: string, line: string): void {
  const buffered = buffers.get(path)
  if (buffered) {
    // A flush for this path is queued but has not started; ride along with it.
    buffered.push(line)
    return
  }
  buffers.set(path, [line])
  const chain = (chains.get(path) ?? Promise.resolve()).then(() => flushTrace(path))
  chains.set(path, chain)
  void chain.finally(() => {
    if (chains.get(path) === chain) chains.delete(path)
  })
}

async function flushTrace(path: string): Promise<void> {
  const lines = buffers.get(path)
  buffers.delete(path)
  if (!lines || lines.length === 0) return
  try {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, lines.join(''), 'utf8')
  } catch (err) {
    // A diagnostic must never break the turn it is observing. Warn once per
    // path so a permission problem is visible without flooding the log.
    if (warnedPaths.has(path)) return
    warnedPaths.add(path)
    console.warn(`[acp-wire-trace] could not append to ${path}:`, err)
  }
}

/**
 * Resolve once every queued trace append has settled. Tests await this before
 * reading the file; nothing in the app needs it, because a lost tail of a
 * diagnostic file is not worth delaying shutdown for.
 */
export async function drainAcpWireTrace(): Promise<void> {
  // Bounded: a flush can enqueue the next one, and this must not spin forever
  // if something keeps recording while we drain.
  for (let pass = 0; pass < 50; pass += 1) {
    const pending = [...chains.values()]
    if (pending.length === 0) return
    await Promise.allSettled(pending)
  }
}

// --- Records -----------------------------------------------------------------

/** Classify one inbound message by its JSON-RPC shape (never by schema). */
export function classifyWireMessage(message: unknown): {
  type: AcpWireRecordType
  method?: string
} {
  if (Array.isArray(message)) return { type: 'batch' }
  if (!isRecord(message)) return { type: 'unknown' }
  const method = message['method']
  if (typeof method === 'string') {
    return { type: message['id'] === undefined ? 'notification' : 'request', method }
  }
  if ('result' in message || 'error' in message) return { type: 'response' }
  return { type: 'unknown' }
}

function traceLine(record: {
  dir: 'in' | 'meta'
  type: AcpWireRecordType
  method?: string
  msg: unknown
}): string {
  const line = {
    v: ACP_WIRE_TRACE_VERSION,
    ts: new Date().toISOString(),
    dir: record.dir,
    type: record.type,
    ...(record.method !== undefined ? { method: record.method } : {}),
    msg: record.msg,
  }
  try {
    return `${JSON.stringify(line)}\n`
  } catch (err) {
    // Wire messages come from JSON.parse and always re-serialize; this only
    // guards a future caller handing us something exotic. Keep the slot in the
    // file so the record count still matches the message count.
    return `${JSON.stringify({
      v: ACP_WIRE_TRACE_VERSION,
      ts: line.ts,
      dir: record.dir,
      type: record.type,
      ...(record.method !== undefined ? { method: record.method } : {}),
      unserializable: err instanceof Error ? err.message : String(err),
    })}\n`
  }
}

/**
 * Values that look like credentials, masked out of the *header* line only.
 *
 * The header records how *we* spawned the agent, which is our own config rather
 * than anything the agent sent — and in practice it is where a live token is
 * most likely to sit, because some agents take their credential as an argv
 * entry (`claude-agent-acp CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…`). A trace is
 * meant to be handed to a maintainer, so leaking the user's own agent
 * credential in line 1 is a bad default with no diagnostic value.
 *
 * This does NOT weaken the "unredacted wire trace" contract in the module doc
 * above: every `session/update` and `session/request_permission` payload is
 * still written verbatim, secrets and all. Only our own spawn arguments are
 * masked, and only the value — the variable name survives, so you can still
 * see *which* credential the agent was given.
 */
const SECRETISH_ASSIGNMENT =
  /^([^=\s]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS?|AUTH)[^=\s]*)=(.+)$/i
const SECRETISH_VALUE = /^(sk-|xox[baprs]-|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|AIza)/

function maskSecret(arg: string): string {
  const name = SECRETISH_ASSIGNMENT.exec(arg)?.[1]
  if (name !== undefined) return `${name}=<redacted>`
  if (SECRETISH_VALUE.test(arg)) return '<redacted>'
  return arg
}

/**
 * Open a trace for one thread's ACP session, or return `null` when the flag is
 * off (or the thread's owning project cannot be resolved). Writes a header line
 * naming the thread, project, and agent, so a file handed back by a user is
 * self-describing.
 */
export async function createAcpWireTrace(
  target: AcpWireTraceTarget,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AcpWireTrace | null> {
  if (!isAcpWireTraceEnabled(env)) return null

  const projectId = await resolveTraceProjectId(target)
  if (!projectId) {
    console.warn(
      `[acp-wire-trace] ${ACP_WIRE_TRACE_ENV}=1 but the owning project of thread ${target.threadId} could not be resolved; not tracing it`,
    )
    return null
  }

  let path: string
  try {
    path = join(threadDirectoryPath(projectId, target.threadId), ACP_WIRE_TRACE_FILE)
  } catch (err) {
    console.warn(`[acp-wire-trace] cannot resolve a thread directory to trace into:`, err)
    return null
  }

  appendTraceLine(
    path,
    traceLine({
      dir: 'meta',
      type: 'session',
      msg: {
        threadId: target.threadId,
        projectId,
        pid: process.pid,
        ...(target.agent
          ? {
              agent: {
                command: maskSecret(target.agent.command),
                args: (target.agent.args ?? []).map(maskSecret),
              },
            }
          : {}),
      },
    }),
  )

  return {
    path,
    record: (message): void => {
      const { type, method } = classifyWireMessage(message)
      appendTraceLine(
        path,
        traceLine({
          dir: 'in',
          type,
          ...(method !== undefined ? { method } : {}),
          msg: message,
        }),
      )
    },
  }
}

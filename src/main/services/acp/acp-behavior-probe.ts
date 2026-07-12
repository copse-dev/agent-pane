import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ActiveSessionMessage,
  type PermissionOption,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionOutcome,
  type RequestPermissionResponse,
  type StopReason,
  type Stream,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { relative, resolve as resolvePath } from 'node:path'
import { Readable, Writable } from 'node:stream'

/**
 * Tier-2 ACP **behavior probe** (issue #832): unlike the Tier-1 capability probe
 * (which only reads the `initialize` / `session/new` handshake), this drives one
 * scripted `session/prompt` turn against a real agent and records what the agent
 * actually *does* — which client callbacks it invokes and with what payloads.
 *
 * It answers the questions Tier-1 can't, and which the "SDK vs ACP" decision now
 * hinges on (see `docs/acp-support-findings.md`):
 *
 * - **Write routing** — does a file edit arrive as `fs/write_text_file` (so
 *   Copse's diff queue can gate it) or land directly on disk via the agent's
 *   own shell (bypassing the queue)?
 * - **Permission payload** — what does a `session/request_permission` actually
 *   carry (title, structured `rawInput`, v2 `subject`)?
 *
 * Because it runs a model turn, this is opt-in and token-spending (unlike Tier-1)
 * — it runs like `test:e2e:agent-eval`, not in CI. The pure classifiers and the
 * in-memory-agent path make the harness itself unit-testable with no binary.
 *
 * Unlike the real client (`acp-client.ts`), the probe backs `fs/*` and
 * `session/request_permission` with plain recording handlers (it applies writes
 * to a throwaway workspace) rather than the diff queue — the point is to observe
 * the agent, not to gate it. A real turn runs the agent's shell tools too, so
 * point it at a scratch directory.
 */

/** One recorded agent→client interaction during the turn, in order. */
export type BehaviorEntry =
  | { type: 'fs_read'; path: string }
  | { type: 'fs_write'; path: string; content: string }
  | {
      type: 'permission'
      title: string
      rawInput: unknown
      hasRawInput: boolean
      /** v2 `subject.type` when present; always null on v1 (no subject field). */
      subjectType: string | null
    }
  | { type: 'update'; sessionUpdate: string }

/** The outcome of one scripted turn. */
export interface AcpBehaviorRun {
  /** Ordered transcript of agent→client requests and update kinds. */
  transcript: BehaviorEntry[]
  /** The turn's stop reason, or null if it errored before stopping. */
  stopReason: StopReason | null
  /**
   * Of the scenario's `watchPaths`, those whose on-disk content differs after
   * the turn (relative to `cwd`). A change with no matching `fs_write` entry is
   * the fingerprint of a shell-tool write that bypassed the client.
   */
  changedPaths: string[]
  ok: boolean
  error?: string
}

export interface BehaviorScenario {
  /** The user prompt to send. */
  prompt: string
  /** How to answer any `session/request_permission`. Default `allow`. */
  permission?: 'allow' | 'reject'
  /**
   * Workspace-relative paths to snapshot before/after the turn, so a shell write
   * is detectable as an on-disk change even when no `fs/write_text_file` arrives.
   */
  watchPaths?: string[]
}

export interface AcpBehaviorConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Absolute scratch workspace passed as the ACP session `cwd`. */
  cwd: string
}

export interface AcpBehaviorOptions {
  /** Overall turn timeout before the agent is killed. Default 120s. */
  timeoutMs?: number
  /** Protocol version to request. Defaults to the SDK's `PROTOCOL_VERSION`. */
  protocolVersion?: number
  /** Transport injection point so tests can wire an in-process agent. */
  createTransport?: (config: AcpBehaviorConfig) => Promise<{ stream: Stream; dispose: () => void }>
}

/** Classification of how a file edit reached disk. */
export type WriteRouting = 'fs_write' | 'shell_bypass' | 'no_write'

/**
 * Classify how an edit to `targetRelPath` (workspace-relative) reached disk:
 * routed through `fs/write_text_file` (gate-able), a shell write that bypassed
 * the client, or no write at all. `fs_write` wins even if the file also changed
 * on disk — the point is whether the client *saw* the write.
 */
export function classifyWriteRouting(run: AcpBehaviorRun, targetRelPath: string): WriteRouting {
  const routed = run.transcript.some(
    (entry) => entry.type === 'fs_write' && entry.path === targetRelPath,
  )
  if (routed) return 'fs_write'
  if (run.changedPaths.includes(targetRelPath)) return 'shell_bypass'
  return 'no_write'
}

export interface PermissionSummary {
  count: number
  /** True if any permission request carried a non-empty structured `rawInput`. */
  anyStructuredInput: boolean
  /** Titles seen, in order. */
  titles: string[]
  /** True if any request carried a v2 `subject` (always false on v1). */
  subjectPresent: boolean
}

/** Summarize the permission requests recorded during the turn. */
export function summarizePermissions(run: AcpBehaviorRun): PermissionSummary {
  const perms = run.transcript.filter((entry) => entry.type === 'permission')
  return {
    count: perms.length,
    anyStructuredInput: perms.some((perm) => perm.hasRawInput),
    titles: perms.map((perm) => perm.title),
    subjectPresent: perms.some((perm) => perm.subjectType !== null),
  }
}

/** True when `rawInput` is a non-empty object/array (structured), not null/undefined. */
function isStructuredInput(rawInput: unknown): boolean {
  if (rawInput === null || rawInput === undefined) return false
  if (Array.isArray(rawInput)) return rawInput.length > 0
  if (typeof rawInput === 'object') return Object.keys(rawInput).length > 0
  return false
}

/** Pick an allow/reject option from what the agent offered, by option kind. */
function chooseOption(
  options: readonly PermissionOption[],
  decision: 'allow' | 'reject',
): RequestPermissionOutcome {
  const prefix = decision === 'allow' ? 'allow' : 'reject'
  const match = options.find((option) => option.kind.startsWith(prefix)) ?? options[0]
  if (!match) return { outcome: 'cancelled' }
  return { outcome: 'selected', optionId: match.optionId }
}

/** Normalize an agent-supplied (absolute) path to workspace-relative for matching. */
function toRelative(cwd: string, path: string): string {
  const rel = relative(cwd, resolvePath(cwd, path))
  return rel === '' ? path : rel
}

/** Default transport: spawn the agent and frame stdio as ndjson. */
function spawnBehaviorTransport(
  config: AcpBehaviorConfig,
): Promise<{ stream: Stream; dispose: () => void }> {
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.cwd,
    env: { ...process.env, ...(config.env ?? {}) },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  return Promise.resolve({
    stream: ndJsonStream(writable, readable),
    dispose: (): void => {
      child.kill()
    },
  })
}

/** Read a file's content, or null if it does not exist / can't be read. */
async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Drive one scripted turn and record the agent's behavior. Never throws — a
 * spawn/handshake/turn failure is captured as `{ ok: false, error }`.
 */
export async function runBehaviorTurn(
  config: AcpBehaviorConfig,
  scenario: BehaviorScenario,
  options: AcpBehaviorOptions = {},
): Promise<AcpBehaviorRun> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION
  const createTransport = options.createTransport ?? spawnBehaviorTransport
  const decision = scenario.permission ?? 'allow'
  const watchPaths = scenario.watchPaths ?? []

  const transcript: BehaviorEntry[] = []

  // Snapshot watched files before the turn so a shell write is detectable.
  const before = new Map<string, string | null>()
  for (const rel of watchPaths) {
    before.set(rel, await readOrNull(resolvePath(config.cwd, rel)))
  }

  const handleRead = async (params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
    transcript.push({ type: 'fs_read', path: toRelative(config.cwd, params.path) })
    return { content: await readFile(params.path, 'utf-8') }
  }
  const handleWrite = async (params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
    transcript.push({
      type: 'fs_write',
      path: toRelative(config.cwd, params.path),
      content: params.content,
    })
    await writeFile(params.path, params.content, 'utf-8')
    return {}
  }
  const handlePermission = (params: RequestPermissionRequest): RequestPermissionResponse => {
    const rawInput = params.toolCall.rawInput
    transcript.push({
      type: 'permission',
      title: params.toolCall.title ?? '',
      rawInput,
      hasRawInput: isStructuredInput(rawInput),
      subjectType: null,
    })
    return { outcome: chooseOption(params.options, decision) }
  }

  const base: Omit<AcpBehaviorRun, 'ok' | 'error'> = {
    transcript,
    stopReason: null,
    changedPaths: [],
  }

  let transport: { stream: Stream; dispose: () => void } | null = null
  const state = { timedOut: false }
  const timer = setTimeout(() => {
    state.timedOut = true
    transport?.dispose()
  }, timeoutMs)

  try {
    transport = await createTransport(config)
    const app = client({ name: 'copse-behavior-probe' })
      .onRequest(methods.client.fs.readTextFile, (ctx) => handleRead(ctx.params))
      .onRequest(methods.client.fs.writeTextFile, (ctx) => handleWrite(ctx.params))
      .onRequest(methods.client.session.requestPermission, (ctx) => handlePermission(ctx.params))

    const stopReason = await app.connectWith(transport.stream, async (ctx) => {
      await ctx.request(methods.agent.initialize, {
        protocolVersion,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      })
      return ctx.buildSession(config.cwd).withSession(async (session) => {
        session.prompt(scenario.prompt).catch(() => {
          // Surfaced instead via the nextUpdate rejection below.
        })
        for (;;) {
          const message: ActiveSessionMessage = await session.nextUpdate()
          if (message.kind === 'stop') return message.stopReason
          transcript.push({ type: 'update', sessionUpdate: message.update.sessionUpdate })
        }
      })
    })

    // Compare watched files after the turn to detect shell-tool writes.
    const changedPaths: string[] = []
    for (const rel of watchPaths) {
      const after = await readOrNull(resolvePath(config.cwd, rel))
      if (after !== before.get(rel)) changedPaths.push(rel)
    }

    return { ...base, changedPaths, stopReason, ok: true }
  } catch (err) {
    const reason = state.timedOut
      ? `timed out after ${String(timeoutMs)}ms`
      : err instanceof Error
        ? err.message
        : String(err)
    return { ...base, ok: false, error: reason }
  } finally {
    clearTimeout(timer)
    transport?.dispose()
  }
}

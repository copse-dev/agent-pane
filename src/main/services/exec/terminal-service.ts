import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { IDisposable, IPty } from 'node-pty'
import { spawnPtyInProjectSandbox } from '../../project-sandbox/index.ts'
import { envForRendererChildProcess } from './child-process-env.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { projectStoreDir } from '../storage/copse-paths.ts'
import { getSetting } from '../storage/settings.ts'
import {
  CappedOutputAccumulator,
  COMMAND_OUTPUT_MAX_BYTES,
  stripTerminalControlSequences,
} from './subprocess-output-cap.ts'
import { READ_TERMINAL_DEFAULT_LINES, takeLastLines } from '@shared/terminal/read-terminal.ts'
import {
  SHARE_TERMINAL_HISTORY_ENABLED_DEFAULT,
  SHARE_TERMINAL_HISTORY_ENABLED_SETTING,
  TERMINAL_HISTORY_FILENAME,
} from '@shared/terminal/terminal-history.ts'
import { nonEmptyStringOr } from '@shared/unknown-value.ts'
import { notifyThreadResourceFinished } from '../worktree-parking-events.ts'

interface PtyListeners {
  onData: IDisposable
  onExit: IDisposable
}

export interface TerminalSessionMeta {
  label?: string
  threadId?: string | null
  /**
   * Project the terminal belongs to — used only at spawn time to pick a
   * shared history file (#2433); not persisted or updatable afterwards.
   */
  projectId?: string
}

export interface TerminalSessionInfo {
  id: string
  label: string
  threadId: string | null
  active: boolean
}

/** A live shell's pid, for attributing listening ports back to the tab that opened them. */
export interface TerminalProcessInfo {
  id: string
  label: string
  pid: number
  threadId: string | null
  projectId: string | null
  ownerId: number
}

export interface TerminalSession {
  id: string
  pty: Pick<IPty, 'pid' | 'write' | 'resize' | 'kill' | 'onData' | 'onExit'>
  /** The renderer that created the session: ownership check *and* output target. */
  owner: TerminalOwner
  listeners?: PtyListeners
  /** Capped PTY output for agent `read_terminal` snapshots. */
  output: CappedOutputAccumulator
  label: string
  threadId: string | null
  projectId: string | null
}

const sessions = new Map<string, TerminalSession>()

/**
 * The renderer a session belongs to — structurally an Electron `WebContents`.
 *
 * A shell's output goes to the window that opened it and nowhere else. Unlike
 * the diff queue (shared workspace state, broadcast to every window), terminal
 * output is private to its owner: fanning it out would replay one window's
 * shell — credentials, tokens, whatever is on screen — into another renderer.
 *
 * Sessions were always keyed by the *calling* renderer's id, but their output
 * was sent to the one window captured at `initTerminal` time. A pane pop-out
 * could therefore open a shell and type into it while every byte it produced
 * was delivered to the main window, which had no tab for that session and
 * dropped it (#1705).
 */
export interface TerminalOwner {
  /** `WebContents.id` — the ownership key. */
  id: number
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

/** Per-owner focused session — the default target for `read_terminal` without an id. */
const activeByOwner = new Map<number, string>()

/**
 * Resolve a session only if `ownerId` matches the one that created it. Returns
 * `undefined` for unknown sessions; throws on an ownership mismatch so a renderer
 * can never write to / resize / destroy a session it does not own.
 */
function ownedSession(sessionId: string, ownerId: number): TerminalSession | undefined {
  const session = sessions.get(sessionId)
  if (!session) return undefined
  if (session.owner.id !== ownerId) {
    throw new Error(`Terminal session ${sessionId} is not owned by the caller`)
  }
  return session
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

function defaultShell(): string {
  if (process.platform === 'win32') return nonEmptyStringOr(process.env['COMSPEC'], 'cmd.exe')
  return nonEmptyStringOr(process.env['SHELL'], '/bin/bash')
}

function sessionCwd(executionRoot?: string): string {
  return executionRoot ?? getWorkspaceRoot() ?? process.cwd()
}

/** bash-only history knobs, applied only where the base env leaves them unset. */
function bashHistoryDefaults(baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  if (!baseEnv['HISTCONTROL']) out['HISTCONTROL'] = 'ignoredups:erasedups'
  if (!baseEnv['HISTSIZE']) out['HISTSIZE'] = '10000'
  if (!baseEnv['HISTFILESIZE']) out['HISTFILESIZE'] = '20000'
  return out
}

/**
 * bash-only: the `PROMPT_COMMAND` that makes a *running* shell converge with
 * the shared HISTFILE on its own, one prompt at a time. `shopt -s histappend`
 * prevents a stale shell from overwriting another shell's newer entries when
 * it exits; `history -n` reads whatever other shells landed since the last
 * prompt, then `history -w` writes the merged in-memory list including the
 * command that just finished. The rewrite is intentional: Bash 3.2 reports
 * success for `history -a` inside PROMPT_COMMAND but does not include that
 * just-finished command, so a second shell cannot recall it yet. Prepended
 * onto whatever `PROMPT_COMMAND` the base env already carries (bash runs the
 * whole string as one command list, left to right), so a user's own hook still
 * runs; never replaces it.
 */
function bashPromptCommand(baseEnv: NodeJS.ProcessEnv): string {
  const flush = 'shopt -s histappend; history -n; history -w'
  const existing = baseEnv['PROMPT_COMMAND']
  return existing ? `${flush}; ${existing}` : flush
}

/**
 * Env additions that make an interactive terminal PTY share command history
 * with every other terminal opened for the same project (#2433: up-arrow
 * history was scoped to a single thread's own PTY).
 *
 * Up-arrow history is the shell's own feature — bash/zsh read and write a
 * `HISTFILE`, so the smallest faithful fix is giving every supported PTY
 * opened for a project the same history identity. Fish is deliberately left
 * untouched: it accepts only a session name and persists that session under
 * its global XDG data directory, outside `COPSE_DIR`, violating Copse's
 * single-root state and profile-isolation contract. This is done through the
 * PTY's environment only, never a shell rc file, and it unconditionally wins
 * over any `HISTFILE` the main process's own environment happens to carry: an
 * Electron GUI launch essentially never has one, and nothing in this repo
 * forwards a user's interactive shell env into PTYs for history to defer to
 * (`envForRendererChildProcess` forwards ordinary vars but has no such
 * convention).
 *
 * A shared `HISTFILE` alone only helps a *new* shell: bash and zsh both load
 * history once, at startup, and otherwise only write it back at exit — so a
 * command typed into thread A's still-open shell would not reach thread B
 * until A's shell exited (or something ran `history -a` by hand). For bash,
 * `bashPromptCommand` closes that gap through `PROMPT_COMMAND`, so a command
 * run in one thread's open shell is recallable from another thread's open
 * shell within one prompt cycle, with no explicit flush and no shell exit
 * required. Two limits this cannot close: a user's own `~/.bashrc` can
 * reassign `PROMPT_COMMAND` after this env var seeds it (rc files run after
 * the shell starts and an assignment, not an append, silently drops the
 * hook), and zsh has no environment-settable equivalent —
 * `INC_APPEND_HISTORY` / `SHARE_HISTORY` are shell options `setopt` turns on,
 * not variables the environment can supply — so zsh still only shares history
 * at shell exit.
 *
 * Non-interactive tool shells (`run_shell` / `run_background`) never call
 * this — only the interactive Shells-tab PTY does.
 */
export function terminalHistoryEnv(
  shell: string,
  projectId: string | null | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!projectId) return {}
  if (
    !getSetting<boolean>(
      SHARE_TERMINAL_HISTORY_ENABLED_SETTING,
      SHARE_TERMINAL_HISTORY_ENABLED_DEFAULT,
    )
  ) {
    return {}
  }
  const shellName = basename(shell).toLowerCase()
  if (shellName === 'fish') return {}
  let dir: string
  try {
    dir = projectStoreDir(projectId)
    mkdirSync(dir, { recursive: true })
  } catch {
    // Bad project id, read-only store, etc. — fall back to the shell's own
    // default history rather than failing to open a terminal over this.
    return {}
  }
  const out: Record<string, string> = { HISTFILE: join(dir, TERMINAL_HISTORY_FILENAME) }
  // `.includes`, not an exact `=== 'bash'` — `$SHELL` is not always a bare
  // `bash` basename (versioned binaries like `bash5`, or a wrapper script that
  // execs real bash, as this repo's own e2e `$SHELL` fixture does for
  // deterministic terminal screenshots).
  const isBash = shellName.includes('bash')
  if (isBash || shellName === 'sh') {
    Object.assign(out, bashHistoryDefaults(baseEnv))
  }
  if (isBash) {
    out['PROMPT_COMMAND'] = bashPromptCommand(baseEnv)
  }
  return out
}

function sendTerminalEvent(
  owner: TerminalOwner,
  channel: 'terminal:output' | 'terminal:exit',
  sessionId: string,
  payload: string | number,
): void {
  if (owner.isDestroyed()) return
  owner.send(channel, sessionId, payload)
}

function disposeSessionListeners(session: TerminalSession): void {
  session.listeners?.onData.dispose()
  session.listeners?.onExit.dispose()
  delete session.listeners
}

function clearActiveIfNeeded(sessionId: string, ownerId: number): void {
  if (activeByOwner.get(ownerId) === sessionId) activeByOwner.delete(ownerId)
}

function disposeSession(session: TerminalSession, sessionId: string, notify = true): void {
  disposeSessionListeners(session)
  clearActiveIfNeeded(sessionId, session.owner.id)
  try {
    session.pty.kill()
  } catch {
    // PTY may already be dead during shutdown.
  }
  sessions.delete(sessionId)
  if (notify) {
    sendTerminalEvent(session.owner, 'terminal:exit', sessionId, -1)
    notifyThreadResourceFinished(session.threadId)
  }
}

function attachPtyHandlers(
  owner: TerminalOwner,
  sessionId: string,
  ptyProcess: IPty,
  session: TerminalSession,
): void {
  const onData = ptyProcess.onData((data) => {
    session.output.append(data)
    sendTerminalEvent(owner, 'terminal:output', sessionId, data)
  })
  const onExit = ptyProcess.onExit(({ exitCode }) => {
    disposeSessionListeners(session)
    clearActiveIfNeeded(sessionId, session.owner.id)
    sessions.delete(sessionId)
    notifyThreadResourceFinished(session.threadId)
    // exitCode comes from node-pty (external); guard against a missing code at runtime.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    sendTerminalEvent(owner, 'terminal:exit', sessionId, exitCode ?? 1)
  })
  session.listeners = { onData, onExit }
}

async function spawnShell(
  owner: TerminalOwner,
  cols: number,
  rows: number,
  meta?: TerminalSessionMeta,
  executionRoot?: string,
): Promise<TerminalSession> {
  const shell = defaultShell()
  const ptyProcess = await spawnPtyInProjectSandbox(shell, {
    cols,
    rows,
    cwd: sessionCwd(executionRoot),
    env: { ...envForRendererChildProcess(), ...terminalHistoryEnv(shell, meta?.projectId) },
    // User-initiated Shells tabs run outside the project seatbelt; agent shell
    // confinement stays on run_shell / run_background (#662, #812).
    unsandboxed: true,
  })

  const session: TerminalSession = {
    id: randomUUID(),
    pty: ptyProcess,
    owner,
    output: new CappedOutputAccumulator(COMMAND_OUTPUT_MAX_BYTES),
    label: nonEmptyStringOr(meta?.label?.trim(), 'Terminal'),
    threadId: meta?.threadId ?? null,
    projectId: meta?.projectId ?? null,
  }
  sessions.set(session.id, session)
  attachPtyHandlers(owner, session.id, ptyProcess, session)
  return session
}

export async function createTerminalSession(
  owner: TerminalOwner,
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  meta?: TerminalSessionMeta,
  executionRoot?: string,
): Promise<string> {
  const session = await spawnShell(owner, cols, rows, meta, executionRoot)
  // First session for this owner becomes active until the UI focuses another.
  if (!activeByOwner.has(owner.id)) activeByOwner.set(owner.id, session.id)
  return session.id
}

/**
 * Tear down every session belonging to one renderer. A pane pop-out is a real
 * window that can be closed on its own, and only the main window's `close` was
 * wired to teardown — so each pop-out close leaked its shells as orphaned ptys.
 */
export function destroyTerminalSessionsForOwner(ownerId: number): void {
  for (const [sessionId, session] of [...sessions]) {
    if (session.owner.id !== ownerId) continue
    disposeSession(session, sessionId)
  }
  activeByOwner.delete(ownerId)
}

export function writeTerminalSession(sessionId: string, ownerId: number, data: string): void {
  const session = ownedSession(sessionId, ownerId)
  if (!session) throw new Error(`Unknown terminal session: ${sessionId}`)
  session.pty.write(data)
}

export function resizeTerminalSession(
  sessionId: string,
  ownerId: number,
  cols: number,
  rows: number,
): void {
  const session = ownedSession(sessionId, ownerId)
  if (!session) throw new Error(`Unknown terminal session: ${sessionId}`)
  if (cols > 0 && rows > 0) session.pty.resize(cols, rows)
}

export function destroyTerminalSession(sessionId: string, ownerId: number): void {
  const session = ownedSession(sessionId, ownerId)
  if (!session) return
  disposeSession(session, sessionId)
}

export function destroyAllTerminalSessions(): void {
  for (const [sessionId, session] of sessions) {
    disposeSession(session, sessionId, false)
  }
  sessions.clear()
  activeByOwner.clear()
}

/** Update label / thread scope published by the Shells UI. */
export function setTerminalSessionMeta(
  sessionId: string,
  ownerId: number,
  meta: TerminalSessionMeta,
): void {
  const session = ownedSession(sessionId, ownerId)
  if (!session) return
  if (meta.label !== undefined) {
    const next = meta.label.trim()
    if (next) session.label = next
  }
  if (meta.threadId !== undefined) session.threadId = meta.threadId
}

/** Mark which Shells tab is focused for this renderer (default `read_terminal` target). */
export function setActiveTerminalSession(sessionId: string, ownerId: number): void {
  const session = ownedSession(sessionId, ownerId)
  if (!session) return
  activeByOwner.set(ownerId, sessionId)
}

function matchesThread(session: TerminalSession, threadId: string | null | undefined): boolean {
  if (threadId === undefined) return true
  if (threadId === null) return session.threadId === null
  return session.threadId === threadId
}

/** Agent-facing catalog; optionally scoped to the running chat thread. */
export function listTerminalSessions(threadId?: string | null): TerminalSessionInfo[] {
  const out: TerminalSessionInfo[] = []
  for (const session of sessions.values()) {
    if (!matchesThread(session, threadId)) continue
    out.push({
      id: session.id,
      label: session.label,
      threadId: session.threadId,
      active: activeByOwner.get(session.owner.id) === session.id,
    })
  }
  return out
}

export function hasTerminalSessions(threadId?: string | null): boolean {
  return listTerminalSessions(threadId).length > 0
}

/**
 * Every live shell's pid, across owners and threads — the Ports panel attributes
 * a listening port to a tab by climbing from the listener to one of these, so it
 * needs the whole host's worth, not one thread's. Sessions without a real pid
 * (test injections) are skipped rather than attributing pid 0 to everything.
 */
export function listTerminalProcesses(): TerminalProcessInfo[] {
  const out: TerminalProcessInfo[] = []
  for (const session of sessions.values()) {
    const { pid } = session.pty
    if (!Number.isInteger(pid) || pid <= 0) continue
    out.push({
      id: session.id,
      label: session.label,
      pid,
      threadId: session.threadId,
      projectId: session.projectId,
      ownerId: session.owner.id,
    })
  }
  return out
}

/**
 * Dispose every terminal owned by one thread. This explicit async boundary is
 * used by ordered thread/worktree retirement; unrelated and unscoped terminals
 * remain alive.
 */
export function destroyTerminalSessionsForThread(threadId: string): Promise<string[]> {
  const owned = [...sessions.values()].filter((session) => session.threadId === threadId)
  for (const session of owned) disposeSession(session, session.id)
  return Promise.resolve(owned.map((session) => session.id))
}

/**
 * Test-only: insert a session without spawning a PTY. Not used by production code.
 */
export function __testInjectTerminalSession(opts: {
  ownerId: number
  label: string
  threadId: string | null
  outputText: string
}): string {
  const id = randomUUID()
  const output = new CappedOutputAccumulator(COMMAND_OUTPUT_MAX_BYTES)
  output.append(opts.outputText)
  const session: TerminalSession = {
    id,
    // Minimal IPty stand-in — never written/resized/killed in these tests. pid 0
    // is deliberately not a real pid, so `listTerminalProcesses` skips it.
    pty: {
      pid: 0,
      write(): void {},
      resize(): void {},
      kill(): void {},
      onData(): { dispose(): void } {
        return { dispose(): void {} }
      },
      onExit(): { dispose(): void } {
        return { dispose(): void {} }
      },
    },
    owner: { id: opts.ownerId, isDestroyed: () => false, send(): void {} },
    output,
    label: opts.label,
    threadId: opts.threadId,
    projectId: null,
  }
  sessions.set(id, session)
  return id
}

/**
 * Snapshot recent PTY output for a session. When `sessionId` is omitted, uses the
 * focused tab for any owner that has sessions in `threadId` (preferring active).
 */
export function readTerminalSessionOutput(
  sessionId: string | undefined,
  maxLines: number = READ_TERMINAL_DEFAULT_LINES,
  threadId?: string | null,
): { id: string; label: string; text: string } | null {
  let session: TerminalSession | undefined
  if (sessionId) {
    session = sessions.get(sessionId)
    if (!session || !matchesThread(session, threadId)) return null
  } else {
    const candidates = listTerminalSessions(threadId)
    if (candidates.length === 0) return null
    const active = candidates.find((c) => c.active) ?? candidates[0]
    if (!active) return null
    session = sessions.get(active.id)
  }
  if (!session) return null
  const cleaned = stripTerminalControlSequences(session.output.toString())
  return {
    id: session.id,
    label: session.label,
    text: takeLastLines(cleaned, maxLines),
  }
}

import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalExitStatus,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk'
import { errorMessage } from '@shared/errors.ts'
import { formatArgvForShell } from '../../project-sandbox/sandbox-argv.ts'
import type { ShellRunObserver } from '../exec/shell-output-context.ts'

/**
 * ACP client terminals (`terminal/*`, issue #623).
 *
 * An agent that sees `clientCapabilities.terminal: true` asks Copse to run each
 * command instead of running it with its own shell. Every command re-enters
 * Copse's `run_shell` through the native bridge (see
 * `AcpNativeBridge.runShellCommand`), so it gets the same permission gate,
 * per-command project sandbox (ASRT on macOS, bubblewrap on Linux), package
 * firewall, env scrubbing and unsandboxed-retry prompt as a native call. This
 * module only owns the ACP side: terminal ids, the output buffer with the
 * agent's byte limit, and the exit status.
 */

/** The agent named a terminal this connection never created, or already released. */
export class UnknownAcpTerminalError extends Error {
  constructor(terminalId: string) {
    super(`Unknown terminal: ${terminalId}`)
    this.name = 'UnknownAcpTerminalError'
  }
}

/** What a command line resolves to once the turn's execution root is known. */
export type AcpTerminalCommand = { command: string } | { refused: string }

/**
 * Runs one command line through Copse's shell path, bound to the owning turn.
 * `compose` receives the execution root the command will run in (null when no
 * workspace is open) and returns the exact text the gate judges. Resolves with
 * run_shell's result text; rejects with its error (a non-zero exit, a timeout).
 */
export type AcpTerminalCommandRunner = (
  compose: (executionRoot: string | null) => AcpTerminalCommand,
  observer: ShellRunObserver,
  signal: AbortSignal,
) => Promise<string>

/** Retained output when the agent sets no `outputByteLimit`. */
export const ACP_TERMINAL_DEFAULT_OUTPUT_BYTES = 1024 * 1024
/** Live (unreleased) terminals one agent connection may hold. */
export const ACP_TERMINAL_MAX_LIVE = 16
/**
 * Exit code reported when Copse ran no process for the request: the gate
 * rejected it, the cwd was refused, or no turn was bound. The shell's own
 * "cannot execute" code, so an agent never reads it as success.
 */
export const ACP_TERMINAL_NOT_RUN_EXIT_CODE = 126

/** Written between a sandboxed attempt's output and its approved retry's output. */
export const ACP_TERMINAL_RETRY_MARKER = '[Copse] Retrying outside the project sandbox (approved).'

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The shell text for a `terminal/create` request, as the gate will see it.
 *
 * - With `args`, the request is an argv: every word is quoted, so the program
 *   runs exactly as named. Without `args`, `command` is a shell command line,
 *   which is how agents that only know a shell string send it.
 * - `env` becomes `export` lines ahead of the command, one per variable, so the
 *   approval prompt shows them and the classifier judges them with the command.
 * - `cwd` must be the execution root or inside it. A subdirectory becomes a
 *   `cd` line; anything outside the root is refused rather than run elsewhere.
 */
export function composeAcpTerminalCommand(
  req: Pick<CreateTerminalRequest, 'command' | 'args' | 'env' | 'cwd'>,
  executionRoot: string | null,
): AcpTerminalCommand {
  if (executionRoot === null) return { refused: 'No workspace is open.' }
  if (!req.command.trim()) return { refused: 'The terminal command is empty.' }
  const lines: string[] = []
  for (const variable of req.env ?? []) {
    if (!ENV_NAME.test(variable.name)) {
      return { refused: `Invalid environment variable name: ${JSON.stringify(variable.name)}` }
    }
    lines.push(`export ${variable.name}=${posixQuote(variable.value)}`)
  }
  if (req.cwd !== undefined && req.cwd !== null && req.cwd !== '') {
    if (!isAbsolute(req.cwd)) {
      return { refused: `The terminal cwd must be an absolute path: ${req.cwd}` }
    }
    const rel = relative(canonical(executionRoot), canonical(req.cwd))
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        refused: `The terminal cwd ${req.cwd} is outside the workspace (${executionRoot}); commands run in the workspace.`,
      }
    }
    if (rel !== '') lines.push(`cd -- ${posixQuote(rel)} || exit 1`)
  }
  const args = req.args ?? []
  lines.push(args.length > 0 ? formatArgvForShell(req.command, args) : req.command)
  return { command: lines.join('\n') }
}

/**
 * Output retained from the end, at most `limit` UTF-8 bytes. Truncation drops
 * whole characters from the front, as the ACP spec requires.
 */
export class AcpTerminalOutputBuffer {
  private text = ''
  private bytes = 0
  private wasTruncated = false

  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  append(chunk: string): void {
    if (!chunk) return
    this.text += chunk
    this.bytes += Buffer.byteLength(chunk)
    if (this.bytes <= this.limit) return
    this.wasTruncated = true
    const buffer = Buffer.from(this.text)
    let start = buffer.length - this.limit
    // Never start on a UTF-8 continuation byte (10xxxxxx).
    while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) start++
    this.text = buffer.subarray(start).toString()
    this.bytes = buffer.length - start
  }

  get output(): string {
    return this.text
  }

  get truncated(): boolean {
    return this.wasTruncated
  }
}

interface AcpTerminal {
  readonly buffer: AcpTerminalOutputBuffer
  readonly abort: AbortController
  exitStatus: TerminalExitStatus | null
  readonly done: Promise<TerminalExitStatus>
}

/** run_shell's own result for a retry the user declined (see shell-tool.ts). */
const DECLINED_RETRY = 'User declined to run outside the sandbox.'

/**
 * The note appended to a terminal's output, if any. run_shell's result is the
 * command's output when it ran normally, which the terminal already holds; only
 * an outcome the agent cannot otherwise see (a rejection, a declined retry, a
 * timeout) is added.
 */
function outcomeNote(outcome: { ok: boolean; text: string }, ran: boolean): string | null {
  if (!ran) return outcome.text
  if (outcome.ok) return outcome.text === DECLINED_RETRY ? outcome.text : null
  return outcome.text.startsWith('Exited with code') ? null : outcome.text
}

/** Terminals for one ACP connection. Disposed with the connection. */
export class AcpTerminalHost {
  private readonly terminals = new Map<string, AcpTerminal>()
  private disposed = false

  private readonly run: AcpTerminalCommandRunner

  constructor(run: AcpTerminalCommandRunner) {
    this.run = run
  }

  create(req: CreateTerminalRequest): CreateTerminalResponse {
    if (this.disposed) throw new Error('The coding agent session has ended')
    if (this.terminals.size >= ACP_TERMINAL_MAX_LIVE) {
      throw new Error(
        `Too many open terminals (${String(ACP_TERMINAL_MAX_LIVE)}); release finished terminals with terminal/release`,
      )
    }
    const limit =
      typeof req.outputByteLimit === 'number' && req.outputByteLimit >= 0
        ? Math.floor(req.outputByteLimit)
        : ACP_TERMINAL_DEFAULT_OUTPUT_BYTES
    const buffer = new AcpTerminalOutputBuffer(limit)
    const abort = new AbortController()
    let lastExit: TerminalExitStatus | null = null
    let retryMarked = false
    const observer: ShellRunObserver = {
      output: (chunk) => {
        // A second process after an exit is run_shell's unsandboxed retry; say
        // so, rather than splicing two attempts into one stream.
        if (lastExit !== null && !retryMarked) {
          retryMarked = true
          const separator = buffer.output && !buffer.output.endsWith('\n') ? '\n' : ''
          buffer.append(`${separator}${ACP_TERMINAL_RETRY_MARKER}\n`)
        }
        buffer.append(chunk)
      },
      exit: ({ exitCode, signal }) => {
        lastExit = { exitCode, signal }
      },
    }
    const terminalId = `copse-term-${randomUUID()}`
    const exited = Promise.withResolvers<TerminalExitStatus>()
    const terminal: AcpTerminal = { buffer, abort, exitStatus: null, done: exited.promise }
    // Read through a call: `lastExit` is assigned in the observer callback.
    const observedExit = (): TerminalExitStatus | null => lastExit
    void this.run((root) => composeAcpTerminalCommand(req, root), observer, abort.signal)
      .then(
        (text) => ({ ok: true, text }),
        (err: unknown) => ({ ok: false, text: errorMessage(err) }),
      )
      .then((outcome) => {
        const exit = observedExit()
        const note = outcomeNote(outcome, exit !== null)
        if (note) {
          const separator = buffer.output && !buffer.output.endsWith('\n') ? '\n' : ''
          buffer.append(`${separator}${note}\n`)
        }
        const status: TerminalExitStatus = exit ?? {
          exitCode: abort.signal.aborted ? null : ACP_TERMINAL_NOT_RUN_EXIT_CODE,
          signal: abort.signal.aborted ? 'SIGTERM' : null,
        }
        terminal.exitStatus = status
        exited.resolve(status)
      })
    this.terminals.set(terminalId, terminal)
    return { terminalId }
  }

  output(req: TerminalOutputRequest): TerminalOutputResponse {
    const terminal = this.get(req.terminalId)
    return {
      output: terminal.buffer.output,
      truncated: terminal.buffer.truncated,
      ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
    }
  }

  async waitForExit(req: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const status = await this.get(req.terminalId).done
    return { exitCode: status.exitCode ?? null, signal: status.signal ?? null }
  }

  kill(req: KillTerminalRequest): KillTerminalResponse {
    const terminal = this.get(req.terminalId)
    if (!terminal.exitStatus) terminal.abort.abort(new Error('terminal/kill'))
    return {}
  }

  release(req: ReleaseTerminalRequest): ReleaseTerminalResponse {
    const terminal = this.get(req.terminalId)
    this.terminals.delete(req.terminalId)
    if (!terminal.exitStatus) terminal.abort.abort(new Error('terminal/release'))
    return {}
  }

  /** Kill every live command. Called when the agent connection closes. */
  dispose(): void {
    this.disposed = true
    for (const terminal of this.terminals.values()) {
      if (!terminal.exitStatus) terminal.abort.abort(new Error('ACP session closed'))
    }
    this.terminals.clear()
  }

  private get(terminalId: string): AcpTerminal {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) throw new UnknownAcpTerminalError(terminalId)
    return terminal
  }
}

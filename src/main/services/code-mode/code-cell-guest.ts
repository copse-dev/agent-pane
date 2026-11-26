/**
 * The guest half of code mode: runs TypeScript cells for one thread inside its
 * code-cell container, and turns `await tools.<name>(args)` into requests to
 * the host over the container's stdio link (`code-cell-wire.ts`).
 *
 * Cells share one `node:vm` context for the container's life, so values a
 * cell leaves on `state` (or on `globalThis`) are there for the thread's next
 * cell. That context is a convenience, not a boundary: code in it can reach
 * this process and everything the process can. The boundary is the container
 * (no network, read-only root, no host mounts, no capabilities); the host
 * decides every tool call as if this process were hostile.
 *
 * Bundled into the guest runner, so it imports nothing from the app beyond
 * the wire module.
 */
import { stripTypeScriptTypes } from 'node:module'
import type { Duplex } from 'node:stream'
import { inspect } from 'node:util'
import { createContext, Script, type Context } from 'node:vm'
import {
  CELL_TOOL_NAME,
  CODE_CELL_CONTROL_TARGET,
  CODE_CELL_OUTPUT_LIMIT,
  CODE_CELL_TOOL_TARGET,
  cellRunSchema,
  decodeLine,
  encodeLine,
  readLines,
  readMessage,
  toolCallResponseSchema,
  type CellResult,
  type CellRun,
} from './code-cell-wire.ts'

/** What the guest needs of its link: the ability to open a stream by name. */
export interface CodeCellGuestLink {
  open(target: string): Promise<Duplex>
}

/**
 * A cell is the body of an async function, so `await` and `return` work at
 * its top level. The wrapper opens on the cell's first line, which keeps the
 * line numbers in a stack trace the cell's own.
 */
const WRAP_PREFIX = '(async () => {'
const WRAP_SUFFIX = '\n})()'

/** Half the output budget for logs and half for the returned value. */
const PART_LIMIT = Math.floor(CODE_CELL_OUTPUT_LIMIT / 2)

class BoundedText {
  private parts: string[] = []
  private bytes = 0
  truncated = false

  append(text: string): void {
    if (this.truncated) return
    const size = Buffer.byteLength(text)
    if (this.bytes + size <= PART_LIMIT) {
      this.parts.push(text)
      this.bytes += size
      return
    }
    const room = PART_LIMIT - this.bytes
    if (room > 0) this.parts.push(Buffer.from(text).subarray(0, room).toString('utf8'))
    this.bytes = PART_LIMIT
    this.truncated = true
  }

  toString(): string {
    return this.parts.join('')
  }
}

function formatArg(value: unknown): string {
  return typeof value === 'string' ? value : inspect(value, { depth: 4, breakLength: 120 })
}

/** The value a cell returned, as the text the model reads. */
export function formatCellValue(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    const json: unknown = JSON.stringify(value, null, 2)
    if (typeof json === 'string') return json
  } catch {
    // A cycle or a BigInt: fall back to the inspector, which handles both.
  }
  return inspect(value, { depth: 4, breakLength: 120 })
}

/**
 * An error thrown by a cell, as the model should read it: the message and the
 * stack frames inside the cell, without the runner's own frames. Errors made
 * inside the cell's context are not `instanceof Error` here (another realm),
 * so this reads the `stack` and `message` properties instead.
 */
export function describeCellError(error: unknown, filename: string): string {
  if (typeof error !== 'object' || error === null) return `Thrown: ${formatArg(error)}`
  const stack: unknown = Reflect.get(error, 'stack')
  const message: unknown = Reflect.get(error, 'message')
  if (typeof stack !== 'string') {
    return typeof message === 'string' ? message : `Thrown: ${formatArg(error)}`
  }
  const lines = stack.split('\n')
  const head = lines[0] ?? ''
  const frames = lines.slice(1).filter((line) => line.includes(filename))
  return [head, ...frames].join('\n')
}

/** A cell's arguments as the JSON object the host will decode, or a readable refusal. */
function plainArguments(name: string, args: unknown): Record<string, unknown> {
  if (args === undefined) return {}
  let text: unknown
  try {
    text = JSON.stringify(args)
  } catch {
    throw new Error(`tools.${name}: its arguments must be JSON (no cycles or BigInts)`)
  }
  const plain: unknown = typeof text === 'string' ? JSON.parse(text) : undefined
  if (typeof plain !== 'object' || plain === null || Array.isArray(plain)) {
    throw new Error(`tools.${name} takes one object of arguments`)
  }
  return Object.fromEntries(Object.entries(plain))
}

/** Reaches the host for one `tools.<name>(args)`: resolves to the text, or throws the refusal. */
export type GuestToolCaller = (name: string, args: Record<string, unknown>) => Promise<string>

/** Runs cells, one at a time, in a context that persists between them. */
export interface CellEngine {
  /** Resolves once the engine can take a cell without starting up first. */
  ready(): Promise<void>
  run(cell: CellRun): Promise<CellResult>
}

export class CodeCellRunner implements CellEngine {
  private readonly context: Context
  /** The current cell's log; a timer left by an earlier cell writes into the current one. */
  private logs = new BoundedText()
  private readonly callHost: GuestToolCaller

  constructor(callHost: GuestToolCaller) {
    this.callHost = callHost
    const state: Record<string, unknown> = {}
    // Every property read goes through the trap, so the target's prototype is never seen.
    const target: Record<string, unknown> = {}
    const tools = new Proxy(target, {
      get: (_target, property): unknown => {
        // Not a thenable: `await tools` must not call a tool named `then`.
        if (typeof property !== 'string' || property === 'then') return undefined
        return (args?: unknown): Promise<string> => this.callTool(property, args)
      },
    })
    this.context = createContext({
      tools,
      state,
      console: this.cellConsole(),
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      queueMicrotask,
      structuredClone,
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
      atob,
      btoa,
    })
  }

  private cellConsole(): Record<string, (...args: unknown[]) => void> {
    const write =
      (prefix: string) =>
      (...args: unknown[]): void => {
        this.logs.append(`${prefix}${args.map(formatArg).join(' ')}\n`)
      }
    return {
      log: write(''),
      info: write(''),
      debug: write(''),
      warn: write('[warn] '),
      error: write('[error] '),
    }
  }

  private async callTool(name: string, args: unknown): Promise<string> {
    if (!CELL_TOOL_NAME.test(name)) throw new Error(`tools.${name} is not a Copse tool name`)
    return await this.callHost(name, plainArguments(name, args))
  }

  ready(): Promise<void> {
    return Promise.resolve()
  }

  async run(cell: CellRun): Promise<CellResult> {
    this.logs = new BoundedText()
    const value = new BoundedText()
    const filename = `cell-${String(cell.id)}.ts`
    const finish = (outcome: { ok: true } | { ok: false; error: string }): CellResult => {
      if (!outcome.ok) value.append(outcome.error)
      const truncated = this.logs.truncated || value.truncated
      const logs = this.logs.toString()
      return outcome.ok
        ? { id: cell.id, ok: true, value: value.toString(), logs, truncated }
        : { id: cell.id, ok: false, error: value.toString(), logs, truncated }
    }
    let source: string
    try {
      source = stripTypeScriptTypes(`${WRAP_PREFIX}${cell.code}${WRAP_SUFFIX}`, { mode: 'strip' })
    } catch (error) {
      return finish({ ok: false, error: describeCellError(error, filename) })
    }
    try {
      // V8 interrupts a cell's synchronous start that runs past the deadline.
      // The asynchronous rest has no such interrupt; the host's own deadline
      // covers it, and discards this container when it passes, because a cell
      // given up on here could still be running.
      const script = new Script(source, { filename })
      const pending: unknown = script.runInContext(this.context, { timeout: cell.timeoutMs })
      value.append(formatCellValue(await pending))
      return finish({ ok: true })
    } catch (error) {
      return finish({ ok: false, error: describeCellError(error, filename) })
    }
  }
}

/**
 * One tool request to the host, stamped with the cell the host asked for
 * last: the host serves it only while that cell is running.
 */
async function requestTool(
  link: CodeCellGuestLink,
  cell: number,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const stream = await link.open(CODE_CELL_TOOL_TARGET)
  stream.end(encodeLine({ cell, name, args }))
  const reply = decodeLine((await readMessage(stream)).trim(), toolCallResponseSchema)
  if (reply === null) throw new Error(`tools.${name}: the host sent an unreadable reply`)
  if (!reply.ok) throw new Error(reply.error)
  return reply.result
}

/**
 * Serve cells until the host closes the control stream. Cells run one at a
 * time, in the order the host sent them; a malformed message ends the stream.
 * `engine` runs them: in the product a worker thread (`code-cell-worker.ts`),
 * so this thread keeps answering the link whatever a cell does.
 */
export async function serveCodeCells(
  link: CodeCellGuestLink,
  options: { nodeVersion: string; engine: (callHost: GuestToolCaller) => CellEngine },
): Promise<void> {
  const control = await link.open(CODE_CELL_CONTROL_TARGET)
  let activeCell = -1
  const engine = options.engine((name, args) => requestTool(link, activeCell, name, args))
  // Ready means ready to run: a warm spare has its engine up already.
  await engine.ready()
  let queue = Promise.resolve()
  control.write(encodeLine({ ready: true, node: options.nodeVersion.slice(0, 64) }))
  await readLines(control, (line) => {
    const cell = decodeLine(line, cellRunSchema)
    if (cell === null) {
      control.destroy(new Error('malformed control message'))
      return
    }
    queue = queue.then(async () => {
      activeCell = cell.id
      const result = await engine.run(cell)
      if (!control.destroyed) control.write(encodeLine(result))
    })
  })
  await queue
}

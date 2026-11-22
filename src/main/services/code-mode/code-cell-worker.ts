/**
 * Runs a code-cell container's cells on a worker thread, so the runner's main
 * thread stays free to answer the link whatever a cell does. A cell that spins
 * (`while (true) {}` after an `await`, or a timer an earlier cell left behind)
 * blocks only the worker: the main thread still sees the host close the link,
 * and exits, and the container exits with it. That holds when the app quits
 * and when it crashes.
 *
 * The cells' context lives in the worker for the container's life, so state
 * persists between them as before. Messages between the threads are decoded
 * through schemas on both sides: code in a cell can reach the worker's port.
 */
import { Worker, type MessagePort } from 'node:worker_threads'
import { z } from 'zod'
import { errorMessage } from '@shared/errors.ts'
import { CodeCellRunner, type CellEngine, type GuestToolCaller } from './code-cell-guest.ts'
import {
  CELL_TOOL_NAME,
  cellResultSchema,
  cellRunSchema,
  toolCallResponseSchema,
  type CellResult,
  type CellRun,
} from './code-cell-wire.ts'

/** The worker's heap: under the container's memory limit, so a runaway cell ends the worker. */
const WORKER_HEAP_MB = 384

const callId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

const toWorkerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run'), cell: cellRunSchema }).strict(),
  z.object({ type: z.literal('tool-reply'), call: callId, reply: toolCallResponseSchema }).strict(),
])

const fromWorkerSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('tool-call'),
      call: callId,
      name: z.string().regex(CELL_TOOL_NAME),
      args: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z.object({ type: z.literal('result'), result: cellResultSchema }).strict(),
  z.object({ type: z.literal('ready') }).strict(),
])

/** The runner's side: hands each cell to the worker and answers its tool calls. */
export class WorkerCellEngine implements CellEngine {
  private readonly worker: Worker
  private pending: { id: number; resolve: (result: CellResult) => void } | null = null
  private readonly started: PromiseWithResolvers<void> = Promise.withResolvers()

  /**
   * @param entry the script the worker runs: the runner bundle itself, which
   *   serves the worker side when it is not the main thread.
   * @param onFailure the worker stopped; the runner cannot run cells any more.
   */
  constructor(entry: string, callHost: GuestToolCaller, onFailure: (reason: string) => void) {
    this.worker = new Worker(entry, {
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      // Not piped to this thread's stdout, which belongs to the link.
      stdout: true,
      stderr: true,
    })
    this.worker.stdout.pipe(process.stderr)
    this.worker.stderr.pipe(process.stderr)
    this.worker.on('message', (raw: unknown) => {
      const message = fromWorkerSchema.safeParse(raw)
      if (!message.success) return
      if (message.data.type === 'ready') {
        this.started.resolve()
        return
      }
      if (message.data.type === 'tool-call') {
        const { call, name, args } = message.data
        callHost(name, args).then(
          (result) => {
            this.worker.postMessage({ type: 'tool-reply', call, reply: { ok: true, result } })
          },
          (error: unknown) => {
            this.worker.postMessage({
              type: 'tool-reply',
              call,
              reply: { ok: false, error: errorMessage(error) },
            })
          },
        )
        return
      }
      const pending = this.pending
      if (pending?.id !== message.data.result.id) return
      this.pending = null
      pending.resolve(message.data.result)
    })
    this.worker.on('error', (error: unknown) => {
      onFailure(`the cell worker failed: ${errorMessage(error)}`)
    })
    this.worker.on('exit', (code) => {
      onFailure(`the cell worker exited (${String(code)})`)
    })
  }

  ready(): Promise<void> {
    return this.started.promise
  }

  run(cell: CellRun): Promise<CellResult> {
    return new Promise((resolve) => {
      this.pending = { id: cell.id, resolve }
      this.worker.postMessage({ type: 'run', cell })
    })
  }
}

/** The worker's side: runs the cells it is sent, asking the runner for their tool calls. */
export function serveCellWorker(port: MessagePort): void {
  let nextCall = 1
  const waiting = new Map<
    number,
    { resolve: (text: string) => void; reject: (error: Error) => void }
  >()
  const runner = new CodeCellRunner(
    (name, args) =>
      new Promise<string>((resolve, reject) => {
        const call = nextCall
        nextCall += 1
        waiting.set(call, { resolve, reject })
        port.postMessage({ type: 'tool-call', call, name, args })
      }),
  )
  port.on('message', (raw: unknown) => {
    const message = toWorkerSchema.safeParse(raw)
    if (!message.success) return
    if (message.data.type === 'run') {
      void runner.run(message.data.cell).then((result) => {
        port.postMessage({ type: 'result', result })
      })
      return
    }
    const entry = waiting.get(message.data.call)
    if (entry === undefined) return
    waiting.delete(message.data.call)
    const { reply } = message.data
    if (reply.ok) entry.resolve(reply.result)
    else entry.reject(new Error(reply.error))
  })
  port.postMessage({ type: 'ready' })
}

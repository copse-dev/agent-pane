import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from './safe-json.mts'
import {
  choiceResponseSchema,
  failedChoice,
  type ChoiceJudgment,
  type ChoicePayload,
} from './choice-judge.mts'

const detailsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
const readySchema = z.object({
  ready: z.literal(true),
  model: z.string().min(1),
  setupMs: z.number().nonnegative(),
  details: detailsSchema,
})
/** JSONL boundary for published local runtimes. Only evidence crosses stdin; labels stay in the scorer. */
export class LocalChoiceJudge {
  private child: ChildProcessWithoutNullStreams
  private lines: Interface
  private iterator: AsyncIterableIterator<string>
  setupError: string | null = null
  private failure: string | null = null
  private disposed = false
  private readonly cancel = (): void => {
    this.failure = 'Local evaluation cancelled'
    this.close()
  }
  private readonly timeoutMs: number

  constructor(command: string, args: string[], timeoutMs: number) {
    this.timeoutMs = timeoutMs
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this.child.stderr.resume()
    this.child.on('error', () => {
      this.failure = 'Local model process failed to start'
      this.lines.close()
    })
    this.child.stdin.on('error', () => {
      this.failure = 'Local model input failed'
      this.lines.close()
    })
    this.lines = createInterface({ input: this.child.stdout })
    this.iterator = this.lines[Symbol.asyncIterator]()
    process.once('SIGINT', this.cancel)
    process.once('SIGTERM', this.cancel)
  }

  private async nextLine(): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const next = await Promise.race([
        this.iterator.next(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Local model timeout'))
          }, this.timeoutMs)
        }),
      ])
      if (next.done || this.failure)
        throw new Error(this.failure ?? 'Local model exited before responding')
      if (next.value.length > 65_536) throw new Error('Local model response exceeded output limit')
      return next.value
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async ready(): Promise<z.infer<typeof readySchema>> {
    try {
      const line = await this.nextLine()
      const failure = safeJsonParse(
        line,
        decodeWithSchema(
          z.object({
            ready: z.literal(false),
            error: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/u),
            detail: z.string().max(800).optional(),
          }),
        ),
      )
      if (failure)
        this.setupError =
          'Local model setup: ' + failure.error + (failure.detail ? ' — ' + failure.detail : '')
      const result = safeJsonParse(line, decodeWithSchema(readySchema))
      if (!result) throw new Error('Local model did not return a valid ready message')
      return result
    } catch {
      this.close()
      throw new Error(
        'Local model setup failed; check its installation, checkpoint and context requirements',
      )
    }
  }

  async evaluatePayload(
    payload: ChoicePayload,
    labels: readonly string[],
  ): Promise<ChoiceJudgment> {
    const started = performance.now()
    try {
      this.child.stdin.write(JSON.stringify(payload) + '\n')
      const raw = safeJsonParse(await this.nextLine(), decodeWithSchema(z.unknown()))
      const parsed = choiceResponseSchema(labels).safeParse(raw)
      const latencyMs = performance.now() - started
      if (!parsed.success)
        return failedChoice(
          'Invalid local judgment: ' +
            parsed.error.issues.map((issue) => issue.path.join('.') + ' ' + issue.code).join('; '),
          false,
          latencyMs,
        )
      const result = parsed.data
      if (!result.error && !result.verdict)
        return failedChoice('Missing local verdict', false, latencyMs)
      return { ...result, latencyMs }
    } catch {
      this.close()
      return failedChoice(
        'Local model transport failed or timed out',
        true,
        performance.now() - started,
      )
    }
  }

  close(): void {
    if (this.disposed) return
    this.disposed = true
    process.off('SIGINT', this.cancel)
    process.off('SIGTERM', this.cancel)
    if (this.child.pid && process.platform !== 'win32') {
      try {
        process.kill(-this.child.pid, 'SIGKILL')
      } catch {
        /* Already exited. */
      }
    }
    this.child.kill('SIGKILL')
    this.lines.close()
    this.child.stdin.destroy()
    this.child.stdout.destroy()
  }
}

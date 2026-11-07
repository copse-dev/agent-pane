import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { z } from 'zod'

// Test-target protocol only. It never handles SIGUSR1 or replaces inspector.close.
// A request is answered by the target's ordinary main-loop IPC callback.
export const TARGET_PROGRESS_SOURCE = `
process.on('message', (request) => {
  if (request === null || typeof request !== 'object' ||
      request.type !== 'profiler-target-progress' ||
      typeof request.nonce !== 'string' || typeof request.stage !== 'string') return
  process.send?.({
    type: 'profiler-target-progress-ack', nonce: request.nonce, stage: request.stage,
    pid: process.pid, node: process.version, v8: process.versions.v8,
    arch: process.arch, coverage: Boolean(process.env.NODE_V8_COVERAGE),
  })
})
process.send?.({ type: 'profiler-target-progress-ready', pid: process.pid })
`

const replySchema = z.object({
  type: z.literal('profiler-target-progress-ack'),
  nonce: z.string().min(1),
  stage: z.string().min(1),
  pid: z.number().int().positive(),
  node: z.string().min(1),
  v8: z.string().min(1),
  arch: z.string().min(1),
  coverage: z.boolean(),
})

const replyKindSchema = z.object({ type: z.literal('profiler-target-progress-ack') })

/** A fresh reply attests target main-loop progress; a closed HTTP listener alone does not. */
export async function requestTargetProgress(
  child: ChildProcess,
  stage: string,
  timeoutMs = 5000,
): Promise<z.infer<typeof replySchema>> {
  const nonce = randomUUID()
  const identity = (): string =>
    `pid=${String(child.pid)} exit=${String(child.exitCode)} signal=${String(child.signalCode)}`
  if (!child.pid || !child.connected || child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`Target unavailable before ${stage}: ${identity()}`)
  }
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, reply?: z.infer<typeof replySchema>): void => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
      child.off('disconnect', onDisconnect)
      child.off('error', onError)
      if (error) reject(error)
      else if (reply) resolve(reply)
    }
    const onMessage = (message: unknown): void => {
      if (!replyKindSchema.safeParse(message).success) return
      const parsed = replySchema.safeParse(message)
      if (!parsed.success) {
        finish(new Error(`Malformed target progress acknowledgement during ${stage}`))
        return
      }
      if (parsed.data.nonce !== nonce) return
      if (parsed.data.stage !== stage || parsed.data.pid !== child.pid) {
        finish(new Error(`Target progress identity mismatch during ${stage}: ${identity()}`))
        return
      }
      finish(undefined, parsed.data)
    }
    const onExit = (): void => {
      finish(new Error(`Target exited during ${stage}: ${identity()}`))
    }
    const onDisconnect = (): void => {
      finish(new Error(`Target IPC disconnected during ${stage}: ${identity()}`))
    }
    const onError = (error: Error): void => {
      finish(new Error(`Target IPC failed during ${stage}: ${identity()}`, { cause: error }))
    }
    const timer = setTimeout(() => {
      finish(new Error(`Target progress timed out during ${stage}: ${identity()}`))
    }, timeoutMs)
    child.on('message', onMessage)
    child.once('exit', onExit)
    child.once('disconnect', onDisconnect)
    child.once('error', onError)
    try {
      child.send({ type: 'profiler-target-progress', nonce, stage }, (error) => {
        if (error) onError(error)
      })
    } catch (error) {
      finish(
        new Error(`Cannot request target progress during ${stage}: ${identity()}`, {
          cause: error,
        }),
      )
    }
  })
}

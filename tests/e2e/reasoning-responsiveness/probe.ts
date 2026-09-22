import { browser } from '@wdio/globals'
import { z } from 'zod'

const probeSchema = z.object({
  frameGapsMs: z.array(z.number().nonnegative()),
  inputDelayMs: z.array(z.number().nonnegative()),
  inputFrameCheckpointMs: z.array(z.number().nonnegative()),
  longFrameMs: z.array(z.number().nonnegative()),
  longTaskMs: z.array(z.number().nonnegative()),
  supportedEntries: z.array(z.string()),
  hidden: z.boolean(),
  overflow: z.boolean(),
  settledNodeRetained: z.boolean(),
  elapsedMs: z.number().positive(),
  startedAt: z.number().positive(),
})

/** Test-owned observer, installed before load and disposed even when a spec fails. */
export async function startResponsivenessProbe(): Promise<void> {
  await browser.execute(() => {
    const frameGapsMs: number[] = []
    const inputDelayMs: number[] = []
    const inputFrameCheckpointMs: number[] = []
    const longFrameMs: number[] = []
    const longTaskMs: number[] = []
    const supportedEntries = [...PerformanceObserver.supportedEntryTypes]
    const observers: Array<{ observer: PerformanceObserver; samples: number[] }> = []
    const started = performance.now()
    const settled = document.querySelector('.tool-card-step .message-reasoning-text p')
    let lastFrame: number | null = null
    let frame = 0
    let stopped = false
    let hidden = document.hidden
    let overflow = false
    const record = (target: number[], value: number): void => {
      if (target.length < 8_192) target.push(value)
      else overflow = true
    }
    const tick = (now: number): void => {
      if (lastFrame !== null) record(frameGapsMs, now - lastFrame)
      lastFrame = now
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    const visibility = (): void => {
      hidden ||= document.hidden
    }
    document.addEventListener('visibilitychange', visibility)
    const keydown = (event: KeyboardEvent): void => {
      if (!event.isTrusted) return
      record(inputDelayMs, Math.max(0, performance.now() - event.timeStamp))
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!stopped)
            record(inputFrameCheckpointMs, Math.max(0, performance.now() - event.timeStamp))
        }),
      )
    }
    document.addEventListener('keydown', keydown, true)
    for (const [type, samples] of [
      ['long-animation-frame', longFrameMs],
      ['longtask', longTaskMs],
    ] satisfies Array<[string, number[]]>) {
      if (!supportedEntries.includes(type)) continue
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) record(samples, entry.duration)
      })
      observer.observe({ type })
      observers.push({ observer, samples })
    }
    Reflect.set(window, '__copseResponsivenessProbe', () => {
      stopped = true
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('visibilitychange', visibility)
      for (const { observer, samples } of observers) {
        for (const entry of observer.takeRecords()) record(samples, entry.duration)
        observer.disconnect()
      }
      Reflect.deleteProperty(window, '__copseResponsivenessProbe')
      return {
        frameGapsMs,
        inputDelayMs,
        inputFrameCheckpointMs,
        longFrameMs,
        longTaskMs,
        supportedEntries,
        hidden,
        overflow,
        settledNodeRetained: settled !== null && settled.isConnected,
        elapsedMs: performance.now() - started,
        startedAt: performance.timeOrigin + started,
      }
    })
  })
}

export async function stopResponsivenessProbe(): Promise<z.infer<typeof probeSchema>> {
  const raw: unknown = await browser.execute(() => {
    const stop: unknown = Reflect.get(window, '__copseResponsivenessProbe')
    if (typeof stop !== 'function') throw new Error('Responsiveness probe was not started')
    return Reflect.apply(stop, window, [])
  })
  return probeSchema.parse(raw)
}

export function summarizeTimings(values: readonly number[]): {
  samples: number
  p50: number | null
  p95: number | null
  p99: number | null
  max: number | null
} {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (fraction: number): number | null =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null
  return {
    samples: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
  }
}

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createFrameLoop,
  createStreamPacer,
  revealBoundary,
  type FrameSource,
} from './stream-pacer.ts'

/** A frame source driven by hand: `advance(ms)` runs the pending frame. */
function manualFrames(options: { animate?: boolean } = {}): FrameSource & {
  advance: (ms: number) => void
  pending: () => boolean
} {
  let time = 0
  let queued: (() => void) | null = null
  let nextHandle = 1
  return {
    now: () => time,
    request: (callback: () => void): number => {
      queued = callback
      return nextHandle++
    },
    cancel: (): void => {
      queued = null
    },
    canAnimate: () => options.animate ?? true,
    advance: (ms: number): void => {
      time += ms
      const run = queued
      queued = null
      run?.()
    },
    pending: () => queued !== null,
  }
}

const FRAME_MS = 1000 / 60

/** Feed `text` in `chunk`-sized pieces every `everyMs`, recording each frame's paint. */
function streamSteadily(
  text: string,
  chunk: number,
  everyMs: number,
): { perFrame: number[]; painted: string[] } {
  const frames = manualFrames()
  const painted: string[] = []
  const pacer = createStreamPacer((next) => painted.push(next), '', frames)
  const perFrame: number[] = []
  let sent = 0
  let nextChunkAt = 0
  let shown = 0
  for (let t = 0; sent < text.length || frames.pending(); t += FRAME_MS) {
    while (t >= nextChunkAt && sent < text.length) {
      sent = Math.min(text.length, sent + chunk)
      pacer.push(text.slice(0, sent))
      nextChunkAt += everyMs
    }
    frames.advance(FRAME_MS)
    const now = painted.at(-1)?.length ?? 0
    perFrame.push(now - shown)
    shown = now
  }
  return { perFrame, painted }
}

const PROSE =
  'The quick brown fox jumps over the lazy dog while the answer keeps streaming. '.repeat(12)

describe('revealBoundary', () => {
  it('ends a reveal only right after a word character', () => {
    assert.equal(revealBoundary('hello world', 6), 7)
    assert.equal(revealBoundary('para.\n\n## Heading', 6), 11)
    assert.equal(revealBoundary('- item', 1), 3)
    assert.equal(revealBoundary('see [docs](https://x)', 10), 12)
    assert.equal(revealBoundary('hello world', 3), 3)
  })

  it('carries a closing fence and a table separator through in one step', () => {
    const fence = '```ts\nconst a = 1\n```\n\nAfter'
    assert.equal(revealBoundary(fence, fence.indexOf('\n```') + 2), fence.indexOf('After') + 1)
    const table = '| a |\n| - |\n| x |'
    assert.equal(revealBoundary(table, 7), table.indexOf('x') + 1)
  })

  it('never splits a surrogate pair', () => {
    const text = 'ok 😀 fine'
    const high = text.indexOf('😀') + 1
    assert.equal(revealBoundary(text, high), high + 1)
  })

  it('stays within the text and the extension bound', () => {
    assert.equal(revealBoundary('abc   ', 4), 6)
    const rule = '-'.repeat(100)
    assert.equal(revealBoundary(rule, 1), 33)
    assert.equal(revealBoundary('abc', 0), 0)
  })
})

describe('createStreamPacer', () => {
  it('reveals a chunky steady stream a little every frame', () => {
    // 12 characters every 50ms: the demo's cadence, and a fast cloud model's.
    const { perFrame } = streamSteadily(PROSE, 12, 50)
    const live = perFrame.slice(10, -10)
    const frozen = live.filter((step) => step === 0).length
    assert.ok(frozen / live.length < 0.1, `text froze in ${String(frozen)}/${String(live.length)}`)
    assert.ok(Math.max(...live) <= 8, `largest frame step ${String(Math.max(...live))}`)
  })

  it('keeps pace with a much faster stream instead of falling ever further behind', () => {
    const frames = manualFrames()
    let shown = ''
    const pacer = createStreamPacer((next) => (shown = next), '', frames)
    let text = ''
    for (let i = 0; i < 180; i++) {
      text += 'abcdefghij '.repeat(3)
      pacer.push(text)
      frames.advance(FRAME_MS)
    }
    // ~2000 chars/s arriving; the reveal trails by well under half a second.
    assert.ok(text.length - shown.length < 2000 * 0.3, `lag ${String(text.length - shown.length)}`)
  })

  it('only ever paints prefixes of the pushed text', () => {
    const { painted } = streamSteadily(PROSE, 7, 40)
    for (const text of painted) assert.ok(PROSE.startsWith(text))
    assert.equal(painted.at(-1), PROSE)
  })

  it('drains the rest promptly on finish, then settles once', () => {
    const frames = manualFrames()
    const painted: string[] = []
    const pacer = createStreamPacer((next) => painted.push(next), '', frames)
    pacer.push(PROSE.slice(0, 400))
    frames.advance(FRAME_MS)
    let settled = 0
    pacer.finish(() => settled++)
    assert.equal(settled, 0)
    for (let i = 0; i < 30 && frames.pending(); i++) frames.advance(FRAME_MS)
    assert.equal(frames.pending(), false)
    assert.equal(painted.at(-1), PROSE.slice(0, 400))
    assert.equal(settled, 1)
  })

  it('settles synchronously when nothing is left to reveal', () => {
    const frames = manualFrames()
    const pacer = createStreamPacer(() => {}, 'done', frames)
    let settled = false
    pacer.finish(() => (settled = true))
    assert.equal(settled, true)
  })

  it('treats text after a finish as the stream resuming', () => {
    const frames = manualFrames()
    const pacer = createStreamPacer(() => {}, '', frames)
    pacer.push('first part')
    let settled = false
    pacer.finish(() => (settled = true))
    pacer.push('first part and more')
    for (let i = 0; i < 60; i++) frames.advance(FRAME_MS)
    assert.equal(settled, false)
  })

  it('does not replay text that was already on screen', () => {
    const frames = manualFrames()
    const painted: string[] = []
    const pacer = createStreamPacer((next) => painted.push(next), 'Already shown. ', frames)
    pacer.push('Already shown. More')
    frames.advance(FRAME_MS)
    assert.ok(painted.every((text) => text.startsWith('Already shown. ')))
  })

  it('resumes from the agreeing prefix when a correction rewrites shown text', () => {
    const frames = manualFrames()
    const painted: string[] = []
    const pacer = createStreamPacer((next) => painted.push(next), 'Hello wrld', frames)
    pacer.push('Hello world, again')
    frames.advance(FRAME_MS)
    assert.ok(painted.every((text) => 'Hello world, again'.startsWith(text)))
    for (let i = 0; i < 60; i++) frames.advance(FRAME_MS)
    assert.equal(painted.at(-1), 'Hello world, again')
  })

  it('shows everything at once when motion is off', () => {
    const frames = manualFrames({ animate: false })
    let shown = ''
    const pacer = createStreamPacer((next) => (shown = next), '', frames)
    pacer.push(PROSE)
    assert.equal(shown, PROSE)
    assert.equal(frames.pending(), false)
  })

  it('catches up in one frame after a long stall, such as a hidden window', () => {
    const frames = manualFrames()
    let shown = ''
    const pacer = createStreamPacer((next) => (shown = next), '', frames)
    pacer.push(PROSE)
    frames.advance(2_000)
    assert.equal(shown, PROSE)
  })
})

describe('createFrameLoop', () => {
  it('finishes in one step on a frame source that runs callbacks synchronously', () => {
    const synchronous: FrameSource = {
      now: () => 0,
      request: (callback) => {
        callback()
        return 0
      },
      cancel: () => {},
      canAnimate: () => true,
    }
    const steps: number[] = []
    const loop = createFrameLoop((dt) => {
      steps.push(dt)
      return true
    }, synchronous)
    loop.start()
    assert.deepEqual(steps, [Infinity])
  })

  it('stops requesting frames once the step is done', () => {
    const frames = manualFrames()
    let remaining = 3
    const loop = createFrameLoop(() => --remaining > 0, frames)
    loop.start()
    frames.advance(FRAME_MS)
    frames.advance(FRAME_MS)
    assert.equal(frames.pending(), true)
    frames.advance(FRAME_MS)
    assert.equal(frames.pending(), false)
  })
})

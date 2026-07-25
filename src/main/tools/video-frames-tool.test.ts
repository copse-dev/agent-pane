import { describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeToolExecuteResult, type ToolExecuteResult } from '@shared/types'
import {
  SIGNATURE_CHANNELS,
  signatureGridFor,
  signatureLength,
} from '@shared/video/frame-selection.ts'
import type { DecodedFrame, DecodeFramesResult } from '@shared/video/decode-contract.ts'
import { MAX_VIDEO_BYTES } from '@shared/video/video-media.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { setVideoDecoderForTest } from '../services/video/video-decoder.ts'
import { ownedIt as it } from '../services/thread-execution-context.test-support.ts'
import { videoFramesTool } from './video-frames-tool.ts'

const signal = new AbortController().signal

function run(args: Record<string, unknown>): Promise<ToolExecuteResult> {
  return Promise.resolve(videoFramesTool.execute(videoFramesTool.parameters.parse(args), signal))
}

/** The grid for the 1280x720 frames these fixtures claim to have decoded. */
const GRID = signatureGridFor(1280, 720)
const CELLS = GRID.cells

/** A frame whose first `changedCells` cells are repainted. */
function frame(time: number, changedCells: number): DecodedFrame {
  const signature = new Array<number>(signatureLength(GRID)).fill(30)
  for (let i = 0; i < changedCells * SIGNATURE_CHANNELS; i++) signature[i] = 220
  return {
    time,
    signature,
    dataUrl: `data:image/jpeg;base64,${Buffer.from(`f${String(time)}`).toString('base64')}`,
  }
}

function decodeResult(frames: DecodedFrame[], durationSeconds = 10): DecodeFramesResult {
  return {
    requestId: 'test',
    ok: true,
    durationSeconds,
    sourceWidth: 2560,
    sourceHeight: 1440,
    frameWidth: 1280,
    frameHeight: 720,
    sampleIntervalSeconds: 0.5,
    frames,
  }
}

describe('video_frames tool', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-video-frames-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    await writeFile(join(tempRoot, 'capture.mp4'), Buffer.from('not really a video, but bytes'))
  })

  afterEach(async () => {
    setVideoDecoderForTest(null)
    restoreWorkspace?.()
    restoreWorkspace = undefined
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('returns one image for a recording that never changes', async () => {
    setVideoDecoderForTest(() =>
      Promise.resolve(
        decodeResult([frame(0, 0), frame(0.5, 0), frame(1, 0), frame(1.5, 0), frame(2, 0)]),
      ),
    )
    const result = normalizeToolExecuteResult(await run({ path: 'capture.mp4' }))
    assert.ok(result.images)
    assert.equal(result.images.length, 1)
    assert.equal(result.images.at(0)?.name, 'frame-00-00-00.000.jpg')
    assert.match(result.result, /1 visually distinct frame returned/)
    assert.match(result.result, /Nothing in this range changed at all/)
  })

  it('reports the biggest change it saw when only one frame cleared the bar', async () => {
    // "1 frame" alone reads as "nothing happened". Naming the largest change and
    // when it happened is what separates a still screen from a change judged too
    // small — and the second has an obvious next move.
    setVideoDecoderForTest(() =>
      Promise.resolve(
        decodeResult([frame(0, 0), frame(3, 4), frame(3.5, 0), frame(4, 0), frame(4.5, 0)]),
      ),
    )
    const result = normalizeToolExecuteResult(await run({ path: 'capture.mp4' }))
    assert.equal(result.images?.length, 1)
    assert.match(result.result, /largest change between consecutive samples was 0\.7% of the frame/)
    assert.match(result.result, /at 00:00:03\.000/)
    assert.match(result.result, /sensitivity:"high"/)
  })

  it('names each returned image for its timestamp', async () => {
    setVideoDecoderForTest(() => Promise.resolve(decodeResult([frame(0, 0), frame(4.5, CELLS)])))
    const result = normalizeToolExecuteResult(await run({ path: 'capture.mp4' }))
    assert.deepEqual(
      result.images?.map((i) => i.name),
      ['frame-00-00-00.000.jpg', 'frame-00-00-04.500.jpg'],
    )
    // The manifest repeats the timestamp in readable form next to the filename.
    assert.match(result.result, /frame-00-00-04\.500\.jpg {2}00:00:04\.500/)
  })

  it('covers the whole video when no range is given', async () => {
    let seen: { startSeconds: number; endSeconds: number | null } | null = null
    setVideoDecoderForTest((input) => {
      seen = { startSeconds: input.startSeconds, endSeconds: input.endSeconds }
      return Promise.resolve(decodeResult([frame(0, 0)]))
    })
    await run({ path: 'capture.mp4' })
    assert.deepEqual(seen, { startSeconds: 0, endSeconds: null })
  })

  it('passes a requested range through to the decoder', async () => {
    let seen: { startSeconds: number; endSeconds: number | null } | null = null
    setVideoDecoderForTest((input) => {
      seen = { startSeconds: input.startSeconds, endSeconds: input.endSeconds }
      return Promise.resolve(decodeResult([frame(90, 0)]))
    })
    await run({ path: 'capture.mp4', start: '1:30', end: '1:40' })
    assert.deepEqual(seen, { startSeconds: 90, endSeconds: 100 })
  })

  it('rejects an unreadable or inverted range without decoding', async () => {
    setVideoDecoderForTest(() => {
      throw new Error('should not decode')
    })
    assert.match(
      normalizeToolExecuteResult(await run({ path: 'capture.mp4', start: 'soon' })).result,
      /Could not read start time/,
    )
    assert.match(
      normalizeToolExecuteResult(await run({ path: 'capture.mp4', start: '10', end: '5' })).result,
      /must be after start/,
    )
  })

  it('rejects a file that is not a supported video', async () => {
    await writeFile(join(tempRoot, 'notes.txt'), 'hello')
    const result = normalizeToolExecuteResult(await run({ path: 'notes.txt' }))
    assert.match(result.result, /not a supported video/)
    assert.equal(result.images, undefined)
  })

  it('refuses to read outside the workspace', async () => {
    const result = normalizeToolExecuteResult(await run({ path: '../escape.mp4' }))
    assert.match(result.result, /outside workspace/)
  })

  it('reports a missing file rather than throwing', async () => {
    const result = normalizeToolExecuteResult(await run({ path: 'absent.mp4' }))
    assert.match(result.result, /Could not read video/)
  })

  it('returns at most 10 frames when the model does not ask for a number', async () => {
    // A default this low is the point: ten images is already a substantial
    // slice of a context window, and the ones kept are the biggest changes.
    const frames = Array.from({ length: 60 }, (_, i) => frame(i, i % 2 === 0 ? CELLS : 0))
    setVideoDecoderForTest(() => Promise.resolve(decodeResult(frames, 60)))
    const result = normalizeToolExecuteResult(await run({ path: 'capture.mp4' }))
    assert.equal(result.images?.length, 10)
    assert.match(result.result, /Capped at max_frames=10/)
  })

  it('honours max_frames and says the result was capped', async () => {
    const frames = Array.from({ length: 12 }, (_, i) => frame(i, i % 2 === 0 ? CELLS : 0))
    setVideoDecoderForTest(() => Promise.resolve(decodeResult(frames, 12)))
    const result = normalizeToolExecuteResult(await run({ path: 'capture.mp4', max_frames: 3 }))
    assert.equal(result.images?.length, 3)
    assert.match(result.result, /Capped at max_frames=3/)
  })

  it('returns fewer frames at low sensitivity than at high', async () => {
    const frames = Array.from({ length: 16 }, (_, i) =>
      frame(i, i % 2 === 0 ? 0 : Math.round(CELLS * 0.03)),
    )
    setVideoDecoderForTest(() => Promise.resolve(decodeResult(frames, 16)))
    const high = normalizeToolExecuteResult(await run({ path: 'capture.mp4', sensitivity: 'high' }))
    const low = normalizeToolExecuteResult(await run({ path: 'capture.mp4', sensitivity: 'low' }))
    assert.ok((low.images?.length ?? 0) <= (high.images?.length ?? 0))
  })

  it('falls back to the last encoded frame when a sample was skipped as identical', async () => {
    // The decoder leaves dataUrl null for a sample identical to its predecessor.
    const frames = [frame(0, 0), { ...frame(0.5, 0), dataUrl: null }, frame(4, CELLS)]
    setVideoDecoderForTest(() => Promise.resolve(decodeResult(frames)))
    const result = normalizeToolExecuteResult(await run({ path: 'capture.mp4' }))
    assert.ok(result.images?.every((i) => i.dataUrl.startsWith('data:image/jpeg;base64,')))
  })

  it('surfaces a decoder failure as a tool error', async () => {
    setVideoDecoderForTest(() => Promise.reject(new Error('codec not supported')))
    const result = normalizeToolExecuteResult(await run({ path: 'capture.mp4' }))
    assert.match(result.result, /Could not decode capture\.mp4: codec not supported/)
    assert.equal(result.images, undefined)
  })

  it('refuses a video past the size limit before decoding', async () => {
    setVideoDecoderForTest(() => {
      throw new Error('should not decode')
    })
    // Sparse file: the tool reads bytes, so only the length has to be real.
    const big = join(tempRoot, 'huge.mp4')
    const handle = await import('node:fs/promises').then((fs) => fs.open(big, 'w'))
    await handle.truncate(MAX_VIDEO_BYTES + 1)
    await handle.close()
    const result = normalizeToolExecuteResult(await run({ path: 'huge.mp4' }))
    assert.match(result.result, /over the .* limit for frame extraction/)
  })

  it('leaves the sample interval for the decoder to derive unless asked', async () => {
    let seen: number | null | undefined
    setVideoDecoderForTest((input) => {
      seen = input.sampleIntervalSeconds
      return Promise.resolve(decodeResult([frame(0, 0)]))
    })
    await run({ path: 'capture.mp4' })
    assert.equal(seen, null, 'a fixed interval would make narrowing the range pointless')
    await run({ path: 'capture.mp4', interval: 0.05 })
    assert.equal(seen, 0.05)
  })

  it('states the sampling resolution and what it can miss', async () => {
    // Without this a model reads "nothing changed" as "nothing happened", when
    // a brief flicker simply landed between two samples.
    setVideoDecoderForTest(() => Promise.resolve(decodeResult([frame(0, 0)])))
    const result = normalizeToolExecuteResult(await run({ path: 'capture.mp4' }))
    assert.match(result.result, /every 500ms/)
    assert.match(result.result, /less than 500ms can fall between samples/)
  })

  it('reports the source and frame dimensions so the model can judge legibility', async () => {
    setVideoDecoderForTest(() => Promise.resolve(decodeResult([frame(0, 0)], 125.5)))
    const result = normalizeToolExecuteResult(await run({ path: 'capture.mp4' }))
    assert.match(result.result, /2560x1440/)
    assert.match(result.result, /1280x720/)
    assert.match(result.result, /00:02:05\.500 long/)
  })
})

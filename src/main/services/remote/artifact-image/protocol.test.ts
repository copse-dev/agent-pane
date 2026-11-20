import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { inspectArtifactImage, parseArtifactImageMime } from './image-signature.ts'
import { gifBytes, jpegBytes, pngBytes, webpLosslessBytes } from './image-fixtures.test-support.ts'
import {
  ArtifactImageError,
  MAX_ARTIFACT_IMAGE_BYTES,
  type ArtifactImageErrorCode,
} from './policy.ts'
import {
  ARTIFACT_IMAGE_CHUNK_BYTES,
  ARTIFACT_IMAGE_MAX_LINE_BYTES,
  ARTIFACT_IMAGE_PROTOCOL_VERSION,
  BoundedLineSplitter,
  decodeLine,
  encodeFrame,
  errorFrame,
  ImageFrameAssembler,
  imageFrames,
  zHostJob,
  zImageFrame,
  type ImageFrame,
} from './protocol.ts'

const REQUEST = 'a'.repeat(32)

function failure(fn: () => unknown): ArtifactImageErrorCode {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof ArtifactImageError)
    return error.code
  }
  assert.fail('expected failure')
}

function assemble(frames: readonly ImageFrame[]): Buffer {
  const assembler = new ImageFrameAssembler(REQUEST)
  for (const frame of frames) {
    const image = assembler.accept(frame)
    if (image) return image.bytes
  }
  assert.fail('no completion')
}

describe('inspectArtifactImage', () => {
  it('accepts each supported format with its matching type', () => {
    assert.deepEqual(inspectArtifactImage(pngBytes(), 'image/png'), {
      ok: true,
      header: { mime: 'image/png', width: 4, height: 3 },
    })
    assert.equal(inspectArtifactImage(jpegBytes(), 'image/jpeg').ok, true)
    assert.equal(inspectArtifactImage(gifBytes(), 'image/gif').ok, true)
    assert.deepEqual(inspectArtifactImage(webpLosslessBytes(7, 9), 'image/webp'), {
      ok: true,
      header: { mime: 'image/webp', width: 7, height: 9 },
    })
  })

  it('refuses bytes that do not match the claimed type', () => {
    assert.deepEqual(inspectArtifactImage(pngBytes(), 'image/jpeg'), { ok: false, reason: 'type' })
    assert.deepEqual(
      inspectArtifactImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png'),
      {
        ok: false,
        reason: 'type',
      },
    )
    assert.deepEqual(inspectArtifactImage(Buffer.from('<!doctype html><script>'), 'image/gif'), {
      ok: false,
      reason: 'type',
    })
  })

  it('refuses canvases over the dimension and pixel limits', () => {
    assert.deepEqual(inspectArtifactImage(pngBytes(16_385, 1), 'image/png'), {
      ok: false,
      reason: 'dimensions',
    })
    assert.deepEqual(inspectArtifactImage(pngBytes(10_000, 10_000), 'image/png'), {
      ok: false,
      reason: 'dimensions',
    })
    assert.deepEqual(inspectArtifactImage(pngBytes(0, 10), 'image/png'), {
      ok: false,
      reason: 'dimensions',
    })
  })

  it('does not read past a truncated JPEG segment', () => {
    const truncated = jpegBytes().subarray(0, 8)
    assert.deepEqual(inspectArtifactImage(truncated, 'image/jpeg'), { ok: false, reason: 'type' })
  })
})

describe('parseArtifactImageMime', () => {
  it('accepts only the four exact types', () => {
    assert.equal(parseArtifactImageMime('image/PNG; charset=binary'), 'image/png')
    for (const hostile of ['image/svg+xml', 'image/*', 'text/html', 'image/png2', '', undefined]) {
      assert.equal(parseArtifactImageMime(hostile), null, String(hostile))
    }
  })
})

describe('ImageFrameAssembler', () => {
  it('round-trips a multi-chunk image', () => {
    const bytes = Buffer.concat([
      pngBytes(4, 3, 0),
      Buffer.alloc(ARTIFACT_IMAGE_CHUNK_BYTES * 2 + 5, 7),
    ])
    const frames = imageFrames(REQUEST, 'image/png', bytes)
    assert.equal(frames.length, 4)
    assert.deepEqual(assemble(frames), bytes)
  })

  it('rejects out-of-order chunks', () => {
    const frames = imageFrames(
      REQUEST,
      'image/png',
      Buffer.concat([pngBytes(), Buffer.alloc(ARTIFACT_IMAGE_CHUNK_BYTES)]),
    )
    assert.equal(
      failure(() => assemble([frames[1], frames[0], frames[2]].filter((f) => f !== undefined))),
      'protocol',
    )
  })

  it('rejects a frame for another request', () => {
    const [chunk] = imageFrames('b'.repeat(32), 'image/png', pngBytes())
    assert.ok(chunk)
    assert.equal(
      failure(() => new ImageFrameAssembler(REQUEST).accept(chunk)),
      'protocol',
    )
  })

  it('rejects a completion whose length or digest does not match what arrived', () => {
    const frames = imageFrames(REQUEST, 'image/png', pngBytes())
    const done = frames.at(-1)
    assert.ok(done?.type === 'done')
    assert.equal(
      failure(() => assemble([...frames.slice(0, -1), { ...done, bytes: done.bytes + 1 }])),
      'protocol',
    )
    assert.equal(
      failure(() =>
        assemble([
          ...frames.slice(0, -1),
          { ...done, sha256: createHash('sha256').update('x').digest('hex') },
        ]),
      ),
      'protocol',
    )
  })

  it('rejects bytes or a second completion after completion', () => {
    const frames = imageFrames(REQUEST, 'image/png', pngBytes())
    const assembler = new ImageFrameAssembler(REQUEST)
    for (const frame of frames) assembler.accept(frame)
    const [first] = frames
    assert.ok(first)
    assert.equal(
      failure(() => assembler.accept(first)),
      'protocol',
    )
  })

  it('rejects a declared type that the bytes do not match', () => {
    const frames = imageFrames(REQUEST, 'image/jpeg', pngBytes())
    assert.equal(
      failure(() => assemble(frames)),
      'bad-type',
    )
  })

  it('stops at the aggregate size limit', () => {
    const assembler = new ImageFrameAssembler(REQUEST)
    const chunk = Buffer.alloc(ARTIFACT_IMAGE_CHUNK_BYTES, 1).toString('base64')
    const limit = Math.ceil(MAX_ARTIFACT_IMAGE_BYTES / ARTIFACT_IMAGE_CHUNK_BYTES)
    assert.equal(
      failure(() => {
        for (let seq = 0; seq <= limit; seq++) {
          assembler.accept({
            v: ARTIFACT_IMAGE_PROTOCOL_VERSION,
            type: 'chunk',
            requestId: REQUEST,
            seq,
            data: chunk,
          })
        }
      }),
      'too-large',
    )
  })

  it('surfaces a sender error code and stays failed', () => {
    const assembler = new ImageFrameAssembler(REQUEST)
    assert.equal(
      failure(() =>
        assembler.accept(errorFrame(REQUEST, 'redirect-denied', 'https://evil.example')),
      ),
      'redirect-denied',
    )
    const [chunk] = imageFrames(REQUEST, 'image/png', pngBytes())
    assert.ok(chunk)
    assert.equal(
      failure(() => assembler.accept(chunk)),
      'protocol',
    )
  })
})

describe('ImageFrameAssembler frame bound', () => {
  it('rejects a chunk after a short one, so a sender cannot drip tiny frames', () => {
    const assembler = new ImageFrameAssembler(REQUEST)
    const tiny = Buffer.from([1, 2, 3]).toString('base64')
    assembler.accept({
      v: ARTIFACT_IMAGE_PROTOCOL_VERSION,
      type: 'chunk',
      requestId: REQUEST,
      seq: 0,
      data: tiny,
    })
    assert.equal(
      failure(() =>
        assembler.accept({
          v: ARTIFACT_IMAGE_PROTOCOL_VERSION,
          type: 'chunk',
          requestId: REQUEST,
          seq: 1,
          data: tiny,
        }),
      ),
      'protocol',
    )
  })
})

describe('error frame origins', () => {
  it('accepts only a canonical origin on the wire', () => {
    const base = { v: 1, type: 'error', requestId: REQUEST, code: 'origin-denied' }
    assert.ok(decodeLine(JSON.stringify({ ...base, origin: 'https://evil.example' }), zImageFrame))
    for (const hostile of [
      'https://evil.example/path?X-Amz-Signature=secret',
      'free text\nwith a newline',
      'https://*.amazonaws.com',
      'http://evil.example',
    ]) {
      assert.equal(
        decodeLine(JSON.stringify({ ...base, origin: hostile }), zImageFrame),
        null,
        hostile,
      )
    }
  })

  it('drops a non-canonical origin instead of relaying it', () => {
    assert.deepEqual(errorFrame(REQUEST, 'origin-denied', 'https://evil.example/x?sig=1'), {
      v: 1,
      type: 'error',
      requestId: REQUEST,
      code: 'origin-denied',
    })
  })
})

describe('decodeLine', () => {
  it('rejects oversized lines before decoding', () => {
    const line = JSON.stringify({ pad: 'x'.repeat(ARTIFACT_IMAGE_MAX_LINE_BYTES) })
    assert.equal(decodeLine(line, zImageFrame), null)
  })

  it('rejects unknown fields and wrong versions', () => {
    const [chunk] = imageFrames(REQUEST, 'image/png', pngBytes())
    assert.equal(decodeLine(JSON.stringify({ ...chunk, extra: 1 }), zImageFrame), null)
    assert.equal(decodeLine(JSON.stringify({ ...chunk, v: 2 }), zImageFrame), null)
    assert.equal(decodeLine('{not json', zImageFrame), null)
  })

  it('does not accept a host job carrying extra configuration', () => {
    const job = {
      v: 1,
      type: 'job',
      requestId: REQUEST,
      url: 'https://a.example/x.png',
      approvedOrigins: ['https://a.example'],
    }
    assert.ok(decodeLine(JSON.stringify(job), zHostJob))
    assert.equal(decodeLine(JSON.stringify({ ...job, command: '/bin/sh' }), zHostJob), null)
    assert.equal(
      decodeLine(JSON.stringify({ ...job, headers: { Authorization: 'x' } }), zHostJob),
      null,
    )
  })
})

describe('BoundedLineSplitter', () => {
  it('splits lines across chunks', () => {
    const lines: string[] = []
    const splitter = new BoundedLineSplitter(
      (line) => lines.push(line),
      () => assert.fail('overflow'),
    )
    splitter.push('ab')
    splitter.push('c\nde')
    splitter.push('f\n')
    assert.deepEqual(lines, ['abc', 'def'])
  })

  it('fails once a pending line exceeds the bound, without buffering further', () => {
    let overflowed = 0
    const splitter = new BoundedLineSplitter(
      () => assert.fail('no line expected'),
      () => overflowed++,
    )
    splitter.push('x'.repeat(ARTIFACT_IMAGE_MAX_LINE_BYTES + 1))
    splitter.push(`${'y'.repeat(10)}\n`)
    assert.equal(overflowed, 1)
  })

  it('encodes frames as single lines', () => {
    assert.equal(encodeFrame(errorFrame(REQUEST, 'timeout')).split('\n').length, 2)
  })
})

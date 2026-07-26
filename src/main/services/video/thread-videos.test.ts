import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { VideoAttachmentRef } from '@shared/video/video-media.ts'
import { applyVideoToolAvailability, describeThreadVideos } from './thread-videos.ts'

const RECORDING: VideoAttachmentRef = {
  name: 'Screen Recording.mov',
  path: '/chat/proj/t1/blobs/media/2f8c-Screen-Recording.mov',
  sizeBytes: 13 * 1024 * 1024,
  mimeType: 'video/quicktime',
}

const OTHER: VideoAttachmentRef = {
  name: 'bug.mp4',
  path: '/chat/proj/t1/blobs/media/9a1b-bug.mp4',
  sizeBytes: 900 * 1024,
  mimeType: 'video/mp4',
}

function tools(): { name: string; description: string }[] {
  return [
    { name: 'read_file', description: 'Read a file.' },
    { name: 'video_frames', description: 'Read a video as stills.' },
    { name: 'run_shell', description: 'Run a command.' },
  ]
}

describe('describeThreadVideos', () => {
  it('names each video with its size and the path the tool takes', () => {
    const described = describeThreadVideos([RECORDING, OTHER])
    assert.match(
      described,
      /- "Screen Recording\.mov" \(13 MB\): \/chat\/proj\/t1\/blobs\/media\/2f8c-Screen-Recording\.mov/,
    )
    assert.match(
      described,
      /- "bug\.mp4" \(900 KB\): \/chat\/proj\/t1\/blobs\/media\/9a1b-bug\.mp4/,
    )
  })
})

describe('applyVideoToolAvailability', () => {
  it('withholds video_frames from a thread that has never had a video', () => {
    const offered = applyVideoToolAvailability(tools(), [])
    assert.deepEqual(
      offered.map((t) => t.name),
      ['read_file', 'run_shell'],
    )
  })

  it('offers video_frames once a video has been attached', () => {
    const offered = applyVideoToolAvailability(tools(), [RECORDING])
    assert.ok(offered.some((t) => t.name === 'video_frames'))
  })

  it('folds the attached paths into the description, not just the names', () => {
    // The reference block in the user's message can be trimmed out of a long
    // conversation; this description is rebuilt every turn, so it is the copy
    // the model can always rely on.
    const offered = applyVideoToolAvailability(tools(), [RECORDING])
    const videoTool = offered.find((t) => t.name === 'video_frames')
    assert.match(videoTool?.description ?? '', /^Read a video as stills\./)
    assert.match(videoTool?.description ?? '', /Videos attached to this conversation:/)
    assert.ok(videoTool?.description.includes(RECORDING.path))
  })

  it('leaves every other tool untouched either way', () => {
    for (const videos of [[], [RECORDING]]) {
      const offered = applyVideoToolAvailability(tools(), videos)
      const readFile = offered.find((t) => t.name === 'read_file')
      assert.deepEqual(readFile, { name: 'read_file', description: 'Read a file.' })
    }
  })

  it('does not mutate the tools it was given', () => {
    const original = tools()
    applyVideoToolAvailability(original, [RECORDING])
    assert.equal(original[1]?.description, 'Read a video as stills.')
  })
})

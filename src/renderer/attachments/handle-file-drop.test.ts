import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type {
  PromptArchiveAttachment,
  PromptAttachmentHandlers,
  PromptVideoAttachment,
} from './prompt-attachments.ts'
import {
  WORKSPACE_PATH_MIME,
  attachFiles,
  handleFileDrop,
  type FileDropApi,
  type FileDropEvent,
} from './handle-file-drop.ts'

Object.assign(globalThis, {
  Blob: window.Blob,
  File: window.File,
  FileReader: window.FileReader,
})

interface Recorded {
  files: { path: string; content: string }[]
  images: { dataUrl: string; mimeType: string }[]
  videos: PromptVideoAttachment[]
  archives: PromptArchiveAttachment[]
}

function recordingHandlers(): { handlers: PromptAttachmentHandlers; recorded: Recorded } {
  const recorded: Recorded = { files: [], images: [], videos: [], archives: [] }
  return {
    recorded,
    handlers: {
      attachFile: (f): void => {
        recorded.files.push(f)
      },
      attachTextBlock: (): void => {},
      quoteText: (): void => {},
      attachImage: (dataUrl, mimeType): void => {
        recorded.images.push({ dataUrl, mimeType })
      },
      attachVideo: (video): Promise<void> => {
        recorded.videos.push(video)
        return Promise.resolve()
      },
      attachArchive: (archive): Promise<void> => {
        recorded.archives.push(archive)
        return Promise.resolve()
      },
    },
  }
}

const api: FileDropApi = {
  fs: {
    readFile: (): Promise<string> => Promise.resolve('file contents'),
    readImage: (): Promise<string> => Promise.resolve('data:image/png;base64,iVBORw0KGgo='),
  },
}

function fakeFile(name: string, type: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type })
}

function workspacePathDrop(path: string): FileDropEvent {
  return {
    preventDefault: (): void => {},
    stopPropagation: (): void => {},
    dataTransfer: {
      getData: (mime: string): string => (mime === WORKSPACE_PATH_MIME ? path : ''),
      files: [],
    },
  }
}

describe('attaching dropped files', () => {
  it('routes a video to the video handler, not into the prompt', async () => {
    const { handlers, recorded } = recordingHandlers()
    await attachFiles([fakeFile('Screen Recording.mov', 'video/quicktime')], handlers, api, null)
    const [video] = recorded.videos
    assert.equal(recorded.videos.length, 1)
    assert.ok(video)
    assert.equal(video.name, 'Screen Recording.mov')
    assert.ok(video.bytes instanceof ArrayBuffer)
    assert.equal(recorded.files.length, 0, 'a video must never be inlined as file content')
    assert.equal(recorded.images.length, 0)
  })

  it('recognises a video by extension when the browser reports no MIME type', async () => {
    const { handlers, recorded } = recordingHandlers()
    await attachFiles([fakeFile('capture.webm', '')], handlers, api, null)
    assert.equal(recorded.videos.length, 1)
    assert.equal(recorded.videos.at(0)?.mimeType, 'video/mp4', 'falls back to a decodable default')
  })

  it('recognises an image by extension when the browser reports no MIME type', async () => {
    const { handlers, recorded } = recordingHandlers()
    await attachFiles([fakeFile('chart.PNG', '')], handlers, api, null)
    assert.equal(recorded.files.length, 0)
    assert.deepEqual(recorded.images, [
      {
        dataUrl: 'data:image/png;base64,AQID',
        mimeType: 'image/png',
      },
    ])
  })

  it('leaves non-video files on their existing path', async () => {
    const { handlers, recorded } = recordingHandlers()
    await attachFiles([fakeFile('notes.md', 'text/markdown')], handlers, api, null)
    assert.equal(recorded.files.length, 1)
    assert.equal(recorded.videos.length, 0)
  })

  it('references a workspace video by path rather than reading it as text', async () => {
    const { handlers, recorded } = recordingHandlers()
    await handleFileDrop(workspacePathDrop('/repo/docs/demo.mp4'), handlers, api, '/repo')
    assert.deepEqual(recorded.videos, [
      { name: 'demo.mp4', mimeType: '', path: '/repo/docs/demo.mp4' },
    ])
    assert.equal(recorded.files.length, 0)
  })

  it('attaches a workspace image through the binary image reader', async () => {
    const { handlers, recorded } = recordingHandlers()
    let textReads = 0
    const imageApi: FileDropApi = {
      fs: {
        readFile: async (): Promise<string> => {
          textReads += 1
          return 'binary garbage'
        },
        readImage: async (projectId, threadId, path): Promise<string> => {
          assert.deepEqual(
            [projectId, threadId, path],
            ['project-1', 'thread-1', 'images/chart.PNG'],
          )
          return 'data:image/png;base64,iVBORw0KGgo='
        },
      },
    }

    await handleFileDrop(workspacePathDrop('images/chart.PNG'), handlers, imageApi, '/repo', {
      projectId: 'project-1',
      threadId: 'thread-1',
    })

    assert.equal(textReads, 0)
    assert.deepEqual(recorded.images, [
      { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' },
    ])
    assert.equal(recorded.files.length, 0)
  })

  it('keeps the absolute path when the dropped path is the workspace root', async () => {
    const { handlers, recorded } = recordingHandlers()

    await handleFileDrop(workspacePathDrop('/repo'), handlers, api, '/repo', {
      projectId: 'project-1',
      threadId: 'thread-1',
    })

    assert.deepEqual(recorded.files, [{ path: '/repo', content: 'file contents' }])
  })

  it('keeps workspace SVG on the text-file path', async () => {
    const { handlers, recorded } = recordingHandlers()
    let imageReads = 0
    const svgApi: FileDropApi = {
      fs: {
        readFile: async (): Promise<string> => '<svg>diagram</svg>',
        readImage: async (): Promise<string> => {
          imageReads += 1
          return 'data:image/svg+xml;base64,PHN2Zz4='
        },
      },
    }

    await handleFileDrop(workspacePathDrop('images/diagram.svg'), handlers, svgApi, '/repo', {
      projectId: 'project-1',
      threadId: 'thread-1',
    })

    assert.equal(imageReads, 0)
    assert.deepEqual(recorded.files, [
      { path: 'images/diagram.svg', content: '<svg>diagram</svg>' },
    ])
    assert.deepEqual(recorded.images, [])
  })

  it('routes a zip to the archive handler instead of inlining its bytes', async () => {
    const { handlers, recorded } = recordingHandlers()
    await attachFiles([fakeFile('bundle.zip', 'application/zip')], handlers, api, null)
    assert.equal(recorded.archives.length, 1)
    assert.equal(recorded.archives.at(0)?.name, 'bundle.zip')
    // The regression this guards: without the archive branch a dropped zip fell
    // through to `file.text()` and landed in the prompt as binary mojibake.
    assert.equal(recorded.files.length, 0)
  })

  it('recognises a zip by extension when the browser reports no MIME type', async () => {
    const { handlers, recorded } = recordingHandlers()
    await attachFiles([fakeFile('release.ZIP', '')], handlers, api, null)
    assert.equal(recorded.archives.length, 1)
    assert.equal(recorded.files.length, 0)
  })

  it('references a workspace archive by path rather than reading it as text', async () => {
    const { handlers, recorded } = recordingHandlers()
    await handleFileDrop(workspacePathDrop('/repo/fixtures/bundle.zip'), handlers, api, '/repo')
    assert.deepEqual(recorded.archives, [{ name: 'bundle.zip', path: '/repo/fixtures/bundle.zip' }])
    assert.equal(recorded.files.length, 0)
  })
})

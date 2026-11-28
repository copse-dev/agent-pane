import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type {
  PromptArchiveAttachment,
  PromptAttachmentHandlers,
  PromptVideoAttachment,
} from './prompt-attachments.ts'
import {
  MAX_TEXT_ATTACHMENT_BYTES,
  UNSUPPORTED_IMAGE_MESSAGE,
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

/** The toast now showing, removed so the next test starts clean. */
function takeToast(): string {
  const toast = document.querySelector('.toast')
  toast?.remove()
  return toast?.textContent ?? ''
}

function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)]
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

  it("asks the preload for an OS-dropped file's disk path (File.path is gone since Electron 32)", async () => {
    const paths = new Map<File, string>()
    const inWorkspace = fakeFile('notes.md', 'text/markdown')
    const outside = fakeFile('todo.txt', 'text/plain')
    paths.set(inWorkspace, '/repo/docs/notes.md')
    paths.set(outside, '/home/me/todo.txt')
    window.copseFiles = { pathForFile: (file): string => paths.get(file) ?? '' }
    try {
      const { handlers, recorded } = recordingHandlers()
      const reads: string[] = []
      const readApi: FileDropApi = {
        fs: {
          readFile: async (_projectId, _threadId, path): Promise<string> => {
            reads.push(path)
            return 'from workspace'
          },
          readImage: (): Promise<string> => Promise.resolve(''),
        },
      }
      await attachFiles([inWorkspace], handlers, readApi, '/repo', {
        projectId: 'p',
        threadId: 't',
      })
      await attachFiles([outside], handlers, readApi, null)
      assert.deepEqual(reads, ['/repo/docs/notes.md'])
      assert.deepEqual(
        recorded.files.map((file) => file.path),
        ['docs/notes.md', '/home/me/todo.txt'],
      )
    } finally {
      delete window.copseFiles
    }
  })

  it('reads a picker file outside the workspace from its File blob', async () => {
    const outside = new File(['%AI-3.0 illustrator data'], 'artwork.ai', {
      type: 'application/postscript',
    })
    window.copseFiles = { pathForFile: (): string => '/Users/me/Downloads/artwork.ai' }
    try {
      const { handlers, recorded } = recordingHandlers()
      const readApi: FileDropApi = {
        fs: {
          readFile: (): Promise<string> => Promise.reject(new Error('outside workspace')),
          readImage: (): Promise<string> => Promise.resolve(''),
        },
      }
      await attachFiles([outside], handlers, readApi, '/repo', { projectId: 'p', threadId: 't' })
      assert.deepEqual(recorded.files, [
        { path: '/Users/me/Downloads/artwork.ai', content: '%AI-3.0 illustrator data' },
      ])
    } finally {
      delete window.copseFiles
    }
  })

  it('refuses a binary file from outside the workspace instead of inlining its bytes', async () => {
    // A current Illustrator file is a PDF container: a text header, then binary streams.
    const streams = Array.from({ length: 512 }, (_, i) => 0x80 + (i % 0x80))
    const outside = new File([new Uint8Array([...utf8('%PDF-1.6\n'), ...streams])], 'artwork.ai', {
      type: 'application/postscript',
    })
    window.copseFiles = { pathForFile: (): string => '/Users/me/Downloads/artwork.ai' }
    try {
      const { handlers, recorded } = recordingHandlers()
      await attachFiles([outside], handlers, api, '/repo', { projectId: 'p', threadId: 't' })
      assert.deepEqual(recorded.files, [])
      assert.match(
        takeToast(),
        /^Can't attach artwork\.ai — it isn't a text file\. Attach it inside a \.zip, or copy it into the project/,
      )
    } finally {
      delete window.copseFiles
    }
  })

  it('keeps a Latin-1 text file with a few undecodable accents as text', async () => {
    const latin1 = new Uint8Array([
      ...utf8('name,city\nRen'),
      0xe9,
      ...utf8(',Paris\nJos'),
      0xe9,
      ...utf8(',Lyon\n'),
    ])
    const { handlers, recorded } = recordingHandlers()
    await attachFiles([new File([latin1], 'people.csv', { type: 'text/csv' })], handlers, api, null)
    assert.equal(recorded.files.length, 1)
    assert.match(recorded.files[0]?.content ?? '', /^name,city\nRen\uFFFD,Paris/)
  })

  it('refuses a picked text file over the cap as too large to save, not too much for a model', async () => {
    const big = new File([new Uint8Array(MAX_TEXT_ATTACHMENT_BYTES + 1).fill(0x61)], 'server.log', {
      type: 'text/plain',
    })
    const { handlers, recorded } = recordingHandlers()
    await attachFiles([big], handlers, api, null)
    assert.deepEqual(recorded.files, [])
    // The prompt only ever carries a head-and-tail preview, so the cap is about
    // the full copy the conversation keeps, not what a model can take in.
    assert.match(
      takeToast(),
      /^Can't attach server\.log — at 4\.0 MB it's too large to save with the conversation\. Copy it into the project/,
    )
  })

  it('refuses a large picked Illustrator file as binary, not as too large', async () => {
    // A real .ai opens with tens of KB of XMP metadata (text) before its first
    // binary stream, so a small head sniff would still call it text.
    const bytes = new Uint8Array(MAX_TEXT_ATTACHMENT_BYTES + 1024 * 1024)
    const header = utf8('%PDF-1.5\n1 0 obj\n<</Metadata 2 0 R>>\nendobj\n<?xpacket begin=""?>')
    bytes.set(header)
    const metadataEnd = 64 * 1024
    bytes.fill(0x20, header.length, metadataEnd)
    for (let i = metadataEnd; i < bytes.length; i++) bytes[i] = (i * 37) % 256
    const outside = new File([bytes], 'logo.ai', { type: 'application/postscript' })
    window.copseFiles = { pathForFile: (): string => '/Users/me/Downloads/logo.ai' }
    try {
      const { handlers, recorded } = recordingHandlers()
      await attachFiles([outside], handlers, api, '/repo', { projectId: 'p', threadId: 't' })
      assert.deepEqual(recorded.files, [])
      assert.match(
        takeToast(),
        /^Can't attach logo\.ai — it isn't a text file\. Attach it inside a \.zip, or copy it into the project/,
      )
    } finally {
      delete window.copseFiles
    }
  })

  it('refuses a large binary workspace file as binary, not as too large', async () => {
    const binaryApi: FileDropApi = {
      fs: {
        readFile: (): Promise<string> =>
          Promise.resolve(`%PDF-1.5\n${' '.repeat(MAX_TEXT_ATTACHMENT_BYTES)}\u0000\u0001streams`),
        readImage: (): Promise<string> => Promise.resolve(''),
      },
    }
    const { handlers, recorded } = recordingHandlers()
    await handleFileDrop(workspacePathDrop('/repo/design/logo.ai'), handlers, binaryApi, '/repo', {
      projectId: 'p',
      threadId: 't',
    })
    assert.deepEqual(recorded.files, [])
    assert.match(
      takeToast(),
      /^Can't attach logo\.ai — it isn't a text file\. It's already in the project, so mention its path/,
    )
  })

  it('still attaches a project text file over the cap, as it did before the cap', async () => {
    // The prompt trims it to a head-and-tail preview, and the agent can open the rest by path.
    const log = 'a'.repeat(MAX_TEXT_ATTACHMENT_BYTES + 1)
    const logApi: FileDropApi = {
      fs: {
        readFile: (): Promise<string> => Promise.resolve(log),
        readImage: (): Promise<string> => Promise.resolve(''),
      },
    }
    const { handlers, recorded } = recordingHandlers()
    await handleFileDrop(workspacePathDrop('/repo/logs/server.log'), handlers, logApi, '/repo', {
      projectId: 'p',
      threadId: 't',
    })
    assert.equal(takeToast(), '')
    assert.deepEqual(recorded.files, [{ path: 'logs/server.log', content: log }])
  })

  it('refuses a binary workspace file and points at the agent tools instead', async () => {
    const binaryApi: FileDropApi = {
      fs: {
        readFile: (): Promise<string> => Promise.resolve('%PDF-1.6\n\u0000\u0001streams'),
        readImage: (): Promise<string> => Promise.resolve(''),
      },
    }
    const { handlers, recorded } = recordingHandlers()
    await handleFileDrop(
      workspacePathDrop('/repo/design/artwork.ai'),
      handlers,
      binaryApi,
      '/repo',
      {
        projectId: 'p',
        threadId: 't',
      },
    )
    assert.deepEqual(recorded.files, [])
    assert.match(
      takeToast(),
      /^Can't attach artwork\.ai — it isn't a text file\. It's already in the project, so mention its path/,
    )
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

  it('refuses an image the composer cannot render instead of attaching a broken chip', async () => {
    const { handlers, recorded } = recordingHandlers()
    await attachFiles([fakeFile('IMG_0412.HEIC', 'image/heic')], handlers, api, null)
    assert.deepEqual(recorded.images, [])
    assert.deepEqual(recorded.files, [])
    assert.equal(document.querySelector('.toast')?.textContent, UNSUPPORTED_IMAGE_MESSAGE)
    document.querySelector('.toast')?.remove()
  })

  it('refuses an unrenderable image by extension when the browser reports no MIME type', async () => {
    const { handlers, recorded } = recordingHandlers()
    await attachFiles([fakeFile('IMG_0412.HEIC', '')], handlers, api, null)
    assert.deepEqual(recorded.images, [])
    assert.deepEqual(recorded.files, [])
    assert.equal(document.querySelector('.toast')?.textContent, UNSUPPORTED_IMAGE_MESSAGE)
    document.querySelector('.toast')?.remove()
  })

  it('refuses a workspace image the composer cannot render instead of reading it as text', async () => {
    const { handlers, recorded } = recordingHandlers()
    let reads = 0
    const countingApi: FileDropApi = {
      fs: {
        readFile: async (): Promise<string> => {
          reads += 1
          return 'binary garbage'
        },
        readImage: async (): Promise<string> => {
          reads += 1
          return 'data:image/png;base64,iVBORw0KGgo='
        },
      },
    }
    await handleFileDrop(
      workspacePathDrop('/repo/photos/scan.tiff'),
      handlers,
      countingApi,
      '/repo',
      {
        projectId: 'project-1',
        threadId: 'thread-1',
      },
    )
    assert.equal(reads, 0)
    assert.deepEqual(recorded.files, [])
    assert.deepEqual(recorded.images, [])
    assert.equal(document.querySelector('.toast')?.textContent, UNSUPPORTED_IMAGE_MESSAGE)
    document.querySelector('.toast')?.remove()
  })
})

import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, Thread, ToolCall } from '@shared/types'
import {
  isStoredToolImageUrl,
  parseStoredToolImageUrl,
  storedToolImageUrl,
} from '@shared/threads/stored-tool-image.ts'
import {
  STORED_IMAGE_MIN_BYTES,
  appendMessage,
  createThread,
  getProjectThread,
  loadThreadMessages,
  readStoredToolImage,
  saveProjectThread,
  threadBlobsDir,
} from './thread-store.ts'

const PROJECT = 'proj-stored-images'
const THREAD = 'thread-images'
// Generated images are megabytes; anything at the threshold stays on disk.
const LARGE = `data:image/png;base64,${'R0VORVJBVEVE'.repeat(STORED_IMAGE_MIN_BYTES / 12 + 1)}`
const SECOND = `data:image/png;base64,${'U0VDT05EIElNQUdF'.repeat(STORED_IMAGE_MIN_BYTES / 16 + 1)}`
const ICON = 'data:image/png;base64,aWNvbg=='

function imageCall(id: string, dataUrl: string): ToolCall {
  return {
    id,
    name: 'image_gen',
    args: {},
    status: 'done',
    result: 'Generated an image.',
    images: [{ dataUrl, kind: 'screenshot' }],
    // ACP agents repeat the image in the call's display content.
    content: [
      { type: 'content', content: { type: 'text', text: 'Revised prompt' } },
      { type: 'content', content: { type: 'image', dataUrl, mimeType: 'image/png' } },
    ],
  }
}

function thread(id: string, messages: Message[]): Thread {
  return {
    id,
    title: 'Badges',
    status: 'idle',
    messages,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

const messages: Message[] = [
  { id: 'u1', role: 'user', content: 'Make two badges', toolCalls: [], createdAt: 1 },
  {
    id: 'a1',
    role: 'assistant',
    content: '',
    toolCalls: [imageCall('call-1', LARGE), imageCall('call-2', SECOND), imageCall('call-3', ICON)],
    createdAt: 2,
  },
]

function imageUrls(message: Message | undefined): string[] {
  return (message?.toolCalls ?? []).flatMap((call) => [
    ...(call.images ?? []).map((image) => image.dataUrl),
    ...(call.content ?? []).flatMap((item) =>
      item.type === 'content' && item.content.type === 'image' ? [item.content.dataUrl] : [],
    ),
  ])
}

/** Each image a message shows, read back through its reference where it has one. */
async function shownImages(message: Message | undefined): Promise<Array<string | null>> {
  return Promise.all(
    imageUrls(message).map((url) =>
      isStoredToolImageUrl(url) ? readStoredToolImage(url) : Promise.resolve(url),
    ),
  )
}

describe('thread store: large tool images stay on disk', () => {
  let root = ''
  let previousRoot: string | undefined

  beforeEach(async () => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-stored-images-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
    await saveProjectThread(PROJECT, thread(THREAD, messages))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
  })

  it('reads a large image and its ACP repeat as one reference, and inlines a small one', async () => {
    const loaded = await loadThreadMessages(PROJECT, THREAD)
    const urls = imageUrls(loaded[1])
    assert.equal(urls.length, 6)
    assert.ok(isStoredToolImageUrl(urls[0] ?? ''))
    assert.equal(urls[0], urls[1], 'the ACP repeat is the same reference')
    assert.ok(isStoredToolImageUrl(urls[2] ?? ''))
    assert.notEqual(urls[0], urls[2])
    assert.deepEqual(urls.slice(4), [ICON, ICON])
    assert.equal(JSON.stringify(loaded).includes('R0VORVJBVEVE'), false, 'no large image bytes')
    // Text content and messages without images come back as they were.
    assert.deepEqual(loaded[0], messages[0])
    assert.deepEqual(loaded[1]?.toolCalls[0]?.content?.[0], messages[1]?.toolCalls[0]?.content?.[0])
    assert.deepEqual(await shownImages(loaded[1]), imageUrls(messages[1]))
  })

  it('reads the same references for every whole-thread reader', async () => {
    const whole = await getProjectThread(PROJECT, THREAD)
    assert.deepEqual(
      imageUrls(whole?.messages[1]),
      imageUrls((await loadThreadMessages(PROJECT, THREAD))[1]),
    )
  })

  it('refuses references outside the thread blobs, of other files, or that no longer match', async () => {
    const reference = imageUrls((await loadThreadMessages(PROJECT, THREAD))[1])[0] ?? ''
    const address = parseStoredToolImageUrl(reference)
    assert.ok(address)
    const variant = (patch: Partial<typeof address>): string =>
      storedToolImageUrl({ ...address, ...patch })
    assert.equal(await readStoredToolImage(variant({ ref: 'blobs/../meta.json' })), null)
    assert.equal(await readStoredToolImage(variant({ ref: 'meta.json' })), null)
    assert.equal(await readStoredToolImage(variant({ ref: 'blobs/a1.tool-0.result.txt' })), null)
    assert.equal(await readStoredToolImage(variant({ threadId: '../other' })), null)
    assert.equal(await readStoredToolImage(variant({ projectId: 'a/b' })), null)
    assert.equal(await readStoredToolImage(variant({ sha256: '0'.repeat(64) })), null)
    assert.equal(await readStoredToolImage('copse-stored-image:not/enough'), null)
    // A blob rewritten since the reference was made no longer matches it.
    const blob = join(threadBlobsDir(PROJECT, THREAD), 'a1.tool-0-img-0.dataurl')
    assert.equal(readFileSync(blob, 'utf8'), LARGE)
    writeFileSync(blob, SECOND)
    assert.equal(await readStoredToolImage(reference), null)
  })

  it('writes the image, never its reference, when a read message is written back', async () => {
    const read = (await loadThreadMessages(PROJECT, THREAD))[1]
    assert.ok(read)
    await appendMessage(PROJECT, THREAD, { ...read, content: 'Two badges' })
    const reloaded = await loadThreadMessages(PROJECT, THREAD)
    assert.equal(reloaded[1]?.content, 'Two badges')
    assert.deepEqual(await shownImages(reloaded[1]), imageUrls(messages[1]))
    // The whole-thread save path resolves them too.
    const whole = await getProjectThread(PROJECT, THREAD)
    assert.ok(whole)
    await saveProjectThread(PROJECT, { ...whole, title: 'Renamed' })
    assert.deepEqual(
      await shownImages((await loadThreadMessages(PROJECT, THREAD))[1]),
      imageUrls(messages[1]),
    )
  })

  it('copies the images a reference names into another thread', async () => {
    const copied = await getProjectThread(PROJECT, THREAD)
    assert.ok(copied)
    await createThread(PROJECT, { ...copied, id: 'thread-copy' })
    const loaded = await loadThreadMessages(PROJECT, 'thread-copy')
    const references = imageUrls(loaded[1]).filter(isStoredToolImageUrl)
    assert.equal(references.length, 4)
    assert.ok(references.every((url) => parseStoredToolImageUrl(url)?.threadId === 'thread-copy'))
    assert.deepEqual(await shownImages(loaded[1]), imageUrls(messages[1]))
  })

  it('drops an image whose reference cannot be read instead of writing the reference', async () => {
    const dangling = storedToolImageUrl({
      projectId: PROJECT,
      threadId: THREAD,
      ref: 'blobs/missing.dataurl',
      sha256: 'f'.repeat(64),
    })
    await appendMessage(PROJECT, THREAD, {
      id: 'a2',
      role: 'assistant',
      content: '',
      toolCalls: [imageCall('call-4', dangling)],
      createdAt: 3,
    })
    const call = (await loadThreadMessages(PROJECT, THREAD))[2]?.toolCalls[0]
    assert.equal(call?.images, undefined)
    assert.deepEqual(call?.content, [
      { type: 'content', content: { type: 'text', text: 'Revised prompt' } },
    ])
  })
})

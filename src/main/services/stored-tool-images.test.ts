import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, Thread, ToolCall } from '@shared/types'
import {
  isStoredToolImageUrl,
  parseStoredToolImageUrl,
  storedToolImageUrl,
} from '@shared/threads/stored-tool-image.ts'
import {
  hasStoredToolImageRefs,
  readStoredToolImageUrl,
  threadWithStoredToolImageRefs,
  withStoredToolImageRefs,
  withStoredToolImagesResolved,
} from './stored-tool-images.ts'
import {
  appendMessage,
  getProjectThread,
  loadThreadMessages,
  saveProjectThread,
  threadBlobsDir,
} from './thread-store.ts'

const PROJECT = 'proj-stored-images'
const THREAD = 'thread-images'
const IMAGE = 'data:image/png;base64,Z2VuZXJhdGVkLWJhZGdl'
const SECOND = 'data:image/png;base64,c2Vjb25kLWJhZGdl'

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

function thread(messages: Message[]): Thread {
  return {
    id: THREAD,
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
    toolCalls: [imageCall('call-1', IMAGE), imageCall('call-2', SECOND)],
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

describe('stored tool images', () => {
  let root = ''
  let previousRoot: string | undefined

  beforeEach(async () => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-stored-images-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
    await saveProjectThread(PROJECT, thread(messages))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
  })

  it('sends each stored image, and its repeat in ACP content, as one reference', async () => {
    const loaded = await loadThreadMessages(PROJECT, THREAD)
    const sent = withStoredToolImageRefs(PROJECT, THREAD, loaded)
    const urls = imageUrls(sent[1])
    assert.equal(urls.length, 4)
    assert.ok(urls.every(isStoredToolImageUrl), 'no image bytes are sent')
    assert.equal(urls[0], urls[1], 'the ACP repeat is the same reference')
    assert.notEqual(urls[0], urls[2])
    assert.equal(JSON.stringify(sent).includes('Z2VuZXJhdGVkLWJhZGdl'), false)
    // Text content and messages without images are passed through untouched.
    assert.equal(sent[0], loaded[0])
    assert.deepEqual(sent[1]?.toolCalls[0]?.content?.[0], loaded[1]?.toolCalls[0]?.content?.[0])
    // The window reads back exactly the stored image.
    assert.equal(await readStoredToolImageUrl(urls[0] ?? ''), IMAGE)
    assert.equal(await readStoredToolImageUrl(urls[2] ?? ''), SECOND)
  })

  it('leaves images that were not folded from the store inline', () => {
    const live = withStoredToolImageRefs(PROJECT, THREAD, messages)
    assert.deepEqual(imageUrls(live[1]), [IMAGE, IMAGE, SECOND, SECOND])
    assert.equal(live[1], messages[1])
  })

  it('references the snapshot thread a transcript writer loads', async () => {
    const loaded = await getProjectThread(PROJECT, THREAD)
    assert.ok(loaded)
    const sent = threadWithStoredToolImageRefs(PROJECT, loaded)
    assert.ok(imageUrls(sent.messages[1]).every(isStoredToolImageUrl))
    assert.ok(imageUrls(loaded.messages[1]).every((url) => url.startsWith('data:image/')))
  })

  it('refuses references outside the thread blobs, of other files, or that no longer match', async () => {
    const loaded = await loadThreadMessages(PROJECT, THREAD)
    const reference = imageUrls(withStoredToolImageRefs(PROJECT, THREAD, loaded)[1])[0] ?? ''
    const address = parseStoredToolImageUrl(reference)
    assert.ok(address)
    const variant = (patch: Partial<typeof address>): string =>
      storedToolImageUrl({ ...address, ...patch })
    assert.equal(await readStoredToolImageUrl(variant({ ref: 'blobs/../meta.json' })), null)
    assert.equal(await readStoredToolImageUrl(variant({ ref: 'meta.json' })), null)
    assert.equal(await readStoredToolImageUrl(variant({ ref: 'blobs/a1.tool-0.result.txt' })), null)
    assert.equal(await readStoredToolImageUrl(variant({ threadId: '../other' })), null)
    assert.equal(await readStoredToolImageUrl(variant({ sha256: '0'.repeat(64) })), null)
    assert.equal(await readStoredToolImageUrl('copse-stored-image:not/enough'), null)
    // A blob rewritten since the reference was sent no longer matches it.
    writeFileSync(join(threadBlobsDir(PROJECT, THREAD), 'a1.tool-0-img-0.dataurl'), SECOND)
    assert.equal(await readStoredToolImageUrl(reference), null)
  })

  it('writes the image, never its reference, when a window sends a message back', async () => {
    const loaded = await loadThreadMessages(PROJECT, THREAD)
    const sent = withStoredToolImageRefs(PROJECT, THREAD, loaded)[1]
    assert.ok(sent)
    assert.equal(hasStoredToolImageRefs(sent), true)
    const edited: Message = { ...sent, content: 'Two badges' }
    const resolved = await withStoredToolImagesResolved(edited)
    assert.equal(hasStoredToolImageRefs(resolved), false)
    assert.deepEqual(imageUrls(resolved), [IMAGE, IMAGE, SECOND, SECOND])
    await appendMessage(PROJECT, THREAD, resolved)
    const reloaded = await loadThreadMessages(PROJECT, THREAD)
    assert.equal(reloaded[1]?.content, 'Two badges')
    assert.deepEqual(imageUrls(reloaded[1]), [IMAGE, IMAGE, SECOND, SECOND])
  })

  it('drops an image whose reference cannot be read instead of writing the reference', async () => {
    const dangling = storedToolImageUrl({
      projectId: PROJECT,
      threadId: THREAD,
      ref: 'blobs/missing.dataurl',
      sha256: 'f'.repeat(64),
    })
    const message: Message = {
      id: 'a2',
      role: 'assistant',
      content: '',
      toolCalls: [imageCall('call-3', dangling)],
      createdAt: 3,
    }
    const resolved = await withStoredToolImagesResolved(message)
    const call = resolved.toolCalls[0]
    assert.equal(call?.images, undefined)
    assert.deepEqual(call?.content, [
      { type: 'content', content: { type: 'text', text: 'Revised prompt' } },
    ])
  })
})

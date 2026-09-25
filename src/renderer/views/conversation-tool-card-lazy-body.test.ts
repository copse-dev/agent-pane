import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  appendAcpContentBlock,
  appendToken,
  updateToolCall,
} from '@shared/store/thread-helpers.ts'
import { createThread } from '@shared/store/thread-helpers.ts'
import type { AcpToolCallContent, ToolCall } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// A collapsed tool card's body (arguments + result) is expensive to build —
// a full markdown render pass for ACP results — and most tool calls stay
// collapsed. It should not exist in the DOM at all until the card opens.

function fakeApi(): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      agent: {
        ...base['agent'],
        run: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      },
    } satisfies ApiClient
  })()
}

const doneCall: ToolCall = {
  id: 'tc-done-1',
  name: 'read_file',
  args: { path: 'README.md' },
  status: 'done',
  result: '# Copse',
}

const runningCall: ToolCall = {
  id: 'tc-running-1',
  name: 'read_file',
  args: { path: 'notes.md' },
  status: 'running',
  result: null,
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('collapsed tool card bodies render lazily', () => {
  it('does not build the args/result DOM for a collapsed card', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, doneCall)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-done-1"]')
    assert.ok(card, 'expected a tool card')
    assert.equal(card.open, false, 'a completed, never-opened card starts collapsed')
    assert.equal(card.querySelector('.tool-result'), null, 'result body should not exist yet')
    assert.equal(card.querySelector('.tool-args'), null, 'args body should not exist yet')
  })

  it('keeps tool-result images after a card that becomes a collapsed rollup', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      ...doneCall,
      images: [
        {
          dataUrl: 'data:image/png;base64,aW1hZ2U=',
          name: 'generated-concept.png',
        },
      ],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const message = host.querySelector(`[data-message-id="${messageId}"]`)
    assert.ok(message)
    const initialCard = message.querySelector<HTMLDetailsElement>(':scope > .tool-card')
    const initialImages = message.querySelector<HTMLElement>(':scope > .tool-result-images')
    assert.ok(initialCard)
    assert.ok(initialImages)
    assert.strictEqual(initialCard.nextElementSibling, initialImages)

    addToolCall(store, messageId, {
      id: 'tc-done-2',
      name: 'read_file',
      args: { path: 'notes.md' },
      status: 'done',
      result: 'notes',
    })

    const rollup = message.querySelector<HTMLDetailsElement>(':scope > .tool-card-rollup')
    const images = message.querySelector<HTMLElement>(':scope > .tool-result-images')
    const image = images?.querySelector<HTMLImageElement>('.tool-result-image')
    assert.ok(rollup)
    assert.equal(rollup.open, false)
    assert.ok(images, 'tool-result images render outside the collapsed rollup')
    assert.equal(rollup.contains(images), false)
    assert.strictEqual(rollup.nextElementSibling, images)
    assert.ok(image)
    assert.equal(image.alt, 'generated-concept.png')
    assert.equal(image.getAttribute('role'), 'button')
    assert.equal(image.getAttribute('aria-label'), 'Expand generated-concept.png')
  })

  it('previews a screenshot-kind tool image inline at reading size', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      ...doneCall,
      images: [
        {
          dataUrl: 'data:image/png;base64,aW1hZ2U=',
          name: 'generated-concept.png',
          kind: 'screenshot',
        },
      ],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const message = host.querySelector(`[data-message-id="${messageId}"]`)
    assert.ok(message)
    const preview = message.querySelector<HTMLElement>(':scope .tool-result-preview')
    assert.ok(preview, 'a screenshot-kind image renders as an inline preview figure')
    const image = preview.querySelector<HTMLImageElement>('.tool-result-preview-image')
    assert.ok(image)
    assert.equal(image.alt, 'generated-concept.png')
    assert.equal(image.getAttribute('role'), 'button')
    assert.equal(image.getAttribute('aria-label'), 'Expand generated-concept.png')
    assert.equal(
      preview.querySelector('.tool-result-preview-caption')?.textContent,
      'generated-concept.png',
    )
    assert.equal(
      message.querySelector('.tool-result-image'),
      null,
      'a previewed image does not also render as a thumbnail',
    )
  })

  it('keeps frame batches as thumbnails when no image is screenshot-kind', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      ...doneCall,
      images: [
        { dataUrl: 'data:image/png;base64,ZnJhbWUtMQ==', name: 'frame-1.png', kind: 'frames' },
        { dataUrl: 'data:image/png;base64,ZnJhbWUtMg==', name: 'frame-2.png', kind: 'frames' },
      ],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const message = host.querySelector(`[data-message-id="${messageId}"]`)
    assert.ok(message)
    assert.equal(message.querySelector('.tool-result-preview'), null)
    assert.equal(message.querySelectorAll('.tool-result-image').length, 2)
  })

  it('renders rich ACP tool content outside the card and removes it on replacement', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      ...doneCall,
      id: 'tc-rich',
      result: null,
      images: [
        {
          dataUrl: 'data:image/png;base64,aW1hZ2U=',
          name: 'concept.png',
          kind: 'screenshot',
        },
      ],
      content: [
        {
          type: 'content',
          content: {
            type: 'image',
            dataUrl: 'data:image/png;base64,aW1hZ2U=',
            mimeType: 'image/png',
            uri: 'concept.png',
          },
        },
        {
          type: 'content',
          content: {
            type: 'resource_link',
            uri: 'https://example.test/report',
            name: 'report',
            title: 'Open report',
          },
        },
        { type: 'diff', path: 'src/a.ts', oldText: 'old', newText: 'new' },
        { type: 'terminal', terminalId: 'terminal-1' },
      ],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const message = host.querySelector(`[data-message-id="${messageId}"]`)
    const card = message?.querySelector<HTMLElement>(':scope > .tool-card')
    const rich = message?.querySelector<HTMLElement>(':scope > .tool-result-content')
    assert.ok(card)
    assert.ok(rich)
    assert.equal(card.contains(rich), false)
    assert.strictEqual(card.nextElementSibling, rich)
    assert.equal(rich.querySelectorAll('.tool-result-preview-image').length, 1)
    assert.equal(
      rich.querySelector('a[href="https://example.test/report"]')?.textContent,
      'Open report',
    )
    assert.match(rich.querySelector('.acp-tool-diff')?.textContent ?? '', /src\/a\.ts/)
    assert.match(rich.querySelector('.acp-terminal-reference')?.textContent ?? '', /terminal-1/)

    updateToolCall(store, messageId, 'tc-rich', {
      result: 'replacement',
      images: [],
      content: [{ type: 'content', content: { type: 'text', text: 'replacement' } }],
    })
    assert.equal(
      message?.querySelector(':scope > .tool-result-content'),
      null,
      'text-only replacement clears every earlier rich block',
    )
  })

  it('shows ACP resource paths relative to the active thread checkout with absolute hover paths', () => {
    const checkout = '/worktrees/thread-1'
    const screenshot = `${checkout}/tests/e2e/screenshots/archive-attachment-chip.png`
    const scratch = `${checkout}/.tmp/archive-attachment-chip-head.png`
    const outside = '/worktrees/thread-10/other.png'
    const store = createStore({ workspaceRoot: '/repo' })
    const threadId = createThread(store)
    store.setState({
      threads: store.getState().threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              worktree: {
                path: checkout,
                branch: 'copse/thread-1',
                baseBranch: 'main',
                baseCommit: 'a'.repeat(40),
                createdAt: 1,
                seededFromDirtyProject: false,
              },
            }
          : thread,
      ),
    })
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      ...doneCall,
      result: null,
      content: [scratch, screenshot, outside].map((uri): AcpToolCallContent => ({
        type: 'content',
        content: { type: 'resource_link', uri, name: uri },
      })),
    })
    appendAcpContentBlock(store, messageId, 'message', {
      type: 'resource_link',
      uri: screenshot,
      name: screenshot,
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const toolCards = host.querySelectorAll<HTMLElement>('.tool-result-content .acp-resource-link')
    assert.equal(toolCards.length, 3)
    for (const [index, expected] of [
      '.tmp/archive-attachment-chip-head.png',
      'tests/e2e/screenshots/archive-attachment-chip.png',
    ].entries()) {
      const card = toolCards.item(index)
      assert.equal(card.querySelector('.acp-resource-title')?.textContent, expected)
      assert.equal(card.querySelector('.acp-resource-uri')?.textContent, expected)
      assert.equal(card.title, index === 0 ? scratch : screenshot)
    }
    assert.equal(toolCards.item(2).textContent, `${outside}${outside}`)
    assert.equal(toolCards.item(2).title, '')

    const answerCard = host.querySelector<HTMLElement>('.acp-message-content .acp-resource-link')
    assert.ok(answerCard)
    assert.equal(
      answerCard.querySelector('.acp-resource-title')?.textContent,
      'tests/e2e/screenshots/archive-attachment-chip.png',
    )
    assert.equal(answerCard.title, screenshot)
  })

  it('opens a local resource file in the panel without requiring an index match', async () => {
    const store = createStore({ workspaceRoot: '/repo', activeProjectId: 'project-1' })
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      ...doneCall,
      result: null,
      content: [
        '/repo/.tmp/report.md',
        '/elsewhere/private.md',
        'https://example.test/report.md',
        String.raw`\\server\share\private.md`,
      ].map((uri): AcpToolCallContent => ({
        type: 'content',
        content: { type: 'resource_link', uri, name: uri },
      })),
    })
    const reads: string[] = []
    const base = fakeApi()
    const api = {
      ...base,
      index: {
        ...base.index,
        resolveFileReferences: (): Promise<never> =>
          Promise.reject(new Error('resource opening should not query the index')),
      },
      fs: {
        ...base.fs,
        readFile: (projectId: string, ownerThreadId: string, path: string): Promise<string> => {
          reads.push(`${projectId}:${ownerThreadId}:${path}`)
          return Promise.resolve('# Report')
        },
      },
    } satisfies ApiClient
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)

    const titles = host.querySelectorAll<HTMLElement>('.tool-result-content .acp-resource-title')
    const local = titles.item(0)
    assert.equal(local.tagName, 'A')
    assert.equal(local.dataset['workspaceResourcePath'], '.tmp/report.md')
    assert.equal(titles.item(1).tagName, 'SPAN', 'outside paths are not opened as workspace files')
    assert.equal(titles.item(2).getAttribute('href'), 'https://example.test/report.md')
    assert.equal(titles.item(3).tagName, 'SPAN', 'network paths are not workspace files')
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    local.dispatchEvent(click)
    await delay(0)

    assert.equal(click.defaultPrevented, true)
    assert.deepEqual(reads, [`project-1:${threadId}:.tmp/report.md`])
    assert.equal(store.getState().openFile?.path, '.tmp/report.md')
    assert.equal(store.getState().panelTab, 'file')
    assert.equal(store.getState().filesPaneOpen, true)
  })

  it('uses a cited non-image resource link to open the panel and hides its tool card', async () => {
    const image = '/repo/.tmp/report.md'
    const store = createStore({ workspaceRoot: '/repo', activeProjectId: 'project-1' })
    const threadId = createThread(store)
    const toolMessageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, toolMessageId, {
      ...doneCall,
      result: null,
      content: [{ type: 'content', content: { type: 'resource_link', uri: image, name: image } }],
    })
    const replyId = addMessage(store, threadId, 'assistant', `Read [the report](${image}).`)
    const base = fakeApi()
    const api = {
      ...base,
      fs: {
        ...base.fs,
        readFile: (): Promise<string> => Promise.resolve('# Report'),
      },
    } satisfies ApiClient
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)

    const resource = host.querySelector<HTMLElement>(
      `[data-message-id="${toolMessageId}"] .acp-resource-link`,
    )
    const link = host.querySelector<HTMLAnchorElement>(
      `[data-message-id="${replyId}"] .message-text a`,
    )
    assert.ok(resource)
    assert.ok(link)
    assert.equal(resource.hidden, true)
    assert.equal(link.dataset['workspaceResourcePath'], '.tmp/report.md')
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await delay(0)
    assert.equal(store.getState().openFile?.path, '.tmp/report.md')
  })

  it('replaces readable local image links with previews and keeps unavailable links', async () => {
    const workspace = '/repo'
    const image = `${workspace}/images/generated.png`
    const missing = `${workspace}/images/missing.png`
    const outside = '/elsewhere/private.png'
    const store = createStore({ workspaceRoot: workspace, activeProjectId: 'project-1' })
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      ...doneCall,
      result: null,
      content: [image, missing, outside].map((uri): AcpToolCallContent => ({
        type: 'content',
        content: { type: 'resource_link', uri, name: uri },
      })),
    })
    appendAcpContentBlock(store, messageId, 'message', {
      type: 'resource_link',
      uri: image,
      name: image,
    })
    const reads: string[] = []
    const base = fakeApi()
    const api = {
      ...base,
      fs: {
        ...base.fs,
        readImage: (projectId: string, ownerThreadId: string, path: string): Promise<string> => {
          reads.push(`${projectId}:${ownerThreadId}:${path}`)
          return path === 'images/missing.png'
            ? Promise.reject(new Error('File not found'))
            : Promise.resolve('data:image/png;base64,aW1hZ2U=')
        },
      },
    } satisfies ApiClient
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)
    await delay(0)

    // The tool card and the message's own content block share one read.
    assert.deepEqual(reads.sort(), [
      `project-1:${threadId}:images/generated.png`,
      `project-1:${threadId}:images/missing.png`,
    ])
    const previews = host.querySelectorAll<HTMLElement>('.acp-resource-image')
    assert.equal(previews.length, 2)
    for (const preview of previews) {
      assert.equal(preview.querySelector('figcaption')?.textContent, 'images/generated.png')
      assert.equal(preview.title, image)
      assert.equal(preview.querySelector('img')?.getAttribute('role'), 'button')
    }
    const cards = host.querySelectorAll<HTMLElement>('.acp-resource-link')
    assert.equal(cards.length, 2)
    assert.equal(
      cards.item(0).querySelector('.acp-resource-uri')?.textContent,
      'images/missing.png',
    )
    assert.equal(cards.item(1).querySelector('.acp-resource-uri')?.textContent, outside)
  })

  it('places a cited tool image after its sentence and hides the duplicate tool preview', async () => {
    const workspace = '/repo'
    const cited = `${workspace}/images/cited.png`
    const uncited = `${workspace}/images/uncited.png`
    const store = createStore({ workspaceRoot: workspace, activeProjectId: 'project-1' })
    const threadId = createThread(store)
    const toolMessageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, toolMessageId, {
      ...doneCall,
      result: null,
      content: [cited, uncited].map((uri): AcpToolCallContent => ({
        type: 'content',
        content: { type: 'resource_link', uri, name: uri },
      })),
    })
    const replyId = addMessage(store, threadId, 'assistant', `Here is [the image](${cited}).`)
    const base = fakeApi()
    const api = {
      ...base,
      fs: {
        ...base.fs,
        readImage: (): Promise<string> => Promise.resolve('data:image/png;base64,aW1hZ2U='),
      },
    } satisfies ApiClient
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)
    await delay(0)

    const reply = host.querySelector(`[data-message-id="${replyId}"]`)
    const preview = reply?.querySelector<HTMLElement>('.message-text .acp-referenced-image')
    assert.ok(preview, 'the cited image gains a preview')
    assert.equal(preview.querySelector('img')?.alt, 'the image')
    assert.equal(
      preview.querySelector('.acp-referenced-image-path')?.textContent,
      'images/cited.png',
    )
    assert.equal(preview.title, cited)
    const link = reply?.querySelector<HTMLAnchorElement>(`a[href="${cited}"]`)
    assert.ok(link, 'the authored link stays in the sentence')
    const sentence = link.parentElement
    assert.ok(sentence)
    assert.equal(sentence.textContent, 'Here is the image.')
    assert.equal(sentence.nextElementSibling, preview)

    const toolOutput = host.querySelector(`[data-message-id="${toolMessageId}"]`)
    const citedPreview = Array.from(
      toolOutput?.querySelectorAll<HTMLElement>('.acp-resource-image') ?? [],
    ).find((node) => node.dataset['acpResourceUri'] === cited)
    const uncitedPreview = Array.from(
      toolOutput?.querySelectorAll<HTMLElement>('.acp-resource-image') ?? [],
    ).find((node) => node.dataset['acpResourceUri'] === uncited)
    assert.equal(citedPreview?.hidden, true)
    assert.equal(uncitedPreview?.hidden, false)
  })

  it('keeps the reply link and tool resource visible when an image cannot be read', async () => {
    const image = '/repo/images/missing.png'
    const store = createStore({ workspaceRoot: '/repo', activeProjectId: 'project-1' })
    const threadId = createThread(store)
    const toolMessageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, toolMessageId, {
      ...doneCall,
      result: null,
      content: [{ type: 'content', content: { type: 'resource_link', uri: image, name: image } }],
    })
    const replyId = addMessage(store, threadId, 'assistant', `[missing image](${image})`)
    const base = fakeApi()
    const api = {
      ...base,
      fs: {
        ...base.fs,
        readImage: (): Promise<string> => Promise.reject(new Error('File not found')),
      },
    } satisfies ApiClient
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)
    await delay(0)

    assert.ok(host.querySelector(`[data-message-id="${replyId}"] a[href="${image}"]`))
    assert.equal(host.querySelector('.acp-referenced-image'), null)
    const resource = host.querySelector<HTMLElement>(
      `[data-message-id="${toolMessageId}"] .acp-resource-link`,
    )
    assert.ok(resource)
    assert.equal(resource.hidden, false)
  })

  it('treats file: resource URIs as workspace files and matches bare-path citations', async () => {
    const image = '/repo/images/shot one.png'
    const store = createStore({ workspaceRoot: '/repo', activeProjectId: 'project-1' })
    const threadId = createThread(store)
    const toolMessageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, toolMessageId, {
      ...doneCall,
      result: null,
      content: ['file:///repo/images/shot%20one.png', 'file:///repo/notes.md'].map(
        (uri): AcpToolCallContent => ({
          type: 'content',
          content: { type: 'resource_link', uri, name: uri },
        }),
      ),
    })
    const replyId = addMessage(store, threadId, 'assistant', `See [the shot](<${image}>).`)
    const reads: string[] = []
    const base = fakeApi()
    const api = {
      ...base,
      fs: {
        ...base.fs,
        readImage: (_projectId: string, _threadId: string, path: string): Promise<string> => {
          reads.push(path)
          return Promise.resolve('data:image/png;base64,aW1hZ2U=')
        },
      },
    } satisfies ApiClient
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)
    await delay(0)

    const notes = host.querySelector<HTMLElement>('.acp-resource-link')
    assert.equal(notes?.dataset['workspaceResourcePath'], 'notes.md')
    assert.equal(notes.querySelector('.acp-resource-uri')?.textContent, 'notes.md')
    assert.equal(notes.title, 'file:///repo/notes.md')
    assert.deepEqual(reads, ['images/shot one.png'])
    const figure = host.querySelector<HTMLElement>('.acp-resource-image')
    assert.equal(figure?.dataset['workspaceResourcePath'], 'images/shot one.png')
    assert.equal(figure.hidden, true, 'the reply cites the same file by its bare path')
    const preview = host.querySelector<HTMLElement>(
      `[data-message-id="${replyId}"] .acp-referenced-image`,
    )
    assert.equal(preview?.title, image)
  })

  it('keeps a cited resource hidden when ACP content rebuilds its message', async () => {
    const image = '/repo/images/cited.png'
    const store = createStore({ workspaceRoot: '/repo', activeProjectId: 'project-1' })
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', `Here is [the image](${image}).`)
    appendAcpContentBlock(store, messageId, 'message', {
      type: 'resource_link',
      uri: image,
      name: image,
    })
    const reads: string[] = []
    const base = fakeApi()
    const api = {
      ...base,
      fs: {
        ...base.fs,
        readImage: (_projectId: string, _threadId: string, path: string): Promise<string> => {
          reads.push(path)
          return Promise.resolve('data:image/png;base64,aW1hZ2U=')
        },
      },
    } satisfies ApiClient
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)
    await delay(0)
    const resource = (): HTMLElement | null =>
      host.querySelector<HTMLElement>('.acp-message-content [data-workspace-resource-path]')
    assert.equal(resource()?.hidden, true)

    appendAcpContentBlock(store, messageId, 'message', { type: 'text', text: 'more' })
    assert.equal(resource()?.hidden, true, 'the rebuilt card stays hidden')
    assert.equal(resource()?.tagName, 'FIGURE', 'the loaded preview is reused without a reload')
    await delay(0)
    assert.equal(resource()?.hidden, true)
    assert.deepEqual(reads, ['images/cited.png'])
  })

  it('leaves a streaming reply to its renderer until the message is done', async () => {
    const image = '/repo/images/cited.png'
    const store = createStore({ workspaceRoot: '/repo', activeProjectId: 'project-1' })
    const threadId = createThread(store)
    const toolMessageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, toolMessageId, {
      ...doneCall,
      result: null,
      content: [{ type: 'content', content: { type: 'resource_link', uri: image, name: image } }],
    })
    const base = fakeApi()
    const api = {
      ...base,
      fs: {
        ...base.fs,
        readImage: (): Promise<string> => Promise.resolve('data:image/png;base64,aW1hZ2U='),
      },
    } satisfies ApiClient
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)
    const replyId = addMessage(store, threadId, 'assistant', '')
    appendToken(store, replyId, `Here is [the image](${image}) so far`)
    // Another tool update runs the reference pass while the reply streams.
    updateToolCall(store, toolMessageId, doneCall.id, { result: 'updated' })
    await delay(0)

    const reply = host.querySelector(`[data-message-id="${replyId}"]`)
    const link = reply?.querySelector<HTMLAnchorElement>('.message-text a')
    assert.ok(link, 'the streaming link is untouched')
    assert.equal(link.dataset['workspaceResourcePath'], undefined)
    assert.equal(reply?.querySelector('.acp-referenced-image'), null)
    assert.equal(host.querySelector<HTMLElement>('.acp-resource-image')?.hidden, false)

    store.emit('message_done', replyId)
    await delay(0)
    assert.ok(reply.querySelector('.acp-referenced-image'))
    assert.equal(host.querySelector<HTMLElement>('.acp-resource-image')?.hidden, true)
  })

  it('only hides resources written at or before the reply that cites them', async () => {
    const report = '/repo/report.md'
    const store = createStore({ workspaceRoot: '/repo', activeProjectId: 'project-1' })
    const threadId = createThread(store)
    const resourceCall = (id: string): ToolCall => ({
      ...doneCall,
      id,
      result: null,
      content: [{ type: 'content', content: { type: 'resource_link', uri: report, name: report } }],
    })
    const firstId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, firstId, resourceCall('tc-first'))
    addMessage(store, threadId, 'assistant', `Read [the report](${report}).`)
    const secondId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, secondId, resourceCall('tc-second'))
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = (messageId: string): HTMLElement | null =>
      host.querySelector<HTMLElement>(`[data-message-id="${messageId}"] .acp-resource-link`)
    assert.equal(card(firstId)?.hidden, true)
    assert.equal(card(secondId)?.hidden, false, 'the rewritten report shows where it happened')
  })

  it('keeps the file link and details on a loaded image preview', async () => {
    const image = '/repo/images/out.png'
    const imageContent = (description: string): AcpToolCallContent[] => [
      {
        type: 'content',
        content: {
          type: 'resource_link',
          uri: image,
          name: 'out.png',
          description,
          mimeType: 'image/png',
          size: 2048,
        },
      },
    ]
    const store = createStore({ workspaceRoot: '/repo', activeProjectId: 'project-1' })
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      ...doneCall,
      result: null,
      content: imageContent('Rendered output'),
    })
    const reads: string[] = []
    const base = fakeApi()
    const api = {
      ...base,
      fs: {
        ...base.fs,
        readImage: (_projectId: string, _threadId: string, path: string): Promise<string> => {
          reads.push(path)
          return Promise.resolve('data:image/png;base64,aW1hZ2U=')
        },
        readFile: (): Promise<string> => Promise.resolve(''),
      },
    } satisfies ApiClient
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)
    await delay(0)

    const figure = host.querySelector<HTMLElement>('.acp-resource-image')
    assert.ok(figure)
    assert.equal(figure.querySelector('.acp-resource-description')?.textContent, 'Rendered output')
    assert.equal(figure.querySelector('.acp-resource-meta')?.textContent, 'image/png · 2048 B')
    const link = figure.querySelector<HTMLAnchorElement>('figcaption a')
    assert.equal(link?.dataset['workspaceResourcePath'], 'images/out.png')
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(click)
    await delay(0)
    assert.equal(click.defaultPrevented, true)
    assert.deepEqual(reads, ['images/out.png', 'images/out.png'], 'the click opens the image')

    // A tool update rebuilds the card; the preview returns at once without a reread.
    updateToolCall(store, messageId, doneCall.id, { content: imageContent('Updated') })
    const rebuilt = host.querySelector<HTMLElement>('.acp-resource-image')
    assert.notEqual(rebuilt, figure)
    assert.equal(rebuilt?.querySelector('.acp-resource-description')?.textContent, 'Updated')
    assert.equal(
      rebuilt.querySelector('img')?.getAttribute('src'),
      'data:image/png;base64,aW1hZ2U=',
    )
    assert.equal(reads.length, 2)
  })

  it('renders ACP assistant media and embedded resources without Markdown data URLs', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Rich answer')
    appendAcpContentBlock(store, messageId, 'message', {
      type: 'audio',
      dataUrl: 'data:audio/ogg;base64,YXVkaW8=',
      mimeType: 'audio/ogg',
    })
    appendAcpContentBlock(store, messageId, 'message', {
      type: 'resource',
      uri: 'file:///notes.txt',
      mimeType: 'text/plain',
      text: 'embedded notes',
    })
    appendAcpContentBlock(store, messageId, 'message', {
      type: 'resource',
      uri: 'file:///%E0%A4%A',
      mimeType: 'text/plain',
      text: 'malformed URI label',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const message = host.querySelector(`[data-message-id="${messageId}"]`)
    assert.ok(message)
    assert.ok(message.querySelector('audio[src^="data:audio/ogg;base64,"]'))
    assert.equal(message.querySelector('.acp-resource-text')?.textContent, 'embedded notes')
    assert.match(message.textContent, /%E0%A4%A/)
    assert.doesNotMatch(message.querySelector('.message-text')?.innerHTML ?? '', /base64/)
  })

  it('builds the body the first time the card is opened', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, doneCall)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-done-1"]')
    assert.ok(card)
    card.querySelector('.tool-card-header')?.dispatchEvent(new MouseEvent('click'))

    const resultEl = card.querySelector('.tool-result')
    assert.ok(resultEl, 'expected the result body to be built after opening')
    assert.match(resultEl.textContent, /# Copse/)
  })

  it('builds the body when a running card reveals after the delay', async () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, runningCall)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-running-1"]')
    assert.ok(card)
    assert.equal(card.open, false, 'a fast tool should remain compact initially')
    await delay(350)
    assert.equal(card.open, true, 'a running tool card auto-expands')
    assert.ok(card.querySelector('.tool-args'), 'expected the args body to already be built')
  })

  it('auto-expands a failed tool card so the error body is visible', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, {
      id: 'tc-error-1',
      name: 'Image generation',
      args: {},
      status: 'error',
      result:
        'Error: Cannot write to file /var/folders/…/T/CFE46EA9\nError 13: an unknown error occurred',
      resultFormat: 'markdown',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-error-1"]')
    assert.ok(card, 'expected a tool card')
    assert.equal(card.getAttribute('data-status'), 'error')
    assert.equal(card.open, true, 'a failed tool card starts expanded')
    const resultEl = card.querySelector('.tool-result')
    assert.ok(resultEl, 'error body must be built without a click')
    assert.match(resultEl.textContent, /Error 13/)
    const name = card.querySelector('.tool-name')
    assert.ok(name)
    assert.match(name.textContent, /Image generation/)
  })

  it('renders an MCP denial as readable text without hiding its arguments', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, {
      id: 'tc-mcp-denied',
      name: 'mcp.copse.advisor',
      args: { question: 'What should I inspect?' },
      status: 'error',
      result: JSON.stringify({
        result: null,
        error: {
          message: '\n  Request denied.  \n   \nReason: <script>stay text</script>\n',
        },
      }),
      resultFormat: 'markdown',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = host.querySelector('[data-tool-id="tc-mcp-denied"]')
    assert.ok(card)
    const paragraphs = card.querySelectorAll('.tool-result-error-message p')
    assert.deepEqual(
      Array.from(paragraphs, (paragraph) => paragraph.textContent),
      ['Request denied.', 'Reason: <script>stay text</script>'],
    )
    assert.equal(card.querySelector('script'), null)
    assert.match(card.querySelector('.tool-args pre')?.textContent ?? '', /What should I inspect/)
  })

  it('keeps a failed card expanded after a reconcile tick', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, {
      id: 'tc-error-2',
      name: 'exec_command',
      args: { command: 'sips -s format png in.svg --out out.png' },
      status: 'error',
      result: 'Error 13: an unknown error occurred',
      resultFormat: 'markdown',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-error-2"]')
    assert.ok(card)
    assert.equal(card.open, true)

    updateToolCall(store, messageId, 'tc-error-2', {
      result: 'Error 13: an unknown error occurred\nTry sips --help',
    })
    const reconciled = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-error-2"]')
    assert.ok(reconciled)
    assert.equal(reconciled.open, true, 'failed cards stay open across reconcile')
    assert.equal(reconciled.getAttribute('data-status'), 'error')
    assert.match(reconciled.querySelector('.tool-result')?.textContent ?? '', /Try sips/)
  })

  it('does not claim a no-argument tool has no details while it is still running', async () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, {
      id: 'tc-running-empty',
      name: 'MCP: tool',
      args: {},
      status: 'running',
      result: null,
      resultFormat: 'markdown',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-running-empty"]')
    assert.ok(card)
    await delay(350)
    assert.equal(card.open, true)
    assert.equal(Boolean(card.querySelector('.tool-result-empty')), false)
  })

  it('shows an empty state when an MCP card has no arguments or result', async () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, {
      id: 'tc-mcp-empty-1',
      name: 'MCP: tool',
      args: {},
      status: 'done',
      result: '',
      resultFormat: 'markdown',
    })
    addToolCall(store, messageId, {
      id: 'tc-mcp-empty-2',
      name: 'MCP: tool',
      args: {},
      status: 'done',
      result: '',
      resultFormat: 'markdown',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const rollup = host.querySelector<HTMLDetailsElement>('.tool-card-rollup')
    assert.ok(rollup, 'multiple MCP calls should render inside a turn rollup')
    rollup.open = true

    const card = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-mcp-empty-1"]')
    assert.ok(card)
    card.querySelector('.tool-card-header')?.dispatchEvent(new MouseEvent('click'))
    card.open = true
    await Promise.resolve()

    const emptyState = card.querySelector('.tool-result-empty')
    assert.ok(emptyState, 'an open card with no payload should visibly reveal a body')
    assert.match(emptyState.textContent, /No tool details were provided/)

    updateToolCall(store, messageId, 'tc-mcp-empty-1', { status: 'done' })
    const reconciled = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-mcp-empty-1"]')
    assert.strictEqual(reconciled, card, 'an unchanged empty card should be reused')
    assert.equal(
      reconciled.open,
      true,
      'the empty card should remain expanded after reconciliation',
    )
  })

  it('builds the body for a card kept open across a reconcile tick', async () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, doneCall)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-done-1"]')
    assert.ok(card)
    card.querySelector('.tool-card-header')?.dispatchEvent(new MouseEvent('click'))
    // happy-dom doesn't implement <details>'s native toggle-on-click default
    // action, so flip the open state ourselves — a real browser click on the
    // summary would do both this and fire the listener dispatched above.
    card.open = true
    await Promise.resolve()
    assert.ok(card.querySelector('.tool-result'), 'sanity: body built after opening')

    // Changing the tool call's own result patches the existing disclosure shell
    // and preserves the user's expansion while refreshing its lazy body.
    updateToolCall(store, messageId, 'tc-done-1', { result: '# Copse (updated)' })

    const reconciled = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-done-1"]')
    assert.ok(reconciled)
    assert.strictEqual(reconciled, card, 'the disclosure shell should be reused')
    assert.equal(reconciled.open, true, 'expansion survives the reconcile')
    const resultAfter = reconciled.querySelector('.tool-result')
    assert.ok(
      resultAfter,
      'a card restored open must have its body rendered, not just the flag flipped',
    )
    assert.match(resultAfter.textContent, /# Copse \(updated\)/)
  })
})

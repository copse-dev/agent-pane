import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, addToolCall, createThread } from '@shared/store/thread-helpers.ts'
import type { ToolCall } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'

// Component-level port of the seeded `subagent display` describe in
// tests/e2e/subagent-display.e2e.ts (CI-quarantined: its live-mock describe
// OOM-crashes the constrained runner). The seeded describe asserts pure DOM
// structure of the rendered subagent card — collapsed "Explore files" header,
// and on expand the inner explore-message markdown + nested tool label — none of
// which needs Electron. happy-dom holds the whole `<details>` timeline in the DOM
// regardless of open state (there is no layout/`display:none` to reveal), so the
// expand-click the e2e needed is unnecessary; the nested nodes are asserted
// directly. The live-mock describe (a real explore turn) is the OOM-causing
// integration and is dropped, not ported.

function fakeApi(): ApiClient {
  return {
    agent: { run: () => Promise.resolve(), abort: () => Promise.resolve() },
    // The explore message renders `Reading **README.md**`; README.md is a
    // file-reference candidate, so stub the resolver the markdown post-pass calls.
    index: { resolveFileReferences: () => Promise.resolve([]) },
  } as unknown as ApiClient
}

function apiWithFiles(
  resolutions: { candidate: string; path: string; kind?: 'file' | 'directory' }[],
): ApiClient {
  return {
    agent: { run: () => Promise.resolve(), abort: () => Promise.resolve() },
    index: {
      resolveFileReferences: () =>
        Promise.resolve(resolutions.map((r) => ({ ...r, kind: r.kind ?? ('file' as const) }))),
    },
    fs: { readFile: () => Promise.resolve('') },
  } as unknown as ApiClient
}

// Mirrors seedSubagentFixture(): one assistant message with a done `explore`
// tool call whose subagent session read README.md and summarised it.
const exploreCall: ToolCall = {
  id: 'tc-explore-1',
  name: 'explore',
  args: { query: 'Find README' },
  status: 'done',
  result: 'README describes Copse setup and dev workflow.',
  subagent: {
    id: 'sub-session-1',
    kind: 'explore',
    status: 'done',
    prompt: 'Find README',
    summary: 'README describes Copse setup and dev workflow.',
    messages: [
      {
        id: 'sub-msg-1',
        role: 'assistant',
        content: 'Reading **README.md** for project overview.',
        toolCalls: [
          {
            id: 'inner-read-1',
            name: 'read_file',
            args: { path: 'README.md' },
            status: 'done',
            result: '# Copse\n',
          },
        ],
      },
      {
        id: 'sub-msg-2',
        role: 'assistant',
        content: 'README describes Copse setup and dev workflow.',
        toolCalls: [],
      },
    ],
  },
}

function mountWithSubagent(): void {
  const store = createStore()
  const threadId = createThread(store)
  const messageId = addMessage(store, threadId, 'assistant', 'Here is what the subagent found.')
  addToolCall(store, messageId, exploreCall)
  const host = document.createElement('div')
  document.body.append(host)
  mountConversation(host, store, fakeApi())
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('subagent display (component)', () => {
  it('renders a collapsed Explore files subagent card', () => {
    mountWithSubagent()

    const card = document.querySelector('.tool-card-subagent')
    assert.ok(card, 'expected a subagent tool card')
    // e2e: card not to have attribute 'open' (collapsed by default)
    assert.equal(card.hasAttribute('open'), false)
    // e2e: summary .tool-name === 'Explore files'
    assert.equal(
      card.querySelector('summary.tool-card-header .tool-name')?.textContent,
      'Explore files',
    )
  })

  it('renders the expanded explore message and nested inner tool', () => {
    mountWithSubagent()

    const card = document.querySelector('.tool-card-subagent')
    assert.ok(card)
    // e2e (after expand): .subagent-message-assistant strong === 'README.md'
    assert.equal(card.querySelector('.subagent-message-assistant strong')?.textContent, 'README.md')
    // e2e (after expand): .subagent-inner-tool .tool-name === 'Read file'
    assert.equal(card.querySelector('.subagent-inner-tool .tool-name')?.textContent, 'Read file')
  })

  it('makes file paths in inner tool results clickable', async () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Here is what the subagent found.')
    const tcWithFileResult: ToolCall = {
      id: 'tc-glob-1',
      name: 'explore',
      args: { query: 'Find TypeScript files' },
      status: 'done',
      result: 'Found 2 files.',
      subagent: {
        id: 'sub-session-2',
        kind: 'explore',
        status: 'done',
        prompt: 'Find TypeScript files',
        summary: 'Found 2 files.',
        messages: [
          {
            id: 'sub-msg-1',
            role: 'assistant',
            content: 'Searching for files.',
            toolCalls: [
              {
                id: 'inner-glob-1',
                name: 'glob',
                args: { pattern: 'src/**/*.ts' },
                status: 'done',
                result: 'src/main/index.ts\nsrc/renderer/index.ts',
              },
            ],
          },
        ],
      },
    }
    addToolCall(store, messageId, tcWithFileResult)

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(
      host,
      store,
      apiWithFiles([
        { candidate: 'src/main/index.ts', path: 'src/main/index.ts' },
        { candidate: 'src/renderer/index.ts', path: 'src/renderer/index.ts' },
      ]),
    )

    // Allow async annotateFileReferences to complete
    await new Promise((resolve) => setTimeout(resolve, 0))

    const links = host.querySelectorAll('.subagent-inner-tool .tool-result a.file-reference-link')
    assert.equal(links.length, 2)
    assert.equal((links[0] as HTMLAnchorElement).dataset['fileReferencePath'], 'src/main/index.ts')
    assert.equal(
      (links[1] as HTMLAnchorElement).dataset['fileReferencePath'],
      'src/renderer/index.ts',
    )
  })
})

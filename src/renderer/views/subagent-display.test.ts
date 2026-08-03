import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  createThread,
  updateToolCall,
} from '@shared/store/thread-helpers.ts'
import type { ToolCall } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'

// Component-level port of the former seeded `subagent display` e2e coverage.
// Its live-mock describe OOM-crashed the constrained runner, while the seeded
// describe asserted pure DOM
// structure of the rendered subagent card — collapsed "Explored files" header,
// and on expand the inner explore-message markdown + nested tool label — none of
// which needs Electron. happy-dom holds the whole `<details>` timeline in the DOM
// regardless of open state (there is no layout/`display:none` to reveal), so the
// expand-click the e2e needed is unnecessary; the nested nodes are asserted
// directly. The live-mock describe (a real explore turn) is the OOM-causing
// integration and is dropped, not ported.

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
      // The explore message renders `Reading **README.md**`; README.md is a
      // file-reference candidate, so stub the resolver the markdown post-pass calls.
      index: {
        ...base['index'],
        resolveFileReferences: () => Promise.resolve([]),
      },
    } satisfies ApiClient
  })()
}

function apiWithFiles(
  resolutions: { candidate: string; path: string; kind?: 'file' | 'directory' }[],
): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      agent: {
        ...base['agent'],
        run: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      },
      index: {
        ...base['index'],
        resolveFileReferences: () =>
          Promise.resolve(resolutions.map((r) => ({ ...r, kind: r.kind ?? ('file' as const) }))),
      },
      fs: {
        ...base['fs'],
        readFile: () => Promise.resolve(''),
      },
    } satisfies ApiClient
  })()
}

// One assistant message with a done `explore` tool call whose subagent session
// read README.md and summarised it.
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

const semanticSearchSummary = [
  'Here is the complete summary of how semantic search is classified, routed, and executed:',
  '',
  '---',
  '',
  "## Search Routing Summary ('search-routing.ts')",
  '',
  "### 1. Classification ('classifySearchQuery')",
  '',
  '**File:** `src/main/services/search-routing.ts`',
  '',
  'The router picks semantic vs grep based on query shape.',
  '',
  '- **Semantic path** — embedding search via `search_codebase`',
  '- **Grep path** — ripgrep via `grep_search`',
  '',
  '### 2. Execution',
  '',
  'Let me find where this classification function is called.',
  '',
  '- Read `search-routing.ts`',
  '- Search for `classifySearchQuery`',
].join('\n')

const semanticSearchCall: ToolCall = {
  id: 'tc-explore-semantic',
  name: 'explore',
  args: { query: 'How is semantic search routed?' },
  status: 'done',
  result: semanticSearchSummary,
  subagent: {
    id: 'sub-semantic-1',
    kind: 'explore',
    status: 'done',
    prompt: 'How is semantic search routed?',
    summary: semanticSearchSummary,
    messages: [
      {
        id: 'sub-semantic-message',
        role: 'assistant',
        content: semanticSearchSummary,
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
  it('renders a collapsed Explored files subagent card', () => {
    mountWithSubagent()

    const card = document.querySelector('.tool-card-subagent')
    assert.ok(card, 'expected a subagent tool card')
    // e2e: card not to have attribute 'open' (collapsed by default)
    assert.equal(card.hasAttribute('open'), false)
    // e2e: summary .tool-name === 'Explored files'
    assert.equal(
      card.querySelector('summary.tool-card-header .tool-name')?.textContent,
      'Explored files',
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

  it('renders semantic-search summary markdown as structural HTML', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(
      store,
      threadId,
      'assistant',
      "Good find — there *is* semantic search in the agent's code search routing.",
    )
    addToolCall(store, messageId, semanticSearchCall)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const intro = host.querySelector('.msg-assistant .message-text')
    const summary = host.querySelector('.tool-card-subagent .subagent-message-assistant')
    assert.ok(intro)
    assert.ok(summary)
    assert.equal(intro.querySelector('em')?.textContent, 'is')
    assert.equal(summary.querySelectorAll('p ul').length, 0)
    assert.equal(
      [...summary.querySelectorAll('code')].some((code) => code.querySelector('em') !== null),
      false,
    )
    assert.equal(
      [...summary.querySelectorAll('h2')].some((heading) =>
        heading.textContent.includes('Search Routing Summary'),
      ),
      true,
    )
    const classification = [...summary.querySelectorAll('h3')].find((heading) =>
      heading.textContent.includes('Classification'),
    )
    assert.ok(classification)
    assert.notEqual(classification.nextElementSibling?.tagName, 'UL')
    assert.ok(summary.querySelectorAll('ul').length >= 2)
    assert.equal(summary.textContent.includes('##'), false)
  })

  it('keeps a user-expanded inner tool open when the timeline rebuilds', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Here is what the subagent found.')
    addToolCall(store, messageId, structuredClone(exploreCall))
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = qsRequired<HTMLDetailsElement>(document, '.tool-card-subagent')
    const inner = qsRequired<HTMLDetailsElement>(card, '[data-tool-id="inner-read-1"]')
    card.open = true
    inner.setAttribute('open', '')

    // A changed inner tool call changes the timeline wrapper's signature, which
    // rebuilds every inner card from scratch; the user's expansion must survive.
    const session = structuredClone(exploreCall.subagent)
    assert.ok(session)
    const innerCall = session.messages[0]?.toolCalls[0]
    assert.ok(innerCall)
    innerCall.result = '# Copse\n\nUpdated readme contents.\n'
    updateToolCall(store, messageId, 'tc-explore-1', { subagent: session })

    const cardAfter = document.querySelector('.tool-card-subagent')
    assert.ok(cardAfter, 'expected the subagent card to still render')
    assert.equal(cardAfter.hasAttribute('open'), true, 'card should stay open')
    const innerAfter = cardAfter.querySelector('[data-tool-id="inner-read-1"]')
    assert.ok(innerAfter, 'expected the inner tool to still render')
    assert.equal(innerAfter.hasAttribute('open'), true, 'expanded inner tool should stay open')
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

    // The inner tool card is collapsed by default — its body (and so the
    // result text annotateFileReferences links) is deferred until it opens.
    host
      .querySelector('.subagent-inner-tool .tool-group-item-header')
      ?.dispatchEvent(new MouseEvent('click'))

    // Allow async annotateFileReferences to complete
    await new Promise((resolve) => setTimeout(resolve, 0))

    const links = host.querySelectorAll<HTMLAnchorElement>(
      '.subagent-inner-tool .tool-result a.file-reference-link',
    )
    assert.equal(links.length, 2)
    const firstLink = links.item(0)
    const secondLink = links.item(1)
    assert.equal(firstLink.dataset['fileReferencePath'], 'src/main/index.ts')
    assert.equal(secondLink.dataset['fileReferencePath'], 'src/renderer/index.ts')
  })

  it('shows the summary once when the parent result repeats the timeline', () => {
    mountWithSubagent()

    const card = qsRequired<HTMLDetailsElement>(document, '.tool-card-subagent')
    // `summary` is the subagent's last assistant message verbatim, so the
    // parent result would otherwise print it a second time below the timeline.
    assert.equal(card.querySelectorAll('.subagent-parent-result').length, 0)
    const copies = [...card.querySelectorAll('.subagent-message-assistant')].filter((node) =>
      node.textContent.includes('README describes Copse setup and dev workflow.'),
    )
    assert.equal(copies.length, 1, 'the summary should render exactly once')
  })

  it('still renders a parent result the subagent never said in its timeline', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Here is what the subagent found.')
    const diverged = structuredClone(exploreCall)
    diverged.result = 'Exploration completed with no summary.'
    addToolCall(store, messageId, diverged)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const result = host.querySelector('.subagent-parent-result')
    assert.ok(result, 'a result absent from the timeline is still shown')
    assert.match(result.textContent, /Exploration completed with no summary\./)
  })

  it('auto-contracts an explore card once the subagent finishes', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    const running = structuredClone(exploreCall)
    running.status = 'running'
    running.result = null
    const runningSession = running.subagent
    assert.ok(runningSession)
    runningSession.status = 'running'
    runningSession.summary = ''
    addToolCall(store, messageId, running)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = qsRequired<HTMLDetailsElement>(host, '.tool-card-subagent')
    assert.equal(card.open, true, 'a running explore card auto-expands')

    // The turn settles. The auto-expansion was never a user preference, so the
    // wall of explored text must collapse rather than stay pinned open.
    const settledCall = structuredClone(exploreCall)
    assert.ok(settledCall.subagent)
    updateToolCall(store, messageId, 'tc-explore-1', {
      status: 'done',
      result: settledCall.result,
      subagent: settledCall.subagent,
    })

    const settled = qsRequired<HTMLDetailsElement>(host, '.tool-card-subagent')
    assert.equal(settled.open, false, 'a finished explore card contracts')
  })

  it('keeps a card the user expanded after it settled open across later ticks', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Here is what the subagent found.')
    addToolCall(store, messageId, structuredClone(exploreCall))
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = qsRequired<HTMLDetailsElement>(host, '.tool-card-subagent')
    card.open = true

    const session = structuredClone(exploreCall.subagent)
    assert.ok(session)
    const innerCall = session.messages[0]?.toolCalls[0]
    assert.ok(innerCall)
    innerCall.result = '# Copse\n\nUpdated readme contents.\n'
    updateToolCall(store, messageId, 'tc-explore-1', { subagent: session })

    assert.equal(
      qsRequired<HTMLDetailsElement>(host, '.tool-card-subagent').open,
      true,
      'an expansion made after the tool settled is a real preference',
    )
  })
})

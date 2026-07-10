import { el, clear } from '../dom/helpers.ts'
import { arrowDownIcon, checkIcon, closeIcon, moreHorizontalIcon } from '../dom/icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import { getThreadById, getActiveThread, setQueuePaused } from '@shared/store/thread-helpers.ts'
import { attachCodeBlockCopyButtons } from '../markdown/code-block-copy.ts'
import { attachTableCopyButtons } from '../markdown/table-copy.ts'
import { renderMarkdown } from '@copse/streaming-markdown'
import { renderMermaidIn } from '../markdown/mermaid.ts'
import { StreamingMarkdownRenderer } from '@copse/streaming-markdown'
import { annotateFileReferences, bindFileReferenceClicks } from '../markdown/file-links.ts'
import { bindBrowserLinkClicks } from '../markdown/browser-links.ts'
import { bindWorkspaceLinkClicks } from '../markdown/workspace-links.ts'
import { hydrateRemoteArtifactImages } from '../markdown/remote-artifact-images.ts'
import { stripTextToolCallBlocks } from '@copse/agent/parse-text-tool-calls.ts'
import type { Message, SubagentSession, ToolCall, TranscriptAttachment } from '@shared/types'
import { attachmentIcon } from '../dom/attachment-icons.ts'
import { CHIP_CHAR } from './composer-editor.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { agentActivityLabel } from '../agent-activity.ts'
import {
  aggregateToolStatus,
  buildToolCallDisplayItems,
  getToolCallLabel,
  getToolEditPath,
  type ToolCallDisplayItem,
} from '@shared/tools/tool-display.ts'
import { navigateToChange } from '../controller/panels.ts'
import { createTodoListEl } from './todo-panel.ts'
import { createReviewCardEl } from './review-panel.ts'
import { createComparisonCardEl } from './comparison-panel.ts'
import { retryComparison, retryReview } from '../controller/retry-review-comparison.ts'
import { renderToolArgs } from './tool-args-format.ts'
import {
  drainMessageQueue,
  queuedMessageIds,
  queuedPayloadText,
  removeQueuedMessage,
  sendQueuedMessageNow,
  updateQueuedMessageText,
} from '../controller/message-queue.ts'

function statusIcon(status: ToolCall['status']): SVGSVGElement {
  if (status === 'done') return checkIcon('ui-icon ui-icon-sm')
  if (status === 'error') return closeIcon('ui-icon ui-icon-sm')
  return moreHorizontalIcon('ui-icon ui-icon-sm')
}

// The disclosure is omitted entirely when there are no arguments to show — e.g.
// external ACP agents run no-argument commands (grep/search with the query in
// the title, not `rawInput`), which otherwise render an empty "Arguments" box.
function createToolArgsSection(args: unknown): HTMLDetailsElement | null {
  const rendered = renderToolArgs(args)
  if (!rendered.trim()) return null
  return el(
    'details',
    { class: 'tool-args' },
    el('summary', {}, 'Arguments'),
    el('pre', {}, rendered),
  )
}

function createToolResultSection(result: string | null, format?: 'markdown'): HTMLElement {
  if (!result) return el('div', { class: 'tool-result' })
  // ACP tool output is agent-authored Markdown — render it through the same
  // pipeline as assistant messages so fenced code, lists and prose display
  // instead of literal backticks. Built-in results stay in a plain `<pre>`.
  if (format === 'markdown') {
    const wrap = el('div', { class: 'tool-result tool-result-markdown message-text' })
    wrap.innerHTML = renderMarkdown(result)
    attachCodeBlockCopyButtons(wrap)
    return wrap
  }
  return el('div', { class: 'tool-result' }, el('pre', {}, renderToolArgs(result)))
}

function createToolHeader(
  label: string,
  status: ToolCall['status'],
  summaryClass: string,
  count?: number,
  editStats?: ToolCall['editStats'],
  editPath?: string | null,
): HTMLElement {
  const children: (Node | string)[] = [el('span', { class: 'tool-name' }, label)]
  if (editStats) {
    const stats = [
      el('span', { class: 'tool-stat tool-stat-add' }, `+${String(editStats.additions)}`),
      el('span', { class: 'tool-stat tool-stat-del' }, `-${String(editStats.deletions)}`),
    ]
    if (editPath) {
      // Clickable: reveal this file's diff in the Changes panel. Delegated
      // click handling lives in mountConversation (needs the store).
      children.push(
        el(
          'button',
          {
            type: 'button',
            class: 'tool-edit-stats',
            'data-edit-path': editPath,
            title: 'View changes',
            'aria-label': `View changes to ${editPath}`,
          },
          ...stats,
        ),
      )
    } else {
      children.push(...stats)
    }
  }
  if (count !== undefined && count > 1) {
    children.push(el('span', { class: 'tool-count' }, `×${String(count)}`))
  }
  children.push(el('span', { class: 'tool-status-icon', 'aria-label': status }, statusIcon(status)))
  return el('summary', { class: summaryClass }, ...children)
}

function appendStandardToolSections(
  card: HTMLElement,
  tc: ToolCall,
  label: string,
  summaryClass: string,
  count?: number,
): void {
  card.append(
    createToolHeader(label, tc.status, summaryClass, count, tc.editStats, getToolEditPath(tc)),
    ...appendIfPresent(createToolArgsSection(tc.args)),
    createToolResultSection(tc.result, tc.resultFormat),
  )
}

/** Spread helper: include a section only when it was rendered (non-null). */
function appendIfPresent(node: Node | null): Node[] {
  return node ? [node] : []
}

function createIndividualToolCard(tc: ToolCall, label: string, api: ApiClient): HTMLElement {
  if (tc.subagent) return createSubagentToolCard(tc, label, api)

  const card = el('details', {
    class: 'tool-card',
    'data-tool-id': tc.id,
    'data-status': tc.status,
  })
  appendStandardToolSections(card, tc, label, 'tool-card-header')
  return card
}

function assistantDisplayText(content: string): string {
  return stripTextToolCallBlocks(content)
}

function summaryPreview(text: string, max = 200): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}…`
}

function createInnerToolCard(tc: ToolCall): HTMLElement {
  const entry = el('details', {
    class: 'tool-group-item subagent-inner-tool',
    'data-tool-id': tc.id,
    'data-status': tc.status,
  })
  appendStandardToolSections(entry, tc, getToolCallLabel(tc), 'tool-group-item-header')
  return entry
}

// Per-message incremental renderers for the active streaming pass. Keyed by the
// `.message-text` element so re-entrant token events reuse the same DOM regions
// instead of rebuilding the whole message innerHTML each token (O(n²)).
const streamingRenderers = new WeakMap<HTMLElement, StreamingMarkdownRenderer>()

function setAssistantMarkdown(
  el: HTMLElement,
  content: string,
  streaming: boolean,
  api: ApiClient,
): void {
  const display = assistantDisplayText(content)
  if (streaming) {
    el.classList.add('is-streaming')
    let renderer = streamingRenderers.get(el)
    if (!renderer) {
      renderer = new StreamingMarkdownRenderer(el)
      streamingRenderers.set(el, renderer)
    }
    renderer.update(display)
    attachCodeBlockCopyButtons(el)
    return
  }
  // Final render: replace the incremental scaffold with the finished markdown.
  el.classList.remove('is-streaming')
  streamingRenderers.delete(el)
  el.innerHTML = renderMarkdown(display)
  attachCodeBlockCopyButtons(el)
  // Tables only on the committed final render — during streaming they are
  // patched with pending rows, so wrapping them then would fight the DOM sync.
  attachTableCopyButtons(el)
  void annotateFileReferences(el, api)
  hydrateRemoteArtifactImages(el, api)
  void renderMermaidIn(el)
}

function createSubagentMessageEl(content: string, streaming: boolean, api: ApiClient): HTMLElement {
  const textEl = el('div', {
    class: 'subagent-message subagent-message-assistant message-text streaming-markdown',
  })
  setAssistantMarkdown(textEl, content, streaming, api)
  return textEl
}

function subagentCardStatus(tc: ToolCall, session: SubagentSession): ToolCall['status'] {
  if (tc.status === 'running' || session.status === 'running') return 'running'
  if (session.status === 'error' || tc.status === 'error') return 'error'
  return 'done'
}

// Which model ran this subagent — the whole point of local routing is invisible
// without it, and so is the silent cloud fallback when LM Studio is unreachable.
function subagentModelBadge(session: SubagentSession): HTMLElement | null {
  if (!session.model) return null
  const isLocal = session.model.startsWith('lmstudio:')
  const badge = el('div', { class: 'subagent-model' })
  badge.textContent = isLocal
    ? `${session.model.slice('lmstudio:'.length)} · local`
    : session.model
  if (session.localFallback) {
    badge.textContent += ' — local model unavailable, ran on cloud'
    badge.classList.add('subagent-model-fallback')
  }
  return badge
}

// Committed (final-render) text of a subagent timeline message element, so a
// completed message whose content is unchanged since the last tick is left
// untouched rather than re-rendered. The running (last) message keeps streaming
// through its existing StreamingMarkdownRenderer — that is why its element
// identity must survive across `tool_call_updated` ticks (#728).
const subagentMessageCommitted = new WeakMap<HTMLElement, string>()
// Signature of an inner-tool wrapper's tool calls, so a message's nested tools
// are rebuilt only when they actually change.
const subagentInnerToolsSig = new WeakMap<HTMLElement, string>()

// Reconcile the subagent timeline in place, keyed by message id. Reuses each
// message's rendered element across ticks so the running subagent's streaming
// markdown (and its code-block copy buttons) stop flickering on every progress
// update — the prior code tore down and rebuilt the whole subtree each tick,
// minting a fresh streaming renderer that replayed the settle-fade (#728).
function syncSubagentTimeline(
  timeline: HTMLElement,
  session: SubagentSession,
  status: ToolCall['status'],
  api: ApiClient,
): void {
  const existing = new Map<string, HTMLElement>()
  for (const node of Array.from(timeline.children) as HTMLElement[]) {
    const key = node.dataset['timelineKey']
    if (key) existing.set(key, node)
  }

  const desired: HTMLElement[] = []
  for (let i = 0; i < session.messages.length; i++) {
    const msg = session.messages[i]
    if (!msg) continue
    const isLast = i === session.messages.length - 1
    const streaming = status === 'running' && isLast

    if (msg.content.trim()) {
      const key = `msg:${msg.id}`
      let node = existing.get(key)
      if (!node) {
        node = createSubagentMessageEl(msg.content, streaming, api)
        node.dataset['timelineKey'] = key
        if (!streaming) subagentMessageCommitted.set(node, msg.content)
      } else if (streaming) {
        // Same element → the WeakMap in setAssistantMarkdown hits, so the block
        // settle-fade runs once instead of replaying on every tick.
        setAssistantMarkdown(node, msg.content, true, api)
        subagentMessageCommitted.delete(node)
      } else if (subagentMessageCommitted.get(node) !== msg.content) {
        // A message that just stopped streaming (or whose text changed) commits
        // its final render once; unchanged completed messages fall through and
        // are reused untouched.
        setAssistantMarkdown(node, msg.content, false, api)
        subagentMessageCommitted.set(node, msg.content)
      }
      desired.push(node)
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- persisted/legacy messages may predate the toolCalls field
    const innerToolCalls = msg.toolCalls ?? []
    if (innerToolCalls.length > 0) {
      const key = `tools:${msg.id}`
      const sig = JSON.stringify(innerToolCalls)
      let wrap = existing.get(key)
      if (!wrap || subagentInnerToolsSig.get(wrap) !== sig) {
        const fresh = el('div', { class: 'subagent-inner-tools' })
        fresh.dataset['timelineKey'] = key
        for (const inner of innerToolCalls) {
          fresh.append(createInnerToolCard(inner))
        }
        subagentInnerToolsSig.set(fresh, sig)
        void annotateFileReferences(fresh, api)
        wrap = fresh
      }
      desired.push(wrap)
    }
  }

  const keep = new Set(desired)
  existing.forEach((node) => {
    if (!keep.has(node)) node.remove()
  })
  // Re-append in order: moves reused nodes into place and inserts new ones.
  for (const node of desired) timeline.append(node)
}

// Fill (or refresh in place) a subagent card. The timeline is reconciled so the
// running subagent's streaming message keeps its element/renderer; the header,
// model badge, preview, args and parent result carry no streaming state and are
// cheap to rebuild — and the preview/result only appear once the run settles, so
// they don't churn during the flickery running phase.
function populateSubagentCard(card: HTMLElement, tc: ToolCall, label: string, api: ApiClient): void {
  const session = tc.subagent
  if (!session) throw new Error('populateSubagentCard requires tc.subagent')
  const status = subagentCardStatus(tc, session)
  card.dataset['status'] = status

  const timeline =
    (Array.from(card.children) as HTMLElement[]).find((node) =>
      node.classList.contains('subagent-timeline'),
    ) ?? el('div', { class: 'subagent-timeline' })
  syncSubagentTimeline(timeline, session, status, api)

  clear(card)
  card.append(createToolHeader(label, status, 'tool-card-header'))

  const badge = subagentModelBadge(session)
  if (badge) card.append(badge)

  const preview = session.summary ?? tc.result ?? ''
  if (preview && status !== 'running') {
    const previewEl = el('div', {
      class: 'subagent-summary-preview message-text streaming-markdown',
    })
    setAssistantMarkdown(previewEl, summaryPreview(preview), false, api)
    card.append(previewEl)
  }

  const argsSection = createToolArgsSection(tc.args)
  if (argsSection) card.append(argsSection)

  card.append(timeline)

  if (tc.result && status === 'done') {
    const resultEl = el('div', {
      class:
        'subagent-parent-result subagent-message subagent-message-assistant message-text streaming-markdown',
    })
    setAssistantMarkdown(resultEl, tc.result, false, api)
    card.append(resultEl)
  }
}

function createSubagentToolCard(tc: ToolCall, label: string, api: ApiClient): HTMLElement {
  const card = el('details', {
    class: 'tool-card tool-card-subagent',
    'data-tool-id': tc.id,
  })
  populateSubagentCard(card, tc, label, api)
  return card
}

function createGroupToolCard(item: Extract<ToolCallDisplayItem, { type: 'group' }>): HTMLElement {
  const status = aggregateToolStatus(item.toolCalls)
  const card = el('details', {
    class: 'tool-card tool-card-group',
    'data-group-key': item.key,
    'data-status': status,
  })

  const count = item.toolCalls.length
  const groupItems = el('div', { class: 'tool-group-items' })
  card.append(createToolHeader(item.label, status, 'tool-card-header', count), groupItems)

  for (const tc of item.toolCalls) {
    const entry = el('details', {
      class: 'tool-group-item',
      'data-tool-id': tc.id,
      'data-status': tc.status,
    })
    entry.append(
      createToolHeader(
        getToolCallLabel(tc),
        tc.status,
        'tool-group-item-header',
        undefined,
        tc.editStats,
        getToolEditPath(tc),
      ),
      ...appendIfPresent(createToolArgsSection(tc.args)),
      createToolResultSection(tc.result, tc.resultFormat),
    )
    groupItems.append(entry)
  }

  return card
}

function createToolCard(item: ToolCallDisplayItem, api: ApiClient): HTMLElement {
  if (item.type === 'group') return createGroupToolCard(item)
  return createIndividualToolCard(item.toolCall, item.label, api)
}

// Stable identity for a tool card across `tool_call_updated` ticks: group cards
// key on the group bucket, individual cards on the tool-call id. Held in
// WeakMaps (rather than DOM attributes) so large signatures don't bloat the DOM.
const toolCardKeys = new WeakMap<HTMLElement, string>()
const toolCardSignatures = new WeakMap<HTMLElement, string>()

function toolCardKey(item: ToolCallDisplayItem): string {
  return item.type === 'group' ? `g:${item.key}` : `t:${item.toolCall.id}`
}

// Everything that determines a card's rendered output. When it is unchanged
// since the last tick the existing card is reused verbatim, so its markdown is
// not re-rendered and its copy buttons are not re-attached (#728). Wire tool
// calls are plain JSON, so a stringify captures args/result/status/subagent.
function toolCardSignature(item: ToolCallDisplayItem): string {
  return JSON.stringify(item)
}

function createMessageImages(images: string[]): HTMLElement {
  const wrap = el('div', { class: 'message-images' })
  for (const dataUrl of images) {
    wrap.append(
      el('img', {
        class: 'message-image',
        src: dataUrl,
        alt: 'Attached image',
        loading: 'lazy',
      }),
    )
  }
  return wrap
}

function appendMessageContent(
  body: HTMLElement,
  msg: {
    role: string
    content: string
    images?: string[]
    reasoning?: string
    attachments?: TranscriptAttachment[]
  },
  api: ApiClient,
): void {
  if (msg.role === 'user' && msg.images?.length) {
    body.append(createMessageImages(msg.images))
  }
  // Reasoning disclosure sits above the answer so the "Thinking" trail reads
  // top-to-bottom. Collapsed once the answer has arrived; the live handler keeps
  // it open while it is still streaming and the answer is empty.
  if (msg.role === 'assistant' && msg.reasoning) {
    body.append(buildReasoningEl(msg.reasoning, !msg.content.trim()))
  }
  const textEl = el('div', { class: 'message-text streaming-markdown' })
  if (msg.role === 'assistant' && msg.content) {
    setAssistantMarkdown(textEl, msg.content, false, api)
  } else if (msg.role === 'user' && msg.attachments?.length) {
    renderUserTranscript(textEl, msg.content, msg.attachments)
  } else {
    textEl.textContent = msg.content
  }
  body.append(textEl)
}

/** A display-only transcript chip: an outline icon + its (clipped) label. */
function transcriptChip(kind: TranscriptAttachment['kind'], label: string): HTMLElement {
  const chip = el('span', { class: `transcript-attachment-chip transcript-attachment-${kind}` })
  chip.append(
    attachmentIcon(kind, 'transcript-attachment-icon'),
    el('span', { class: 'transcript-attachment-label' }, label),
  )
  return chip
}

/**
 * Render a sent user message with its attachment chips: each pasted block sits
 * inline at its U+FFFC placeholder (in `content`), and file/thread references
 * follow in a trailing row. Pastes are matched to placeholders by order.
 */
function renderUserTranscript(
  host: HTMLElement,
  content: string,
  attachments: TranscriptAttachment[],
): void {
  const pastes = attachments.filter((a) => a.kind === 'paste')
  const trailing = attachments.filter((a) => a.kind !== 'paste')

  const parts = content.split(CHIP_CHAR)
  parts.forEach((part, i) => {
    if (part) host.append(document.createTextNode(part))
    if (i < parts.length - 1) {
      host.append(transcriptChip('paste', pastes[i]?.label ?? 'Pasted text'))
    }
  })

  if (trailing.length) {
    const row = el('div', { class: 'transcript-attachment-row' })
    for (const a of trailing) row.append(transcriptChip(a.kind, a.label))
    host.append(row)
  }
}

/**
 * A `<details>` disclosure holding the model's reasoning trail. `open` reflects
 * whether the answer is still pending so live thinking is visible by default but
 * past turns stay collapsed. A click on the summary marks it user-controlled so
 * later streaming updates never fight the user's choice.
 */
function buildReasoningEl(reasoning: string, open: boolean): HTMLDetailsElement {
  const details = el('details', { class: 'message-reasoning', open })
  const summary = el(
    'summary',
    { class: 'message-reasoning-summary' },
    el('span', { class: 'message-reasoning-icon', 'aria-hidden': 'true' }),
    el('span', { class: 'message-reasoning-title' }, 'Thinking'),
  )
  const text = el('div', { class: 'message-reasoning-text' })
  renderReasoningText(text, reasoning)
  summary.addEventListener('click', () => {
    details.dataset['userToggled'] = '1'
  })
  details.append(summary, text)
  return details
}

/**
 * Render reasoning text as markdown into a <div>. Uses the same pipeline as
 * the answer body but without post-processing (file links, mermaid, remote
 * images) — reasoning is self-contained and doesn't reference external resources.
 */
function renderReasoningText(el: HTMLElement, text: string): void {
  el.innerHTML = renderMarkdown(text)
}

/**
 * Create or update the reasoning disclosure for a streaming assistant message.
 * Reuses the existing element so re-entrant reasoning events keep the user's
 * open/closed choice and avoid rebuilding the DOM each token.
 */
function syncReasoningEl(msgEl: HTMLElement, msg: { content: string; reasoning?: string }): void {
  const body = msgEl.querySelector('.message-body')
  if (!body) return
  let details = body.querySelector<HTMLDetailsElement>('.message-reasoning')
  if (!msg.reasoning) {
    details?.remove()
    return
  }
  if (!details) {
    details = buildReasoningEl(msg.reasoning, true)
    body.prepend(details)
  } else {
    const textEl = body.querySelector<HTMLElement>('.message-reasoning-text')
    if (textEl) renderReasoningText(textEl, msg.reasoning)
  }
  // Keep the trail open while it is still live, unless the user collapsed it.
  if (!details.dataset['userToggled'] && !msg.content.trim()) details.open = true
}

const SCROLL_PIN_THRESHOLD_PX = 48
/** Ignore auto-scroll briefly after the user scrolls up during streaming. */
const USER_SCROLL_UP_DEBOUNCE_MS = 150

export function mountConversation(root: HTMLElement, store: AppStore, api: ApiClient): () => void {
  const scrollArea = el('div', { class: 'conversation-scroll' })
  const todoHost = el('div', { class: 'conversation-todos-host' })
  const list = el('div', { class: 'messages-list', role: 'log', 'aria-live': 'polite' })
  const scrollToBottomBtn = el(
    'button',
    {
      class: 'scroll-to-bottom',
      type: 'button',
      'aria-label': 'Scroll to bottom',
      hidden: true,
    },
    arrowDownIcon('ui-icon'),
  )
  scrollArea.append(todoHost, list, scrollToBottomBtn)

  const activityBar = el('div', { class: 'agent-activity', role: 'status', 'aria-live': 'polite' })
  const activityLabel = el('span', { class: 'agent-activity-label' })
  activityBar.append(
    el('span', { class: 'agent-activity-pulse', 'aria-hidden': 'true' }),
    activityLabel,
  )
  // Clicking the activity row jumps to and opens the latest reasoning trail so the
  // "Thinking…" indicator is itself the way in to watching the model think.
  activityBar.addEventListener('click', () => {
    const trails = list.querySelectorAll('.msg-assistant .message-reasoning')
    const details = trails[trails.length - 1] as HTMLDetailsElement | undefined
    if (!details) return
    details.dataset['userToggled'] = '1'
    details.open = true
    details.scrollIntoView({ block: 'nearest' })
  })
  // Queued follow-ups live in a pinned panel below the scroll area so they stay
  // visible at the bottom of the screen instead of getting buried under the
  // streaming response inside the scrollable message list.
  const queuedHost = el('div', { class: 'conversation-queued', hidden: true })
  root.append(scrollArea, queuedHost, activityBar)

  // Clicking a file edit's +/- counts reveals that file in the Changes panel.
  // Delegated here so the handler can reach the store; preventDefault stops the
  // surrounding <summary> from toggling its <details>.
  list.addEventListener('click', (e) => {
    const statsBtn = (e.target as HTMLElement | null)?.closest(
      '.tool-edit-stats',
    ) as HTMLElement | null
    const path = statsBtn?.dataset['editPath']
    if (!path) return
    e.preventDefault()
    e.stopPropagation()
    navigateToChange(store, path)
  })

  // Inline-edit state for a queued message. Preserved across re-renders so a
  // store-driven rebuild (e.g. pause toggle) keeps the editor and its draft.
  let editingMessageId: string | null = null
  let editingDraft = ''

  function startEditing(messageId: string): void {
    const threadId = store.getState().activeThreadId
    if (!threadId) return
    const thread = store.getState().threads.find((t) => t.id === threadId)
    const item = thread?.pendingMessages?.find((p) => p.messageId === messageId)
    if (!item) return
    editingMessageId = messageId
    editingDraft = queuedPayloadText(item.payload)
    // Pausing emits threads_changed, which re-renders this message in edit mode.
    setQueuePaused(store, threadId, true)
  }

  function stopEditing(): void {
    editingMessageId = null
    editingDraft = ''
  }

  function cancelEditing(): void {
    const threadId = store.getState().activeThreadId
    stopEditing()
    if (!threadId) return
    setQueuePaused(store, threadId, false)
    drainMessageQueue(store, api, threadId)
  }

  function saveEditing(messageId: string, sendNow: boolean): void {
    const threadId = store.getState().activeThreadId
    if (!threadId) return
    const text = editingDraft.trim()
    stopEditing()
    if (text) updateQueuedMessageText(store, threadId, messageId, text)
    setQueuePaused(store, threadId, false)
    if (sendNow) sendQueuedMessageNow(store, api, threadId, messageId)
    else drainMessageQueue(store, api, threadId)
  }

  function deleteQueued(messageId: string): void {
    const threadId = store.getState().activeThreadId
    if (!threadId) return
    const wasEditing = editingMessageId === messageId
    if (wasEditing) stopEditing()
    removeQueuedMessage(store, threadId, messageId)
    if (wasEditing) {
      setQueuePaused(store, threadId, false)
      drainMessageQueue(store, api, threadId)
    }
  }

  function buildQueuedActions(messageId: string): HTMLElement {
    const editBtn = el('button', { class: 'queued-action queued-edit', type: 'button' }, 'Edit')
    editBtn.addEventListener('click', () => {
      startEditing(messageId)
    })
    const sendNowBtn = el(
      'button',
      { class: 'queued-action queued-send-now', type: 'button' },
      'Send now',
    )
    sendNowBtn.addEventListener('click', () => {
      const threadId = store.getState().activeThreadId
      if (threadId) sendQueuedMessageNow(store, api, threadId, messageId)
    })
    const deleteBtn = el(
      'button',
      { class: 'queued-action queued-delete', type: 'button' },
      'Delete',
    )
    deleteBtn.addEventListener('click', () => {
      deleteQueued(messageId)
    })
    return el(
      'div',
      { class: 'message-queued-ui' },
      el('div', { class: 'message-queued-actions' }, editBtn, sendNowBtn, deleteBtn),
    )
  }

  function buildQueuedEditor(messageId: string): HTMLElement {
    const input = el('textarea', {
      class: 'message-edit-input',
      rows: '3',
      'aria-label': 'Edit queued message',
    })
    input.value = editingDraft
    input.addEventListener('input', () => {
      editingDraft = input.value
    })
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelEditing()
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        saveEditing(messageId, false)
      }
    })
    const sendBtn = el('button', { class: 'queued-action queued-send', type: 'button' }, 'Send')
    sendBtn.addEventListener('click', () => {
      saveEditing(messageId, false)
    })
    const sendNowBtn = el(
      'button',
      { class: 'queued-action queued-send-now', type: 'button' },
      'Send now',
    )
    sendNowBtn.addEventListener('click', () => {
      saveEditing(messageId, true)
    })
    const cancelBtn = el(
      'button',
      { class: 'queued-action queued-cancel', type: 'button' },
      'Cancel',
    )
    cancelBtn.addEventListener('click', () => {
      cancelEditing()
    })
    const deleteBtn = el(
      'button',
      { class: 'queued-action queued-delete', type: 'button' },
      'Delete',
    )
    deleteBtn.addEventListener('click', () => {
      deleteQueued(messageId)
    })
    const wrap = el(
      'div',
      { class: 'message-queued-ui' },
      input,
      el('div', { class: 'message-queued-actions' }, sendBtn, sendNowBtn, cancelBtn, deleteBtn),
    )
    requestAnimationFrame(() => {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    })
    return wrap
  }

  function createQueuedItem(msg: Message): HTMLElement {
    const editing = editingMessageId === msg.id
    const item = el('div', {
      class: editing ? 'msg msg-user msg-queued msg-editing' : 'msg msg-user msg-queued',
      'data-message-id': msg.id,
    })
    const body = el('div', { class: 'message-body' })
    body.append(el('span', { class: 'message-queued-badge' }, editing ? 'Editing' : 'Queued'))
    if (editing) {
      body.append(buildQueuedEditor(msg.id))
    } else {
      appendMessageContent(body, msg, api)
      body.append(buildQueuedActions(msg.id))
    }
    item.append(body)
    return item
  }

  function renderQueuedPanel(threadId: string): void {
    if (threadId !== store.getState().activeThreadId) return
    const thread = store.getState().threads.find((t) => t.id === threadId)
    const pending = thread?.pendingMessages ?? []
    // Drop stale edit state if the edited message is no longer queued.
    if (editingMessageId && !pending.some((p) => p.messageId === editingMessageId)) {
      stopEditing()
    }
    queuedHost.replaceChildren()
    if (!thread || pending.length === 0) {
      queuedHost.hidden = true
      return
    }
    const messagesById = new Map(thread.messages.map((m) => [m.id, m]))
    for (const item of pending) {
      const msg = messagesById.get(item.messageId)
      if (!msg || msg.role !== 'user') continue
      queuedHost.append(createQueuedItem(msg))
    }
    queuedHost.hidden = queuedHost.childElementCount === 0
  }

  let pinnedToBottom = true
  let lastScrollTop = 0
  // The scrollTop our own scrollToBottom() last landed on. Used to tell our
  // programmatic scroll echo apart from a genuine user scroll, so a user scroll
  // (especially scrolling up mid-stream) is never mistaken for autoscroll (#468).
  let lastProgrammaticScrollTop = -1
  let userScrolledUpAt = 0

  function isNearBottom(): boolean {
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight
    return distance <= SCROLL_PIN_THRESHOLD_PX
  }

  function shouldAutoScroll(): boolean {
    return pinnedToBottom && Date.now() - userScrolledUpAt > USER_SCROLL_UP_DEBOUNCE_MS
  }

  function updateScrollButton(): void {
    scrollToBottomBtn.hidden = isNearBottom()
  }

  function handleUserScroll(): void {
    const scrollTop = list.scrollTop
    // Ignore the scroll event emitted by our own scrollToBottom(): it lands on
    // an exact, known position. Everything else is a real user scroll. Matching
    // the position (rather than suppressing for a time window) means a user
    // scroll-up during rapid autoscroll is never dropped, so the view reliably
    // unpins instead of being yanked back to the bottom (#468). Consume the echo
    // once so a later user scroll to the same pixel isn't swallowed too.
    if (scrollTop === lastProgrammaticScrollTop) {
      lastProgrammaticScrollTop = -1
      lastScrollTop = scrollTop
      return
    }
    if (scrollTop < lastScrollTop - 1) {
      userScrolledUpAt = Date.now()
      pinnedToBottom = false
    } else if (isNearBottom()) {
      pinnedToBottom = true
    }
    lastScrollTop = scrollTop
    updateScrollButton()
  }

  list.addEventListener('scroll', handleUserScroll, { passive: true })
  list.addEventListener(
    'wheel',
    (event) => {
      if (event.deltaY < 0) {
        userScrolledUpAt = Date.now()
        pinnedToBottom = false
        updateScrollButton()
      }
    },
    { passive: true },
  )
  scrollToBottomBtn.addEventListener('click', () => {
    userScrolledUpAt = 0
    scrollToBottom(true)
  })

  function setActivity(label: string | null): void {
    if (!label) {
      activityBar.hidden = true
      return
    }
    activityLabel.textContent = label
    // Only advertise the row as clickable once there's a reasoning trail to open.
    activityBar.classList.toggle(
      'agent-activity-clickable',
      !!list.querySelector('.msg-assistant .message-reasoning'),
    )
    activityBar.hidden = false
    scrollToBottom()
  }

  function syncFromStore(): void {
    const tid = store.getState().activeThreadId
    if (!tid) {
      setActivity(null)
      return
    }
    const thread = getThreadById(store, tid)
    // Writing state lives in the agent controller; agent_activity events carry the label.
    setActivity(agentActivityLabel(thread, false))
  }

  // Single place that performs our own scroll bookkeeping. Assigns scrollTop,
  // reads back the actual landed value (the browser may clamp it, e.g. when a
  // rebuild shrank scrollHeight), and records it. The programmatic-echo arming
  // is guarded on the position actually changing: when scrollTop doesn't move
  // (already at the requested position, common while pinned during streaming)
  // the browser fires NO scroll event, so handleUserScroll would never consume
  // lastProgrammaticScrollTop back to -1 and it would silently swallow the next
  // genuine user scroll landing on that pixel. Leaving it at -1 avoids that.
  function setScrollTopProgrammatically(top: number): void {
    const before = list.scrollTop
    list.scrollTop = top
    const landed = list.scrollTop
    lastScrollTop = landed
    if (landed !== before) {
      // Remember exactly where we landed so the resulting scroll event is
      // recognized as ours and not treated as a user scroll (see handleUserScroll).
      lastProgrammaticScrollTop = landed
    }
  }

  function scrollToBottom(force = false): void {
    if (!force && !shouldAutoScroll()) return
    // The scrollable element is the messages list, not the mount root.
    setScrollTopProgrammatically(list.scrollHeight)
    if (force) {
      userScrolledUpAt = 0
      pinnedToBottom = true
    }
    updateScrollButton()
  }

  function renderToolCards(
    msgEl: HTMLElement,
    toolCalls: ToolCall[],
    commandSummary?: string,
  ): void {
    const userExpandedGroups = new Set<string>()
    msgEl.querySelectorAll('.tool-card-group[open]').forEach((node) => {
      const el = node as HTMLElement
      const key = el.dataset['groupKey']
      // Running groups are auto-expanded; don't treat that as a user preference.
      if (key && el.dataset['status'] !== 'running') userExpandedGroups.add(key)
    })

    const userExpandedTools = new Set<string>()
    msgEl
      .querySelectorAll(
        '.tool-card[data-tool-id][open], .tool-group-item[open], .tool-card-subagent[open]',
      )
      .forEach((node) => {
        const id = (node as HTMLElement).dataset['toolId']
        if (id) userExpandedTools.add(id)
      })

    const items = buildToolCallDisplayItems(toolCalls)
    for (const item of items) {
      // LLM-only rollup: a small-model summary, when ready, replaces the generic
      // "Running commands" header for the shell group.
      if (item.type === 'group' && item.key === 'shell' && commandSummary) {
        item.label = commandSummary
      }
    }

    // Index the cards already in the DOM by their stable key so unchanged ones
    // are reused wholesale instead of torn down and rebuilt on every tick — the
    // former remove-all/rebuild-all churned every card's markdown and copy
    // buttons while a subagent streamed (#728).
    const existing = new Map<string, HTMLElement>()
    for (const node of Array.from(msgEl.children) as HTMLElement[]) {
      if (!node.classList.contains('tool-card')) continue
      const key = toolCardKeys.get(node)
      if (key) existing.set(key, node)
    }

    const desired: HTMLElement[] = []
    for (const item of items) {
      const key = toolCardKey(item)
      const sig = toolCardSignature(item)
      let card = existing.get(key) ?? null
      if (card) existing.delete(key)

      if (card && toolCardSignatures.get(card) === sig) {
        // Nothing this card renders has changed — leave its DOM (and any
        // streaming renderers / copy buttons) exactly as they are.
      } else if (
        card &&
        item.type === 'individual' &&
        item.toolCall.subagent &&
        card.classList.contains('tool-card-subagent')
      ) {
        // Running subagent: update in place so the timeline's streaming message
        // keeps the same element (and renderer) across ticks.
        populateSubagentCard(card, item.toolCall, item.label, api)
        toolCardSignatures.set(card, sig)
      } else {
        card = createToolCard(item, api)
        toolCardKeys.set(card, key)
        toolCardSignatures.set(card, sig)
      }

      if (item.type === 'group') {
        const status = aggregateToolStatus(item.toolCalls)
        ;(card as HTMLDetailsElement).open = status === 'running' || userExpandedGroups.has(item.key)
      } else {
        const tc = item.toolCall
        const running = tc.status === 'running' || tc.subagent?.status === 'running'
        ;(card as HTMLDetailsElement).open = running || userExpandedTools.has(tc.id)
      }
      desired.push(card)
    }

    // Drop cards whose tool calls are gone (e.g. an individual card absorbed
    // into a newly-formed group).
    existing.forEach((node) => {
      node.remove()
    })
    // Re-append in order: moves reused nodes to the correct position and inserts
    // freshly built ones. Tool cards are the trailing children of the message.
    for (const node of desired) msgEl.append(node)
  }

  function appendMessageEl(threadId: string, msgId: string): void {
    if (threadId !== store.getState().activeThreadId) return
    const thread = getThreadById(store, threadId)
    const msg = thread?.messages.find((m) => m.id === msgId)
    if (!msg) return

    // Queued user follow-ups render in the pinned panel, not inline.
    if (msg.role === 'user' && thread && queuedMessageIds(thread).has(msgId)) {
      renderQueuedPanel(threadId)
      return
    }

    const msgEl = el('div', { class: `msg msg-${msg.role}`, 'data-message-id': msgId })
    const body = el('div', { class: 'message-body' })
    appendMessageContent(body, msg, api)
    msgEl.append(body)

    // Copy only when there is reply text — tool-only bubbles stay compact.
    if (msg.role === 'assistant' && msg.content.trim()) {
      attachCopyButton(body, msgId, store)
    }

    // Keep the trailing comparison card (if any) last in the transcript: a new
    // message belongs above a comparison produced for an earlier turn. Review
    // cards are anchored inline after their own message (see renderMessageReview)
    // and stay put — a new message naturally lands after them.
    const trailingCard = list.querySelector('[data-comparison-card]')
    if (trailingCard) list.insertBefore(msgEl, trailingCard)
    else list.append(msgEl)
    hydrateRemoteArtifactImages(list, api)
    // Re-render any tool cards this message already carries (restored threads).
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- persisted/legacy messages may predate the toolCalls field
    renderToolCards(msgEl, msg.toolCalls ?? [], msg.commandSummary)
    // Restore an inline review this message already carries (rebuilt threads).
    if (msg.review) renderMessageReview(threadId, msgId)
    scrollToBottom(msg.role === 'user')
  }

  function syncTodoPanel(): void {
    todoHost.replaceChildren()
    const thread = getActiveThread(store)
    if (thread?.todos?.length) {
      todoHost.append(createTodoListEl(thread.todos, { compact: true }))
    }
  }

  function renderMessageReview(threadId: string, messageId: string): void {
    if (threadId !== store.getState().activeThreadId) return
    // Each review is anchored to the message that concluded its turn and renders
    // as that message's next sibling, so reviews join the transcript inline (in
    // position, one per turn) rather than as a single trailing card. Drop any
    // prior card for this message first (status transitions, retries, rebuilds).
    list.querySelector(`[data-review-card][data-review-for="${messageId}"]`)?.remove()
    const msg = getActiveThread(store)?.messages.find((m) => m.id === messageId)
    const msgEl = list.querySelector(`[data-message-id="${messageId}"]`)
    if (!msg?.review || !msgEl) return
    const card = createReviewCardEl(msg.review, api, () => {
      retryReview(store, api, threadId, messageId)
    })
    card.setAttribute('data-review-card', '')
    card.setAttribute('data-review-for', messageId)
    msgEl.after(card)
  }

  function syncComparisonPanel(): void {
    // Render the comparison card inline as the last child of the message list,
    // after the review card, so it joins the transcript flow. Replace on sync.
    list.querySelector('[data-comparison-card]')?.remove()
    const thread = getActiveThread(store)
    if (thread?.comparison) {
      const threadId = thread.id
      const card = createComparisonCardEl(thread.comparison, api, () => {
        retryComparison(store, api, threadId)
      })
      card.setAttribute('data-comparison-card', '')
      list.append(card)
    }
  }

  function rebuildForThread(): void {
    pinnedToBottom = true
    userScrolledUpAt = 0
    lastScrollTop = 0
    clear(list)
    const thread = getActiveThread(store)
    if (thread) {
      thread.messages.forEach((m) => {
        appendMessageEl(thread.id, m.id)
      })
    }
    syncTodoPanel()
    // Inline review cards are rendered per message by appendMessageEl above.
    syncComparisonPanel()
    if (thread) {
      renderQueuedPanel(thread.id)
    } else {
      // No active thread: hide the queued panel (matches the prior call, which
      // passed a null active id and fell through to the empty-state branch).
      queuedHost.replaceChildren()
      queuedHost.hidden = true
    }
    updateScrollButton()
  }

  function refreshToolCards(msgId: string): void {
    const msg = store
      .getState()
      .threads.flatMap((t) => t.messages)
      .find((m) => m.id === msgId)
    const msgEl = list.querySelector(`[data-message-id="${msgId}"]`)
    if (!msg || !msgEl) return
    // renderToolCards tears down and rebuilds every tool card, which destroys the
    // browser's scroll anchor and can jump a user who has scrolled up to read.
    // Preserve their position across the rebuild; only autoscroll when the view
    // is still pinned to the bottom (#468).
    const prevScrollTop = list.scrollTop
    const wasPinned = pinnedToBottom
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- persisted/legacy messages may predate the toolCalls field
    renderToolCards(msgEl as HTMLElement, msg.toolCalls ?? [], msg.commandSummary)
    if (wasPinned) {
      scrollToBottom()
    } else if (list.scrollTop !== prevScrollTop) {
      // Restore the user's position; setScrollTopProgrammatically reads back the
      // actual landed value (the rebuild may have shrunk scrollHeight and the
      // browser clamps the requested scrollTop) so the echo matches reality.
      setScrollTopProgrammatically(prevScrollTop)
    }
  }

  const unsubs = [
    store.on('message_added', (tid, mid) => {
      appendMessageEl(tid, mid)
    }),
    store.on('message_queued', (tid) => {
      renderQueuedPanel(tid)
    }),
    store.on('message_token', (mid) => {
      const thread = getActiveThread(store)
      const msg = thread?.messages.find((m) => m.id === mid)
      const textEl = list.querySelector(`[data-message-id="${mid}"] .message-text`)
      if (textEl && msg?.role === 'assistant') {
        setAssistantMarkdown(textEl as HTMLElement, msg.content, true, api)
        scrollToBottom()
      }
    }),
    store.on('message_reasoning', (mid) => {
      const thread = getActiveThread(store)
      const msg = thread?.messages.find((m) => m.id === mid)
      const msgEl = list.querySelector(`[data-message-id="${mid}"]`)
      if (msg?.role === 'assistant' && msgEl) {
        syncReasoningEl(msgEl as HTMLElement, msg)
        activityBar.classList.add('agent-activity-clickable')
        scrollToBottom()
      }
    }),
    store.on('message_done', (mid) => {
      const msgEl = list.querySelector(`[data-message-id="${mid}"]`)
      const textEl = msgEl?.querySelector('.message-text')
      const thread = getActiveThread(store)
      const msg = thread?.messages.find((m) => m.id === mid)
      if (textEl && msg?.role === 'assistant') {
        setAssistantMarkdown(textEl as HTMLElement, msg.content, false, api)
        hydrateRemoteArtifactImages(list, api)
      }
      if (msg?.role === 'assistant' && msg.content.trim()) {
        const body = msgEl?.querySelector('.message-body')
        if (body && !body.querySelector('.msg-copy'))
          attachCopyButton(body as HTMLElement, mid, store)
        // Answer is in: tuck the reasoning trail away unless the user opened it.
        const reasoning = body?.querySelector('.message-reasoning') as HTMLDetailsElement | null
        if (reasoning && !reasoning.dataset['userToggled']) reasoning.open = false
      }
    }),
    store.on('tool_call_started', (mid) => {
      refreshToolCards(mid)
    }),
    store.on('tool_call_updated', (mid) => {
      refreshToolCards(mid)
    }),
    store.on('threads_changed', () => {
      rebuildForThread()
      syncFromStore()
    }),
    store.on('todos_changed', () => {
      syncTodoPanel()
      syncFromStore()
      scrollToBottom()
    }),
    store.on('review_changed', (tid, mid) => {
      renderMessageReview(tid, mid)
      scrollToBottom()
    }),
    store.on('comparison_changed', () => {
      syncComparisonPanel()
      scrollToBottom()
    }),
    store.on('thread_status_changed', (tid, status) => {
      if (tid !== store.getState().activeThreadId) return
      if (status !== 'running') setActivity(null)
    }),
    store.on('agent_activity', (tid, label) => {
      if (tid !== store.getState().activeThreadId) return
      setActivity(label)
    }),
  ]

  const unbindFileLinks = bindFileReferenceClicks(root, store, api)
  const unbindWorkspaceLinks = bindWorkspaceLinkClicks(root, store, api)
  const unbindBrowserLinks = bindBrowserLinkClicks(root, store, api)
  rebuildForThread()
  syncFromStore()
  return () => {
    unbindFileLinks()
    unbindWorkspaceLinks()
    unbindBrowserLinks()
    unsubs.forEach((u) => {
      u()
    })
  }
}

function attachCopyButton(body: HTMLElement, msgId: string, store: AppStore): void {
  const copyBtn = el('button', { class: 'msg-copy', 'aria-label': 'Copy response' }, 'Copy')
  copyBtn.addEventListener('click', () => {
    const current = store
      .getState()
      .threads.flatMap((t) => t.messages)
      .find((m) => m.id === msgId)
    void navigator.clipboard.writeText(current?.content ?? '').then(() => {
      copyBtn.textContent = 'Copied'
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1200)
    })
  })
  body.append(copyBtn)
}

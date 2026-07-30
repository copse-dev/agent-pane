import { el, clear } from '../dom/helpers.ts'
import { reasoningActivityIcon } from '../dom/reasoning-activity-icon.ts'
import {
  arrowDownIcon,
  checkIcon,
  closeIcon,
  moreHorizontalIcon,
  warningIcon,
  zapIcon,
} from '../dom/icons.ts'
import {
  getHookCardStatusLabel,
  getHookCardTitle,
  hookEventLabel,
  isHookCardBlocking,
  type HookCard,
  type HookCardStatus,
} from '@shared/hooks/hook-card.ts'
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
import type {
  Message,
  SubagentSession,
  Thread,
  ToolCall,
  TranscriptAttachment,
} from '@shared/types'
import {
  formatPrimaryChatModelLabel,
  shouldShowPrimaryChatModelLabels,
} from '@shared/threads/message-model.ts'
import { attachmentIcon } from '../dom/attachment-icons.ts'
import { attachImageExpand } from '../attachments/image-expand.ts'
import { attachVideoExpand } from '../attachments/video-expand.ts'
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
import { createPackPanelEl } from './pack-panel.ts'
import { todosToPanelListData, type PanelListData } from '@copse/agent/packs/pack-panel.ts'
import { TODOS_PACK_ID, TODOS_PANEL_CONTRIBUTION_ID } from '@copse/agent/packs/todos-pack.ts'
import { createReviewCardEl } from './review-panel.ts'
import { createComparisonCardEl } from './comparison-panel.ts'
import {
  dismissComparison,
  retryComparison,
  retryReview,
} from '../controller/retry-review-comparison.ts'
import { renderToolArgs } from './tool-args-format.ts'
import {
  drainMessageQueue,
  isHeldMessage,
  queuedMessageIds,
  queuedPayloadText,
  releaseHeldMessage,
  removeQueuedMessage,
  sendQueuedMessageNow,
  updateQueuedMessageText,
} from '../controller/message-queue.ts'
import { forkThread } from '../controller/fork-thread.ts'
import { lastResendableMessage, resendLastMessage } from '../controller/resend-message.ts'
import { showToast } from './toast.ts'
import type { QueuedUserMessage } from '@shared/types'

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

function createIndividualToolCard(tc: ToolCall, label: string, api: ApiClient): HTMLDetailsElement {
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

/** Turn composer single newlines into CommonMark hard breaks; skip fenced code. */
function userPromptMarkdown(source: string): string {
  const parts: string[] = []
  const fenceRe = /```[\s\S]*?```/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = fenceRe.exec(source)) !== null) {
    parts.push(hardBreakSingleNewlines(source.slice(last, match.index)))
    parts.push(match[0])
    last = match.index + match[0].length
  }
  parts.push(hardBreakSingleNewlines(source.slice(last)))
  return parts.join('')
}

function hardBreakSingleNewlines(text: string): string {
  return text.replace(/(?<!\n)\n(?!\n)/g, '  \n')
}

/** Render a settled user prompt: markdown like assistant replies, without post-processing hooks. */
function setUserMarkdown(el: HTMLElement, content: string): void {
  if (!content) {
    el.replaceChildren()
    return
  }
  el.innerHTML = renderMarkdown(userPromptMarkdown(content))
  attachCodeBlockCopyButtons(el)
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
  badge.textContent = isLocal ? `${session.model.slice('lmstudio:'.length)} · local` : session.model
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
  for (const node of Array.from(timeline.children)) {
    if (!(node instanceof HTMLElement)) continue
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
        // Rebuilding recreates every inner tool collapsed; carry over the ids
        // the user expanded so their disclosure survives the tick.
        const openInner = new Set<string>()
        wrap?.querySelectorAll<HTMLElement>('.subagent-inner-tool[open]').forEach((node) => {
          const id = node.dataset['toolId']
          if (id) openInner.add(id)
        })
        const fresh = el('div', { class: 'subagent-inner-tools' })
        fresh.dataset['timelineKey'] = key
        for (const inner of innerToolCalls) {
          const entry = createInnerToolCard(inner)
          if (openInner.has(inner.id)) entry.setAttribute('open', '')
          fresh.append(entry)
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
  // Move/insert only when order actually changed — a no-op append still
  // remove+reinserts the node and can flash layout on every streaming tick.
  for (let i = 0; i < desired.length; i++) {
    const node = desired[i]
    if (!node) continue
    if (timeline.children[i] !== node) timeline.insertBefore(node, timeline.children[i] ?? null)
  }
}

// Signature of the non-timeline chrome on a subagent card (header / badge /
// args / settled preview+result). Timeline text changes every streaming tick;
// chrome usually does not — rebuilding it via `clear(card)` was the remaining
// #728 flicker after the timeline itself started reconciling in place.
const subagentCardChromeSig = new WeakMap<HTMLElement, string>()

function subagentChromeSignature(
  tc: ToolCall,
  session: SubagentSession,
  label: string,
  status: ToolCall['status'],
): string {
  const preview = status !== 'running' ? (session.summary ?? tc.result ?? '') : ''
  const result = status === 'done' ? (tc.result ?? '') : ''
  return JSON.stringify({
    label,
    status,
    model: session.model ?? null,
    localFallback: session.localFallback === true,
    args: tc.args,
    preview,
    result,
  })
}

// Fill (or refresh in place) a subagent card. The timeline is always reconciled
// without teardown. Chrome (header / badge / args / settled preview+result) is
// only rebuilt when its signature changes — never on every streamed token.
function populateSubagentCard(
  card: HTMLElement,
  tc: ToolCall,
  label: string,
  api: ApiClient,
): void {
  const session = tc.subagent
  if (!session) throw new Error('populateSubagentCard requires tc.subagent')
  const status = subagentCardStatus(tc, session)
  card.dataset['status'] = status

  const timeline =
    Array.from(card.children).find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.classList.contains('subagent-timeline'),
    ) ?? el('div', { class: 'subagent-timeline' })
  syncSubagentTimeline(timeline, session, status, api)

  const chromeSig = subagentChromeSignature(tc, session, label, status)
  if (subagentCardChromeSig.get(card) === chromeSig && timeline.isConnected) {
    // Streaming tick: timeline already updated; leave chrome nodes alone.
    return
  }

  // Status / label / model / args / settled preview changed — rebuild chrome
  // around the preserved timeline node (do not clear the timeline itself).
  for (const node of Array.from(card.children)) {
    if (node !== timeline) node.remove()
  }

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

  subagentCardChromeSig.set(card, chromeSig)
}

function createSubagentToolCard(tc: ToolCall, label: string, api: ApiClient): HTMLDetailsElement {
  const card = el('details', {
    class: 'tool-card tool-card-subagent',
    'data-tool-id': tc.id,
  })
  populateSubagentCard(card, tc, label, api)
  return card
}

function createGroupToolCard(
  item: Extract<ToolCallDisplayItem, { type: 'group' }>,
): HTMLDetailsElement {
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

/**
 * One quiet summary row for a turn's tooling (`Used 12 tools` / `Read files`).
 * Nested cards stay available on expand but don't each paint their own chrome.
 */
function createRollupToolCard(
  item: Extract<ToolCallDisplayItem, { type: 'rollup' }>,
  api: ApiClient,
): HTMLDetailsElement {
  const status = aggregateToolStatus(item.toolCalls)
  const card = el('details', {
    class: 'tool-card tool-card-rollup',
    'data-rollup-key': item.key,
    'data-status': status,
    'data-tool-count': String(item.toolCalls.length),
  })
  const count =
    item.children.length === 1 && item.children[0]?.type === 'group'
      ? item.toolCalls.length
      : undefined
  const body = el('div', { class: 'tool-rollup-body' })
  for (const child of item.children) {
    body.append(createToolCard(child, api))
  }
  card.append(createToolHeader(item.label, status, 'tool-card-header', count), body)
  return card
}

function createToolCard(item: ToolCallDisplayItem, api: ApiClient): HTMLDetailsElement {
  if (item.type === 'rollup') return createRollupToolCard(item, api)
  if (item.type === 'group') return createGroupToolCard(item)
  return createIndividualToolCard(item.toolCall, item.label, api)
}

// Stable identity for a tool card across `tool_call_updated` ticks: group cards
// key on the group bucket, individual cards on the tool-call id. Held in
// WeakMaps (rather than DOM attributes) so large signatures don't bloat the DOM.
const toolCardKeys = new WeakMap<HTMLElement, string>()
const toolCardSignatures = new WeakMap<HTMLElement, string>()

function toolCardKey(item: ToolCallDisplayItem): string {
  if (item.type === 'rollup') return `r:${item.key}`
  if (item.type === 'group') return `g:${item.key}`
  return `t:${item.toolCall.id}`
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
    const img = el('img', {
      class: 'message-image',
      src: dataUrl,
      alt: 'Attached image',
      loading: 'lazy',
    })
    attachImageExpand(img, 'Attached image')
    wrap.append(img)
  }
  return wrap
}

// --- Hook cards (decision 10) ------------------------------------------------
// Hook executions / deny-ask decisions / halts render as a distinct tool-call
// family: right-aligned, blue, but clearly *not* a user message. Built purely
// from the derived {@link HookCard} model (folded from the spine `hook_run`
// records, or delivered live via the `hook_run` chunk), so history renders them
// without any live hook registration (decision 17).

function hookCardStatusIcon(status: HookCardStatus): SVGSVGElement {
  if (status === 'ask') return warningIcon('ui-icon ui-icon-sm')
  if (isHookCardBlocking(status)) return closeIcon('ui-icon ui-icon-sm')
  return checkIcon('ui-icon ui-icon-sm')
}

/** Compact facts about what a hook run did — shown under the header when useful. */
function hookCardDetailLines(card: HookCard): string[] {
  const lines: string[] = []
  lines.push(`Hook: ${card.hookId}`)
  if (card.executor === 'command' && card.exitCode !== undefined && card.exitCode !== null) {
    lines.push(`Exit code: ${String(card.exitCode)}`)
  }
  if (card.exitCode === null) lines.push('Process killed (timeout / output cap)')
  if (card.durationMs > 0) lines.push(`Duration: ${String(card.durationMs)}ms`)
  if (card.updatedInput) lines.push('Rewrote the tool input')
  if (card.injectContextChars !== undefined && card.injectContextChars > 0) {
    lines.push(`Injected ${String(card.injectContextChars)} chars of context`)
  }
  if (card.queuedMessageChars !== undefined && card.queuedMessageChars > 0) {
    lines.push(`Queued a ${String(card.queuedMessageChars)}-char follow-up`)
  }
  if (card.stopReason) lines.push(`Reason: ${card.stopReason}`)
  if (card.sandboxBlocked) lines.push('Blocked by the project sandbox')
  if (!card.parseOk) lines.push('Output did not parse as a hook response')
  if (card.error) lines.push(`Error: ${card.error}`)
  return lines
}

function createHookCard(card: HookCard): HTMLElement {
  const cardEl = el('details', {
    class: 'hook-card',
    'data-hook-id': card.hookId,
    'data-hook-event': card.event,
    'data-hook-kind': card.kind,
    'data-status': card.status,
  })
  const header = el(
    'summary',
    { class: 'hook-card-header' },
    zapIcon('ui-icon ui-icon-sm hook-card-icon'),
    el('span', { class: 'hook-name' }, getHookCardTitle(card)),
    el('span', { class: 'hook-card-status' }, getHookCardStatusLabel(card)),
    el(
      'span',
      { class: 'hook-status-icon', 'aria-label': card.status },
      hookCardStatusIcon(card.status),
    ),
  )
  const detail = el('div', { class: 'hook-card-detail' })
  for (const line of hookCardDetailLines(card)) {
    detail.append(el('div', { class: 'hook-card-detail-line' }, line))
  }
  cardEl.append(header, detail)
  return cardEl
}

/**
 * Attribution marker on a hook-originated turn (decision 10): the message role
 * stays `user`, but this shows the hook + event that started the follow-up so it
 * never reads as something the human typed. `editedByUser` notes a human touched
 * the text before it dispatched — authorship stays honest.
 */
function buildHookOriginMarker(
  origin: { hookId: string; event: string },
  editedByUser: boolean,
): HTMLElement {
  const label = `Hook · ${origin.hookId} (${hookEventLabel(origin.event)})`
  const marker = el(
    'div',
    { class: 'msg-hook-origin-marker' },
    zapIcon('ui-icon ui-icon-sm hook-card-icon'),
    el('span', { class: 'msg-hook-origin-label' }, label),
  )
  if (editedByUser) {
    marker.append(el('span', { class: 'msg-hook-origin-edited' }, 'edited'))
  }
  return marker
}

/**
 * The most severe status across a turn's hook runs, so the collapsed summary
 * never buries a deny / halt / error behind a quiet "ran" count. Blocking wins
 * outright; an ask (or stale-halt) beats a plain ok/allow.
 */
function hookGroupStatus(cards: HookCard[]): HookCardStatus {
  let worst: HookCardStatus = 'ok'
  for (const card of cards) {
    if (isHookCardBlocking(card.status)) return card.status
    if (card.status === 'ask' || card.status === 'halt-suppressed') worst = card.status
  }
  return worst
}

/** Summary line for the collapsed group, e.g. `12 ran` or `12 ran · 1 blocked`. */
function hookGroupSummaryLabel(cards: HookCard[]): string {
  const ran = `${String(cards.length)} ran`
  const blocking = cards.filter((c) => isHookCardBlocking(c.status)).length
  if (blocking > 0) return `${ran} · ${String(blocking)} blocked`
  const asked = cards.filter((c) => c.status === 'ask').length
  if (asked > 0) return `${ran} · ${String(asked)} asked`
  return ran
}

/**
 * Right-aligned host holding a turn's hook cards (decision 10). The cards are
 * machine-side provenance — handy on demand, noise inline — so they collapse
 * into a single summary row (`Hooks · 12 ran`) that expands to reveal each card
 * in fire order. The summary carries the worst status so a blocking verdict is
 * still visible while collapsed.
 */
function createHookCardHost(messageId: string, cards: HookCard[]): HTMLElement {
  const host = el('div', {
    class: 'hook-card-host',
    'data-hook-cards-for': messageId,
  })
  const status = hookGroupStatus(cards)
  const group = el('details', {
    class: 'hook-card-group',
    'data-status': status,
    'data-hook-count': String(cards.length),
  })
  const header = el(
    'summary',
    { class: 'hook-card-header' },
    zapIcon('ui-icon ui-icon-sm hook-card-icon'),
    el('span', { class: 'hook-name' }, cards.length === 1 ? 'Hook' : 'Hooks'),
    el('span', { class: 'hook-card-status' }, hookGroupSummaryLabel(cards)),
    el('span', { class: 'hook-status-icon', 'aria-label': status }, hookCardStatusIcon(status)),
  )
  const body = el('div', { class: 'hook-card-group-body' })
  for (const card of cards) body.append(createHookCard(card))
  group.append(header, body)
  host.append(group)
  return host
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
  opts?: { nestReasoningInTools?: boolean },
): void {
  if (msg.role === 'user' && msg.images?.length) {
    body.append(createMessageImages(msg.images))
  }
  // Reasoning usually sits above the answer. When this segment also has tools,
  // it nests inside the tool rollup instead — collapsed view is just the italic
  // summary heading. History renders as settled ("Reasoned").
  if (msg.role === 'assistant' && msg.reasoning && opts?.nestReasoningInTools !== true) {
    body.append(buildReasoningEl(msg.reasoning, !msg.content.trim(), false))
  }
  const textEl = el('div', { class: 'message-text streaming-markdown' })
  if (msg.role === 'assistant' && msg.content) {
    setAssistantMarkdown(textEl, msg.content, false, api)
  } else if (msg.role === 'user' && msg.attachments?.length) {
    renderUserTranscript(textEl, msg.content, msg.attachments, api)
  } else if (msg.role === 'user') {
    setUserMarkdown(textEl, msg.content)
  } else {
    textEl.textContent = msg.content
  }
  body.append(textEl)
}

/** True when reasoning should fold into the tool rollup for this message. */
function shouldNestReasoningInTools(toolCalls: ToolCall[]): boolean {
  return toolCalls.some((tc) => !tc.subagent)
}

/** Progressive while this bubble is the live step; past once settled. */
function reasoningDisclosureTitle(live: boolean): string {
  return live ? 'Reasoning…' : 'Reasoned'
}

function setReasoningDisclosureTitle(details: HTMLDetailsElement, live: boolean): void {
  const title = details.querySelector('.message-reasoning-title')
  if (title) title.textContent = reasoningDisclosureTitle(live)
  details.classList.toggle('message-reasoning-live', live)
}

/** Live = running thread, this is the latest bubble, and no answer text yet. */
function isReasoningDisclosureLive(
  thread: Thread | undefined,
  msg: { id: string; content: string },
): boolean {
  if (!thread || thread.status !== 'running') return false
  if (msg.content.trim()) return false
  return thread.messages[thread.messages.length - 1]?.id === msg.id
}

/**
 * A transcript chip: an outline icon + its (clipped) label. Display-only except
 * for a video, which becomes a button that plays the recording — the file is on
 * disk and the person who attached it otherwise has no way to see what they
 * sent, since the video deliberately never becomes model content.
 */
function transcriptChip(
  attachment: Pick<TranscriptAttachment, 'kind' | 'label' | 'path'>,
  api: ApiClient,
): HTMLElement {
  const { kind, label } = attachment
  const chip = el('span', { class: `transcript-attachment-chip transcript-attachment-${kind}` })
  chip.append(
    attachmentIcon(kind, 'transcript-attachment-icon'),
    el('span', { class: 'transcript-attachment-label' }, label),
  )
  if (kind === 'video' && attachment.path) {
    attachVideoExpand(chip, api, attachment.path, label)
  }
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
  api: ApiClient,
): void {
  const pastes = attachments.filter((a) => a.kind === 'paste')
  const trailing = attachments.filter((a) => a.kind !== 'paste')

  const parts = content.split(CHIP_CHAR)
  parts.forEach((part, i) => {
    if (part) host.append(document.createTextNode(part))
    if (i < parts.length - 1) {
      host.append(transcriptChip({ kind: 'paste', label: pastes[i]?.label ?? 'Pasted text' }, api))
    }
  })

  if (trailing.length) {
    const row = el('div', { class: 'transcript-attachment-row' })
    for (const a of trailing) row.append(transcriptChip(a, api))
    host.append(row)
  }
}

/**
 * A `<details>` disclosure holding the model's reasoning trail. `open` reflects
 * whether the answer is still pending so live reasoning is visible by default but
 * past turns stay collapsed. Title tense follows status (`Reasoning` / `Reasoned`).
 * A click on the summary marks it user-controlled so later streaming updates
 * never fight the user's choice.
 */
function buildReasoningEl(reasoning: string, open: boolean, live: boolean): HTMLDetailsElement {
  const details = el('details', {
    class: `message-reasoning${live ? ' message-reasoning-live' : ''}`,
    open,
  })
  const summary = el(
    'summary',
    { class: 'message-reasoning-summary' },
    el(
      'span',
      { class: 'message-reasoning-icon', 'aria-hidden': 'true' },
      reasoningActivityIcon('reasoning-activity-icon'),
    ),
    el('span', { class: 'message-reasoning-title' }, reasoningDisclosureTitle(live)),
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
 * open/closed choice and avoid rebuilding the DOM each token. Prefers a nested
 * home inside the tool rollup when tools have already arrived on this message.
 */
function syncReasoningEl(
  msgEl: HTMLElement,
  msg: { content: string; reasoning?: string },
  live: boolean,
): void {
  const body = msgEl.querySelector('.message-body')
  if (!body) return
  const rollupBody = msgEl.querySelector<HTMLElement>(
    ':scope > .tool-card-rollup > .tool-rollup-body',
  )
  const host = rollupBody ?? body
  let details = msgEl.querySelector<HTMLDetailsElement>('.message-reasoning')
  if (!msg.reasoning) {
    details?.remove()
    return
  }
  if (!details) {
    details = buildReasoningEl(msg.reasoning, true, live)
    host.prepend(details)
  } else {
    if (details.parentElement !== host) host.prepend(details)
    const textEl = details.querySelector<HTMLElement>('.message-reasoning-text')
    if (textEl) renderReasoningText(textEl, msg.reasoning)
    setReasoningDisclosureTitle(details, live)
  }
  // Keep the trail open while it is still live, unless the user collapsed it.
  if (!details.dataset['userToggled'] && !msg.content.trim()) details.open = true
}

/**
 * Keep reasoning nested at the top of a turn rollup (and strip any leftover
 * body-level trail) so the collapsed chrome is only the italic summary.
 */
function syncNestedRollupReasoning(
  card: HTMLElement,
  msgEl: HTMLElement,
  reasoning: string | undefined,
  live: boolean,
): void {
  const rollupBody = card.querySelector<HTMLElement>(':scope > .tool-rollup-body')
  if (!rollupBody) return
  const body = msgEl.querySelector('.message-body')
  let details =
    rollupBody.querySelector<HTMLDetailsElement>(':scope > .message-reasoning') ??
    msgEl.querySelector<HTMLDetailsElement>('.message-reasoning')
  if (!reasoning?.trim()) {
    details?.remove()
    return
  }
  if (!details) {
    details = buildReasoningEl(reasoning, true, live)
  } else {
    const textEl = details.querySelector<HTMLElement>('.message-reasoning-text')
    if (textEl) renderReasoningText(textEl, reasoning)
    setReasoningDisclosureTitle(details, live)
  }
  if (details.parentElement !== rollupBody) rollupBody.prepend(details)
  // Orphaned body-level trail (streamed before tools arrived) is the same node
  // after prepend — also drop any duplicate left behind.
  body?.querySelectorAll<HTMLElement>(':scope > .message-reasoning').forEach((node) => {
    if (node !== details) node.remove()
  })
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
  activityBar.append(reasoningActivityIcon('reasoning-activity-icon'), activityLabel)
  // Non-reasoning activity can still reopen the latest trail (for example while
  // the answer is being written). During reasoning, the live disclosure itself
  // replaces this standalone row.
  activityBar.addEventListener('click', () => {
    const trails = list.querySelectorAll<HTMLDetailsElement>('.msg-assistant .message-reasoning')
    const details = trails[trails.length - 1]
    if (!details) return
    details.dataset['userToggled'] = '1'
    details.open = true
    details.scrollIntoView({ block: 'nearest' })
  })
  // Queued follow-ups live in a pinned panel below the scroll area so they stay
  // visible at the bottom of the screen instead of getting buried under the
  // streaming response inside the scrollable message list.
  const queuedHost = el('div', { class: 'conversation-queued', hidden: true })
  root.append(scrollArea, queuedHost)

  // Clicking a file edit's +/- counts reveals that file in the Changes panel.
  // Delegated here so the handler can reach the store; preventDefault stops the
  // surrounding <summary> from toggling its <details>.
  list.addEventListener('click', (e) => {
    const statsBtn =
      e.target instanceof Element ? e.target.closest<HTMLElement>('.tool-edit-stats') : null
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

  function releaseQueued(messageId: string): void {
    const threadId = store.getState().activeThreadId
    if (threadId) releaseHeldMessage(store, api, threadId, messageId)
  }

  // A held message (decisions 5 & 16) is skipped by the drain loop — it only
  // moves on an explicit human action. It gets a primary "Release" affordance
  // (submit + start a fresh turn tree) plus the usual edit / delete.
  function buildHeldActions(messageId: string): HTMLElement {
    const releaseBtn = el(
      'button',
      { class: 'queued-action queued-release', type: 'button' },
      'Release',
    )
    releaseBtn.addEventListener('click', () => {
      releaseQueued(messageId)
    })
    const editBtn = el('button', { class: 'queued-action queued-edit', type: 'button' }, 'Edit')
    editBtn.addEventListener('click', () => {
      startEditing(messageId)
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
      el('div', { class: 'message-queued-actions' }, releaseBtn, editBtn, deleteBtn),
    )
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

  function createQueuedItem(msg: Message, queued: QueuedUserMessage): HTMLElement {
    const editing = editingMessageId === msg.id
    const held = isHeldMessage(queued)
    const fromHook = queued.origin?.kind === 'hook'
    const classes = ['msg', 'msg-user', 'msg-queued']
    if (editing) classes.push('msg-editing')
    if (held) classes.push('msg-held')
    if (fromHook) classes.push('msg-hook-origin')
    const item = el('div', {
      class: classes.join(' '),
      'data-message-id': msg.id,
      ...(fromHook ? { 'data-hook-id': queued.origin?.hookId ?? '' } : {}),
    })
    const body = el('div', { class: 'message-body' })
    const badgeText = editing ? 'Editing' : held ? 'Held' : 'Queued'
    body.append(el('span', { class: 'message-queued-badge' }, badgeText))
    if (editing) {
      body.append(buildQueuedEditor(msg.id))
    } else {
      appendMessageContent(body, msg, api)
      body.append(held ? buildHeldActions(msg.id) : buildQueuedActions(msg.id))
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
      queuedHost.append(createQueuedItem(msg, item))
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
    // Once reasoning tokens exist, the disclosure title is the activity row.
    // Keep the standalone row for the initial wait before the first token, but
    // never show two live "Reasoning…" labels in the transcript.
    if (
      label.startsWith('Reasoning…') &&
      list.querySelector('.message-reasoning.message-reasoning-live')
    ) {
      activityBar.hidden = true
      scrollToBottom()
      return
    }
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

  function applyRollupSummaries(
    item: ToolCallDisplayItem,
    opts: { commandSummary?: string; toolSummary?: string },
  ): void {
    const { commandSummary, toolSummary } = opts
    // LLM polish for the turn rollup: replaces the canned `Used N tools` /
    // category label when ready. Failures stay visible on the collapsed line.
    if (item.type === 'rollup') {
      if (toolSummary?.trim()) {
        const failed = item.toolCalls.filter((tc) => tc.status === 'error').length
        item.label =
          failed > 0 ? `${toolSummary.trim()} · ${String(failed)} failed` : toolSummary.trim()
      }
      for (const child of item.children) applyRollupSummaries(child, opts)
      // Legacy shell-only path: when no toolSummary yet, a commandSummary can
      // still label a pure shell turn.
      if (
        !toolSummary?.trim() &&
        commandSummary &&
        item.children.length === 1 &&
        item.children[0]?.type === 'group' &&
        item.children[0].key === 'shell'
      ) {
        item.label = commandSummary
      }
      // When the polish lands on a single shell group, keep the nested header
      // in sync so expand doesn't revert to the canned "Ran commands".
      if (
        toolSummary?.trim() &&
        item.children.length === 1 &&
        item.children[0]?.type === 'group' &&
        item.children[0].key === 'shell'
      ) {
        item.children[0].label = toolSummary.trim()
      }
      return
    }
    // LLM-only rollup: a small-model summary, when ready, replaces the generic
    // "Ran commands" header for the shell group.
    if (item.type === 'group' && item.key === 'shell' && commandSummary) {
      item.label = commandSummary
    }
  }

  function applyToolCardOpenState(
    card: HTMLDetailsElement,
    item: ToolCallDisplayItem,
    userExpandedRollups: Set<string>,
    userExpandedGroups: Set<string>,
    userExpandedTools: Set<string>,
  ): void {
    if (item.type === 'rollup') {
      const status = aggregateToolStatus(item.toolCalls)
      card.open = status === 'running' || userExpandedRollups.has(item.key)
      const nestedCards = card.querySelectorAll<HTMLDetailsElement>(
        ':scope > .tool-rollup-body > .tool-card',
      )
      item.children.forEach((child, index) => {
        const nested = nestedCards[index]
        if (nested) {
          applyToolCardOpenState(
            nested,
            child,
            userExpandedRollups,
            userExpandedGroups,
            userExpandedTools,
          )
        }
      })
      return
    }
    if (item.type === 'group') {
      const status = aggregateToolStatus(item.toolCalls)
      card.open = status === 'running' || userExpandedGroups.has(item.key)
      // A changed group card is rebuilt from scratch with every item collapsed;
      // reapply the per-item expansion captured above so an item the user
      // opened (or an expanded individual card absorbed into this group)
      // survives the per-step rebuild.
      card
        .querySelectorAll<HTMLDetailsElement>('.tool-group-item[data-tool-id]')
        .forEach((entry) => {
          const id = entry.dataset['toolId']
          if (id && userExpandedTools.has(id)) entry.open = true
        })
      return
    }
    const tc = item.toolCall
    const running = tc.status === 'running' || tc.subagent?.status === 'running'
    card.open = running || userExpandedTools.has(tc.id)
  }

  function renderToolCards(
    msgEl: HTMLElement,
    toolCalls: ToolCall[],
    opts: {
      commandSummary?: string
      toolSummary?: string
      reasoning?: string
      reasoningLive?: boolean
    } = {},
  ): void {
    const userExpandedRollups = new Set<string>()
    msgEl.querySelectorAll<HTMLElement>('.tool-card-rollup[open]').forEach((node) => {
      const key = node.dataset['rollupKey']
      // Running rollups are auto-expanded; don't treat that as a user preference.
      if (key && node.dataset['status'] !== 'running') userExpandedRollups.add(key)
    })

    const userExpandedGroups = new Set<string>()
    msgEl.querySelectorAll<HTMLElement>('.tool-card-group[open]').forEach((node) => {
      const key = node.dataset['groupKey']
      // Running groups are auto-expanded; don't treat that as a user preference.
      if (key && node.dataset['status'] !== 'running') userExpandedGroups.add(key)
    })

    const userExpandedTools = new Set<string>()
    msgEl
      .querySelectorAll<HTMLElement>(
        '.tool-card[data-tool-id][open], .tool-group-item[open], .tool-card-subagent[open]',
      )
      .forEach((node) => {
        const id = node.dataset['toolId']
        if (id) userExpandedTools.add(id)
      })

    const nestReasoning = Boolean(opts.reasoning?.trim()) && shouldNestReasoningInTools(toolCalls)
    const items = buildToolCallDisplayItems(toolCalls, {
      ...(nestReasoning ? { forceRollup: true } : {}),
    })
    for (const item of items) applyRollupSummaries(item, opts)

    // Index the cards already in the DOM by their stable key so unchanged ones
    // are reused wholesale instead of torn down and rebuilt on every tick — the
    // former remove-all/rebuild-all churned every card's markdown and copy
    // buttons while a subagent streamed (#728).
    const existing = new Map<string, HTMLDetailsElement>()
    for (const node of msgEl.querySelectorAll<HTMLDetailsElement>(':scope > .tool-card')) {
      const key = toolCardKeys.get(node)
      if (key) existing.set(key, node)
    }

    const desired: HTMLDetailsElement[] = []
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
        // The stale node was already claimed out of `existing`, so the cleanup
        // below won't drop it — remove it here or the rebuilt card duplicates.
        card?.remove()
        card = createToolCard(item, api)
        toolCardKeys.set(card, key)
        toolCardSignatures.set(card, sig)
      }

      applyToolCardOpenState(card, item, userExpandedRollups, userExpandedGroups, userExpandedTools)
      if (item.type === 'rollup' && nestReasoning) {
        syncNestedRollupReasoning(card, msgEl, opts.reasoning, opts.reasoningLive === true)
      }
      desired.push(card)
    }

    // Drop cards whose tool calls are gone (e.g. an individual card absorbed
    // into a newly-formed group).
    existing.forEach((node) => {
      node.remove()
    })
    // No rollup this tick (tools cleared) — leave body-level reasoning alone;
    // when tools exist without nested reasoning, strip any orphan nested trail.
    if (!nestReasoning) {
      msgEl
        .querySelectorAll<HTMLElement>('.tool-card-rollup .message-reasoning')
        .forEach((node) => {
          node.remove()
        })
    }
    // Move/insert only when a card is out of place. Blind `append` of an
    // already-correct child still remove+reinserts it and can flash siblings
    // whenever any other tool on the message ticks (#728).
    const firstToolIdx = Array.from(msgEl.children).findIndex((node) =>
      node.classList.contains('tool-card'),
    )
    const base = firstToolIdx === -1 ? msgEl.children.length : firstToolIdx
    for (let i = 0; i < desired.length; i++) {
      const node = desired[i]
      if (!node) continue
      if (msgEl.children[base + i] !== node) {
        msgEl.insertBefore(node, msgEl.children[base + i] ?? null)
      }
    }
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

    // A hook-originated turn (decision 10): the message role stays `user`, but a
    // marker attributes it to the hook follow-up that started it.
    const hookOrigin = msg.origin?.kind === 'hook' ? msg.origin : null
    const msgClass = `msg msg-${msg.role}${hookOrigin ? ' msg-hook-origin' : ''}`
    const msgEl = el('div', { class: msgClass, 'data-message-id': msgId })
    if (hookOrigin) msgEl.setAttribute('data-hook-id', hookOrigin.hookId)
    const body = el('div', { class: 'message-body' })
    if (hookOrigin) body.append(buildHookOriginMarker(hookOrigin, msg.editedByUser === true))
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- persisted/legacy messages may predate the toolCalls field
    const nestReasoning = shouldNestReasoningInTools(msg.toolCalls ?? [])
    appendMessageContent(body, msg, api, {
      ...(nestReasoning ? { nestReasoningInTools: true } : {}),
    })
    msgEl.append(body)

    // Copy only when there is reply text — tool-only bubbles stay compact.
    if (msg.role === 'assistant' && msg.content.trim()) {
      attachCopyButton(body, msgId, store)
    }
    // Every settled prompt can start a fork of the conversation as it stood at
    // that point; only the latest one can be resent (see syncUserActions).
    if (msg.role === 'user') body.append(buildUserActions(threadId, msgId))

    // Keep the trailing comparison card (if any) last in the transcript: a new
    // message belongs above a comparison produced for an earlier turn. Review
    // cards are anchored inline after their own message (see renderMessageReview)
    // and stay put — a new message naturally lands after them.
    const trailingCard = list.querySelector('[data-comparison-card]')
    if (trailingCard) {
      // The activity row sits immediately above a trailing comparison. Insert
      // the message above both so the status remains the transcript's live tail
      // while the comparison preserves its last-child contract.
      list.insertBefore(msgEl, activityBar.isConnected ? activityBar : trailingCard)
    } else list.insertBefore(msgEl, activityBar.isConnected ? activityBar : null)
    hydrateRemoteArtifactImages(list, api)
    // Re-render any tool cards this message already carries (restored threads).
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- persisted/legacy messages may predate the toolCalls field
    renderToolCards(msgEl, msg.toolCalls ?? [], {
      ...(msg.commandSummary !== undefined ? { commandSummary: msg.commandSummary } : {}),
      ...(msg.toolSummary !== undefined ? { toolSummary: msg.toolSummary } : {}),
      ...(msg.reasoning !== undefined ? { reasoning: msg.reasoning } : {}),
    })
    // Restore an inline review this message already carries (rebuilt threads).
    if (msg.review) renderMessageReview(threadId, msgId)
    // Render any hook cards folded onto this message's turn (decision 10).
    renderMessageHookCards(threadId, msgId)
    // Model labels appear only once the primary chat has used more than one
    // model, and only at model-segment boundaries (first assistant turn of
    // each contiguous model run). Syncing after each append also backfills
    // earlier boundaries when the second model arrives. (Best-value auto-picks
    // show in the footer picker.)
    syncModelLabels()
    syncUserActions()
    scrollToBottom(msg.role === 'user')
  }

  /**
   * Per-prompt actions. **Fork from here** branches the conversation as it stood
   * at that message into a new thread; **Resend** submits the prompt again as a
   * fresh turn. Both are hover affordances on the user bubble, matching the
   * assistant bubble's Copy.
   */
  function buildUserActions(threadId: string, msgId: string): HTMLElement {
    const fork = el(
      'button',
      { class: 'msg-action msg-fork', type: 'button', title: 'Fork the thread from this message' },
      'Fork from here',
    )
    fork.addEventListener('click', () => {
      fork.disabled = true
      void runFork(threadId, msgId).finally(() => (fork.disabled = false))
    })
    const resend = el(
      'button',
      { class: 'msg-action msg-resend', type: 'button', title: 'Send this prompt again' },
      'Resend',
    )
    resend.addEventListener('click', () => {
      runResend(threadId)
    })
    return el('div', { class: 'msg-actions' }, fork, resend)
  }

  /**
   * Only the prompt a resend would actually repeat — the thread's last settled
   * one — offers the button; the rest keep Fork alone. Re-run after every append
   * so the affordance moves down with the conversation.
   */
  function syncUserActions(): void {
    const thread = getActiveThread(store)
    const resendableId = thread ? lastResendableMessage(thread)?.id : undefined
    list.querySelectorAll<HTMLButtonElement>('.msg-resend').forEach((button) => {
      const owner = button.closest<HTMLElement>('[data-message-id]')?.dataset['messageId']
      button.hidden = owner !== resendableId
    })
  }

  async function runFork(threadId: string, msgId: string): Promise<void> {
    const result = await forkThread(store, api, threadId, { throughMessageId: msgId })
    if (!result) {
      showToast('Nothing to fork from this message.', { variant: 'error' })
      return
    }
    showToast(
      result.droppedAttachments
        ? 'Forked into a new thread. Attached file contents were not carried over.'
        : 'Forked into a new thread.',
    )
  }

  function runResend(threadId: string): void {
    const result = resendLastMessage(store, api, threadId)
    if (!result) return
    if (result.droppedAttachments) {
      showToast('Resent without the original attachments.')
    } else if (result.queued) {
      showToast('Resend queued behind the running turn.')
    }
  }

  /**
   * Show/hide per-message model chrome when the primary chat is multi-model.
   * Labels mark the start of each model segment only — same-model
   * continuations stay unlabeled.
   */
  function syncModelLabels(): void {
    const thread = getActiveThread(store)
    if (!thread) return
    const show = shouldShowPrimaryChatModelLabels(thread.messages)
    let prevModel: string | undefined
    for (const msg of thread.messages) {
      if (msg.role !== 'assistant') continue
      const msgEl = list.querySelector(`[data-message-id="${msg.id}"]`)
      if (!msgEl) continue
      const existing = msgEl.querySelector<HTMLElement>('.message-model')
      const model = msg.model
      if (show && model && model !== prevModel) {
        const label = existing ?? el('div', { class: 'message-model' })
        label.textContent = formatPrimaryChatModelLabel(model)
        if (!existing) msgEl.prepend(label)
      } else {
        existing?.remove()
      }
      prevModel = model
    }
  }

  function syncTodoPanel(): void {
    // P4: the plan panel is a level-2 declarative pack contribution from
    // `copse.todos`. Historical rendering resolves from `thread.todos` (the
    // durable `todo_update` state persisted across sessions), never from the
    // live pack registration (decision 17) — so an old thread's plan renders
    // even if the pack is later disabled. The generic pack-panel renderer
    // (`createPackPanelEl`) is fed the same `PanelListData` the pack emits
    // via `panel_update` for new turns (`todosToPanelListData`), keeping the
    // in-turn UI and reloaded-history UI byte-identical.
    todoHost.replaceChildren()
    const thread = getActiveThread(store)
    if (!thread?.todos?.length) return
    const data: PanelListData = todosToPanelListData(thread.todos)
    if (data.rows.length === 0) return
    todoHost.append(
      createPackPanelEl(data, {
        packId: TODOS_PACK_ID,
        contributionId: TODOS_PANEL_CONTRIBUTION_ID,
        ariaLabel: 'To-dos',
      }),
    )
  }

  // Hook cards fired within a turn render as this message's next sibling (like
  // review cards) so the right-aligned blue family joins the transcript inline
  // rather than nesting inside the (also-blue) user bubble. Rebuilt on every sync
  // + live `hook_card_added`, so late cards from the same turn append in order.
  function renderMessageHookCards(threadId: string, messageId: string): void {
    if (threadId !== store.getState().activeThreadId) return
    list.querySelector(`[data-hook-cards-for="${messageId}"]`)?.remove()
    const msg = getActiveThread(store)?.messages.find((m) => m.id === messageId)
    const msgEl = list.querySelector(`[data-message-id="${messageId}"]`)
    const cards = msg?.hookCards ?? []
    if (!msgEl || cards.length === 0) return
    msgEl.after(createHookCardHost(messageId, cards))
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
      const card = createComparisonCardEl(
        thread.comparison,
        api,
        () => {
          retryComparison(store, api, threadId)
        },
        () => {
          dismissComparison(store, threadId)
        },
      )
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
    // Activity is transcript content, not composer chrome. Keep it beneath the
    // messages but above a trailing comparison card, which remains last.
    list.insertBefore(activityBar, list.querySelector('[data-comparison-card]'))
    updateScrollButton()
  }

  function refreshToolCards(msgId: string): void {
    const thread = store.getState().threads.find((t) => t.messages.some((m) => m.id === msgId))
    const msg = thread?.messages.find((m) => m.id === msgId)
    const msgEl = list.querySelector<HTMLElement>(`[data-message-id="${msgId}"]`)
    if (!msg || !msgEl) return
    // renderToolCards tears down and rebuilds every tool card, which destroys the
    // browser's scroll anchor and can jump a user who has scrolled up to read.
    // Preserve their position across the rebuild; only autoscroll when the view
    // is still pinned to the bottom (#468).
    const prevScrollTop = list.scrollTop
    const wasPinned = pinnedToBottom
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- persisted/legacy messages may predate the toolCalls field
    renderToolCards(msgEl, msg.toolCalls ?? [], {
      ...(msg.commandSummary !== undefined ? { commandSummary: msg.commandSummary } : {}),
      ...(msg.toolSummary !== undefined ? { toolSummary: msg.toolSummary } : {}),
      ...(msg.reasoning !== undefined ? { reasoning: msg.reasoning } : {}),
      reasoningLive: isReasoningDisclosureLive(thread, msg),
    })
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
      const msgEl = list.querySelector<HTMLElement>(`[data-message-id="${mid}"]`)
      const textEl = msgEl?.querySelector<HTMLElement>('.message-text')
      if (textEl && msg?.role === 'assistant') {
        setAssistantMarkdown(textEl, msg.content, true, api)
        // Answer started — disclosure flips to past tense even while tokens stream.
        if (msg.content.trim()) {
          msgEl?.querySelectorAll<HTMLDetailsElement>('.message-reasoning').forEach((details) => {
            setReasoningDisclosureTitle(details, false)
          })
        }
        scrollToBottom()
      }
    }),
    store.on('message_reasoning', (mid) => {
      const thread = getActiveThread(store)
      const msg = thread?.messages.find((m) => m.id === mid)
      const msgEl = list.querySelector<HTMLElement>(`[data-message-id="${mid}"]`)
      if (msg?.role === 'assistant' && msgEl) {
        syncReasoningEl(msgEl, msg, isReasoningDisclosureLive(thread, msg))
        activityBar.classList.add('agent-activity-clickable')
        setActivity(activityLabel.textContent)
        scrollToBottom()
      }
    }),
    store.on('message_done', (mid) => {
      const msgEl = list.querySelector<HTMLElement>(`[data-message-id="${mid}"]`)
      const textEl = msgEl?.querySelector<HTMLElement>('.message-text')
      const thread = getActiveThread(store)
      const msg = thread?.messages.find((m) => m.id === mid)
      if (textEl && msg?.role === 'assistant') {
        setAssistantMarkdown(textEl, msg.content, false, api)
        hydrateRemoteArtifactImages(list, api)
      }
      if (msg?.role === 'assistant' && msgEl) {
        // Segment settled — past-tense the disclosure title even for tool-only bubbles.
        msgEl.querySelectorAll<HTMLDetailsElement>('.message-reasoning').forEach((details) => {
          setReasoningDisclosureTitle(details, false)
        })
      }
      if (msg?.role === 'assistant' && msg.content.trim()) {
        const body = msgEl?.querySelector<HTMLElement>('.message-body')
        if (body && !body.querySelector('.msg-copy')) attachCopyButton(body, mid, store)
        // Answer is in: tuck a body-level reasoning trail away unless the user
        // opened it. Nested trails inside a tool rollup stay with that rollup.
        const reasoning = body?.querySelector<HTMLDetailsElement>(':scope > .message-reasoning')
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
    store.on('hook_card_added', (tid, mid) => {
      renderMessageHookCards(tid, mid)
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

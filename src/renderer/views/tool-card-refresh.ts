/**
 * Tool-card refresh for the transcript: builds a message's display items,
 * reconciles them against the cards already in its bubble (reusing unchanged
 * cards, patching changed ones in place), keeps multi-message run rollups on
 * their anchor, and applies open state from the disclosure model.
 *
 * Extracted from `mountConversation` (#3962). The card DOM builders stay in
 * `conversation.ts` and arrive through {@link ToolCardDom}; scroll anchoring
 * stays with the conversation view and arrives through {@link ToolCardRefreshHost}.
 */
import type { AppStore } from '@shared/store/store.ts'
import { getActiveThread } from '@shared/store/thread-helpers.ts'
import type { AcpContentBlock, Message, Thread, ToolCall } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  buildSubagentDisplayItems,
  buildToolCallDisplayItems,
  buildToolRunDisplayItems,
  RUN_ROLLUP_KEY,
  type ToolCallDisplayItem,
} from '@shared/tools/tool-display.ts'
import { toolRunForMessage, type ToolRun } from '@shared/tools/tool-runs.ts'
import { isHostInterruptedToolCall } from '@shared/tools/tool-interruption.ts'
import { isReviewerInputCall } from '@shared/threads/reviewer-input.ts'
import {
  acpWorkspaceRoot,
  hydrateAcpResourceImages,
  syncAcpResourceReferences,
} from './acp-resource-previews.ts'
import { syncConciseMessageClasses } from './concise-thread.ts'
import { createDisclosureModel, type DisclosureModel } from './disclosure-model.ts'
import { renderSignature } from './render-signature.ts'
import { isThreadProposalCall, threadProposalCardSignature } from './thread-proposal-tool-card.ts'
import { interruptionCause, type InterruptionCause } from './turn-interruption.ts'

export type ToolCardStatus = ToolCall['status'] | 'interrupted'

// The host records cancelled ACP calls as errors so the next model does not
// assume they completed. Their transcript presentation can still distinguish a
// user interruption from a tool failure using the turn outcome. Every call of a
// user-cancelled turn is keyed here; {@link userInterruption} checks live
// whether the call was actually cut off, since tool calls update in place.
export const userInterruptedCalls = new WeakMap<ToolCall, InterruptionCause>()

// Transcripts already walked. Adding, moving or removing a message and landing
// a turn outcome all replace `thread.messages`, so a list is only walked again
// after a change that can move an interruption. `renderToolCards` runs once per
// message; walking the whole thread on every call was quadratic per rebuild.
export const markedTranscripts = new WeakSet<readonly Message[]>()

export function markUserInterruptedCalls(thread: Thread | undefined): void {
  if (!thread || markedTranscripts.has(thread.messages)) return
  markedTranscripts.add(thread.messages)
  let turnCalls: ToolCall[] = []
  for (const [index, message] of thread.messages.entries()) {
    if (message.role !== 'assistant') turnCalls = []
    else turnCalls.push(...message.toolCalls)
    if (!message.turnOutcome) continue
    const next = thread.messages[index + 1]
    const userCancelled =
      message.turnOutcome.status === 'cancelled' &&
      message.turnOutcome.source === 'user' &&
      !(next?.role === 'user' && next.origin !== undefined)
    const cause = userCancelled ? interruptionCause(message.turnOutcome, next) : null
    for (const call of turnCalls) {
      if (cause) userInterruptedCalls.set(call, cause)
      else userInterruptedCalls.delete(call)
    }
    turnCalls = []
  }
}

export function userInterruption(call: ToolCall): InterruptionCause | undefined {
  return isHostInterruptedToolCall(call) ? userInterruptedCalls.get(call) : undefined
}

export function cardStatus(toolCalls: readonly ToolCall[]): ToolCardStatus {
  if (toolCalls.some((call) => call.status === 'running')) return 'running'
  if (toolCalls.some((call) => call.status === 'error' && userInterruption(call) === undefined)) {
    return 'error'
  }
  if (toolCalls.some((call) => userInterruption(call) !== undefined)) return 'interrupted'
  // A command declined or refused before launch returned normally, but nothing
  // ran: never the green check beside "Did not start" (#3956). A rollup whose
  // other calls did their work stays done; the declined call's own card says so.
  if (
    toolCalls.length > 0 &&
    toolCalls.every((call) => call.commandPhase?.state === 'not_started')
  ) {
    return 'interrupted'
  }
  return 'done'
}

// Stable identity for a tool card across `tool_call_updated` ticks: group cards
// key on the group bucket, individual cards on the tool-call id. Held in
// WeakMaps (rather than DOM attributes) so large signatures don't bloat the DOM.
export const toolCardKeys = new WeakMap<HTMLElement, string>()
export const toolCardSignatures = new WeakMap<HTMLElement, string>()

export function toolCardKey(item: ToolCallDisplayItem): string {
  // One identity for a message's rollup, whether it is still one message's
  // `turn` or has become a cross-message `run`: the disclosure is patched in
  // place (keeping its open state) instead of being replaced as messages join.
  if (item.type === 'rollup') return 'r:activity'
  if (item.type === 'step') return `s:${item.key}`
  if (item.type === 'group') return `g:${item.key}`
  return `t:${item.toolCall.id}`
}

// Everything that determines a card's rendered output. When it is unchanged
// since the last tick the existing card is reused verbatim, so its markdown is
// not re-rendered and its copy buttons are not re-attached (#728). Wire tool
// calls are plain JSON, so a stringify captures args/result/status/subagent —
// digested rather than kept, or the cache would pin a second copy of every tool
// result for as long as its card is on screen (see {@link renderSignature}).
export function toolCallSignature(call: ToolCall): string {
  return renderSignature({ call, interruption: userInterruption(call) ?? null })
}

export function toolCardSignature(item: ToolCallDisplayItem, extra?: string): string {
  const calls = item.type === 'individual' ? [item.toolCall] : item.toolCalls
  const base = renderSignature({
    item,
    interruptions: calls.map((call) => userInterruption(call) ?? null),
  })
  return extra === undefined ? base : `${base}|${extra}`
}

/** True when reasoning should fold into the tool rollup for this message. */
export function shouldNestReasoningInTools(toolCalls: ToolCall[]): boolean {
  return toolCalls.some((tc) => !tc.subagent)
}

/**
 * The presentation run this message belongs to, but only once it actually spans
 * more than one assistant message. A one-message run is indistinguishable from
 * the per-message rollup, so it stays on the untouched single-message path.
 */
export function multiStepRunFor(thread: Thread | undefined, msgId: string): ToolRun | undefined {
  if (!thread) return undefined
  const run = toolRunForMessage(thread.messages, msgId)
  return run && run.steps.length > 1 ? run : undefined
}

/** The summary/reasoning inputs a message contributes to its own tool cards. */
export function messageToolCardOpts(msg: Message): {
  commandSummary?: string
  toolSummary?: string
  reasoning?: string
  reasoningBlocks?: AcpContentBlock[]
} {
  return {
    ...(msg.commandSummary !== undefined ? { commandSummary: msg.commandSummary } : {}),
    ...(msg.toolSummary !== undefined ? { toolSummary: msg.toolSummary } : {}),
    ...(msg.reasoning !== undefined ? { reasoning: msg.reasoning } : {}),
    ...(msg.reasoningBlocks !== undefined ? { reasoningBlocks: msg.reasoningBlocks } : {}),
  }
}

/**
 * The message whose reasoning is still live, by the same rule
 * {@link isReasoningDisclosureLive} applies: a running thread's last bubble
 * with no answer text yet.
 */
export function liveStepMessageId(thread: Thread | undefined): string | null {
  if (!thread || thread.status !== 'running') return null
  const last = thread.messages[thread.messages.length - 1]
  if (!last || last.content.trim()) return null
  return last.id
}

/** Live = running thread, this is the latest bubble, and no answer text yet. */
export function isReasoningDisclosureLive(
  thread: Thread | undefined,
  msg: { id: string; content: string },
): boolean {
  if (!thread || thread.status !== 'running') return false
  if (msg.content.trim()) return false
  return thread.messages[thread.messages.length - 1]?.id === msg.id
}

/** Fast operations should finish without flashing their detail open. */
const TOOL_AUTO_REVEAL_DELAY_MS = 300
/** Once shown, live detail remains visible long enough to be read. */
const TOOL_AUTO_REVEAL_MIN_DWELL_MS = 1_000
/** Compact auto-opened work once, after the completed run has gone quiet. */
const TOOL_AUTO_COMPACT_DELAY_MS = 750

/** The card DOM builders, which live with the rest of the card markup in `conversation.ts`. */
export interface ToolCardDom {
  createToolCard: (
    item: ToolCallDisplayItem,
    api: ApiClient,
    threadId: string,
    store?: AppStore,
  ) => HTMLDetailsElement
  reconcileToolCard: (
    card: HTMLDetailsElement,
    item: ToolCallDisplayItem,
    api: ApiClient,
    threadId: string,
    store?: AppStore,
  ) => void
  ensureToolCardBodyRendered: (card: HTMLDetailsElement) => void
  syncToolResultContent: (
    msgEl: HTMLElement,
    toolCalls: readonly ToolCall[],
    workspaceRoot: string | null,
  ) => void
  syncToolRunMemberVisibility: (msgEl: HTMLElement) => void
  syncNestedRollupReasoning: (
    card: HTMLElement,
    msgEl: HTMLElement,
    reasoning: string | undefined,
    reasoningBlocks: readonly AcpContentBlock[] | undefined,
    live: boolean,
    workspaceRoot: string | null,
  ) => void
  syncRunStepReasoning: (
    card: HTMLElement,
    run: ToolRun,
    liveStepId: string | null,
    workspaceRoot: string | null,
  ) => void
  syncReasoningEl: (
    msgEl: HTMLElement,
    msg: { content: string; reasoning?: string; reasoningBlocks?: AcpContentBlock[] },
    live: boolean,
    workspaceRoot: string | null,
  ) => void
}

export interface ToolCardRefreshHost {
  store: AppStore
  api: ApiClient
  /** The transcript list holding one `[data-message-id]` bubble per message. */
  list: HTMLElement
  dom: ToolCardDom
  /** Whether the reader is at the live end, so automatic reveals may move geometry. */
  isPinnedToBottom: () => boolean
  scrollToBottom: () => void
  /** Run `update`, then restore what the reader was looking at (or re-pin to the end). */
  keepReadingPosition: (update: () => void) => void
  conciseEnabledFor: (thread: Thread | undefined, messageId: string) => boolean
}

export interface ToolCardRefresher {
  readonly disclosures: DisclosureModel
  renderToolCards: (msgEl: HTMLElement, toolCalls: ToolCall[], opts?: ToolCardRenderOptions) => void
  refreshToolCards: (msgId: string) => void
  registerReasoningDisclosures: (msgEl: HTMLElement) => void
  syncRunLayout: (thread: Thread | undefined, run: ToolRun, changedId: string) => void
  resyncRunMembership: (thread: Thread | undefined, msgId: string) => void
  syncRunStepTrail: (thread: Thread | undefined, run: ToolRun) => void
  /** Drop element registrations; the model's state and user choices are kept. */
  forgetDisclosureElements: () => void
}

export interface ToolCardRenderOptions {
  commandSummary?: string
  toolSummary?: string
  reasoning?: string
  reasoningBlocks?: AcpContentBlock[]
  reasoningLive?: boolean
  /**
   * The multi-message run this message belongs to. The run's combined
   * rollup renders on its anchor; every other member keeps only its
   * subagent cards (see {@link buildToolRunDisplayItems}).
   */
  run?: ToolRun
  /** Message id whose reasoning is still streaming, for the step titles. */
  liveStepId?: string | null
}

export function createToolCardRefresher(host: ToolCardRefreshHost): ToolCardRefresher {
  const { store, api, list, conciseEnabledFor } = host
  const {
    createToolCard,
    reconcileToolCard,
    ensureToolCardBodyRendered,
    syncToolResultContent,
    syncToolRunMemberVisibility,
    syncNestedRollupReasoning,
    syncRunStepReasoning,
    syncReasoningEl,
  } = host.dom

  // Disclosure presentation is deliberately independent from execution status:
  // `disclosures` owns auto / user-open / user-closed per key, plus the reveal
  // and compaction timers. A brief done -> running gap must not close and
  // reopen the same rollup, and a user's explicit choice must survive status
  // updates and mounted thread switches. The DOM only renders that state.
  // Once a live message starts as a rollup, keep that wrapper shape for this
  // mounted session so a one-tool update cannot turn into a different card type.
  const liveRollupMessages = new Set<string>()
  const disclosureElements = new Map<string, HTMLDetailsElement>()
  const wiredDisclosureSummaries = new WeakSet<HTMLElement>()
  const disclosures = createDisclosureModel(
    {
      canReveal: () => host.isPinnedToBottom(),
      canCompact: (threadId) =>
        threadId !== store.getState().activeThreadId || host.isPinnedToBottom(),
      reveal(key) {
        const details = disclosureElements.get(key)
        if (!details?.isConnected) return false
        details.open = true
        ensureToolCardBodyRendered(details)
        host.scrollToBottom()
        return true
      },
      collapse(key) {
        const details = disclosureElements.get(key)
        if (details?.isConnected) details.open = false
      },
      compacted(threadId) {
        if (threadId === store.getState().activeThreadId) host.scrollToBottom()
      },
    },
    {
      revealDelayMs: TOOL_AUTO_REVEAL_DELAY_MS,
      minDwellMs: TOOL_AUTO_REVEAL_MIN_DWELL_MS,
      compactDelayMs: TOOL_AUTO_COMPACT_DELAY_MS,
    },
  )

  function wireDisclosurePreference(
    details: HTMLDetailsElement,
    threadId: string,
    key: string,
  ): void {
    const summary = details.querySelector<HTMLElement>(':scope > summary')
    if (!summary || wiredDisclosureSummaries.has(summary)) return
    wiredDisclosureSummaries.add(summary)
    summary.addEventListener('click', (event) => {
      const target = event.target
      if (target instanceof Element && target.closest('button')) return
      // Chromium can run microtasks before the summary's default action. Own
      // the toggle so the stored preference always matches the visible state.
      event.preventDefault()
      details.open = !details.open
      disclosures.choose(threadId, key, details.open)
      details.dataset['userToggled'] = '1'
      if (details.open) ensureToolCardBodyRendered(details)
    })
  }

  /** Register a disclosure's element under its model key and wire user toggles. */
  function bindDisclosure(details: HTMLDetailsElement, threadId: string, key: string): void {
    details.dataset['disclosureKey'] = key
    disclosureElements.set(key, details)
    wireDisclosurePreference(details, threadId, key)
  }

  function registerReasoningDisclosures(msgEl: HTMLElement): void {
    const threadId = getActiveThread(store)?.id
    const fallbackMessageId = msgEl.dataset['messageId']
    if (!threadId || !fallbackMessageId) return
    msgEl.querySelectorAll<HTMLDetailsElement>('.message-reasoning').forEach((details) => {
      const step = details.closest<HTMLElement>('.tool-card-step[data-step-message-id]')
      const messageId = step?.dataset['stepMessageId'] ?? fallbackMessageId
      const key = `${threadId}:${messageId}:reasoning`
      bindDisclosure(details, threadId, key)
      const preference = disclosures.userChoice(key)
      if (preference !== undefined) {
        details.dataset['userToggled'] = '1'
        details.open = preference
      }
    })
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

  function labelUserInterruptions(item: ToolCallDisplayItem): void {
    const calls = item.type === 'individual' ? [item.toolCall] : item.toolCalls
    if (calls.some((call) => userInterruption(call) !== undefined)) {
      const failed = calls.filter(
        (call) => call.status === 'error' && userInterruption(call) === undefined,
      ).length
      const base = item.label.replace(/ · \d+ failed$/, '')
      item.label = `${base}${failed ? ` · ${String(failed)} failed` : ''} · Interrupted`
    }
    if (item.type === 'rollup' || item.type === 'step') {
      for (const child of item.children) labelUserInterruptions(child)
    }
  }

  function applyToolCardOpenState(
    card: HTMLDetailsElement,
    item: ToolCallDisplayItem,
    threadId: string,
    messageId: string,
    autoRevealEligible: boolean,
  ): void {
    // Proposal cards derive their open state from the pending user decision.
    if (card.classList.contains('thread-proposal')) return
    const key = `${threadId}:${messageId}:${toolCardKey(item)}`
    // Keep dataset.status aligned with the live tool status for styling.
    const itemStatus =
      item.type === 'individual' ? cardStatus([item.toolCall]) : cardStatus(item.toolCalls)
    card.dataset['status'] = itemStatus
    bindDisclosure(card, threadId, key)
    const container = item.type === 'rollup' || item.type === 'step'
    const subagentRunning =
      item.type === 'individual' && item.toolCall.subagent?.status === 'running'
    card.open = disclosures.update(threadId, key, {
      kind: container ? 'container' : 'tool',
      status: subagentRunning ? 'running' : itemStatus,
      autoRevealEligible,
    })
    if (card.open) ensureToolCardBodyRendered(card)

    if (container) {
      const nestedCards = card.querySelectorAll<HTMLDetailsElement>(
        ':scope > .tool-rollup-body > .tool-card',
      )
      item.children.forEach((child, index) => {
        const nested = nestedCards[index]
        if (nested) {
          applyToolCardOpenState(nested, child, threadId, messageId, false)
        }
      })
      return
    }
    if (item.type === 'group') {
      const calls = new Map(item.toolCalls.map((call) => [call.id, call]))
      card
        .querySelectorAll<HTMLDetailsElement>('.tool-group-item[data-tool-id]')
        .forEach((entry) => {
          const id = entry.dataset['toolId']
          const call = id ? calls.get(id) : undefined
          if (!id || !call) return
          const itemKey = `${threadId}:${messageId}:t:${id}`
          bindDisclosure(entry, threadId, itemKey)
          entry.open = disclosures.update(threadId, itemKey, {
            kind: 'entry',
            status: cardStatus([call]),
            autoRevealEligible: false,
          })
          if (entry.open) ensureToolCardBodyRendered(entry)
        })
    }
  }

  function renderToolCards(
    msgEl: HTMLElement,
    toolCalls: ToolCall[],
    opts: ToolCardRenderOptions = {},
  ): void {
    const threadId = store.getState().activeThreadId ?? ''
    const msgId = msgEl.dataset['messageId'] ?? ''
    const messageKey = threadId && msgId ? `${threadId}:${msgId}` : null
    const activeThread = getActiveThread(store)
    markUserInterruptedCalls(activeThread)
    if (
      messageKey &&
      activeThread?.status === 'running' &&
      toolCalls.some((tool) => !tool.subagent)
    ) {
      liveRollupMessages.add(messageKey)
    }
    // A run only renders as one when its anchor is actually on screen. During
    // the newest-first backfill a member can be rendered before its anchor is;
    // it falls back to its own rollup and is repainted once the anchor lands
    // (see finalizeMessageEl), rather than hiding its tools in the meantime.
    const run =
      opts.run &&
      (opts.run.anchorId === msgId ||
        list.querySelector(`[data-message-id="${opts.run.anchorId}"]`) !== null)
        ? opts.run
        : undefined
    const isRunMember = run !== undefined && run.anchorId !== msgId
    // Keep the persisted message node for stable event routing and backfill, but
    // let CSS collapse it when the run absorbed everything it could show. The
    // selector deliberately checks the live DOM, so a retained subagent card or
    // a canvas preview added later makes the bubble visible again automatically.
    msgEl.classList.toggle('msg-tool-run-member', isRunMember)
    // Refresh compact tool activity without changing assistant text visibility.
    const message = activeThread?.messages.find((m) => m.id === msgId)
    if (message) syncConciseMessageClasses(msgEl, message, conciseEnabledFor(activeThread, msgId))

    const nestReasoning =
      run === undefined &&
      (Boolean(opts.reasoning?.trim()) || Boolean(opts.reasoningBlocks?.length)) &&
      shouldNestReasoningInTools(toolCalls)
    // User-interrupted calls fold into the rollup; genuine failures sit beside it.
    const isInterrupted = (call: ToolCall): boolean => userInterruption(call) !== undefined
    const items = run
      ? isRunMember
        ? buildSubagentDisplayItems(toolCalls)
        : [
            ...buildToolRunDisplayItems(run, { isInterrupted }),
            ...buildSubagentDisplayItems(toolCalls),
          ]
      : buildToolCallDisplayItems(toolCalls, {
          isInterrupted,
          ...(nestReasoning || (messageKey !== null && liveRollupMessages.has(messageKey))
            ? { forceRollup: true }
            : {}),
        })
    // Run rollups carry their own composed label (polish + counts + steps), so
    // the per-message summary only applies on the single-message path.
    if (!run) for (const item of items) applyRollupSummaries(item, opts)
    for (const item of items) labelUserInterruptions(item)

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
      // A proposal card also renders the user's answer, which lives on the
      // thread rather than on the tool call — fold it in so accepting or
      // dismissing an offer rebuilds the card the way a new result would.
      const sig = toolCardSignature(
        item,
        item.type === 'individual'
          ? threadProposalCardSignature(item.toolCall, store, threadId)
          : undefined,
      )
      let card = existing.get(key) ?? null
      if (card) existing.delete(key)

      if (card && toolCardSignatures.get(card) === sig) {
        // Nothing this card renders has changed — leave its DOM (and any
        // streaming renderers / copy buttons) exactly as they are.
      } else if (
        card &&
        !card.classList.contains('thread-proposal') &&
        !(item.type === 'individual' && isThreadProposalCall(item.toolCall)) &&
        !(item.type === 'individual' && isReviewerInputCall(item.toolCall))
      ) {
        // Patch the existing disclosure shell so status/result changes preserve
        // focus, open state, and the browser's scroll anchor.
        reconcileToolCard(card, item, api, threadId, store)
      } else {
        // The stale node was already claimed out of `existing`, so the cleanup
        // below won't drop it — remove it here or the rebuilt card duplicates.
        card?.remove()
        card = createToolCard(item, api, threadId, store)
        toolCardKeys.set(card, key)
        toolCardSignatures.set(card, sig)
      }

      applyToolCardOpenState(card, item, threadId, msgId, true)
      if (item.type === 'rollup' && nestReasoning) {
        syncNestedRollupReasoning(
          card,
          msgEl,
          opts.reasoning,
          opts.reasoningBlocks,
          opts.reasoningLive === true,
          acpWorkspaceRoot(store),
        )
      }
      if (item.type === 'rollup' && run && item.key === RUN_ROLLUP_KEY) {
        syncRunStepReasoning(card, run, opts.liveStepId ?? null, acpWorkspaceRoot(store))
      }
      desired.push(card)
    }

    // Drop cards whose tool calls are gone (e.g. an individual card absorbed
    // into a newly-formed group).
    existing.forEach((node) => {
      node.remove()
    })
    if (run) {
      // Every member's reasoning is shown as a step inside the run's rollup, so
      // no bubble keeps a trail of its own — including the anchor's, which the
      // single-message path would have nested in its own rollup.
      msgEl.querySelectorAll<HTMLElement>('.message-body > .message-reasoning').forEach((node) => {
        node.remove()
      })
    } else if (!nestReasoning) {
      // No rollup this tick (tools cleared) — leave body-level reasoning alone;
      // when tools exist without nested reasoning, strip any orphan nested trail.
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
    syncToolResultContent(
      msgEl,
      run ? (isRunMember ? [] : run.toolCalls) : toolCalls,
      acpWorkspaceRoot(store),
    )
    hydrateAcpResourceImages(msgEl, api, store)
    registerReasoningDisclosures(msgEl)
    syncToolRunMemberVisibility(msgEl)
  }

  /**
   * A run's combined rollup renders on its anchor, so anything that changes a
   * member — a tool ticking, a new member arriving — has to repaint the anchor
   * as well as the member's own bubble.
   */
  function renderRunAnchor(thread: Thread | undefined, run: ToolRun): void {
    const anchor = thread?.messages.find((m) => m.id === run.anchorId)
    const anchorEl = list.querySelector<HTMLElement>(`[data-message-id="${run.anchorId}"]`)
    if (!anchor || !anchorEl) return
    renderToolCards(anchorEl, anchor.toolCalls, {
      ...messageToolCardOpts(anchor),
      run,
      liveStepId: liveStepMessageId(thread),
    })
  }

  /**
   * Hand back any rollup a member painted for itself while the anchor was still
   * off screen — the newest-first backfill renders the transcript's tail before
   * the history above it. Only members that still hold one are repainted.
   */
  function releaseRunMembers(thread: Thread | undefined, run: ToolRun): void {
    for (const id of run.memberIds) {
      if (id === run.anchorId) continue
      const memberEl = list.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
      if (!memberEl?.querySelector(':scope > .tool-card-rollup')) continue
      const msg = thread?.messages.find((m) => m.id === id)
      if (!msg) continue
      renderToolCards(memberEl, msg.toolCalls, {
        ...messageToolCardOpts(msg),
        run,
        liveStepId: liveStepMessageId(thread),
      })
    }
  }

  /** Repaint whichever side of `run` the message that just changed is not. */
  function syncRunLayout(thread: Thread | undefined, run: ToolRun, changedId: string): void {
    if (changedId === run.anchorId) releaseRunMembers(thread, run)
    else renderRunAnchor(thread, run)
  }

  /**
   * A bubble that gains visible prose leaves the run it had joined — prose is a
   * run boundary. Rare (it takes the mid-sentence continuation heuristic landing
   * on a bubble that so far had only tools or reasoning), but without this the
   * old anchor would keep showing a step for a message that has moved on, and
   * the message itself would show none of its tools or its reasoning trail.
   */
  function resyncRunMembership(thread: Thread | undefined, msgId: string): void {
    const staleStep = list.querySelector<HTMLElement>(
      `.tool-card-step[data-step-message-id="${msgId}"]`,
    )
    const anchorEl = staleStep?.closest<HTMLElement>('.msg')
    const anchorId = anchorEl?.dataset['messageId']
    if (!anchorEl || !anchorId || anchorId === msgId) return
    const anchorRun = multiStepRunFor(thread, anchorId)
    if (anchorRun?.memberIds.includes(msgId) === true) return
    const anchor = thread?.messages.find((m) => m.id === anchorId)
    if (!anchor) return
    renderToolCards(anchorEl, anchor.toolCalls, {
      ...messageToolCardOpts(anchor),
      ...(anchorRun ? { run: anchorRun, liveStepId: liveStepMessageId(thread) } : {}),
    })
    refreshToolCards(msgId)
    // The step that held this message's reasoning is gone with the repaint
    // above. Unless the message now anchors a run of its own (where the trail
    // lives on its step again), hand the trail back to its bubble.
    const msg = thread?.messages.find((m) => m.id === msgId)
    const msgEl = list.querySelector<HTMLElement>(`[data-message-id="${msgId}"]`)
    if (!msg || !msgEl || multiStepRunFor(thread, msgId)) return
    syncReasoningEl(msgEl, msg, isReasoningDisclosureLive(thread, msg), acpWorkspaceRoot(store))
  }

  /**
   * Update the run's reasoning trails in place after a reasoning chunk. Falls
   * back to a full anchor repaint only when a step this run now has does not
   * exist in the DOM yet — a member that has streamed reasoning but no tools.
   */
  function syncRunStepTrail(thread: Thread | undefined, run: ToolRun): void {
    const runCard = list.querySelector<HTMLElement>(
      `[data-message-id="${run.anchorId}"] > .tool-card-rollup[data-rollup-key="${RUN_ROLLUP_KEY}"]`,
    )
    const complete =
      runCard !== null &&
      run.steps.every((step) =>
        runCard.querySelector(`.tool-card-step[data-step-message-id="${step.messageId}"]`),
      )
    if (!complete) {
      renderRunAnchor(thread, run)
      return
    }
    syncRunStepReasoning(runCard, run, liveStepMessageId(thread), acpWorkspaceRoot(store))
    hydrateAcpResourceImages(runCard, api, store)
  }

  function refreshToolCards(msgId: string): void {
    const thread = store.getState().threads.find((t) => t.messages.some((m) => m.id === msgId))
    const msg = thread?.messages.find((m) => m.id === msgId)
    const msgEl = list.querySelector<HTMLElement>(`[data-message-id="${msgId}"]`)
    if (!msg || !msgEl) return
    host.keepReadingPosition(() => {
      const run = multiStepRunFor(thread, msgId)
      renderToolCards(msgEl, msg.toolCalls, {
        ...messageToolCardOpts(msg),
        reasoningLive: isReasoningDisclosureLive(thread, msg),
        ...(run ? { run, liveStepId: liveStepMessageId(thread) } : {}),
      })
      // This message's tools may belong to a rollup anchored on another bubble.
      if (run) syncRunLayout(thread, run, msgId)
      syncAcpResourceReferences(list, api, store)
    })
  }

  return {
    disclosures,
    renderToolCards,
    refreshToolCards,
    registerReasoningDisclosures,
    syncRunLayout,
    resyncRunMembership,
    syncRunStepTrail,
    forgetDisclosureElements(): void {
      disclosureElements.clear()
    },
  }
}

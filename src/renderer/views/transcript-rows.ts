/**
 * Keyed reconciliation of the transcript's message rows (#3962).
 *
 * A row is one message's `.msg[data-message-id]` element plus the cards the
 * view anchors right after it (inline review, review report, hook cards, turn
 * recovery). Each row carries a signature of everything it was built from:
 * the message itself and the few thread facts that change what a message
 * renders (its multi-message run, live reasoning and failed-turn recovery). When the transcript's inputs change, the view plans
 * against the rows already in the list: rows whose signature still matches
 * are kept as they are, changed rows are rebuilt in place, new rows are
 * inserted at their position, rows that left the transcript are dropped and
 * rows out of order are moved, nodes and all.
 *
 * A kept row keeps everything that arrived after it was built — resolved
 * file-reference links, lazily built tool-card bodies, open disclosures and
 * hover-action transitions — which a whole-list rebuild threw away.
 *
 * The planner is pure; {@link applyTranscriptRowPlan} does the DOM work with
 * the view's own build path ({@link TranscriptRowHost.insert}), so a row
 * built here is identical to one the view appends live.
 */
import type { Message, Thread, ToolCall } from '@shared/types'
import type { AppStore } from '@shared/store/store.ts'
import { artefactTitleFromUri } from '@shared/canvas/artefact.ts'
import { isReviewerInputCall, reviewerInputAnswer } from '@shared/threads/reviewer-input.ts'
import { artefactPreviewVersion, artefactUriFromToolResult } from '../canvas/artefact-previews.ts'
import { disposeInlineArtefacts } from '../canvas/inline-artefact.ts'
import { turnRecoveryForMessage } from '../controller/turn-recovery.ts'
import { backgroundTaskCommandCall } from './command-task-links.ts'
import { renderSignature } from './render-signature.ts'
import { isThreadProposalCall, threadProposalCardSignature } from './thread-proposal-tool-card.ts'
import {
  isReasoningDisclosureLive,
  liveStepMessageId,
  markUserInterruptedCalls,
  multiStepRunFor,
  userInterruption,
} from './tool-card-refresh.ts'
import type { ReadingAnchor } from './transcript-scroll.ts'

/** A row as the planner sees it: its key (the message id) and its signature. */
export interface TranscriptRow {
  readonly key: string
  readonly signature: string
}

export type TranscriptRowOp =
  /** Detach the row and its anchored cards. */
  | { readonly kind: 'remove'; readonly key: string }
  /** Rebuild the row where it stands. */
  | { readonly kind: 'replace'; readonly key: string }
  /**
   * Build a new row before the row keyed `before` (a row already in the list),
   * or at the rows' tail when `before` is null.
   */
  | { readonly kind: 'insert'; readonly key: string; readonly before: string | null }
  /**
   * Move the row, with its anchored cards and everything it holds, before the
   * row keyed `before` (or to the rows' tail when null). A moved row whose
   * signature also changed is replaced right after the move.
   */
  | { readonly kind: 'move'; readonly key: string; readonly before: string | null }

export type TranscriptRowPlan =
  | {
      readonly kind: 'patch'
      /** Removals first, then replacements and insertions in transcript order. */
      readonly ops: readonly TranscriptRowOp[]
      /** How many rows stay untouched. */
      readonly kept: number
    }
  | {
      /**
       * The list holds a key twice, so rows cannot be matched by key and the
       * caller rebuilds the list instead.
       */
      readonly kind: 'rebuild'
      readonly reason: 'duplicate-key'
    }

/**
 * Plan how to turn the `rendered` rows (in list order) into the `wanted` rows
 * (in transcript order).
 */
export function planTranscriptRows(
  rendered: readonly TranscriptRow[],
  wanted: readonly TranscriptRow[],
): TranscriptRowPlan {
  const renderedByKey = new Map<string, TranscriptRow>()
  for (const row of rendered) {
    if (renderedByKey.has(row.key)) return { kind: 'rebuild', reason: 'duplicate-key' }
    renderedByKey.set(row.key, row)
  }
  const wantedKeys = new Set<string>()
  for (const row of wanted) {
    if (wantedKeys.has(row.key)) return { kind: 'rebuild', reason: 'duplicate-key' }
    wantedKeys.add(row.key)
  }

  // Rows present on both sides stay where they are when they are already in
  // transcript order. Otherwise the longest run of them that is still in order
  // stays put and only the rest move: the fewest rows leave their place.
  const wantedIndex = new Map(wanted.map((row, i) => [row.key, i]))
  const surviving = rendered.filter((row) => wantedKeys.has(row.key))
  const stable = longestIncreasingRun(surviving.map((row) => wantedIndex.get(row.key) ?? 0))
  const stableKeys = new Set(stable.map((i) => surviving[i]?.key ?? ''))

  const ops: TranscriptRowOp[] = []
  for (const row of rendered) {
    if (!wantedKeys.has(row.key)) ops.push({ kind: 'remove', key: row.key })
  }
  // The row each insertion or move goes before: the next wanted row that stays
  // where it is. Walk backwards so each lookup is O(1). Rows placed before the
  // same stable row are placed in transcript order, so they land in order.
  const placeBefore = new Map<string, string | null>()
  let nextStable: string | null = null
  for (let i = wanted.length - 1; i >= 0; i--) {
    const row = wanted[i]
    if (!row) continue
    if (stableKeys.has(row.key)) nextStable = row.key
    else placeBefore.set(row.key, nextStable)
  }
  let kept = 0
  for (const row of wanted) {
    const previous = renderedByKey.get(row.key)
    const before = placeBefore.get(row.key) ?? null
    if (!previous) {
      ops.push({ kind: 'insert', key: row.key, before })
      continue
    }
    if (!stableKeys.has(row.key)) ops.push({ kind: 'move', key: row.key, before })
    if (previous.signature !== row.signature) ops.push({ kind: 'replace', key: row.key })
    else kept++
  }
  return { kind: 'patch', ops, kept }
}

/**
 * Indexes into `values` of one longest strictly increasing subsequence
 * (patience sorting, O(n log n)). In the common case the whole input is
 * increasing and every index is returned.
 */
function longestIncreasingRun(values: readonly number[]): number[] {
  // tails[k]: index of the smallest tail value of an increasing run of length k + 1.
  const tails: number[] = []
  const previous = new Array<number>(values.length).fill(-1)
  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? 0
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((values[tails[mid] ?? 0] ?? 0) < value) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) previous[i] = tails[lo - 1] ?? -1
    tails[lo] = i
  }
  const run: number[] = []
  for (let i = tails.at(-1) ?? -1; i !== -1; i = previous[i] ?? -1) run.push(i)
  return run.reverse()
}

/**
 * Attributes of the cards the view anchors directly after a message element,
 * each naming the message it belongs to. They are part of that message's row.
 */
export const ROW_CARD_ATTRIBUTES = [
  'data-review-for',
  'data-review-report-for',
  'data-hook-cards-for',
  'data-turn-recovery-for',
] as const

function rowCardSelector(key: string): string {
  const quoted = CSS.escape(key)
  return ROW_CARD_ATTRIBUTES.map((attribute) => `:scope > [${attribute}="${quoted}"]`).join(', ')
}

function isRowCardOf(node: Element, key: string): boolean {
  return ROW_CARD_ATTRIBUTES.some((attribute) => node.getAttribute(attribute) === key)
}

/** The message element of row `key`, or null when it is not in the list. */
export function transcriptRowElement(list: HTMLElement, key: string): HTMLElement | null {
  return list.querySelector<HTMLElement>(`:scope > [data-message-id="${CSS.escape(key)}"]`)
}

/**
 * Detach row `key` (its message element and anchored cards), disposing any
 * inline artefact it hosted. Returns the node that followed the row, which is
 * where a rebuilt row belongs.
 */
export function removeTranscriptRow(list: HTMLElement, key: string): Element | null {
  const element = transcriptRowElement(list, key)
  let next = element?.nextElementSibling ?? null
  while (next && isRowCardOf(next, key)) next = next.nextElementSibling
  const parts = [...(element ? [element] : []), ...list.querySelectorAll(rowCardSelector(key))]
  for (const part of parts) {
    disposeInlineArtefacts(part)
    part.remove()
  }
  return next
}

export interface TranscriptRowHost {
  readonly list: HTMLElement
  /**
   * Build row `key` through the view's own build path and insert it before
   * `before`, or at the rows' tail (above the activity row and trailing
   * cards) when `before` is null.
   */
  insert: (key: string, before: Element | null) => void
  /** Where a row placed at the rows' tail goes: above the activity row and trailing cards. */
  tail: () => Element | null
}

/**
 * Move row `key` (its message element and anchored cards, in list order)
 * before `before`, or to the rows' tail when null. The nodes stay alive: a
 * moved row keeps its links, disclosures and inline artefacts.
 */
export function moveTranscriptRow(
  host: TranscriptRowHost,
  key: string,
  before: Element | null,
): void {
  const { list } = host
  const element = transcriptRowElement(list, key)
  const parts = [...(element ? [element] : []), ...list.querySelectorAll(rowCardSelector(key))]
  const target = before ?? host.tail()
  for (const part of parts) list.insertBefore(part, target)
}

/** Apply a `patch` plan to the list. */
export function applyTranscriptRowPlan(
  plan: Extract<TranscriptRowPlan, { kind: 'patch' }>,
  host: TranscriptRowHost,
): void {
  const { list } = host
  for (const op of plan.ops) {
    if (op.kind === 'remove') {
      removeTranscriptRow(list, op.key)
    } else if (op.kind === 'replace') {
      const next = removeTranscriptRow(list, op.key)
      host.insert(op.key, next)
    } else if (op.kind === 'move') {
      moveTranscriptRow(
        host,
        op.key,
        op.before === null ? null : transcriptRowElement(list, op.before),
      )
    } else {
      host.insert(op.key, op.before === null ? null : transcriptRowElement(list, op.before))
    }
  }
}

/**
 * What a call's card shows that lives on the thread rather than on the call:
 * the user's answer to a proposed thread (and whether the thread it started
 * still exists), or to a reviewer question.
 */
function callAnswer(store: AppStore, thread: Thread, call: ToolCall): unknown {
  if (isThreadProposalCall(call)) return threadProposalCardSignature(call, store, thread.id) ?? null
  if (isReviewerInputCall(call)) {
    return reviewerInputAnswer(thread.reviewerInputAnswers, call.id) ?? null
  }
  return undefined
}

/**
 * The canvas thumbnails a row draws: the message's own artefact cards and the
 * preview section of each finished canvas tool call (a run's anchor draws its
 * members' calls). Thumbnails live outside the thread (artefact-previews.ts).
 */
function previewTitles(message: Message, calls: readonly ToolCall[]): string[] {
  const titles = (message.canvasArtefacts ?? []).map((artefact) => artefact.title)
  for (const call of calls) {
    if (call.status !== 'done') continue
    const uri = artefactUriFromToolResult(call.result)
    if (uri) titles.push(artefactTitleFromUri(uri))
  }
  return titles
}

/**
 * The signature of `message`'s row: everything its build reads that
 * can change while the row stays in the list. Anything else a row shows
 * (concise classes, model labels, user actions, side-chat chips, hook-card
 * visibility) has its own sync pass that patches the row in place, and the
 * thread's own model is drawn only by the queued panel and the activity row,
 * which are chrome.
 *
 * - The message itself: streamed tokens and tool calls mutate it in place.
 *   Its turn outcome is left out and signed by what it draws instead (the
 *   interruption labels and recovery below; concise classes are synced on
 *   every reconcile), so the outcome landing at the end of a turn does not
 *   rebuild a reply that draws the same.
 * - Its multi-message run, whose rollup the anchor draws from every member.
 * - For a machine-origin prompt, the command whose wake it reports.
 * - Each tool call's user-interruption cause. A Stop marks the interrupted
 *   calls of every bubble in its turn, not only the bubble that carries the
 *   outcome, so an earlier bubble's cards change without its message moving.
 * - The thread-wide facts a call's card draws: the answer to a proposed thread
 *   or a reviewer question, and whether a started thread still exists.
 * - The version of each canvas thumbnail the row draws.
 * - What the thread status and the message's place in it change: whether its
 *   reasoning is live, the live step of its run, and the failed-turn recovery
 *   the last message offers (which also reads the thread's interrupted-turn
 *   marker).
 *
 * A build that starts reading another field of the message or thread must be
 * signed here too, or a row drawn from it will be kept when it changes.
 */
export function transcriptRowSignature(store: AppStore, thread: Thread, message: Message): string {
  const run = multiStepRunFor(thread, message.id)
  const liveStep = liveStepMessageId(thread)
  const origin = message.role === 'user' ? message.origin : undefined
  markUserInterruptedCalls(thread)
  // A run's anchor draws every member's calls.
  const calls = [...message.toolCalls, ...(run?.toolCalls ?? [])]
  return renderSignature({
    message: { ...message, turnOutcome: undefined },
    run: run ?? null,
    wake:
      origin?.kind === 'machine'
        ? (backgroundTaskCommandCall(thread, origin.operationId)?.id ?? null)
        : null,
    interrupted: calls.map((call) => userInterruption(call) ?? null),
    answers: calls.flatMap((call) => {
      const answer = callAnswer(store, thread, call)
      return answer === undefined ? [] : [[call.id, answer]]
    }),
    previews: previewTitles(message, calls).map((title) =>
      artefactPreviewVersion(thread.id, title),
    ),
    // What the thread status and the message's place at the end mean for this
    // row, rather than the raw facts: a finished reply that stops being the
    // last message draws exactly what it drew before, and keeps its row.
    live: isReasoningDisclosureLive(thread, message),
    liveStep: liveStep !== null && run?.memberIds.includes(liveStep) === true ? liveStep : null,
    recovery: turnRecoveryForMessage(thread, message.id),
  })
}

/** The rows the thread's transcript should show, in order, skipping `hidden` messages. */
export function wantedTranscriptRows(
  store: AppStore,
  thread: Thread,
  hidden: ReadonlySet<string>,
): TranscriptRow[] {
  return thread.messages
    .filter((message) => !hidden.has(message.id))
    .map((message) => ({
      key: message.id,
      signature: transcriptRowSignature(store, thread, message),
    }))
}

/**
 * A reading anchor whose row a reconcile rebuilt points at a detached element.
 * Hand it the rebuilt row with the same key so the reader stays on that
 * message, rather than falling back to the bare scroll offset.
 */
export function relinkReadingAnchor(
  list: HTMLElement,
  anchor: ReadingAnchor | null,
): ReadingAnchor | null {
  if (!anchor || anchor.element.isConnected) return anchor
  const key = anchor.element.dataset['messageId']
  const element = key === undefined ? null : transcriptRowElement(list, key)
  return element ? { element, viewportTop: anchor.viewportTop } : anchor
}

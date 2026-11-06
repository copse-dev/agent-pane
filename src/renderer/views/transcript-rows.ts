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
 * inserted at their position and rows that left the transcript are dropped.
 *
 * A kept row keeps everything that arrived after it was built — resolved
 * file-reference links, lazily built tool-card bodies, open disclosures and
 * hover-action transitions — which a whole-list rebuild threw away.
 *
 * The planner is pure; {@link applyTranscriptRowPlan} does the DOM work with
 * the view's own build path ({@link TranscriptRowHost.insert}), so a row
 * built here is identical to one the view appends live.
 */
import type { Message, Thread } from '@shared/types'
import { disposeInlineArtefacts } from '../canvas/inline-artefact.ts'
import { turnRecoveryForMessage } from '../controller/turn-recovery.ts'
import { backgroundTaskCommandCall } from './command-task-links.ts'
import { renderSignature } from './render-signature.ts'
import {
  isReasoningDisclosureLive,
  liveStepMessageId,
  multiStepRunFor,
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
       * The kept rows would have to move, or the list holds a key twice. Moving
       * rows is not worth a second code path: the transcript only ever
       * appends, edits or truncates, so the caller rebuilds the list instead.
       */
      readonly kind: 'rebuild'
      readonly reason: 'reordered' | 'duplicate-key'
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

  // Rows present on both sides must already be in transcript order.
  const survivingOrder = rendered.filter((row) => wantedKeys.has(row.key)).map((row) => row.key)
  const wantedOrder = wanted.filter((row) => renderedByKey.has(row.key)).map((row) => row.key)
  if (survivingOrder.some((key, i) => key !== wantedOrder[i])) {
    return { kind: 'rebuild', reason: 'reordered' }
  }

  const ops: TranscriptRowOp[] = []
  for (const row of rendered) {
    if (!wantedKeys.has(row.key)) ops.push({ kind: 'remove', key: row.key })
  }
  // The row each insertion goes before: the next wanted row that is already
  // in the list. Walk backwards so each lookup is O(1).
  const insertBefore = new Map<string, string | null>()
  let nextExisting: string | null = null
  for (let i = wanted.length - 1; i >= 0; i--) {
    const row = wanted[i]
    if (!row) continue
    if (renderedByKey.has(row.key)) nextExisting = row.key
    else insertBefore.set(row.key, nextExisting)
  }
  let kept = 0
  for (const row of wanted) {
    const previous = renderedByKey.get(row.key)
    if (!previous) {
      ops.push({ kind: 'insert', key: row.key, before: insertBefore.get(row.key) ?? null })
    } else if (previous.signature !== row.signature) {
      ops.push({ kind: 'replace', key: row.key })
    } else kept++
  }
  return { kind: 'patch', ops, kept }
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
    } else {
      host.insert(op.key, op.before === null ? null : transcriptRowElement(list, op.before))
    }
  }
}

/**
 * The signature of `message`'s row: everything its build reads that
 * can change while the row stays in the list. Anything else a row shows
 * (concise classes, model labels, user actions, side-chat chips, hook-card
 * visibility) has its own sync pass that patches the row in place.
 *
 * - The message itself, in full: streamed tokens, tool calls and turn outcomes
 *   all mutate it in place.
 * - Its multi-message run, whose rollup the anchor draws from every member.
 * - For a machine-origin prompt, the command whose wake it reports.
 * - What the thread status and the message's place in it change: whether its
 *   reasoning is live, the live step of its run, and the failed-turn recovery
 *   the last message offers.
 */
export function transcriptRowSignature(thread: Thread, message: Message): string {
  const run = multiStepRunFor(thread, message.id)
  const liveStep = liveStepMessageId(thread)
  const origin = message.role === 'user' ? message.origin : undefined
  return renderSignature({
    message,
    run: run ?? null,
    wake:
      origin?.kind === 'machine'
        ? (backgroundTaskCommandCall(thread, origin.operationId)?.id ?? null)
        : null,
    // What the thread status and the message's place at the end mean for this
    // row, rather than the raw facts: a finished reply that stops being the
    // last message draws exactly what it drew before, and keeps its row.
    live: isReasoningDisclosureLive(thread, message),
    liveStep: liveStep !== null && run?.memberIds.includes(liveStep) === true ? liveStep : null,
    recovery: turnRecoveryForMessage(thread, message.id),
  })
}

/** The rows the thread's transcript should show, in order, skipping `hidden` messages. */
export function wantedTranscriptRows(thread: Thread, hidden: ReadonlySet<string>): TranscriptRow[] {
  return thread.messages
    .filter((message) => !hidden.has(message.id))
    .map((message) => ({
      key: message.id,
      signature: transcriptRowSignature(thread, message),
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

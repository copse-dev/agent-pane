/**
 * Keyed reconciliation of the transcript's message rows (#3962).
 *
 * A row is one message's `.msg[data-message-id]` element plus the cards the
 * view anchors right after it (inline review, review report, hook cards, turn
 * recovery). Each row carries a signature of everything it was built from:
 * the message itself and the few thread facts that change what a message
 * renders (its multi-message run, live reasoning and failed-turn recovery).
 * When the transcript's inputs change, the view plans against the rows
 * already in the list: rows whose signature still matches are kept as they
 * are, changed rows are rebuilt in place, new rows are inserted at their
 * position and rows that left the transcript are dropped.
 *
 * The view's streaming handlers also patch rows in place between reconciles.
 * They only note which rows they touched; {@link adoptPatchedSignatures} lets
 * the next reconcile count such a row as drawing what its message is now,
 * so a streamed reply is kept too, without signing anything per event.
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
import type { ToolRun } from '@shared/tools/tool-runs.ts'
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

/**
 * What a row was built from, in the two parts a reconcile treats differently
 * (see {@link transcriptRowSignature}).
 */
export interface TranscriptRowSignature {
  /**
   * What the view's streaming handlers keep current as they patch the row in
   * place. A reconcile takes the current value for a row patched since the
   * last one, instead of comparing it.
   */
  readonly patched: string
  /** What changes without any handler reaching the row: always compared. */
  readonly settled: string
}

/** A row as the planner sees it: its key (the message id) and its signature. */
export interface TranscriptRow {
  readonly key: string
  readonly signature: TranscriptRowSignature
}

/** A row the transcript should show, as {@link wantedTranscriptRows} derives it. */
export interface WantedTranscriptRow extends TranscriptRow {
  /**
   * The messages whose in-place patches redraw this row: the members of its
   * multi-message run, whose rollup the anchor draws, or the row's own message.
   */
  readonly patchedBy: readonly string[]
}

export function sameSignature(a: TranscriptRowSignature, b: TranscriptRowSignature): boolean {
  return a.patched === b.patched && a.settled === b.settled
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
    } else if (!sameSignature(previous.signature, row.signature)) {
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
 * (model labels, user actions, side-chat chips, hook-card visibility) has its
 * own sync pass that patches the row in place, and the thread's own model is
 * drawn only by the queued panel and the activity row, which are chrome.
 *
 * `patched` holds what the streaming handlers redraw in place as they patch
 * the row (tokens, reasoning, ACP content, tool calls, segment and turn end,
 * canvas, visual evidence, review and hook cards):
 *
 * - The message itself, but its turn outcome: streamed tokens and tool calls
 *   mutate it in place. The outcome is signed by what it draws instead (the
 *   settled facts below), so the outcome landing at the end of a turn does not
 *   rebuild a reply that draws the same.
 * - Its multi-message run, whose rollup the anchor draws from every member.
 * - Whether its reasoning is live and the live step of its run: what the
 *   thread status and the message's place at the end mean for this row,
 *   rather than the raw facts, so a finished reply that stops being the last
 *   message draws exactly what it drew before, and keeps its row.
 *
 * `settled` holds what no handler redraws, so a reconcile always compares it:
 *
 * - The run a non-anchor member belongs to. A member's own bubble is hidden
 *   inside the anchor's rollup only when it is built as one, and a step joins
 *   its run with a reasoning chunk that never repaints that bubble.
 * - Each tool call's user-interruption cause. A Stop marks the interrupted
 *   calls of every bubble in its turn, not only the bubble that carries the
 *   outcome, so an earlier bubble's cards change without its message moving.
 *   Only causes are listed, so a call starting does not change it.
 * - The canvas references and visual evidence the message carries. Their
 *   handlers append each section to the bubble as it arrives, ahead of the
 *   reply actions the segment's end adds; a build draws the actions first.
 * - Whether the turn failed here, which the concise classes read.
 * - The thread-wide facts a call's card draws: the answer to a proposed
 *   thread or a reviewer question, and whether a started thread still exists.
 * - The version of each canvas thumbnail the row draws.
 * - The failed-turn recovery the last message offers (which also reads the
 *   thread's interrupted-turn marker).
 * - For a machine-origin prompt, the command whose wake it reports.
 *
 * A build that starts reading another field of the message or thread must be
 * signed here too, or a row drawn from it will be kept when it changes.
 */
export function transcriptRowSignature(
  store: AppStore,
  thread: Thread,
  message: Message,
): TranscriptRowSignature {
  return signRow(store, thread, message, multiStepRunFor(thread, message.id))
}

function signRow(
  store: AppStore,
  thread: Thread,
  message: Message,
  run: ToolRun | undefined,
): TranscriptRowSignature {
  const liveStep = liveStepMessageId(thread)
  const origin = message.role === 'user' ? message.origin : undefined
  markUserInterruptedCalls(thread)
  // A run's anchor draws every member's calls.
  const calls = [...message.toolCalls, ...(run?.toolCalls ?? [])]
  return {
    patched: renderSignature({
      message: { ...message, turnOutcome: undefined },
      run: run ?? null,
      live: isReasoningDisclosureLive(thread, message),
      liveStep: liveStep !== null && run?.memberIds.includes(liveStep) === true ? liveStep : null,
    }),
    settled: renderSignature({
      memberOf: run && run.anchorId !== message.id ? run.anchorId : null,
      interrupted: calls.flatMap((call) => {
        const cause = userInterruption(call)
        return cause === undefined ? [] : [[call.id, cause]]
      }),
      sections: [
        (message.canvasArtefacts ?? []).map((artefact) => artefact.title),
        (message.visualEvidence ?? []).map((evidence) => evidence.id),
      ],
      answers: calls.flatMap((call) => {
        const answer = callAnswer(store, thread, call)
        return answer === undefined ? [] : [[call.id, answer]]
      }),
      previews: previewTitles(message, calls).map((title) =>
        artefactPreviewVersion(thread.id, title),
      ),
      failed: message.turnOutcome?.status === 'failed',
      recovery: turnRecoveryForMessage(thread, message.id),
      wake:
        origin?.kind === 'machine'
          ? (backgroundTaskCommandCall(thread, origin.operationId)?.id ?? null)
          : null,
    }),
  }
}

/** The rows the thread's transcript should show, in order, skipping `hidden` messages. */
export function wantedTranscriptRows(
  store: AppStore,
  thread: Thread,
  hidden: ReadonlySet<string>,
): WantedTranscriptRow[] {
  return thread.messages
    .filter((message) => !hidden.has(message.id))
    .map((message) => {
      const run = multiStepRunFor(thread, message.id)
      return {
        key: message.id,
        signature: signRow(store, thread, message, run),
        patchedBy: run ? run.memberIds : [message.id],
      }
    })
}

/**
 * The `rendered` rows as a reconcile should compare them, given the messages
 * the view's streaming handlers patched in place since the last reconcile.
 *
 * A handler that patches a row brings what the row's `patched` signature
 * covers up to date, so a row that any of its {@link WantedTranscriptRow.patchedBy}
 * messages patched takes that part from `wanted`; its `settled` part stays
 * what the row was built with, so what no handler draws (an interruption
 * landing with the turn outcome, a step joining a run) still rebuilds it.
 *
 * That only holds while every change since the patch reached the rows through
 * a handler. When a message was replaced from outside the stream (an edit, a
 * runtime snapshot) or the list itself must change shape around the rows (a
 * row removed, or one inserted above a kept row), a patch may have drawn a
 * run that no longer exists, so `rendered` is returned as it is and changed
 * rows are rebuilt. `drawsCurrent(i)` says whether rendered row `i` was last
 * drawn from the message its thread holds now; a message whose turn outcome
 * alone changed still counts (see {@link sameExceptTurnOutcome}).
 */
export function adoptPatchedSignatures(
  rendered: readonly TranscriptRow[],
  wanted: readonly WantedTranscriptRow[],
  patched: ReadonlySet<string>,
  drawsCurrent: (index: number) => boolean,
): readonly TranscriptRow[] {
  if (patched.size === 0) return rendered
  const renderedKeys = new Set(rendered.map((row) => row.key))
  const wantedByKey = new Map(wanted.map((row) => [row.key, row]))
  if (rendered.some((row, index) => !wantedByKey.has(row.key) || !drawsCurrent(index))) {
    return rendered
  }
  // Rows only ever arrive at the tail, after the last row already drawn.
  let tail = false
  for (const row of wanted) {
    if (!renderedKeys.has(row.key)) tail = true
    else if (tail) return rendered
  }
  return rendered.map((row) => {
    const current = wantedByKey.get(row.key)
    if (!current?.patchedBy.some((id) => patched.has(id))) return row
    return {
      key: row.key,
      signature: { patched: current.signature.patched, settled: row.signature.settled },
    }
  })
}

/**
 * Whether `next` is `drawn` with at most a new turn outcome: the one field the
 * stream sets by replacing the message rather than patching it in place, and
 * which the row signature leaves to what it draws. `redrawn` names further
 * fields a handler replaces the message for and redraws itself (a review, a
 * review report), which may differ too.
 */
export function sameExceptTurnOutcome(
  drawn: Message,
  next: Message,
  redrawn: readonly (keyof Message)[] = [],
): boolean {
  if (drawn === next) return true
  const skipped = new Set<string>(['turnOutcome', ...redrawn])
  const nextEntries = new Map(Object.entries(next).filter(([key]) => !skipped.has(key)))
  const drawnEntries = Object.entries(drawn).filter(([key]) => !skipped.has(key))
  return (
    drawnEntries.length === nextEntries.size &&
    drawnEntries.every(([key, value]) => nextEntries.has(key) && nextEntries.get(key) === value)
  )
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

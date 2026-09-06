/**
 * Model-proposed threads: the agent can offer a follow-up run it thinks is worth
 * doing *somewhere else* — a refactor it spotted mid-task, a test gap, a
 * migration — instead of quietly widening the turn it is on.
 *
 * The offer is not a gate. A permission prompt interrupts because the action is
 * already happening and cannot proceed without an answer; this is the opposite
 * shape — nothing is running, nothing is blocked, and ignoring the card forever
 * is a perfectly good outcome. So the proposal is recorded as ordinary tool-call
 * data, rendered inline in the transcript, and only becomes a thread when the
 * user says so. Two consequences the wording and the types both have to keep:
 *
 * 1. **The model never learns whether it was accepted.** The tool returns
 *    immediately (see {@link threadProposalAcknowledgement}) so the agent loop
 *    is never held hostage by a decision nobody is present to make, and so a
 *    dismissed proposal costs the current turn nothing.
 * 2. **The user reads prose, not a prompt.** `summary` is the human-readable
 *    description of what the run would do; `prompt` is the machine text that
 *    seeds the new thread. They are separate fields because writing one and
 *    showing the other is how these cards turn into unreadable JSON dumps.
 *
 * Pure and Node-free: the store, the renderer, the tool, and unit tests share
 * one definition of the shape and one definition of the wording.
 */

import { isRecord } from '@copse/std/unknown-value.ts'
import type { ThreadCheckoutMode } from './worktree-types.ts'
import { isNonBlankString } from '@copse/std/nullish.ts'

/** The tool the agent calls to offer one. */
export const THREAD_PROPOSAL_TOOL = 'propose_thread'

/** Longest title/summary we render before the card starts looking like prose. */
export const THREAD_PROPOSAL_TITLE_MAX = 80
export const THREAD_PROPOSAL_SUMMARY_MAX = 400

/** How many touched paths a card lists before collapsing the rest into a count. */
export const THREAD_PROPOSAL_FILES_SHOWN = 4

/**
 * One offered thread, as authored by the model. `id` is the tool call's own id,
 * which is what makes a proposal addressable after a reload without persisting a
 * second copy of it: the transcript already carries the call.
 */
export interface ThreadProposal {
  id: string
  /** Short name for the work, used as the card heading and the thread title. */
  title: string
  /** Plain-language description of what the new thread would do. */
  summary: string
  /** Why this belongs in its own thread rather than the current one. */
  rationale?: string
  /** The exact text the new thread is started with. */
  prompt: string
  /** Paths the run expects to touch, for the card only. */
  files?: string[]
}

/**
 * Where an offer has got to. `pending` is the resting state and survives
 * restarts — an unanswered proposal is not a stuck prompt, it is a standing
 * offer.
 */
export type ThreadProposalStatus = 'pending' | 'started' | 'dismissed'

/** A user's answer to one proposal, persisted on the proposing thread's meta. */
export interface ThreadProposalDecision {
  /** The {@link ThreadProposal.id} this answers. */
  id: string
  status: Exclude<ThreadProposalStatus, 'pending'>
  decidedAt: number
  /** Thread the `started` decision created; absent for `dismissed`. */
  threadId?: string
  /**
   * The checkout the started thread actually got — **the outcome, not the ask**.
   *
   * The card offers work "in its own checkout", but that is a request the
   * repository can refuse: `decideThreadWorktreePolicy` degrades to `shared`
   * for a non-git folder, a remote project, a detached HEAD, or a project with
   * worktrees disabled. Recording what was granted is what lets the settled
   * card say so instead of leaving a promise it did not keep standing as the
   * last word. Absent on decisions written before this was captured, which
   * read as "not known" rather than as isolated.
   */
  checkoutMode?: ThreadCheckoutMode
}

function trimTo(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`
}

function stringField(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function stringListField(args: Record<string, unknown>, key: string): string[] {
  const value = args[key]
  if (!Array.isArray(value)) return []
  return value.filter(isNonBlankString).map((entry) => entry.trim())
}

/**
 * Decode a `propose_thread` call's arguments into a card. Returns null when the
 * model omitted anything the card cannot be drawn without — a proposal with no
 * prompt cannot start a thread, and one with no summary would show the user the
 * raw prompt and call it a description.
 *
 * Tolerant of extra keys and of a persisted transcript's `args` being `unknown`:
 * this runs over both live stream chunks and JSON read back off disk.
 */
export function parseThreadProposal(id: string, args: unknown): ThreadProposal | null {
  if (id === '' || !isRecord(args)) return null
  const title = stringField(args, 'title')
  const summary = stringField(args, 'summary')
  const prompt = stringField(args, 'prompt')
  if (!title || !summary || !prompt) return null
  const rationale = stringField(args, 'rationale')
  const files = stringListField(args, 'files')
  return {
    id,
    title: trimTo(title, THREAD_PROPOSAL_TITLE_MAX),
    summary: trimTo(summary, THREAD_PROPOSAL_SUMMARY_MAX),
    ...(rationale ? { rationale: trimTo(rationale, THREAD_PROPOSAL_SUMMARY_MAX) } : {}),
    prompt,
    ...(files.length > 0 ? { files } : {}),
  }
}

/** Current state of one proposal, given the thread's recorded decisions. */
export function threadProposalStatus(
  decisions: readonly ThreadProposalDecision[] | undefined,
  id: string,
): ThreadProposalStatus {
  return findThreadProposalDecision(decisions, id)?.status ?? 'pending'
}

export function findThreadProposalDecision(
  decisions: readonly ThreadProposalDecision[] | undefined,
  id: string,
): ThreadProposalDecision | undefined {
  return decisions?.find((decision) => decision.id === id)
}

/**
 * Record an answer, replacing any earlier one for the same proposal. Answers are
 * keyed by proposal rather than appended so an undo followed by a start leaves
 * one row, not a decision log — the log that matters (a thread exists, or does
 * not) is the workspace itself.
 */
export function recordThreadProposalDecision(
  decisions: readonly ThreadProposalDecision[] | undefined,
  decision: ThreadProposalDecision,
): ThreadProposalDecision[] {
  const rest = (decisions ?? []).filter((entry) => entry.id !== decision.id)
  return [...rest, decision]
}

/** Drop an answer entirely, returning the proposal to its standing-offer state. */
export function clearThreadProposalDecision(
  decisions: readonly ThreadProposalDecision[] | undefined,
  id: string,
): ThreadProposalDecision[] {
  return (decisions ?? []).filter((entry) => entry.id !== id)
}

/**
 * What the agent is told the instant it proposes. The wording is load-bearing,
 * so it lives here with a test rather than being retyped at the call site: the
 * model has to read this as "offered, now carry on", never as "queued and will
 * happen" (which would let it report work nobody agreed to) and never as
 * "rejected" (which invites it to re-propose the same thing in a loop).
 */
export function threadProposalAcknowledgement(proposal: ThreadProposal): string {
  return (
    `Offered to the user: "${proposal.title}". They can start it as a separate ` +
    'thread with its own checkout, or leave it. Nothing has run and nothing is ' +
    'waiting on you — the offer stands on its own after this turn ends, so do ' +
    'not wait for an answer, do not do the work here, and do not propose the ' +
    'same thing again in this thread.'
  )
}

/** One-line summary of what a card's meta row says, shared by the UI and tests. */
export function threadProposalFileSummary(files: readonly string[] | undefined): string | null {
  if (!files || files.length === 0) return null
  if (files.length <= THREAD_PROPOSAL_FILES_SHOWN) return files.join(', ')
  const shown = files.slice(0, THREAD_PROPOSAL_FILES_SHOWN).join(', ')
  return `${shown} +${String(files.length - THREAD_PROPOSAL_FILES_SHOWN)} more`
}

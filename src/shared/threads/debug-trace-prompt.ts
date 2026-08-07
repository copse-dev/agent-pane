import type { Thread } from '@shared/types'

/**
 * "Debug trace" — the composer action that opens a new thread holding the zipped
 * trace of the thread you were just looking at, plus the draft prompt built here.
 *
 * The prompt is a *draft*, never a send. What the archive cannot contain is the
 * one thing only the person watching knows: which part of that run looked wrong.
 * So this states the facts about the thread under investigation that are tedious
 * to recover from a zip, fixes the shape of the answer, and ends on an open line
 * for the user to say what they saw before they submit.
 *
 * The mechanics of unpacking are deliberately absent — the archive attachment's
 * own steering block (`build-text-with-attachments.ts`) already tells the agent
 * about `read_archive` and does it better than a restatement here would.
 */

/** How the trace's on-disk layout is described to the model, once unpacked. */
const TRACE_LAYOUT =
  'a full copy of its thread directory: `meta.json`, the append-only `events.jsonl` ' +
  'spine, message prose under `messages/*.md`, tool arguments and results under ' +
  '`blobs/`, plans, and any nested subagent runs'

/** Title for the thread the action opens, so it is findable in the sidebar later. */
export function debugTraceThreadTitle(thread: Thread): string {
  const source = thread.title.trim() || thread.id
  return `Debug: ${source}`.slice(0, 60)
}

export function buildDebugTracePrompt(thread: Thread, archiveName: string): string {
  const facts = [
    `- Id: \`${thread.id}\``,
    `- Title: ${thread.title.trim() || '(untitled)'}`,
    `- Status: ${thread.status}`,
    `- Model: ${thread.model ?? '(unset)'}`,
    `- Messages: ${String(thread.messages.length)}`,
  ]
  // History trimming is one of the likelier explanations for a thread that
  // "forgot" something, and it is invisible in the transcript itself — the
  // messages it dropped are simply not there. Say so up front when it happened.
  const trims = thread.contextTrims?.length ?? 0
  if (trims > 0) {
    facts.push(
      `- Context trims: ${String(trims)} (history was dropped mid-run — check whether that lost something it needed)`,
    )
  }

  return [
    'Something went wrong in another Copse thread and I would like you to work out what.',
    '',
    `The attached \`${archiveName}\` is that thread's trace — ${TRACE_LAYOUT}. Read it in order rather than skimming the end: the cause is usually earlier than the symptom.`,
    '',
    'Thread under investigation:',
    '',
    ...facts,
    '',
    'What I am after:',
    '',
    '1. A short timeline — what the thread was asked to do, and what it actually did.',
    '2. Where it went wrong: the specific message, tool call, or decision, quoted from the trace.',
    '3. Why: the failure mode behind it, not just the error text. A bad tool result, a misread file, context lost to trimming, a loop, a wrong assumption carried forward, a provider or tool failure.',
    '4. What would have prevented it — a concrete change to the prompt, the tooling, or Copse itself.',
    '',
    'Quote the trace for anything you claim, and do not fix anything in my working tree; this is a diagnosis, not a repair. If the trace does not actually show a failure, say so and tell me what it does show instead of inventing a fault to explain.',
    '',
    'What I saw: ',
  ].join('\n')
}

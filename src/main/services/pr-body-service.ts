import type { FollowUpContext } from '@shared/follow-ups/types.ts'
import {
  resolveSmallTasksProvider,
  resolveSmallTasksModelId,
} from './providers/small-tasks-provider.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { recordUsageEvent } from './storage/usage-ledger.ts'
import { getSetting } from './storage/settings.ts'
import { getGitChangeStats, getCommittedChanges } from './github/git-service.ts'
import { getWorkspaceRoot } from './workspace.ts'

/** Keep a proposed body reviewable in a dialog field, and bounded over IPC. */
const MAX_PR_BODY_CHARS = 2000
/** Enough files to describe the shape of a change without pasting a tree. */
const MAX_LISTED_FILES = 25

/** Fixed body for e2e / headless runs, so the dialog is drivable without a model. */
export function mockPrBody(): string {
  return 'Rolls tool activity up across adjacent assistant messages.\n\n- Groups a run under its anchor message\n- Keeps acronyms upper case in humanized tool names'
}

/**
 * Propose a pull-request body for the work on this branch.
 *
 * This is the *first* of the two halves the "Create PR" chip splits the old
 * agent turn into, and the only one that wants a model at all. It runs while
 * the dialog is open — a description the user is about to read and edit is
 * worth waiting on; one produced after they have already pressed Create is
 * just latency in front of a `gh` call whose every argument is settled.
 *
 * Null when no small-tasks provider is configured, or the model returns
 * nothing: the dialog then leaves the field empty and the user writes their own
 * (or lets GitHub's template stand), which is strictly better than blocking the
 * PR on an unavailable model.
 */
export async function suggestPrBody(
  context: FollowUpContext,
  root: string | null = getWorkspaceRoot(),
): Promise<string | null> {
  if (
    process.env['COPSE_PANEL_MOCK_FOLLOW_UPS'] === '1' ||
    getSetting<boolean>('mockFollowUps', false)
  ) {
    return mockPrBody()
  }

  const provider = await resolveSmallTasksProvider()
  if (!provider) return null

  const prompt = buildPrBodyPrompt(context, await describeChanges(root))
  try {
    const model = resolveSmallTasksModelId()
    const { text, usage } = await completeTextWithUsage(provider, prompt, 20_000)
    if (usage.inputTokens || usage.outputTokens) {
      recordUsageEvent({
        model,
        source: 'small-tasks',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })
    }
    const body = text.trim().slice(0, MAX_PR_BODY_CHARS)
    return body || null
  } catch {
    return null
  }
}

/**
 * The deterministic half of the prompt: what actually changed on disk. The turn
 * transcript says what the agent *meant* to do; the file list says what it did,
 * and a body that names the wrong files is worse than a terse one.
 */
async function describeChanges(root: string | null): Promise<string> {
  const lines: string[] = []
  const stats = await getGitChangeStats(root)
  if (stats) lines.push(`Uncommitted: +${String(stats.additions)} -${String(stats.deletions)}`)
  // hasOpenPr is false by construction here — the chip that opens this dialog is
  // only offered when no PR carries the branch — so this compares against the
  // default branch and lists everything the PR would contain.
  const committed = await getCommittedChanges(root, { hasOpenPr: () => Promise.resolve(false) })
  const paths = (committed?.changes ?? []).map((change) => change.path)
  if (paths.length > 0) {
    lines.push(`Files (vs ${committed?.baseLabel ?? 'base'}):`)
    for (const path of paths.slice(0, MAX_LISTED_FILES)) lines.push(`- ${path}`)
    if (paths.length > MAX_LISTED_FILES) {
      lines.push(`- …and ${String(paths.length - MAX_LISTED_FILES)} more`)
    }
  }
  return lines.join('\n')
}

/** Exported for tests: the prompt is the whole behaviour of this service. */
export function buildPrBodyPrompt(context: FollowUpContext, changeSummary: string): string {
  return (
    'Write the body of a GitHub pull request for the change described below.\n' +
    'Rules: British English. Markdown. Start with one short paragraph saying what ' +
    'the change does and why, then a bullet list of the notable parts. ' +
    'No title, no heading, no "Summary" label, no test plan, no attribution — ' +
    'those are added elsewhere. Describe only what the change actually does; if ' +
    'the material below does not say, leave it out.\n\n' +
    'Request:\n' +
    context.userMessage.slice(0, 800) +
    '\n\nWhat the agent reported:\n' +
    context.assistantMessage.slice(0, 1500) +
    (context.toolNames.length > 0 ? `\n\nTools used: ${context.toolNames.join(', ')}` : '') +
    (changeSummary ? `\n\nChanges on the branch:\n${changeSummary}` : '')
  )
}

import type { RemoteAgentProvider } from './remote-agent-provider.ts'
import type { Thread } from './thread-types.ts'
import { githubPrKey, parseGithubPrUrl } from './github-pr-url.ts'

/**
 * Durable link between a cloud-agent run, the GitHub PR it produced, and the
 * chat thread that launched it (issue #690, Q6). Persisted on the launching
 * thread's `meta.json` as the source of truth; a per-project reverse index
 * (`agent-pr-index.jsonl`) is derived from these so the PR pane can answer
 * "which thread/agent owns PR #123" without scanning every thread.
 *
 * `agentId` + `provider` + `createdAt` are known at launch; `runId`, `branch`,
 * and `repo` are recorded when available; `prUrl` is filled in once the agent's
 * output reveals the PR it opened (agents launch with `autoCreatePR`).
 */
export interface RemoteAgentLink {
  provider: RemoteAgentProvider
  /** Provider-side agent id (Cursor agent / Anthropic managed agent). */
  agentId: string
  /** Provider-side run/session id for the launching turn, when the API exposes one. */
  runId?: string
  /**
   * This link was imported from a cloud agent launched outside Copse.
   *
   * Imported links can be refreshed from the provider's durable run snapshot;
   * Copse-owned live turns keep their renderer-owned streaming lifecycle.
   */
  imported?: true
  /** The PR the agent opened, once detected. */
  prUrl?: string
  /** Local branch the run was seeded from. */
  branch?: string
  /** `owner/repo` slug the agent worked on. */
  repo?: string
  createdAt: number
}

/** Prefix of the app-authored notice in legacy imported Cursor-agent stubs. */
export const IMPORTED_CURSOR_AGENT_NOTICE_PREFIX = '_Imported Cursor cloud agent — '
const LEGACY_IMPORTED_CURSOR_AGENT_NOTICE =
  /^_Imported Cursor cloud agent — \[([^\]\n]+)]\(([^()\n]+)\)\. Send a message here to continue that run from Copse\._$/

const IMPORTED_CURSOR_AGENT_RESULT_ID = /^remote-cursor-run-[a-f0-9]{64}$/

function isImportedCursorAgentNotice(
  thread: Thread,
  messageIndex: number,
  link: RemoteAgentLink,
): boolean {
  const message = thread.messages[messageIndex]
  if (!message || message.role !== 'assistant' || message.toolCalls.length !== 0) return false
  const match = LEGACY_IMPORTED_CURSOR_AGENT_NOTICE.exec(message.content)
  return (
    match !== null &&
    thread.model === 'remote-agent:cursor' &&
    thread.title === match[1] &&
    thread.createdAt === link.createdAt &&
    message.createdAt === link.createdAt
  )
}

/**
 * Whether a thread has durable external-import provenance.
 *
 * New imports carry `link.imported`. Stubs written before that field existed
 * must match the complete app-authored notice shape and its other immutable
 * stub fields; a prefix in arbitrary assistant prose is not enough.
 */
export function isImportedCursorAgentThread(thread: Thread, expectedResultId?: string): boolean {
  const link = thread.remoteAgentLink
  if (link?.provider !== 'cursor') return false
  if (link.imported === true) {
    const isResult = (messageIndex: number): boolean => {
      const message = thread.messages[messageIndex]
      if (!message) return false
      return (
        (expectedResultId
          ? message.id === expectedResultId
          : IMPORTED_CURSOR_AGENT_RESULT_ID.test(message.id)) &&
        message.role === 'assistant' &&
        message.toolCalls.length === 0
      )
    }
    // An externally imported stub stays refreshable through its one
    // provider-owned terminal snapshot. Any other message is local work and
    // must never admit the old cloud result after that turn settles.
    return (
      thread.messages.length === 0 ||
      (thread.messages.length === 1 &&
        (isImportedCursorAgentNotice(thread, 0, link) || isResult(0))) ||
      (thread.messages.length === 2 && isImportedCursorAgentNotice(thread, 0, link) && isResult(1))
    )
  }
  // A crash may land the terminal spine message before the follow-up metadata
  // migration writes `imported: true`. Accept only the exact app notice plus
  // that expected provider result so a retry can complete the migration.
  const isResult = (messageIndex: number): boolean => {
    const message = thread.messages[messageIndex]
    if (!message) return false
    return (
      (expectedResultId
        ? message.id === expectedResultId
        : IMPORTED_CURSOR_AGENT_RESULT_ID.test(message.id)) &&
      message.role === 'assistant' &&
      message.toolCalls.length === 0
    )
  }
  return (
    (thread.messages.length === 1 && isImportedCursorAgentNotice(thread, 0, link)) ||
    (thread.messages.length === 2 && isImportedCursorAgentNotice(thread, 0, link) && isResult(1))
  )
}

/** One line of a project's `agent-pr-index.jsonl` reverse index. */
export interface RemoteAgentPrIndexEntry {
  prUrl: string
  threadId: string
  agentId: string
  provider: RemoteAgentProvider
}

/**
 * Stable key for the `prUrl → thread` reverse index (`owner/repo#number`), or
 * null when the string is not a recognizable GitHub PR URL. The key is derived
 * from owner/repo/number, so the same PR referenced by slightly different URLs
 * (trailing slash, a `/files` or `/commits` sub-tab suffix) collapses to one
 * entry.
 */
export function remoteAgentPrIndexKey(prUrl: string): string | null {
  const ref = parseGithubPrUrl(prUrl)
  return ref ? githubPrKey(ref) : null
}

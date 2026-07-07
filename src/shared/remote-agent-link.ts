import type { RemoteAgentProvider } from './remote-agent.ts'
import { githubPrKey, parseGithubPrUrl } from './git/github-pr-url.ts'

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
  /** The PR the agent opened, once detected. */
  prUrl?: string
  /** Local branch the run was seeded from. */
  branch?: string
  /** `owner/repo` slug the agent worked on. */
  repo?: string
  createdAt: number
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

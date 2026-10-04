import { randomUUID } from 'node:crypto'
import type { CommitProduction } from '@shared/git/thread-pr-relations.ts'
import type { ThreadExecutionContext } from '../thread-execution-context-store.ts'

export interface CommitProductionDependencies {
  repository: string | null
  readGit: (args: string[]) => Promise<{ code: number; stdout: string }>
  record: (projectId: string, threadId: string, evidence: CommitProduction) => Promise<void>
}

/** Called only after git_commit succeeds. Never attributes a subsequent shared HEAD. */
export async function recordSuccessfulCommit(
  output: string,
  context: ThreadExecutionContext | null,
  deps: CommitProductionDependencies,
): Promise<boolean> {
  if (!context || !deps.repository) return false
  // Hook output can contain arbitrary text: ambiguous summaries are not evidence.
  const summaries = [...output.matchAll(/^\[[^\]\n]+ ([a-f0-9]{7,64})\] /gmu)]
  const reported = summaries.length === 1 ? summaries[0]?.[1] : undefined
  if (!reported) return false
  const result = await deps.readGit(['rev-parse', '--verify', `${reported}^{commit}`])
  const sha = result.stdout.trim().toLowerCase()
  if (
    result.code !== 0 ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha) ||
    !sha.startsWith(reported)
  )
    return false
  await deps.record(context.projectId, context.threadId, {
    repository: deps.repository.toLowerCase(),
    sha,
    source: 'git-commit',
    eventId: randomUUID(),
    createdAt: Date.now(),
  })
  return true
}

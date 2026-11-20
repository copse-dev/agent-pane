import type { UserContent } from '@shared/types/llm.ts'
import { commitShaExists } from '../github/git-service.ts'

// Keep only standalone Git identifiers. Values embedded in paths, URLs, email
// local-parts or larger identifiers stay on the ordinary privacy path.
const FULL_COMMIT_SHA = /(?<![a-z0-9_./:@+%=-])[a-f0-9]{40}(?![a-z0-9_/:@+%=-]|\.[a-z0-9])/gi
const MAX_COMMIT_CANDIDATES = 16

function promptText(content: UserContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Find exact user-typed commit IDs that are safe to keep through PII redaction.
 *
 * Shape alone is never enough: every value must resolve locally to a commit in
 * this turn's repository. Bounded validation prevents an adversarial prompt
 * from turning privacy preflight into an unbounded Git probe.
 */
export async function localPromptCommitIds(
  content: UserContent,
  root: string | null,
): Promise<readonly string[]> {
  if (!root) return []
  const candidates = [...new Set(promptText(content).match(FULL_COMMIT_SHA) ?? [])].slice(
    0,
    MAX_COMMIT_CANDIDATES,
  )
  const existing: string[] = []
  for (const candidate of candidates) {
    if (await commitShaExists(candidate, root)) existing.push(candidate)
  }
  return existing
}

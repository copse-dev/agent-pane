import type { UserContent } from '@shared/types/llm.ts'
import { commitShaExists } from '../github/git-service.ts'
import type { PreservedTextSpan } from './pii-redactor.ts'

// Keep only standalone Git identifiers. Values embedded in paths, URLs, email
// local-parts or larger identifiers stay on the ordinary privacy path.
const FULL_COMMIT_SHA =
  /(?<![\p{ID_Continue}./\\:@+%=-])[a-f0-9]{40}(?![\p{ID_Continue}/\\:@+%=-]|\.[\p{ID_Continue}])/giu
const MAX_COMMIT_CANDIDATES = 16
const MAX_COMMIT_OCCURRENCES = 64

function textBlocks(content: UserContent): ReadonlyArray<{ blockIndex: number; text: string }> {
  if (typeof content === 'string') return [{ blockIndex: 0, text: content }]
  return content.flatMap((block, blockIndex) =>
    block.type === 'text' ? [{ blockIndex, text: block.text }] : [],
  )
}

/**
 * Find exact user-typed commit IDs that are safe to keep through PII redaction.
 *
 * Shape alone is never enough: every value must resolve locally to a commit in
 * this turn's repository. Bounded validation prevents an adversarial prompt
 * from turning privacy preflight into an unbounded Git probe.
 */
export async function localPromptCommitSpans(
  content: UserContent,
  root: string | null,
): Promise<readonly PreservedTextSpan[]> {
  if (!root) return []
  const occurrences: PreservedTextSpan[] = []
  for (const { blockIndex, text } of textBlocks(content)) {
    for (const match of text.matchAll(FULL_COMMIT_SHA)) {
      occurrences.push({
        blockIndex,
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
      })
    }
  }
  const candidates = [...new Set(occurrences.map((occurrence) => occurrence.value))].slice(
    0,
    MAX_COMMIT_CANDIDATES,
  )
  const existing = new Set<string>()
  for (const candidate of candidates) {
    // A Git that cannot run (missing binary, sandbox failure, timeout) proves
    // nothing: keep the value redacted instead of failing the whole turn.
    if (await commitShaExists(candidate, root).catch(() => false)) existing.add(candidate)
  }
  return occurrences
    .filter((occurrence) => existing.has(occurrence.value))
    .slice(0, MAX_COMMIT_OCCURRENCES)
}

// Copse credits itself (and the model(s) that did the work) on commits it makes,
// the way Claude Code adds a `Co-Authored-By` trailer. The co-author line is
// fixed; the `Copse-Models` trailer lists the distinct model ids that actually
// ran in the thread (sourced from usage, not the LLM guessing its own name).

/** Fixed co-author trailer identifying Copse as a commit author. */
export const COPSE_COAUTHOR = 'Co-Authored-By: Copse <noreply@copse-panel.app>'

/** Trailer key carrying the comma-separated list of models used. */
export const COPSE_MODELS_TRAILER = 'Copse-Models'

function dedupePreservingOrder(models: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of models) {
    const model = raw.trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    out.push(model)
  }
  return out
}

/**
 * Build the Copse attribution trailer block: a `Co-Authored-By: Copse` line and,
 * when any models are known, a `Copse-Models:` line listing them. Models are
 * de-duplicated and blank entries dropped.
 */
export function buildCommitAttribution(models: string[]): string {
  const lines = [COPSE_COAUTHOR]
  const used = dedupePreservingOrder(models)
  if (used.length > 0) lines.push(`${COPSE_MODELS_TRAILER}: ${used.join(', ')}`)
  return lines.join('\n')
}

/**
 * Append the Copse attribution trailer to a commit message, separated from the
 * body by a blank line. Idempotent: if the message already carries the Copse
 * co-author line, it is returned unchanged so re-commits don't stack trailers.
 */
export function appendCommitAttribution(message: string, models: string[]): string {
  const body = message.replace(/\s+$/, '')
  if (body.includes(COPSE_COAUTHOR)) return `${body}\n`
  return `${body}\n\n${buildCommitAttribution(models)}\n`
}

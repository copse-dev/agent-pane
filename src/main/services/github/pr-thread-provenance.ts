import { parsePrRelationUrl, prRepositoryKey } from '@shared/git/thread-pr-relations.ts'
import { lookupPrThreadRelationships, lookupCommitThreadProductions } from '../thread-store.ts'

/** Exact evidence only. Missing evidence means unknown, never "not made by a thread". */
export async function getPrThreadProvenanceText(
  projectId: string | null,
  url: string,
  shas: readonly string[] | undefined,
): Promise<string> {
  const pr = parsePrRelationUrl(url)
  if (!projectId || !pr) return 'Thread relationships: unavailable (no project/repository context).'
  try {
    const relations = await lookupPrThreadRelationships(projectId, pr)
    const lines = ['Thread relationships (current project):']
    const producers = relations.filter((row) => row.kinds.includes('produced'))
    const related = relations.filter((row) => !row.kinds.includes('produced'))
    lines.push(`Producing threads: ${producers.length === 0 ? 'none recorded' : ''}`)
    for (const row of producers)
      lines.push(`  - ${row.threadId}: ${row.title} (recorded PR creation)`)
    lines.push(`Related threads: ${related.length === 0 ? 'none recorded' : ''}`)
    for (const row of related)
      lines.push(`  - ${row.threadId}: ${row.title} (${row.kinds.join(', ')})`)
    lines.push('Commit attribution (commits returned by GitHub; exact SHA matching):')
    if (!shas) lines.push('  unavailable: GitHub did not return commits')
    else if (shas.length === 0) lines.push('  no commits returned')
    for (const sha of shas ?? []) {
      const evidence = await lookupCommitThreadProductions(projectId, prRepositoryKey(pr), sha)
      lines.push(
        `  - ${sha}: ${evidence.length === 0 ? 'unknown' : evidence.map((row) => `recorded in ${row.threadId} (${row.title}); events ${row.evidence.map((event) => event.eventId).join(', ')}`).join('; ')}`,
      )
    }
    return lines.join('\n')
  } catch {
    return 'Thread relationships and commit attribution: unavailable (local index read failed).'
  }
}

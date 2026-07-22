import type { Thread } from '@shared/types'
import { COPSE_PRODUCT_REPO_URL } from './product-repo.ts'

/** Build a GitHub "new issue" URL with title/body prefilled for a shared trace. */
export function buildShareTraceIssueUrl(thread: Thread): string {
  const title = `Debug trace: ${thread.title.trim() || thread.id}`
  const body = [
    '## Debug trace',
    '',
    'Please attach the downloaded `.jsonl` file from Copse (**Share trace**).',
    '',
    '### Thread',
    '',
    `- **Id:** \`${thread.id}\``,
    `- **Title:** ${thread.title || '(untitled)'}`,
    `- **Status:** ${thread.status}`,
    `- **Model:** ${thread.model ?? '(unset)'}`,
    `- **Messages:** ${String(thread.messages.length)}`,
    '',
    '### Notes',
    '',
    '- Portable export is analyzer-ready: `npm run analyze:thread -- <file.jsonl>`.',
    '- Traces may contain workspace paths, prompts, and tool output — treat as private.',
  ].join('\n')

  const params = new URLSearchParams({ title, body })
  return `${COPSE_PRODUCT_REPO_URL}/issues/new?${params.toString()}`
}

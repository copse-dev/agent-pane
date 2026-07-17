/** Keep knowledge metadata compact while preserving the store's ISO calendar date. */
export function knowledgeDate(timestamp: string): string {
  return /^\d{4}-\d{2}-\d{2}/.exec(timestamp)?.[0] ?? timestamp
}

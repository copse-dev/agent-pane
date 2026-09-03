import type { Thread } from './thread-types.ts'

export function sortThreadsNewestFirst(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => b.createdAt - a.createdAt)
}

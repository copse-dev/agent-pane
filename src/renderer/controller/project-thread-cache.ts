import type { Thread } from '@shared/types'

/** Resident project lists, with one shared budget for inactive transcripts. */
export class ProjectThreadCache {
  private readonly projects = new Map<
    string,
    { threads: Thread[]; revision: number; selectedThreadId: string | null }
  >()

  get(projectId: string, revision: number): Thread[] | undefined {
    const entry = this.projects.get(projectId)
    if (!entry || entry.revision !== revision) return undefined
    return entry.threads
  }

  remember(
    projectId: string,
    threads: Thread[],
    revision: number,
    selectedThreadId: string | null = null,
  ): void {
    this.projects.delete(projectId)
    this.projects.set(projectId, { threads, revision, selectedThreadId })
    // Project metadata is cheap, but still bounded. Never retain an unbounded
    // number of old projects just because the sidebar was browsed all day.
    while (this.projects.size > 16) {
      const oldest = this.projects.keys().next().value
      if (oldest === undefined) break
      this.projects.delete(oldest)
    }
    let remaining = 8
    for (const [id, entry] of [...this.projects].reverse()) {
      if (id === projectId) continue // the visible project's hydrator owns its budget
      // Keep the selected thread first even when it is an old sidebar row.
      const candidates = entry.threads
        .filter((thread) => thread.messagesLoaded !== false && thread.messages.length > 0)
        .sort(
          (a, b) =>
            Number(b.id === entry.selectedThreadId) - Number(a.id === entry.selectedThreadId),
        )
      const dropping = new Set<string>()
      for (const thread of candidates) {
        if (thread.messagesLoaded === false || thread.messages.length === 0) continue
        if (remaining-- <= 0) dropping.add(thread.id)
      }
      if (dropping.size === 0) continue
      entry.threads = entry.threads.map((thread) =>
        dropping.has(thread.id) ? { ...thread, messages: [], messagesLoaded: false } : thread,
      )
    }
  }

  update(projectId: string, update: (thread: Thread) => Thread): void {
    const entry = this.projects.get(projectId)
    if (entry) entry.threads = entry.threads.map(update)
  }

  delete(projectId: string): void {
    this.projects.delete(projectId)
  }

  clear(): void {
    this.projects.clear()
  }
}

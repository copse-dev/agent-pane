interface Entry {
  updatedAt: number
  projectRoot: string | null
  hasChanges: boolean
  checkedAt: number
}

interface Check {
  projectId: string
  threadId: string
  updatedAt: number
  projectRoot: string | null
}

/** Activity never waits for checkout inspection or Git, including on a cold cache. */
export class MobileActivityChanges {
  private readonly cache = new Map<string, Entry>()
  private readonly pending = new Set<string>()
  private readonly queue = new Map<string, Check>()
  private active = 0
  private readonly inspect: (
    projectId: string,
    threadId: string,
    updatedAt: number,
  ) => Promise<boolean>

  constructor(
    inspect: (projectId: string, threadId: string, updatedAt: number) => Promise<boolean>,
  ) {
    this.inspect = inspect
  }

  read(
    projectId: string,
    threadId: string,
    updatedAt: number,
    projectRoot: string | null,
  ): boolean {
    const key = `${projectId}\0${threadId}`
    const cached = this.cache.get(key)
    if (
      !this.pending.has(key) &&
      (!cached ||
        cached.updatedAt !== updatedAt ||
        cached.projectRoot !== projectRoot ||
        Date.now() - cached.checkedAt >= 30_000)
    ) {
      this.pending.add(key)
      this.queue.set(key, { projectId, threadId, updatedAt, projectRoot })
      this.drain()
    }
    // Keep the last known group while refreshing; unseen threads start in Recent.
    return cached?.hasChanges ?? false
  }

  private drain(): void {
    // A large profile must not spawn one Git process per settled thread at once.
    while (this.active < 2) {
      const next = this.queue.entries().next().value
      if (!next) return
      const [key, check] = next
      this.queue.delete(key)
      this.active += 1
      void Promise.resolve()
        .then(() => this.inspect(check.projectId, check.threadId, check.updatedAt))
        .then((hasChanges) => {
          this.remember(key, check.updatedAt, check.projectRoot, hasChanges)
        })
        .catch(() => {
          this.remember(
            key,
            check.updatedAt,
            check.projectRoot,
            this.cache.get(key)?.hasChanges ?? false,
          )
        })
        .finally(() => {
          this.pending.delete(key)
          this.active -= 1
          this.drain()
        })
    }
  }

  private remember(
    key: string,
    updatedAt: number,
    projectRoot: string | null,
    hasChanges: boolean,
  ): void {
    this.cache.set(key, { updatedAt, projectRoot, hasChanges, checkedAt: Date.now() })
  }
}

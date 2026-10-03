import { parseThreadDeepLink } from '@shared/git/thread-link.ts'

export interface ThreadDeepLinkTarget {
  threadId: string
  projectId: string | null
}

export interface DeepLinkWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  webContents: { id: number; send(channel: string, target: ThreadDeepLinkTarget): void }
}

// Keep the last launch request until a full main renderer has restored its projects.
export class ThreadDeepLinks {
  private pending: string | null = null
  private readyWindows = new Set<number>()
  private sequence = 0
  private readonly getWindow: () => DeepLinkWindow | null
  private readonly findOwners: (threadId: string) => Promise<string[]>

  constructor(
    getWindow: () => DeepLinkWindow | null,
    findOwners: (threadId: string) => Promise<string[]>,
  ) {
    this.getWindow = getWindow
    this.findOwners = findOwners
  }

  accept(url: string): boolean {
    const id = parseThreadDeepLink(url)
    if (!id) return false
    this.pending = id
    this.sequence++
    void this.flush()
    return true
  }

  ready(id: number): void {
    this.readyWindows.add(id)
    void this.flush()
  }

  unready(id: number): void {
    this.readyWindows.delete(id)
  }

  async flush(): Promise<void> {
    const win = this.getWindow()
    if (!win || win.isDestroyed() || !this.readyWindows.has(win.webContents.id)) return
    const threadId = this.pending
    if (!threadId) return
    const sequence = this.sequence
    this.pending = null
    const owners = await this.findOwners(threadId).catch(() => [])
    if (sequence !== this.sequence) return
    if (win.isDestroyed() || !this.readyWindows.has(win.webContents.id)) {
      this.pending = threadId
      return
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('deep-links:open-thread', {
      threadId,
      projectId: owners.length === 1 ? (owners[0] ?? null) : null,
    })
  }
}

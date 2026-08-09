import { randomUUID } from 'node:crypto'

export interface MainWindowWebContents {
  send(channel: string, ...args: unknown[]): void
}

export interface MainWindowHandle {
  webContents: MainWindowWebContents
  isDestroyed(): boolean
  isFocused(): boolean
}

export interface MainWindowContext<TWindow extends MainWindowHandle = MainWindowHandle> {
  id: string
  window: TWindow
}

export class MainWindowRegistry<TWindow extends MainWindowHandle = MainWindowHandle> {
  readonly #contexts = new Map<string, MainWindowContext<TWindow>>()
  readonly #idsByWebContents = new Map<MainWindowWebContents, string>()
  readonly #createId: () => string
  #primaryId: string | null = null
  #mostRecentId: string | null = null

  constructor(createId: () => string = randomUUID) {
    this.#createId = createId
  }

  register(window: TWindow): MainWindowContext<TWindow> {
    const existing = this.fromWebContents(window.webContents)
    if (existing) return existing

    const context = { id: this.#createId(), window }
    this.#contexts.set(context.id, context)
    this.#idsByWebContents.set(window.webContents, context.id)
    this.#primaryId ??= context.id
    this.#mostRecentId = context.id
    return context
  }

  unregister(windowOrId: TWindow | string): void {
    const context =
      typeof windowOrId === 'string'
        ? this.#contexts.get(windowOrId)
        : this.fromWebContents(windowOrId.webContents)
    if (!context) return

    this.#contexts.delete(context.id)
    this.#idsByWebContents.delete(context.window.webContents)
    if (this.#primaryId === context.id) {
      // Existing services still capture the first window as their UI owner.
      // Do not promote another window until owner-routed services land.
      this.#primaryId = null
    }
    if (this.#mostRecentId === context.id) {
      this.#mostRecentId = this.#lastLiveContext()?.id ?? this.#primaryId
    }
  }

  markFocused(windowOrId: TWindow | string): void {
    const context =
      typeof windowOrId === 'string'
        ? this.#contexts.get(windowOrId)
        : this.fromWebContents(windowOrId.webContents)
    if (context && !context.window.isDestroyed()) this.#mostRecentId = context.id
  }

  get(id: string): MainWindowContext<TWindow> | undefined {
    const context = this.#contexts.get(id)
    return context && !context.window.isDestroyed() ? context : undefined
  }

  fromWebContents(webContents: MainWindowWebContents): MainWindowContext<TWindow> | undefined {
    const id = this.#idsByWebContents.get(webContents)
    return id ? this.get(id) : undefined
  }

  getPrimary(): MainWindowContext<TWindow> | undefined {
    return this.#primaryId ? this.get(this.#primaryId) : undefined
  }

  getFocused(): MainWindowContext<TWindow> | undefined {
    for (const context of this.list()) {
      if (context.window.isFocused()) return context
    }
    return undefined
  }

  getMostRecentlyFocused(): MainWindowContext<TWindow> | undefined {
    return this.#mostRecentId ? this.get(this.#mostRecentId) : undefined
  }

  list(): MainWindowContext<TWindow>[] {
    return [...this.#contexts.values()].filter(({ window }) => !window.isDestroyed())
  }

  isPrimary(webContents: MainWindowWebContents): boolean {
    return this.getPrimary()?.window.webContents === webContents
  }

  send(id: string, channel: string, ...args: unknown[]): boolean {
    const context = this.get(id)
    if (!context) return false
    context.window.webContents.send(channel, ...args)
    return true
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const { window } of this.list()) {
      window.webContents.send(channel, ...args)
    }
  }

  #lastLiveContext(): MainWindowContext<TWindow> | undefined {
    return this.list().at(-1)
  }
}

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  MainWindowBounds,
  MainWindowNavigation,
  MainWindowRecord,
  MainWindowState,
} from '@shared/types/main-window.ts'

export const MAIN_WINDOW_STATE_KEY = 'mainWindowState'
export const MAX_MAIN_WINDOWS = 32

const boundsSchema = z.object({
  width: z.number().int().positive().max(100_000),
  height: z.number().int().positive().max(100_000),
  x: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  y: z.number().int().min(-1_000_000).max(1_000_000).optional(),
})

const windowIdSchema = z.string().regex(/^[\w-]{1,128}$/)
const nullableIdSchema = z.string().min(1).max(128).nullable()

const recordSchema = z.object({
  id: windowIdSchema,
  activeProjectId: nullableIdSchema,
  activeThreadId: nullableIdSchema,
  bounds: boundsSchema,
  displayId: z.string().min(1).max(128).optional(),
  maximized: z.boolean(),
  fullscreen: z.boolean(),
  lastFocusedAt: z.number().nonnegative(),
})

const stateSchema = z
  .object({
    version: z.literal(1),
    windows: z.array(recordSchema).max(MAX_MAIN_WINDOWS),
  })
  .superRefine((state, context) => {
    const ids = new Set<string>()
    for (const window of state.windows) {
      if (ids.has(window.id)) {
        context.addIssue({
          code: 'custom',
          path: ['windows'],
          message: 'Window ids must be unique',
        })
        return
      }
      ids.add(window.id)
    }
  })

function decodeState(value: unknown): MainWindowState | null {
  const parsed = stateSchema.safeParse(value)
  if (!parsed.success) return null
  return {
    version: 1,
    windows: parsed.data.windows.map((record) => ({
      id: record.id,
      activeProjectId: record.activeProjectId,
      activeThreadId: record.activeThreadId,
      bounds: {
        width: record.bounds.width,
        height: record.bounds.height,
        ...(record.bounds.x !== undefined ? { x: record.bounds.x } : {}),
        ...(record.bounds.y !== undefined ? { y: record.bounds.y } : {}),
      },
      ...(record.displayId !== undefined ? { displayId: record.displayId } : {}),
      maximized: record.maximized,
      fullscreen: record.fullscreen,
      lastFocusedAt: record.lastFocusedAt,
    })),
  }
}

export interface MainWindowStateStorage {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export interface MainWindowRecordDefaults extends MainWindowNavigation {
  bounds: MainWindowBounds
}

/**
 * Owns the persisted set of full main windows. The repository keeps one
 * in-memory snapshot so focus, move and navigation events cannot overwrite one
 * another through read-modify-write races against the JSON store.
 */
export class MainWindowStateRepository {
  readonly #storage: MainWindowStateStorage
  readonly #createId: () => string
  readonly #now: () => number
  #state: MainWindowState | null = null

  constructor(
    storage: MainWindowStateStorage,
    createId: () => string = randomUUID,
    now: () => number = Date.now,
  ) {
    this.#storage = storage
    this.#createId = createId
    this.#now = now
  }

  loadOrMigrate(defaults: MainWindowRecordDefaults): MainWindowRecord[] {
    if (!this.#state) {
      this.#state = decodeState(this.#storage.get(MAIN_WINDOW_STATE_KEY)) ?? {
        version: 1,
        windows: [],
      }
    }
    if (this.#state.windows.length === 0) this.create(defaults)
    return this.list()
  }

  list(): MainWindowRecord[] {
    return structuredClone(this.#state?.windows ?? [])
  }

  get(id: string): MainWindowRecord | undefined {
    const record = this.#state?.windows.find((candidate) => candidate.id === id)
    return record ? structuredClone(record) : undefined
  }

  create(defaults: MainWindowRecordDefaults, id: string = this.#createId()): MainWindowRecord {
    this.#ensureLoaded()
    const existing = this.#state?.windows.find((candidate) => candidate.id === id)
    if (existing) return structuredClone(existing)
    if ((this.#state?.windows.length ?? 0) >= MAX_MAIN_WINDOWS) {
      throw new Error(`Cannot open more than ${String(MAX_MAIN_WINDOWS)} main windows`)
    }
    const record: MainWindowRecord = {
      id,
      ...defaults,
      maximized: false,
      fullscreen: false,
      lastFocusedAt: this.#now(),
    }
    this.#state?.windows.push(record)
    this.#persist()
    return structuredClone(record)
  }

  update(id: string, patch: Partial<Omit<MainWindowRecord, 'id'>>): MainWindowRecord | undefined {
    this.#ensureLoaded()
    const index = this.#state?.windows.findIndex((candidate) => candidate.id === id) ?? -1
    if (index < 0 || !this.#state) return undefined
    const current = this.#state.windows[index]
    if (!current) return undefined
    const next: MainWindowRecord = { ...current, ...patch, id }
    this.#state.windows[index] = next
    this.#persist()
    return structuredClone(next)
  }

  remove(id: string): void {
    this.#ensureLoaded()
    if (!this.#state) return
    const windows = this.#state.windows.filter((candidate) => candidate.id !== id)
    if (windows.length === this.#state.windows.length) return
    this.#state = { version: 1, windows }
    this.#persist()
  }

  #ensureLoaded(): void {
    if (this.#state) return
    this.#state = decodeState(this.#storage.get(MAIN_WINDOW_STATE_KEY)) ?? {
      version: 1,
      windows: [],
    }
  }

  #persist(): void {
    if (this.#state) this.#storage.set(MAIN_WINDOW_STATE_KEY, this.#state)
  }
}

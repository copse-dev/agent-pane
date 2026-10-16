import type { SettingsSnapshot } from '@shared/settings-contract.ts'
import type { SettingsSection } from './navigation.ts'

export interface SettingsSectionLifecycle {
  refresh(snapshot: SettingsSnapshot, signal: AbortSignal): Promise<void>
  deactivate?(): void
  /** Editors with pending ordinary changes retain their draft for this open. */
  retainDrafts?: boolean
}

/** A snapshot per open, with cancellable work only for sections currently visible. */
export class SettingsLifecycle {
  private readonly loaded = new Set<SettingsSection>()
  private readonly visible = new Map<
    SettingsSection,
    { controller: AbortController; loading: Promise<void> }
  >()
  private readonly owners: Partial<Record<SettingsSection, SettingsSectionLifecycle>>
  private readonly onError: (id: SettingsSection, error: unknown) => void
  constructor(
    owners: Partial<Record<SettingsSection, SettingsSectionLifecycle>>,
    onError: (id: SettingsSection, error: unknown) => void,
  ) {
    this.owners = owners
    this.onError = onError
  }

  signalFor(id: SettingsSection): AbortSignal | undefined {
    return this.visible.get(id)?.controller.signal
  }

  reset(): void {
    this.cancel()
    this.loaded.clear()
  }
  cancel(): void {
    for (const id of this.visible.keys()) this.hide(id)
  }
  private hide(id: SettingsSection): void {
    this.visible.get(id)?.controller.abort()
    this.owners[id]?.deactivate?.()
    this.visible.delete(id)
  }
  async show(ids: readonly SettingsSection[], snapshot: SettingsSnapshot): Promise<void> {
    const next = new Set(ids)
    for (const id of this.visible.keys()) if (!next.has(id)) this.hide(id)
    const work: Promise<void>[] = []
    for (const id of next) {
      const existing = this.visible.get(id)
      if (existing) {
        work.push(existing.loading)
        continue
      }
      const controller = new AbortController()
      const owner = this.owners[id]
      const loading =
        this.loaded.has(id) || !owner
          ? Promise.resolve()
          : (async (): Promise<void> => {
              try {
                await owner.refresh(snapshot, controller.signal)
                if (!controller.signal.aborted && owner.retainDrafts) this.loaded.add(id)
              } catch (error: unknown) {
                if (!controller.signal.aborted) this.onError(id, error)
              }
            })()
      this.visible.set(id, { controller, loading })
      work.push(loading)
    }
    await Promise.all(work)
  }
}

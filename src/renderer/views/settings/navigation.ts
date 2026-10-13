import type { ModelSettingsTarget } from '@shared/model-invalidation.ts'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
export type SettingsSection =
  | 'general'
  | 'classifiers'
  | 'usage'
  | 'agent'
  | 'permissions'
  | 'mcp'
  | 'customise'
  | 'storage'
  | 'appearance'
  | 'ssh'
  | 'experimental'
  | 'about'

export const isSettingsSection: (value: unknown) => value is SettingsSection = (value) =>
  value === 'general' ||
  value === 'classifiers' ||
  value === 'usage' ||
  value === 'agent' ||
  value === 'permissions' ||
  value === 'mcp' ||
  value === 'customise' ||
  value === 'storage' ||
  value === 'appearance' ||
  value === 'ssh' ||
  value === 'experimental' ||
  value === 'about'

/**
 * A plugin's level-3 detail view to reveal on the next open (Settings → Customise →
 * <plugin>), plus the row inside it the caller was pointing at — a schedule id for
 * the automations detail.
 */
export interface PluginDetailTarget {
  pluginId: string
  detailId?: string
}

let overlayEl: HTMLDialogElement | null = null
let submitting = false
// Section to reveal on the next open (e.g. a deep-link from the low-context
// warning). Read and cleared by the `settings-open` handler; null → General.
let pendingSection: SettingsSection | null = null
// Plugin detail to reveal on the next open. Same lifecycle as `pendingSection`.
let pendingPluginDetail: PluginDetailTarget | null = null
let pendingModelTarget: ModelSettingsTarget | null = null

export function openSettingsDialog(section?: SettingsSection): void {
  if (!overlayEl || overlayEl.open) return
  pendingSection = section ?? null
  // showModal() puts the dialog in the top layer: focus is trapped inside, the
  // background is made inert, and Esc closes it — all for free, replacing the
  // hand-rolled overlay + manual `hidden` toggle.
  overlayEl.showModal()
  overlayEl.dispatchEvent(new Event('settings-open'))
}

/**
 * Open Settings on the automations plugin's schedule editor — the configuration
 * behind an automation heading in the projects sidebar. With a schedule id, that
 * schedule opens for editing; without one, the project's schedule list is shown.
 *
 * The editor is scoped to the open project, so callers must already be on the
 * project that owns the schedule.
 */
export function openAutomationSettings(scheduleId?: string): void {
  if (!overlayEl || overlayEl.open) return
  pendingPluginDetail = {
    pluginId: AUTOMATIONS_PLUGIN_ID,
    ...(scheduleId ? { detailId: scheduleId } : {}),
  }
  openSettingsDialog('customise')
}

export function closeSettingsDialog(): void {
  if (!overlayEl || !overlayEl.open || submitting) return
  overlayEl.close()
}

export function isSettingsDialogOpen(): boolean {
  return !!overlayEl && overlayEl.open
}

/**
 * Subscribe to the settings dialog closing (Save, Cancel, the close button, or Esc —
 * all funnel through the native dialog `close` event). Used by other top-layer
 * UI (e.g. the approval dialog) that must stay behind settings: it defers itself
 * while settings is open and flushes when this fires. Returns an unsubscribe fn.
 */
export function onSettingsDialogClose(listener: () => void): () => void {
  if (!overlayEl) throw new Error('onSettingsDialogClose called before mountSettingsDialog')
  overlayEl.addEventListener('close', listener)
  return () => overlayEl?.removeEventListener('close', listener)
}

export function bindSettingsDialog(dialog: HTMLDialogElement): void {
  overlayEl = dialog
  submitting = false
}
export function consumeSettingsOpenTarget(): {
  section: SettingsSection
  pluginDetail: PluginDetailTarget | null
  modelTarget: ModelSettingsTarget | null
} {
  const target = {
    section: pendingSection ?? 'general',
    pluginDetail: pendingPluginDetail,
    modelTarget: pendingModelTarget,
  }
  pendingSection = null
  pendingPluginDetail = null
  pendingModelTarget = null
  return target
}

export function openModelSettings(target: ModelSettingsTarget = 'model'): void {
  pendingModelTarget = target
  const section =
    target === 'orchestrationWorkerModel'
      ? 'experimental'
      : target.startsWith('plugin:') || target === 'advisorModel'
        ? 'customise'
        : 'general'
  pendingSection = section
  if (overlayEl?.open) overlayEl.dispatchEvent(new Event('settings-reveal-model'))
  else openSettingsDialog(section)
}

export function revealModelSettingsControl(
  root: HTMLElement,
  target: ModelSettingsTarget,
): boolean {
  const resolved = target === 'advisorModel' ? 'plugin:copse.advisor-strategy:advisorModel' : target
  const controls = [...root.querySelectorAll<HTMLElement>('[data-model-setting-target]')]
  const matched = controls.find((control) => control.dataset['modelSettingTarget'] === resolved)
  const fallback = root.querySelector(`[name="${CSS.escape(resolved)}"]`)
  const control = matched ?? (fallback instanceof HTMLElement ? fallback : null)
  if (!control) return false
  if (control.closest('#plugins-installed-panel')) {
    root.querySelector<HTMLButtonElement>('#plugins-installed-tab')?.click()
  }
  let ancestor = control.parentElement
  while (ancestor && ancestor !== root) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
    ancestor = ancestor.parentElement
  }
  const picker =
    control.closest('.model-picker')?.querySelector<HTMLElement>('.model-picker-trigger') ?? control
  picker.scrollIntoView({ block: 'center' })
  picker.focus()
  return true
}

/** Save holds one draft until ordinary, security and credential writes settle. */
export function setSettingsSubmitting(value: boolean): void {
  submitting = value
}

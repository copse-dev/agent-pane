import type { ApiClient } from '../../preload/api.d.ts'
import type { StorageArea, StorageMaintenanceState } from '@shared/types/storage-cleanup.ts'
import { formatByteSize } from '@shared/file-bytes.ts'
import { errorMessage } from '@shared/errors.ts'
import { el, qsRequired } from '../dom/helpers.ts'
import { showConfirmDialog } from './confirm-dialog.ts'

export function createStorageMaintenancePanel(api: ApiClient): {
  element: HTMLElement
  refresh: () => Promise<void>
} {
  const element = el('fieldset', { id: 'storage-maintenance' })
  element.innerHTML = `
    <legend>Saved runs and build data</legend>
    <p class="settings-fieldset-desc">Across all projects. Clean up completed container runs or temporary Apple build files. Chats, attachments, source files and shared dependencies are kept.</p>
    <div class="settings-action-row"><span>Saved container runs</span><span id="storage-runs-size">Checking…</span><button type="button" class="ui-btn ui-btn-secondary" id="storage-runs-clean">Clean up…</button></div>
    <p class="field-hint">Removes repository snapshots, outputs and saved state. Incomplete runs and runs with teardown errors are kept.</p>
    <div class="settings-action-row"><span>Temporary build data</span><span id="storage-builds-size">Checking…</span><button type="button" class="ui-btn ui-btn-secondary" id="storage-builds-clean">Clean up…</button></div>
    <p class="field-hint">Removes Apple build outputs and package caches. They are recreated on the next build. Active runs and builds are kept.</p>
    <label class="checkbox-label"><input type="checkbox" id="storage-expiry-enabled"> Automatically clean up unused data</label>
    <label class="storage-project-field"><span>Keep unused data for</span><select id="storage-expiry-days" aria-label="Storage retention"><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">365 days</option></select></label>
    <p class="field-hint">Checked when Copse starts and once a day. Older saved run outputs will no longer be available for review or continuation.</p>
    <p id="storage-maintenance-status" class="field-hint" role="status" aria-live="polite"></p>`
  const status = qsRequired(element, '#storage-maintenance-status')
  const enabled = qsRequired<HTMLInputElement>(element, '#storage-expiry-enabled')
  const days = qsRequired<HTMLSelectElement>(element, '#storage-expiry-days')
  let state: StorageMaintenanceState | null = null
  let working = false
  let generation = 0
  function controls(): void {
    enabled.disabled = working || !state
    days.disabled = working || !state
    for (const area of ['runs', 'builds'] as const) {
      const summary = state?.areas.find((entry) => entry.area === area)
      qsRequired<HTMLButtonElement>(element, `#storage-${area}-clean`).disabled =
        working || !summary || summary.busy || summary.entries === 0
    }
  }
  async function refresh(): Promise<void> {
    const token = ++generation
    controls()
    try {
      const next = await api.storage.maintenance()
      if (token !== generation) return
      state = next
      enabled.checked = next.retention.enabled
      if (![...days.options].some((option) => Number(option.value) === next.retention.days)) {
        days.add(new Option(`${String(next.retention.days)} days`, String(next.retention.days)))
      }
      days.value = String(next.retention.days)
      for (const summary of next.areas)
        qsRequired(element, `#storage-${summary.area}-size`).textContent = summary.busy
          ? 'In use'
          : `${formatByteSize(summary.bytes)} · ${String(summary.entries)} item${summary.entries === 1 ? '' : 's'}`
    } catch (error) {
      if (token === generation) status.textContent = errorMessage(error)
    } finally {
      if (token === generation) controls()
    }
  }
  async function save(): Promise<void> {
    working = true
    generation++
    controls()
    try {
      const retention = { enabled: enabled.checked, days: Number(days.value) }
      await api.storage.retention(retention)
      if (state) state.retention = retention
      status.textContent = 'Automatic cleanup updated.'
    } catch (error) {
      status.textContent = errorMessage(error)
      await refresh()
    } finally {
      working = false
      controls()
    }
  }
  async function clean(area: StorageArea): Promise<void> {
    const confirmed = await showConfirmDialog({
      message: area === 'runs' ? 'Remove saved container runs?' : 'Remove temporary build data?',
      detail:
        area === 'runs'
          ? 'Completed run snapshots, outputs and saved state will be permanently removed. Incomplete runs, teardown failures and active runs are kept. Chats remain.'
          : 'Apple build outputs and package caches will be removed and recreated on the next build. Active builds and chats are kept.',
      confirmLabel: 'Clean up',
      danger: true,
    })
    if (!confirmed) return
    working = true
    generation++
    controls()
    status.textContent = 'Cleaning up…'
    try {
      const result = await api.storage.cleanup(area)
      await refresh()
      status.textContent = `Removed ${String(result.removed)} item${result.removed === 1 ? '' : 's'} (${formatByteSize(result.bytes)}).${result.skipped ? ` Kept ${String(result.skipped)} active, incomplete or protected items.` : ''}`
    } catch (error) {
      status.textContent = errorMessage(error)
    } finally {
      working = false
      controls()
    }
  }
  enabled.addEventListener('change', () => {
    void save()
  })
  days.addEventListener('change', () => {
    void save()
  })
  for (const area of ['runs', 'builds'] as const)
    qsRequired(element, `#storage-${area}-clean`).addEventListener('click', () => {
      void clean(area)
    })
  controls()
  return { element, refresh }
}

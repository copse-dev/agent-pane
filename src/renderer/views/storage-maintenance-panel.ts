import {
  CONTAINER_STORAGE_ACTIONS,
  type ContainerStorageAction,
} from '@shared/types/storage-cleanup.ts'
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
  const element = el('div', { id: 'storage-maintenance', class: 'settings-mount' })
  element.innerHTML = `
    <fieldset id="storage-saved-data"><legend>Saved runs and build data</legend>
    <p class="settings-fieldset-desc">Across all projects. Clean up completed container runs or temporary Apple build files. Chats, attachments, source files and shared dependencies are kept.</p>
    <div class="settings-action-row"><span>Saved container runs</span><span id="storage-runs-size">Checking…</span><button type="button" class="ui-btn ui-btn-secondary" id="storage-runs-clean">Clean up…</button></div>
    <p class="field-hint">Removes repository snapshots, outputs and saved state. Incomplete runs and runs with teardown errors are kept.</p>
    <div class="settings-action-row"><span>Temporary build data</span><span id="storage-builds-size">Checking…</span><button type="button" class="ui-btn ui-btn-secondary" id="storage-builds-clean">Clean up…</button></div>
    <p class="field-hint">Removes Apple build outputs and package caches. They are recreated on the next build. Active runs and builds are kept.</p>
    <label class="checkbox-label"><input type="checkbox" id="storage-expiry-enabled"> Automatically clean up unused data</label>
    <label class="storage-project-field"><span>Keep unused data for</span><select id="storage-expiry-days" aria-label="Storage retention"><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">365 days</option></select></label>
    <p class="field-hint">Checked when Copse starts and once a day. Older saved run outputs will no longer be available for review or continuation. Old unused Copse worker images are also removed; the current local worker is kept. Broader shared cache cleanup requires confirmation; Apple garbage collection also removes orphaned snapshots and blobs when deleting a Copse image.</p>
    </fieldset>
    <fieldset id="storage-containers">
      <legend>Apple container storage</legend>
      <p class="field-hint">Shared across Copse profiles and other Apple container applications on this Mac.</p>
      <p id="storage-containers-status" class="field-hint" role="status"></p>
      <dl id="storage-container-breakdown"></dl>
      <p class="field-hint">Unmatched snapshots may include Apple infrastructure images. Apple decides which cached files are unused during cleanup. Allocated disk estimates include filesystem overhead and may count APFS shared blocks more than once. Removing files inside a sparse VM disk may not immediately shrink it.</p>
      <div class="settings-action-row"><button type="button" class="ui-btn ui-btn-secondary" id="storage-worker-images-clean">Clean unused Copse images…</button><button type="button" class="ui-btn ui-btn-secondary" id="storage-apple-images-clean">Clean shared image cache…</button><button type="button" class="ui-btn ui-btn-secondary" id="storage-apple-builder-clean">Clean shared builder cache…</button></div>
      <p class="field-hint">The local worker image is kept. Cleanup is paused during Copse runs and builds, and requires other containers to be removed. Shared caches can be recreated by future builds.</p>
      <details><summary>Cached images</summary><div id="storage-container-images"></div></details>
    </fieldset>
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
    for (const action of CONTAINER_STORAGE_ACTIONS) {
      const container = state?.containers
      qsRequired<HTMLButtonElement>(element, `#storage-${action}-clean`).disabled =
        working ||
        !container?.available ||
        container.busy ||
        (action === 'worker-images' && !container.images.some((image) => image.eligible)) ||
        (action === 'apple-builder' &&
          (!container.builderRunning || container.builderCacheBytes === null))
    }
  }
  function renderContainers(): void {
    const container = state?.containers
    if (!container) return
    qsRequired(element, '#storage-containers-status').textContent = container.error
      ? `Inventory unavailable: ${container.error}`
      : !container.available
        ? 'Apple container is not available on this platform.'
        : container.busy
          ? 'Containers or builds are in use. Cleanup is paused.'
          : 'Apple container storage is ready.'
    const breakdown = qsRequired(element, '#storage-container-breakdown')
    breakdown.replaceChildren()
    const rows = [
      ['Total allocated', container.totalBytes],
      [
        `Unpacked snapshots (${String(container.snapshotCount)}; ${String(container.unmatchedSnapshots)} not matched to listed images)`,
        container.snapshotsBytes,
      ],
      ['Compressed image content', container.blobsBytes],
      ['Builder VM disk', container.builderDiskBytes],
      [
        'Other container disks',
        Math.max(0, container.containersBytes - container.builderDiskBytes),
      ],
      ['Workspace volumes', container.volumesBytes],
      ['Kernels and other supporting files', container.otherBytes],
    ] as const
    for (const [label, bytes] of rows)
      breakdown.append(el('dt', {}, label), el('dd', {}, formatByteSize(bytes)))
    for (const [label, bytes] of [
      ['BuildKit cache (inside the builder disk)', container.builderCacheBytes],
      ['Unused BuildKit cache', container.builderReclaimableBytes],
    ] as const)
      breakdown.append(
        el('dt', {}, label),
        el('dd', {}, bytes === null ? 'Not reported' : formatByteSize(bytes)),
      )
    const images = qsRequired(element, '#storage-container-images')
    images.replaceChildren()
    for (const image of container.images)
      images.append(
        el(
          'p',
          { class: 'field-hint' },
          `${image.name}: ${formatByteSize(image.bytes)} compressed · ${formatByteSize(image.snapshotBytes)} snapshot${image.eligible ? ' · extra Copse image' : ''}`,
        ),
      )
  }
  async function refresh(): Promise<void> {
    const token = ++generation
    controls()
    try {
      const next = await api.storage.maintenance()
      if (token !== generation) return
      state = next
      renderContainers()
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
  async function cleanContainers(action: ContainerStorageAction): Promise<void> {
    const detail: Record<ContainerStorageAction, string> = {
      'worker-images':
        'Remove unused extra Copse worker images. The local worker is kept. Apple also collects orphaned snapshots and image blobs from its shared cache.',
      'apple-images':
        'Remove dangling images, orphaned snapshots and image blobs from the shared Apple container cache. This can affect other applications and require images to be downloaded again. Tagged worker images are kept.',
      'apple-builder':
        'Remove unused build cache from the shared Apple builder. Other applications may need to rebuild cached layers. The builder remains running and its sparse disk may retain allocated space.',
    }
    if (
      !(await showConfirmDialog({
        message: 'Clean Apple container storage?',
        detail: detail[action],
        confirmLabel: 'Clean up',
        danger: true,
      }))
    )
      return
    working = true
    generation++
    controls()
    status.textContent = 'Cleaning up…'
    try {
      const result = await api.storage.containerCleanup(action)
      await refresh()
      status.textContent =
        result.skipped && result.removed === 0
          ? 'Cleanup paused: storage is in use or images are protected.'
          : `Apple container cleanup finished. Reported disk allocation decreased by ${formatByteSize(result.bytes)}.`
    } catch (error) {
      status.textContent = errorMessage(error)
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
  for (const action of CONTAINER_STORAGE_ACTIONS)
    qsRequired(element, `#storage-${action}-clean`).addEventListener('click', () => {
      void cleanContainers(action)
    })
  controls()
  return { element, refresh }
}

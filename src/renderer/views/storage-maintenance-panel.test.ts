import { emptyContainerStorage } from '@shared/types/storage-cleanup.ts'
import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createStorageMaintenancePanel } from './storage-maintenance-panel.ts'
import {
  mountConfirmDialog,
  clickActiveConfirmDialogConfirm,
  clickActiveConfirmDialogCancel,
} from './confirm-dialog.ts'
import type {
  StorageArea,
  StorageMaintenanceState,
  StorageRetention,
} from '@shared/types/storage-cleanup.ts'

beforeEach(() => {
  document.body.replaceChildren()
  mountConfirmDialog()
})
function state(busy = false): StorageMaintenanceState {
  return {
    containers: emptyContainerStorage(),
    retention: { enabled: true, days: 30 },
    areas: [
      { area: 'runs', bytes: 1024, entries: 1, busy },
      { area: 'builds', bytes: 2048, entries: 1, busy: false },
    ],
  }
}
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

test('cleanup requires confirmation, respects cancellation and refreshes after removal', async () => {
  const base = createFakeApi()
  const calls: StorageArea[] = []
  const panel = createStorageMaintenancePanel({
    ...base,
    storage: {
      ...base.storage,
      maintenance: async () => state(),
      cleanup: async (area) => {
        calls.push(area)
        return { removed: 1, bytes: 1024, skipped: 0 }
      },
    },
  })
  document.body.append(panel.element)
  await panel.refresh()
  const button = panel.element.querySelector<HTMLButtonElement>('#storage-runs-clean')
  assert.ok(button)
  button.click()
  await settle()
  assert.equal(calls.length, 0)
  clickActiveConfirmDialogCancel()
  await settle()
  assert.equal(calls.length, 0)
  button.click()
  await settle()
  clickActiveConfirmDialogConfirm()
  await settle()
  assert.deepEqual(calls, ['runs'])
  assert.match(
    panel.element.querySelector('#storage-maintenance-status')?.textContent ?? '',
    /Removed 1 item/,
  )
})

test('busy categories are disabled; retention persists independently of the settings save bar', async () => {
  const base = createFakeApi()
  const policies: StorageRetention[] = []
  const panel = createStorageMaintenancePanel({
    ...base,
    storage: {
      ...base.storage,
      maintenance: async () => state(true),
      retention: async (policy) => {
        policies.push(policy)
      },
    },
  })
  document.body.append(panel.element)
  await panel.refresh()
  assert.equal(
    panel.element.querySelector<HTMLButtonElement>('#storage-runs-clean')?.disabled,
    true,
  )
  assert.equal(
    panel.element.querySelector<HTMLButtonElement>('#storage-builds-clean')?.disabled,
    false,
  )
  assert.equal(panel.element.querySelector('#storage-runs-size')?.textContent, 'In use')
  const input = panel.element.querySelector<HTMLInputElement>('#storage-expiry-enabled')
  assert.ok(input)
  input.checked = false
  input.dispatchEvent(new Event('change'))
  await settle()
  assert.deepEqual(policies, [{ enabled: false, days: 30 }])
})

test('Apple storage shows all categories and image names as text; shared cleanup requires confirmation', async () => {
  const base = createFakeApi()
  const calls: string[] = []
  const next = state()
  next.containers = {
    ...emptyContainerStorage(),
    available: true,
    builderRunning: true,
    totalBytes: 70 * 1024 ** 3,
    snapshotsBytes: 53 * 1024 ** 3,
    containersBytes: 15 * 1024 ** 3,
    blobsBytes: 1024 ** 3,
    volumesBytes: 100,
    snapshotCount: 22,
    unmatchedSnapshots: 15,
    images: [
      {
        name: '<img src=x onerror=alert(1)>',
        bytes: 598000000,
        snapshotBytes: 3 * 1024 ** 3,
        eligible: true,
      },
    ],
  }
  const panel = createStorageMaintenancePanel({
    ...base,
    storage: {
      ...base.storage,
      maintenance: async () => next,
      containerCleanup: async (action) => {
        calls.push(action)
        return { removed: 1, bytes: 0, skipped: 0 }
      },
    },
  })
  document.body.append(panel.element)
  await panel.refresh()
  assert.match(
    panel.element.querySelector('#storage-container-breakdown')?.textContent ?? '',
    /22; 15 not matched to listed images/,
  )
  assert.equal(panel.element.querySelectorAll('#storage-container-breakdown dt').length, 9)
  assert.equal(panel.element.querySelector('#storage-container-images img'), null)
  assert.match(
    panel.element.querySelector('#storage-container-images')?.textContent ?? '',
    /<img src=x/,
  )
  const button = panel.element.querySelector<HTMLButtonElement>('#storage-apple-images-clean')
  assert.ok(button)
  button.click()
  await settle()
  assert.deepEqual(calls, [])
  assert.match(document.querySelector('#confirm-dialog')?.textContent ?? '', /other applications/)
  clickActiveConfirmDialogConfirm()
  await settle()
  assert.deepEqual(calls, ['apple-images'])
  next.containers.busy = true
  await panel.refresh()
  assert.equal(button.disabled, true)
})

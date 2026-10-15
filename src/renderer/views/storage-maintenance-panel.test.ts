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

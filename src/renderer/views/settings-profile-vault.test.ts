import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createProfileVaultSection } from './settings-profile-vault.ts'
import type { ProfileVaultAction, ProfileVaultResult } from '@shared/types/profile-vault.ts'

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}
function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((value) => value.textContent === label)
  assert.ok(found)
  return found
}
describe('saved-secret encryption controls', () => {
  it('keeps cancelled native authentication locked without exposing a secret field', async () => {
    const root = createProfileVaultSection({
      status: async () => ({
        state: 'locked',
        enabled: true,
        available: true,
        requireAuth: true,
        recovery: 'not-backed-up',
      }),
      run: async () => ({ ok: false, reason: 'cancelled' }),
    })
    await flush()
    button(root, 'Unlock').click()
    await flush()
    assert.equal(root.dataset['state'], 'locked')
    assert.match(root.textContent, /Cancelled. Your saved credentials are unchanged/)
    assert.equal(root.querySelector('input[type=password]'), null)
    assert.equal(button(root, 'Unlock').disabled, false)
  })
  it('offers optional startup authentication while always explaining authenticated export', async () => {
    let requireAuth = false
    let finish: (result: ProfileVaultResult) => void = () => assert.fail('request not started')
    const calls: ProfileVaultAction[] = []
    const root = createProfileVaultSection({
      status: async () => ({
        state: 'unlocked',
        enabled: true,
        available: true,
        requireAuth,
        recovery: 'not-backed-up',
      }),
      run: (action) => {
        calls.push(action)
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    await flush()
    const checkbox = root.querySelector('input')
    assert.ok(checkbox)
    assert.equal(checkbox.checked, false)
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change'))
    assert.equal(checkbox.disabled, true)
    assert.deepEqual(calls, [{ action: 'set-auth', requireAuth: true }])
    requireAuth = true
    finish({ ok: true })
    await flush()
    assert.equal(root.querySelector('input')?.checked, true)
    assert.equal(root.dataset['state'], 'unlocked')
    assert.match(root.textContent, /Exporting a recovery key always requires authentication/)
    assert.match(root.textContent, /takes effect next time/)
    assert.ok(!root.textContent.includes('Lock and restart'))
  })
  it('offers migration retry without exposing an opt-in enrollment flow', async () => {
    const calls: ProfileVaultAction[] = []
    const root = createProfileVaultSection({
      status: async () => ({
        state: 'disabled',
        enabled: false,
        available: true,
        automatic: true,
        migrationFailed: true,
        recovery: 'not-backed-up',
      }),
      run: async (action) => {
        calls.push(action)
        return { ok: false, reason: 'unavailable' }
      },
    })
    await flush()
    button(root, 'Retry migration').click()
    await flush()
    assert.deepEqual(calls, [{ action: 'retry-migration' }])
    assert.equal(root.querySelector('input'), null)
    assert.match(root.textContent, /existing OS secure storage/)
  })
})

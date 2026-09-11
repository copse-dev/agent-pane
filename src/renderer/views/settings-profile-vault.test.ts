import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createProfileVaultSection } from './settings-profile-vault.ts'
import type { ProfileVaultApi, ProfileVaultResult } from '@shared/types/profile-vault.ts'

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
    const api: ProfileVaultApi = {
      status: () =>
        Promise.resolve({
          state: 'locked',
          enabled: true,
          available: true,
          recovery: 'not-backed-up',
        }),
      run: () => Promise.resolve({ ok: false, reason: 'cancelled' }),
    }
    const root = createProfileVaultSection(api)
    await flush()
    button(root, 'Unlock').click()
    await flush()
    assert.equal(root.dataset['state'], 'locked')
    assert.match(root.textContent, /Cancelled. Your saved credentials are unchanged/)
    assert.equal(root.querySelector('input[type=password]'), null)
    assert.equal(button(root, 'Unlock').disabled, false)
  })
  it('disables setup inputs during native work and preserves source on reported recovery failure', async () => {
    let finish: (value: ProfileVaultResult) => void = () => {
      assert.fail('request not started')
    }
    let calls = 0
    const root = createProfileVaultSection({
      status: () =>
        Promise.resolve({
          state: 'disabled',
          enabled: false,
          available: true,
          recovery: 'not-backed-up',
        }),
      run: () => {
        calls++
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    await flush()
    const enable = button(root, 'Enable encryption')
    enable.click()
    enable.click()
    assert.equal(calls, 1)
    assert.ok([...root.querySelectorAll('input')].every((input) => input.disabled))
    finish({ ok: false, reason: 'corrupt' })
    await flush()
    assert.match(root.textContent, /Verification failed/)
    assert.equal(root.dataset['state'], 'disabled')
    assert.equal(button(root, 'Enable encryption').disabled, false)
  })
})

import assert from 'node:assert/strict'
import { $, browser } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

// This foundation changes main-process persistence and IPC without changing DOM.
describe('ordinary Settings transaction IPC', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-transaction')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('round-trips null and merges role edits while rejecting a partial invalid save', async () => {
    await browser.execute(async () => {
      await window.api.settings.update({
        theme: 'dark',
        claudePlanMonthlyFeeUsd: null,
        roleModels: { coder: 'old', research: 'keep' },
      })
      await window.api.settings.update({ roleAssignments: { coder: 'chosen' } })
    })
    const before = await browser.execute(() => window.api.settings.getSnapshot())
    assert.ok(Object.hasOwn(before, 'claudePlanMonthlyFeeUsd'))
    assert.equal(before.claudePlanMonthlyFeeUsd, null)
    assert.deepEqual(before.roleModels, { coder: 'chosen', research: 'keep' })

    const rejected = await browser.execute(async () => {
      try {
        await window.api.settings.update({ theme: 'light', fontSize: -10 })
        return false
      } catch {
        return true
      }
    })
    assert.equal(rejected, true)
    assert.equal((await browser.execute(() => window.api.settings.getSnapshot())).theme, 'dark')

    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const reopened = await browser.execute(() => window.api.settings.getSnapshot())
    assert.ok(Object.hasOwn(reopened, 'claudePlanMonthlyFeeUsd'))
    assert.equal(reopened.claudePlanMonthlyFeeUsd, null)
    assert.equal(reopened.theme, 'dark')
    assert.deepEqual(reopened.roleModels, { coder: 'chosen', research: 'keep' })
  })
})

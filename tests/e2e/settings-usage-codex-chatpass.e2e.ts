import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

const e2eEnvFile = join(process.cwd(), 'tests/e2e/electron-shell/.e2e-env.json')

function setPlanUsageMock(mode: string): void {
  const env = JSON.parse(readFileSync(e2eEnvFile, 'utf8')) as Record<string, string>
  env.COPSE_PLAN_USAGE_MOCK = mode
  writeFileSync(e2eEnvFile, JSON.stringify(env), 'utf8')
}

describe('settings usage panel with a Codex ChatPass pool', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-usage-codex-chatpass')
    setPlanUsageMock('codex-chatpass')
    await browser.reloadSession()
  })

  after(async () => {
    setPlanUsageMock('1')
    resetUserData()
    await browser.reloadSession()
  })

  it('lists the spent weekly window beside the ChatPass window that still has room', async () => {
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()

    const codex = $('.usage-plan-provider[data-provider="codex"][data-status="ok"]')
    await expect(codex).toBeDisplayed()
    const labels = await codex.$$('.usage-plan-window-label').map((el) => el.getText())
    assert.deepEqual(labels, ['Weekly', 'ChatPass Weekly'])
    assert.equal((await $$('.usage-plan-provider[data-provider="codex"]')).length, 1)

    await prepareE2eScreenshot()
    await saveElementScreenshot('#settings-dialog', 'settings-usage-codex-chatpass.png')
  })
})

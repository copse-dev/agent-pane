import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

const e2eEnvFile = join(process.cwd(), 'tests/e2e/electron-shell/.e2e-env.json')

function setPlanUsageMock(mode: string): void {
  const env = JSON.parse(readFileSync(e2eEnvFile, 'utf8')) as Record<string, string>
  env.COPSE_PLAN_USAGE_MOCK = mode
  writeFileSync(e2eEnvFile, JSON.stringify(env), 'utf8')
}

describe('settings usage panel with a lapsed Claude token', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-usage-token-expired')
    setPlanUsageMock('claude-token-expired')
    await browser.reloadSession()
  })

  after(async () => {
    setPlanUsageMock('1')
    resetUserData()
    await browser.reloadSession()
  })

  it('offers an in-app Claude login for an expired token', async () => {
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()

    const claude = $('.usage-plan-provider[data-provider="claude"][data-status="unavailable"]')
    await expect(claude).toBeDisplayed()
    assert.match(await claude.$('.usage-plan-status').getText(), /access token has expired/i)
    const signIn = claude.$('.usage-plan-signin-btn')
    await expect(signIn).toBeDisplayed()
    assert.equal(await signIn.getText(), 'Sign in to Claude')

    await prepareE2eScreenshot()
    await saveElementScreenshot('#settings-dialog', 'settings-usage-plan-token-expired.png')
  })
})

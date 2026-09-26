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

  it('waits for Claude Code to refresh instead of asking to sign in', async () => {
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()

    const claude = $('.usage-plan-provider[data-provider="claude"][data-status="unavailable"]')
    await expect(claude).toBeDisplayed()
    assert.match(await claude.$('.usage-plan-status').getText(), /access token has expired/i)
    // Copse no longer refreshes the token itself, so a lapsed one is not a
    // sign-in problem: offering `claude /login` here would be a needless re-login.
    await expect(claude.$('.usage-plan-signin-btn')).not.toBeExisting()

    await prepareE2eScreenshot()
    await saveElementScreenshot('#settings-dialog', 'settings-usage-plan-token-expired.png')
  })
})

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

describe('settings usage panel plan errors', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-usage-auth-errors')
    setPlanUsageMock('auth-errors')
    await browser.reloadSession()
  })

  after(async () => {
    setPlanUsageMock('1')
    resetUserData()
    await browser.reloadSession()
  })

  it('shows rejected credentials as provider sign-in hints', async () => {
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()

    const claude = $('.usage-plan-provider[data-provider="claude"][data-status="unavailable"]')
    await expect(claude).toBeDisplayed()
    const claudeText = await claude.$('.usage-plan-status').getText()
    assert.match(claudeText, /Claude credentials were rejected/i)
    assert.doesNotMatch(
      claudeText,
      /HTTP 401|authentication_error|request_id|req_011Cd5RChA2NLVzY1EV634KW/,
    )
    // A rejected Claude credential offers an inline recovery affordance.
    const signIn = claude.$('.usage-plan-signin-btn')
    await expect(signIn).toBeDisplayed()
    assert.match(await signIn.getText(), /Sign in to Claude/i)
    // It is the kit primary (#3065), not a bespoke filled button: kit classes,
    // kit radius, and the readable --accent-fill tier behind its label.
    const signInStyle = await browser.execute(() => {
      const button = document.querySelector<HTMLElement>('.usage-plan-signin-btn')
      if (!button) return null
      const probe = document.createElement('div')
      probe.style.height = 'var(--radius)'
      probe.style.background = 'var(--accent-fill)'
      document.body.append(probe)
      const probeStyle = getComputedStyle(probe)
      const kit = { radius: probeStyle.height, fill: probeStyle.backgroundColor }
      probe.remove()
      const style = getComputedStyle(button)
      return {
        classes: [...button.classList],
        radius: style.borderTopLeftRadius,
        background: style.backgroundColor,
        kit,
      }
    })
    assert.ok(signInStyle, 'sign-in button not found')
    assert.ok(signInStyle.classes.includes('ui-btn'), 'sign-in is a kit button')
    assert.ok(signInStyle.classes.includes('ui-btn-primary'), 'sign-in is the kit primary')
    assert.equal(signInStyle.radius, signInStyle.kit.radius, 'sign-in uses the kit radius')
    assert.equal(signInStyle.background, signInStyle.kit.fill, 'sign-in fills with --accent-fill')

    await expect($('.usage-plan-provider[data-provider="codex"][data-status="ok"]')).toBeDisplayed()

    const hf = $('.usage-plan-provider[data-provider="huggingface"][data-status="error"]')
    await expect(hf).toBeDisplayed()
    assert.equal(
      await hf.$('.usage-plan-status-error').getText(),
      'Timed out while checking Hugging Face plan usage.',
    )

    const cursor = $('.usage-plan-provider[data-provider="cursor"][data-status="unavailable"]')
    await expect(cursor).toBeDisplayed()
    assert.match(await cursor.$('.usage-plan-status').getText(), /Cursor session was rejected/i)

    await prepareE2eScreenshot()
    await saveElementScreenshot('#settings-dialog', 'settings-usage-plan-auth-errors.png')
  })
})

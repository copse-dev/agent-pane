import { readFixtureJsonObject } from './helpers/fixture-json.ts'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

const e2eEnvFile = join(process.cwd(), 'tests/e2e/electron-shell/.e2e-env.json')
let initialEnv = ''
let fakeClaudeDir: string | null = null

function setPlanUsageMock(mode: string): void {
  const env = readFixtureJsonObject(e2eEnvFile)
  env['COPSE_PLAN_USAGE_MOCK'] = mode
  writeFileSync(e2eEnvFile, JSON.stringify(env), 'utf8')
}

describe('settings usage panel plan errors', () => {
  before(async () => {
    initialEnv = readFileSync(e2eEnvFile, 'utf8')
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-usage-auth-errors')
    setPlanUsageMock('auth-errors')
    await browser.reloadSession()
  })

  after(async () => {
    writeFileSync(e2eEnvFile, initialEnv, 'utf8')
    resetUserData()
    await browser.reloadSession()
    if (fakeClaudeDir) rmSync(fakeClaudeDir, { recursive: true, force: true })
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
    // The recovery command renders as inline code, never as raw backticks.
    await expect(claude.$('.usage-plan-status code')).toHaveText('claude auth login')
    assert.doesNotMatch(claudeText, /`/)
    // A rejected Claude credential offers an inline recovery affordance.
    const signIn = claude.$('.usage-plan-signin-btn')
    await expect(signIn).toBeDisplayed()
    assert.match(await signIn.getText(), /Sign in to Claude/i)
    await expect(signIn).toHaveAttribute('title', 'Open a terminal and run claude auth login')
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
    assert.doesNotMatch((await signIn.getAttribute('title')) ?? '', /`/)

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

    const planText = await browser.execute(() =>
      [...document.querySelectorAll('.usage-plan-provider')].map((card) => card.textContent).join(),
    )
    assert.doesNotMatch(planText, /`/, 'no plan-usage copy shows raw backtick delimiters')

    // The worth-it card, the ledger and the value map load after the plan cards.
    // They set the page's height, which the scrollbar and the content under the
    // action bar show, so capture once all three have drawn.
    await expect($('.usage-worth-section .usage-worth-card')).toBeExisting()
    await expect($('.usage-period-body .usage-headline')).toBeExisting()
    await expect($('.frontier-fieldset .frontier-chart > *')).toBeExisting()
    await prepareE2eScreenshot()
    await saveElementScreenshot('#settings-dialog', 'settings-usage-plan-auth-errors.png')
  })

  it('keeps Settings open and shows guided Claude sign-in progress', async () => {
    if (process.platform === 'win32') return
    fakeClaudeDir = mkdtempSync(join(tmpdir(), 'copse-claude-login-'))
    const fakeClaude = join(fakeClaudeDir, 'claude')
    writeFileSync(
      fakeClaude,
      '#!/bin/sh\nif [ "$2" = "login" ]; then while [ ! -f "$(dirname "$0")/ready" ]; do sleep 0.1; done; exit 0; fi\nif [ "$2" = "status" ]; then echo \'{"authMethod":"claude.ai"}\'; exit 0; fi\nexit 1\n',
    )
    chmodSync(fakeClaude, 0o755)
    const env = readFixtureJsonObject(e2eEnvFile)
    env['PATH'] = `${fakeClaudeDir}:${process.env['PATH'] ?? ''}`
    writeFileSync(e2eEnvFile, JSON.stringify(env), 'utf8')
    await browser.reloadSession()
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    await $('.usage-plan-signin-btn').click()
    const status = $('.usage-plan-signin-status')
    await expect(status).toBeDisplayed()
    assert.match(await status.getText(), /Complete Claude sign-in in the browser/)
    await expect($('.usage-plan-signin-btn')).toBeDisabled()
    await expect($('#settings-dialog')).toBeDisplayed()
    await prepareE2eScreenshot()
    await saveElementScreenshot('#settings-dialog', 'settings-usage-claude-signin-progress.png')
    writeFileSync(join(fakeClaudeDir, 'ready'), '')
    await expect(status).toHaveText('Claude sign-in complete.')
  })
})

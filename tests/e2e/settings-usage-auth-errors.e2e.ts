import { readFixtureJsonObject } from './helpers/fixture-json.ts'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { assertVisibleInSettings } from './helpers/settings-geometry.ts'

const e2eEnvFile = join(process.cwd(), 'tests/e2e/electron-shell/.e2e-env.json')
const CLAUDE_ROW = '.usage-plan-provider[data-provider="claude"]'
const CLAUDE_SIGN_IN = `${CLAUDE_ROW} .usage-plan-signin-btn`
const CLAUDE_SIGN_IN_STATUS = `${CLAUDE_ROW} .usage-plan-signin-status`
let initialEnv = ''
let fakeClaudeDir: string | null = null

/**
 * The status line is what each of these references is for: prove it is on
 * screen where the user clicked, then frame the Claude row that holds it.
 */
async function captureClaudeSignIn(filename: string): Promise<void> {
  await prepareE2eScreenshot()
  await assertVisibleInSettings(CLAUDE_SIGN_IN_STATUS)
  await saveElementScreenshot(CLAUDE_ROW, filename)
}

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
    // Release a held fixture even when a progress assertion/capture failed.
    if (fakeClaudeDir) writeFileSync(join(fakeClaudeDir, 'ready'), '')
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
    await expect(signIn).toHaveAttribute('title', 'Open Claude sign-in in your browser')
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

  it('shows each guided Claude sign-in outcome under its button, then recovers', async () => {
    if (process.platform === 'win32') return
    fakeClaudeDir = mkdtempSync(join(tmpdir(), 'copse-claude-login-'))
    const fakeClaude = join(fakeClaudeDir, 'claude')
    writeFileSync(join(fakeClaudeDir, 'mode'), 'nonzero')
    writeFileSync(
      fakeClaude,
      `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const directory = path.dirname(process.argv[1])
const mode = fs.readFileSync(path.join(directory, 'mode'), 'utf8')
if (process.argv[3] === 'login') {
  if (mode === 'nonzero') process.exit(19)
  if (mode === 'cancel') process.kill(process.pid, 'SIGTERM')
  if (mode === 'pending') {
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(directory, 'ready'))) clearInterval(timer)
    }, 25)
  }
} else if (process.argv[3] === 'status') {
  process.stdout.write(JSON.stringify({ authMethod: mode === 'api-key' ? 'api_key' : 'claude.ai' }))
} else process.exit(1)
`,
    )
    chmodSync(fakeClaude, 0o755)
    const env = readFixtureJsonObject(e2eEnvFile)
    env['PATH'] = `${fakeClaudeDir}:${process.env['PATH'] ?? ''}`
    writeFileSync(e2eEnvFile, JSON.stringify(env), 'utf8')
    await browser.reloadSession()
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    await expect($(`${CLAUDE_ROW}[data-status="unavailable"]`)).toBeDisplayed()

    // The executable boundary owns these outcomes. Keep the real usage IPC,
    // renderer handler and Settings dialog in the loop. A failure re-reads
    // nothing, so the rejected row keeps its button and clicking it again is
    // the retry; the outcome sits directly under that button each time.
    for (const [mode, message, shot] of [
      [
        'nonzero',
        'Claude sign-in did not complete. Try again, or run claude auth login in a terminal.',
        'settings-usage-claude-signin-failed.png',
      ],
      [
        'cancel',
        'Claude sign-in did not complete. Try again, or run claude auth login in a terminal.',
        null,
      ],
      [
        'api-key',
        'Claude is using an API key or token, not a Claude subscription sign-in.',
        'settings-usage-claude-signin-not-subscription.png',
      ],
    ] as const) {
      writeFileSync(join(fakeClaudeDir, 'mode'), mode)
      await expect($(CLAUDE_SIGN_IN)).toBeEnabled()
      await $(CLAUDE_SIGN_IN).click()
      await expect($(CLAUDE_SIGN_IN_STATUS)).toHaveText(message)
      await expect($(`${CLAUDE_SIGN_IN_STATUS} .ui-inline-status`)).toHaveAttribute(
        'data-status-kind',
        'error',
      )
      await expect($(CLAUDE_SIGN_IN)).toBeEnabled()
      await expect($(`${CLAUDE_ROW}[data-status="unavailable"]`)).toBeDisplayed()
      await expect($('#settings-dialog')).toBeDisplayed()
      if (shot) await captureClaudeSignIn(shot)
    }

    writeFileSync(join(fakeClaudeDir, 'mode'), 'pending')
    await $(CLAUDE_SIGN_IN).click()
    await expect($(CLAUDE_SIGN_IN_STATUS)).toHaveText(/Complete Claude sign-in in the browser/)
    await expect($(`${CLAUDE_SIGN_IN_STATUS} .ui-inline-status`)).toHaveAttribute(
      'data-status-kind',
      'pending',
    )
    await expect($(CLAUDE_SIGN_IN)).toBeDisabled()
    await expect($('#settings-dialog')).toBeDisplayed()
    await captureClaudeSignIn('settings-usage-claude-signin-progress.png')

    // Finishing the held login is the successful retry. Its forced re-read
    // replaces the rejected row with the signed-in plan: no stale rejection
    // copy or button is left beside "complete", and the outcome stays in the row.
    writeFileSync(join(fakeClaudeDir, 'ready'), '')
    await expect($(CLAUDE_SIGN_IN_STATUS)).toHaveText('Claude sign-in complete.')
    await expect($(`${CLAUDE_SIGN_IN_STATUS} .ui-inline-status`)).toHaveAttribute(
      'data-status-kind',
      'ok',
    )
    await expect($(`${CLAUDE_ROW}[data-status="ok"]`)).toBeDisplayed()
    await expect($(CLAUDE_SIGN_IN)).not.toBeExisting()
    assert.doesNotMatch(await $(CLAUDE_ROW).getText(), /credentials were rejected/i)
    await captureClaudeSignIn('settings-usage-claude-signin-retry.png')
  })
})

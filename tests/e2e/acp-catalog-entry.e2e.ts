import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'

// Owned by this spec: a protocol fixture, not a Copilot implementation or live eval.
const ACP_FIXTURE = `
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

assert.deepEqual(process.argv.slice(2), ['--acp', '--stdio'])
agent({ name: 'catalog-entry-fixture' })
  .onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {},
    agentInfo: { name: 'catalog-entry-fixture', version: '1' },
  }))
  .onRequest('session/new', () => ({ sessionId: 'catalog-fixture' }))
  .onRequest('session/prompt', async (ctx) => {
    assert.ok(ctx.params.prompt.some((block) =>
      block.type === 'text' && block.text.includes('Verify the catalog entry path.'),
    ))
    await ctx.client.notify(methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Catalog fixture turn completed.' },
      },
    })
    return { stopReason: 'end_turn' }
  })
  .onNotification('session/cancel', () => {})
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
`

describe('manual ACP catalog entry', function () {
  this.timeout(90_000)
  let scratch = ''
  let command = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    mkdirSync(join(process.cwd(), '.tmp'), { recursive: true })
    scratch = mkdtempSync(join(process.cwd(), '.tmp/acp-catalog-e2e-'))
    const fixture = join(scratch, 'catalog-acp-agent.mjs')
    writeFileSync(fixture, ACP_FIXTURE)
    command = join(scratch, process.platform === 'win32' ? 'copilot.cmd' : 'copilot')
    // Inject at the executable boundary through the supported Command editor.
    // The real catalog arguments still reach the child; no registration is seeded.
    writeFileSync(
      command,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
        : `#!${process.execPath}\nvoid import(${JSON.stringify(pathToFileURL(fixture).href)})\n`,
      { mode: 0o755 },
    )
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-acp-catalog-entry', {
      windowBounds: { width: 1280, height: 800 },
      registeredAcpAgents: [],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('adds from Settings, selects in the picker and completes a fixture turn', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed()
    await $('.settings-nav-btn[data-section="general"]').click()
    const chip = await $('.provider-chip[data-provider="github-copilot-cli"]')
    await chip.waitForDisplayed()
    await chip.click()
    const note = await $('.acp-known-agent-note')
    await expect(note).toHaveText(expect.stringContaining('Manual setup'))
    await expect(note).toHaveText(expect.stringContaining('BYOK is billed by your model provider'))
    await note.scrollIntoView({ block: 'center' })
    await saveElementScreenshot(
      '.provider-capability .provider-form',
      'acp-copilot-manual-setup.png',
    )
    await $('button=Add to my agents').click()

    const card = await $('.acp-agent-card')
    await card.waitForExist()
    const commandInput = await card.$('label*=Command').$('input')
    await expect(commandInput).toHaveValue('copilot')
    await expect(card.$('label*=Arguments').$('textarea')).toHaveValue('--acp\n--stdio')
    await commandInput.setValue(command)
    await card.$('button=Save').click()
    await $('.acp-agent-card').$('button=Detect models').click()
    await browser.waitUntil(
      async () => (await $('.acp-agent-card').getText()).includes('no selectable models'),
      {
        timeout: 20_000,
        timeoutMsg: 'the fixture did not finish the Settings model probe',
      },
    )
    await $('#settings-close').click()

    await $('.model-picker-trigger').click()
    await $('.model-picker-browse').click()
    await $('.model-picker-filter').setValue('Copilot')
    const option = await $('.model-picker-option[data-value="acp:github-copilot-cli"]')
    await option.waitForDisplayed({ timeout: 10_000 })
    await expect(option).toHaveText(expect.stringContaining('GitHub Copilot CLI'))
    await saveElementScreenshot('.model-picker-menu', 'acp-copilot-model-picker.png')
    await option.click()
    await setComposerValue('Verify the catalog entry path.')
    await submitComposer()
    await browser.waitUntil(
      async () => (await $('.messages-list').getText()).includes('Catalog fixture turn completed.'),
      {
        timeout: 30_000,
        timeoutMsg: 'the registered ACP fixture did not receive and complete the turn',
      },
    )
    await waitForAgentIdle(15_000)
    const transcript = await $('.messages-list').getText()
    assert.ok(transcript.includes('Catalog fixture turn completed.'))
    await saveElementScreenshot('.messages-list', 'acp-copilot-fixture-turn.png')
  })
})

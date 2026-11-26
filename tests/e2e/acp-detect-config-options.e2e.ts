import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

// A fixture agent that advertises a reasoning-level selector on `session/new`.
// Settings → Detect models runs the real isolated probe worker
// (acp-probe-host.ts), whose result must keep `configOptions` so the composer's
// model picker can offer the selector without a turn. The picker rendering from
// a seeded cache is footer-acp-config-options.e2e.ts; this spec is the probe
// path that fills that cache.
const ACP_FIXTURE = `
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { agent, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable'

assert.deepEqual(process.argv.slice(2), ['--acp', '--stdio'])
agent({ name: 'config-options-fixture' })
  .onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {},
    agentInfo: { name: 'config-options-fixture', version: '1' },
  }))
  .onRequest('session/new', () => ({
    sessionId: 'config-options-fixture-session',
    configOptions: [
      {
        id: 'thinking',
        name: 'Thinking effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'medium',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
    ],
  }))
  .onRequest('session/prompt', async () => ({ stopReason: 'end_turn' }))
  .onNotification('session/cancel', () => {})
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
`

const AGENT_ID = 'config-options-fixture'

describe('ACP Detect models keeps the agent’s config options', function () {
  this.timeout(90_000)
  let scratch = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    const workspace = seedStableWorkspace()
    // A fixed path keeps the Command field identical between runs.
    scratch = join(workspace, 'acp-config-options-e2e')
    rmSync(scratch, { recursive: true, force: true })
    mkdirSync(scratch, { recursive: true })
    const fixture = join(scratch, 'config-options-acp-agent.mjs')
    buildSync({
      stdin: {
        contents: ACP_FIXTURE,
        resolveDir: process.cwd(),
        sourcefile: 'config-options-agent.mjs',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: fixture,
    })
    const command = join(
      scratch,
      process.platform === 'win32' ? 'config-options.cmd' : 'config-options',
    )
    writeFileSync(
      command,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
        : `#!${process.execPath}\nvoid import(${JSON.stringify(pathToFileURL(fixture).href)})\n`,
      { mode: 0o755 },
    )
    resetUserData()
    seedEmptyProject(workspace, 'e2e-acp-detect-config-options', {
      windowBounds: { width: 1280, height: 800 },
      model: `acp:${AGENT_ID}`,
      registeredAcpAgents: [
        {
          id: AGENT_ID,
          title: 'Config options fixture',
          command,
          args: ['--acp', '--stdio'],
          enabled: true,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('offers the probed reasoning level in the composer model picker', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    // Nothing probed yet: the picker has no selector rows for the agent.
    await $('.model-picker-trigger').click()
    await $('.model-picker-menu').waitForDisplayed()
    await expect($$('.model-picker-group-row')).toBeElementsArrayOfSize(0)
    await $('.model-picker-trigger').click()
    await expect($('.model-picker-menu')).not.toBeDisplayed()

    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed()
    await $('.settings-nav-btn[data-section="general"]').click()
    const options = await $(`.acp-row[data-agent="${AGENT_ID}"] button[aria-expanded]`)
    await options.waitForExist({ timeout: 15_000 })
    await options.click()
    const card = await $('.acp-agent-card')
    await card.waitForExist({ timeout: 15_000 })
    await card.$('button=Detect models').click()
    await browser.waitUntil(async () => (await card.getText()).includes('Detected'), {
      timeout: 20_000,
      timeoutMsg: 'the fixture did not finish the Settings probe',
    })
    await $('#settings-close').click()
    await expect($('#settings-dialog')).not.toBeDisplayed()

    await $('.model-picker-trigger').click()
    await $('.model-picker-menu').waitForDisplayed()
    await expect($$('.model-picker-group-row')).toBeElementsArrayOfSize(1)
    const row = $('.model-picker-group-row')
    await expect(row.$('.model-picker-group-row-label')).toHaveText('Thinking effort')
    await expect(row.$('.model-picker-group-row-value')).toHaveText('Medium')
    await saveElementScreenshot('.model-picker-menu', 'acp-detect-config-options-menu.png')
  })
})

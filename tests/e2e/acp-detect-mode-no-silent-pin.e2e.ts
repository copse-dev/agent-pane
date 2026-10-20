import assert from 'node:assert/strict'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { copseUserDataDir } from '../../src/main/services/storage/copse-paths.ts'

// A fixture agent that advertises a non-empty current session mode, the way
// Claude Code's real ACP implementation defaults new sessions to a mode other
// than "none selected". Detect models must not let that advertised default
// silently become this config's *saved* permission mode — see
// acp-agents-section.ts, where "Detect models" used to seed the Mode <select>
// from `probe.modes.currentValue` whenever the field was still unset, so the
// next Save persisted the agent's own default as if the user had chosen it.
const ACP_FIXTURE = `
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

assert.deepEqual(process.argv.slice(2), ['--acp', '--stdio'])
agent({ name: 'mode-default-fixture' })
  .onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {},
    agentInfo: { name: 'mode-default-fixture', version: '1' },
  }))
  .onRequest('session/new', () => ({
    sessionId: 'mode-default-fixture-session',
    modes: {
      currentModeId: 'auto',
      availableModes: [
        { id: 'auto', name: 'Auto' },
        { id: 'acceptEdits', name: 'Accept edits' },
      ],
    },
  }))
  .onRequest('session/prompt', async () => ({ stopReason: 'end_turn' }))
  .onNotification('session/cancel', () => {})
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
`

describe('ACP Detect models does not pin the agent default mode', function () {
  this.timeout(90_000)
  let scratch = ''
  let command = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    const workspace = seedStableWorkspace()
    scratch = mkdtempSync(join(workspace, 'acp-mode-default-e2e-'))
    const fixture = join(scratch, 'mode-default-acp-agent.mjs')
    buildSync({
      stdin: {
        contents: ACP_FIXTURE,
        resolveDir: process.cwd(),
        sourcefile: 'mode-default-agent.mjs',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: fixture,
    })
    command = join(scratch, process.platform === 'win32' ? 'mode-default.cmd' : 'mode-default')
    writeFileSync(
      command,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
        : `#!${process.execPath}\nvoid import(${JSON.stringify(pathToFileURL(fixture).href)})\n`,
      { mode: 0o755 },
    )
    resetUserData()
    seedEmptyProject(workspace, 'e2e-acp-mode-default', {
      windowBounds: { width: 1280, height: 800 },
      registeredAcpAgents: [],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('leaves the saved agent on "Agent default" after probing a mode-advertising fixture', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed()
    await $('.settings-nav-btn[data-section="general"]').click()
    await $('[data-testid="connections-add-toggle"]').click()
    await $('.acp-add-row[data-add="agent"]').$('button=Set up').click()

    const form = await $('.acp-add-menu .acp-agent-form')
    await form.$('label*=Id').$('input').setValue('mode-default-fixture')
    await form.$('label*=Title').$('input').setValue('Mode default fixture')
    await form.$('label*=Command').$('input').setValue(command)
    await form.$('label*=Arguments').$('textarea').setValue('--acp\n--stdio')
    await form.$('button=Add agent').click()

    const card = await $('.acp-agent-card')
    await card.waitForExist({ timeout: 10_000 })
    await card.$('button=Save').click()

    const modeSelect = card.$('label*=Permission mode').$('select')
    await expect(modeSelect).toHaveValue('')

    await card.$('button=Detect models').click()
    await browser.waitUntil(async () => (await card.getText()).includes('permission modes'), {
      timeout: 20_000,
      timeoutMsg: 'the fixture did not finish the Settings mode probe',
    })

    // The fixture's advertised default ("auto") must stay informational only —
    // the select itself must still read "Agent default", not the probed value.
    await expect(modeSelect).toHaveValue('')
    await expect(card).toHaveText(expect.stringContaining('agent default: auto'))
    await modeSelect.scrollIntoView({ block: 'center' })
    await saveAppScreenshot('acp-mode-default-detected.png')

    await card.$('button=Save').click()
    const settingsPath = join(copseUserDataDir(), 'settings.json')
    const settings = safeJsonParse(
      readFileSync(settingsPath, 'utf8'),
      decodeWithSchema(
        z.object({
          registeredAcpAgents: z.array(
            z.object({ id: z.string(), permissionMode: z.string().optional() }),
          ),
        }),
      ),
    )
    assert.ok(settings, 'expected valid persisted ACP agent settings')
    const saved = settings.registeredAcpAgents.find((a) => a.id === 'mode-default-fixture')
    assert.ok(saved, 'expected the fixture agent to be persisted')
    assert.equal(
      saved.permissionMode,
      undefined,
      'Detect models must not silently persist the agent-advertised default as the saved permission mode',
    )
  })
})

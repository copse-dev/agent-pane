import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const FAILURE = 'Could not check this coding agent. Try again.'

// A real external agent fails during initialization. The Settings card must
// show a stable user message; the worker's fail-closed path has separate coverage.
const ACP_FIXTURE = `
import { Readable, Writable } from 'node:stream'
import { agent, ndJsonStream } from '@agentclientprotocol/sdk/unstable'

agent({ name: 'probe-failure-fixture' })
  .onRequest('initialize', () => { throw new Error('fixture initialization failed') })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
`

describe('coding agent check failure copy', function () {
  this.timeout(90_000)
  let scratch = ''

  before(async () => {
    const workspace = seedStableWorkspace()
    scratch = join(workspace, 'acp-probe-failure-e2e')
    rmSync(scratch, { recursive: true, force: true })
    mkdirSync(scratch, { recursive: true })
    const fixture = join(scratch, 'fail-agent.mjs')
    buildSync({
      stdin: { contents: ACP_FIXTURE, resolveDir: process.cwd(), sourcefile: 'fail-agent.mjs' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: fixture,
    })
    const command = join(scratch, process.platform === 'win32' ? 'fail-agent.cmd' : 'fail-agent')
    writeFileSync(
      command,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
        : `#!${process.execPath}\nvoid import(${JSON.stringify(pathToFileURL(fixture).href)})\n`,
      { mode: 0o755 },
    )
    resetUserData()
    seedEmptyProject(workspace, 'e2e-acp-probe-failure-copy', {
      windowBounds: { width: 1280, height: 800 },
      registeredAcpAgents: [
        { id: 'probe-failure-fixture', title: 'Check failure fixture', command, enabled: true },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('shows a readable failure in the Settings agent card', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed()
    await $('.settings-nav-btn[data-section="general"]').click()
    await $('.acp-row[data-agent="probe-failure-fixture"]').$('button=Options').click()
    const card = await $('.acp-agent-card')
    await card.waitForDisplayed()
    await card.$('button=Detect models').click()
    const error = card.$('.acp-model-row + .field-hint [data-status-kind="error"]')
    await error.waitForDisplayed({ timeout: 20_000 })
    await expect(error).toHaveText(FAILURE)
    await expect(error).not.toHaveText(expect.stringContaining('acp:probe-agent'))
    await saveElementScreenshot(
      '.acp-agent-card label:has(.acp-model-row)',
      'acp-probe-failure-copy.png',
    )
  })
})

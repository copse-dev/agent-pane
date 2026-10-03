import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'

// A real local ACP process reached only after the user reviews and enables the
// custom draft. Discovery itself must never start it or a package runner.
const AGENT = `
import { writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
writeFileSync(new URL('./launched', import.meta.url), 'yes')
agent({ name: 'registry-entry-fixture' })
  .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest('session/new', () => ({ sessionId: 'registry-session' }))
  .onRequest('session/prompt', async (ctx) => {
    await ctx.client.notify(methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Registry fixture completed.' } },
    })
    return { stopReason: 'end_turn' }
  })
  .onNotification('session/cancel', () => {})
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
`

describe('public agent registry discovery', function () {
  this.timeout(90_000)
  let scratch = ''
  let registryFile = ''
  let executable = ''
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    mkdirSync(join(process.cwd(), '.tmp'), { recursive: true })
    scratch = mkdtempSync(join(process.cwd(), '.tmp/acp-registry-e2e-'))
    registryFile = join(scratch, 'registry.json')
    executable = join(scratch, 'agent.mjs')
    writeFileSync(executable, AGENT)
    writeFileSync(
      registryFile,
      JSON.stringify({
        version: '1.0.0',
        agents: [
          {
            id: 'community-agent',
            name: 'Community Agent',
            version: '1.2.3',
            description:
              'An independently published coding agent. Configure an installed executable to get started.',
            website: 'https://example.com/agent',
            distribution: {
              npx: {
                package: '@community/agent@1.2.3',
                args: ['--acp'],
                env: { SECRET: 'must-not-import' },
              },
            },
            sandbox: { allowedDomains: ['*'], homeDirs: ['.ssh'] },
            autoInstall: true,
          },
        ],
      }),
    )
    writeE2eEnv({ COPSE_E2E_ACP_REGISTRY_FIXTURE: registryFile })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-acp-registry', {
      windowBounds: { width: 1280, height: 800 },
      registeredAcpAgents: [],
    })
    await browser.reloadSession()
  })
  after(() => {
    writeE2eEnv({ COPSE_E2E_ACP_REGISTRY_FIXTURE: undefined })
    resetUserData()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('discovers without executing, reviews a disabled draft, then explicitly enables and runs it', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed()
    await $('.settings-nav-btn[data-section="general"]').click()
    assert.equal(existsSync(`${registryFile}.requests`), false)
    await $('.provider-chip[data-provider="other"]').click()
    await $('.provider-vendor')
      .$('label*=What are you adding?')
      .$('select')
      .selectByAttribute('value', 'agent')
    await $('.acp-registry-toggle').click()
    await $('.acp-registry-entry').waitForDisplayed()
    await expect($('.acp-registry-entry')).toHaveText(expect.stringContaining('Unverified'))
    await expect($('.acp-registry-entry')).toHaveText(
      expect.stringContaining('Installed status unknown'),
    )
    assert.equal(readFileSync(`${registryFile}.requests`, 'utf8'), 'fetch\n')
    assert.equal(existsSync(join(scratch, 'launched')), false)
    const search = await $('[aria-label="Search agent registry"]')
    await search.setValue('absent')
    await expect($('.acp-registry-results')).toHaveText('No agents match your search.')
    await search.setValue('Community')
    await $('.acp-registry-browser').scrollIntoView({ block: 'start' })
    await saveElementScreenshot('.acp-registry-browser', 'acp-registry-browser.png')

    writeFileSync(`${registryFile}.offline`, '')
    await $('button=Refresh registry').click()
    await browser.waitUntil(async () =>
      (await $('.acp-registry-content [role="status"]').getText()).includes(
        'Previously loaded entries',
      ),
    )
    await expect($('.acp-registry-entry')).toExist()
    rmSync(`${registryFile}.offline`)
    await $('button=Refresh registry').click()
    await browser.waitUntil(async () =>
      (await $('.acp-registry-content [role="status"]').getText()).startsWith('1 registry entries'),
    )
    await $('button=Review configuration').click()
    await expect($('.acp-registry-draft-note')).toBeDisplayed()
    const form = await $('.provider-add-host .acp-agent-form')
    await expect(form.$('label*=Id').$('input')).toHaveValue('registry-community-agent')
    await expect(form.$('label*=Command').$('input')).toHaveValue('')
    await expect(form.$('label*=Environment').$('textarea')).toHaveValue('')
    await expect(form.$('.checkbox-label input')).not.toBeSelected()
    await expect(form.$('.checkbox-label input')).toBeDisabled()
    await $('.acp-registry-draft-note').scrollIntoView({ block: 'start' })
    await saveAppScreenshot('acp-registry-review.png')
    await form.$('.checkbox-label').scrollIntoView({ block: 'center' })
    await expect(form.$('.checkbox-label input')).toBeDisplayed()
    await saveAppScreenshot('acp-registry-review-enable.png')
    await form.$('label*=Command').$('input').setValue(process.execPath)
    await form.$('label*=Arguments').$('textarea').setValue(`${executable}\n--acp`)
    await form.$('button=Add agent').click()
    assert.equal(existsSync(join(scratch, 'launched')), false)

    await $('#settings-close').click()
    await $('.model-picker-trigger').click()
    await $('.model-picker-browse').click()
    await $('.model-picker-filter').setValue('Community')
    await expect($('.model-picker-empty')).toHaveText('No matching models')
    await expect($('.model-picker-option[data-value="acp:registry-community-agent"]')).not.toExist()
    await browser.keys('Escape')
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="general"]').click()
    await $('.provider-chip[data-provider="registry-community-agent"]').click()
    const card = await $('.acp-agent-card')
    await card.$('.checkbox-label input').click()
    await card.$('button=Save').click()
    assert.equal(existsSync(join(scratch, 'launched')), false)
    await $('.acp-agent-card').$('button=Detect models').click()
    await browser.waitUntil(async () =>
      (await $('.acp-agent-card').getText()).includes('no selectable models'),
    )
    assert.equal(existsSync(join(scratch, 'launched')), true)
    await $('#settings-close').click()
    await $('.model-picker-trigger').click()
    await $('.model-picker-browse').click()
    await $('.model-picker-filter').setValue('Community')
    await $('.model-picker-option[data-value="acp:registry-community-agent"]').click()
    await setComposerValue('Verify registry setup.')
    await submitComposer()
    await browser.waitUntil(async () =>
      (await $('.messages-list').getText()).includes('Registry fixture completed.'),
    )
    await waitForAgentIdle(15_000)
    await saveElementScreenshot('.messages-list', 'acp-registry-fixture-turn.png')
  })
})

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { parseAcpAgentConfigs } from '../../src/shared/acp.ts'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSettings,
  readSeededSettings,
} from './helpers/seed-config.ts'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

// No model call and no API request: a real ACP process returns a fixture bitmap.
describe('Image generation runner routing', function () {
  this.timeout(90_000)
  let scratch = ''
  before(async () => {
    resetUserData()
    const workspace = seedStableWorkspace()
    scratch = join(workspace, 'image-routing-fixture')
    mkdirSync(scratch, { recursive: true })
    const fixture = join(scratch, 'agent.cjs')
    const png = readFileSync(
      join(process.cwd(), 'tests/e2e/fixtures/inline-rollup-prototype.png'),
    ).toString('base64')
    buildSync({
      stdin: {
        contents: `
        const { Readable, Writable } = require('node:stream')
        const { agent, methods, ndJsonStream, PROTOCOL_VERSION } = require('@agentclientprotocol/sdk/unstable')
        agent({ name: 'image-fixture' })
          .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
          .onRequest('session/new', () => ({ sessionId: 'image-session' }))
          .onRequest('session/prompt', async ctx => {
            await ctx.client.notify(methods.client.session.update, { sessionId: ctx.params.sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: ${JSON.stringify(png)} } } })
            return { stopReason: 'end_turn' }
          })
          .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
      `,
        resolveDir: process.cwd(),
        sourcefile: 'image-fixture.cjs',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: fixture,
    })
    seedEmptyProject(workspace, 'e2e-image-routing', {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
      registeredAcpAgents: [
        {
          id: 'image-fixture',
          title: 'Image fixture',
          command: process.execPath,
          args: [fixture],
          enabled: true,
          imageGeneration: true,
          sandbox: false,
          configOptions: { effort: 'medium' },
        },
      ],
    })
    writeSettings({
      ...readSeededSettings(),
      apiKey: {
        openai: {
          v: 1,
          enc: Buffer.from('unused-image-fallback-key').toString('base64'),
          plain: true,
        },
      },
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    resetUserData()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('returns an image from an enabled ACP runner before consulting the API', async () => {
    const scenario = await prepareMockToolTurn(
      'Generate a review sheet.',
      { name: 'image_gen', args: { prompt: 'A review sheet' } },
      'The image is ready.',
    )
    await submitComposer()
    await waitForAgentIdle(45_000)
    await scenario.assertComplete()
    await expect($('.tool-result-images img')).toBeDisplayed()
    const result = await $('.tool-card').getText()
    assert.match(result, /Generated image/)
    assert.equal(await $('#approval-dialog').isDisplayed(), false)
    await saveElementScreenshot('.tool-result-images img', 'image-gen-acp-result.png')
  })

  it('persists the capability setting and asks before the paid API fallback', async () => {
    await $('[aria-label="Settings"]').click()
    const row = $('[data-row="agent:image-fixture"]')
    await row.$('button=Options').click()
    const capability = row.$('[data-testid="acp-image-generation"]')
    await capability.waitForDisplayed()
    await expect(capability).toBeChecked()
    await capability.click()
    await row.$('button=Save').click()
    await expect(capability).not.toBeChecked()
    await browser.waitUntil(
      () =>
        parseAcpAgentConfigs(readSeededSettings()['registeredAcpAgents'])[0]?.imageGeneration ===
        false,
    )
    const saved = parseAcpAgentConfigs(readSeededSettings()['registeredAcpAgents'])[0]
    assert.equal(saved?.sandbox, false, 'image routing must preserve existing sandbox choices')
    assert.deepEqual(saved.configOptions, { effort: 'medium' })
    await capability.scrollIntoView({ block: 'center' })
    await saveElementScreenshot(
      '[data-row="agent:image-fixture"] .acp-image-generation-field',
      'image-gen-runner-setting.png',
    )
    await $('#settings-close').click()
    const scenario = await prepareMockToolTurn(
      'Generate another review sheet.',
      { name: 'image_gen', args: { prompt: 'Another review sheet' } },
      'The API fallback was declined.',
    )
    await submitComposer()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Use the OpenAI API for this image?')
    await expect(dialog.$('.approval-body')).toHaveText(
      expect.stringContaining('separately from your ChatGPT plan'),
    )
    await expect(dialog.$('.approval-approve')).toHaveText('Use OpenAI API')
    await saveElementScreenshot('#approval-dialog', 'image-gen-api-fallback-approval.png')
    await dialog.$('.approval-reject').click()
    await waitForAgentIdle(30_000)
    await scenario.assertComplete()
  })
})

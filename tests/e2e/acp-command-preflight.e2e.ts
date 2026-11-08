import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { composerText, setComposerValue } from './helpers/composer.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

const PROMPT =
  'Review the project and prepare a careful implementation plan. Keep this complete request while I repair the agent setup.'
const FIXTURE = `
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable'
agent({ name: 'readiness-fixture' })
  .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest('session/new', () => ({ sessionId: 'readiness-fixture' }))
  .onRequest('session/prompt', async (ctx) => {
    const text = ctx.params.prompt.filter((block) => block.type === 'text').map((block) => block.text).join(' ')
    assert.ok(text.includes(${JSON.stringify(PROMPT)}))
    assert.ok(text.includes('Keep the amber theme and preserve existing work.'))
    await ctx.client.notify(methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The repaired agent received the preserved request.' } },
    })
    return { stopReason: 'end_turn' }
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
`

describe('missing local coding agent before first send', function () {
  this.timeout(90_000)
  let scratch = ''
  let command = ''

  before(async () => {
    if (process.platform === 'win32') return
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    const workspace = seedStableWorkspace()
    scratch = mkdtempSync(join(workspace, 'readiness-'))
    appendFileSync(join(workspace, '.git/info/exclude'), '\nreadiness-*/\n')
    const fixture = join(scratch, 'agent.mjs')
    buildSync({
      stdin: { contents: FIXTURE, resolveDir: process.cwd(), sourcefile: 'readiness.mjs' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: fixture,
    })
    command = join(scratch, 'repaired-agent')
    writeFileSync(
      command,
      `#!${process.execPath}\nvoid import(${JSON.stringify(pathToFileURL(fixture).href)})\n`,
      { mode: 0o755 },
    )
    resetUserData()
    seedEmptyProject(workspace, 'e2e-acp-readiness', {
      model: 'acp:readiness-fixture',
      subagentsEnabled: false,
      registeredAcpAgents: [
        {
          id: 'readiness-fixture',
          title: 'Coding agent',
          command: join(scratch, 'missing-agent'),
          enabled: true,
        },
      ],
      uiAccentColor: '#e7ad52',
    })
    // Discovery of unrelated host installations must not offer an install over
    // this controlled command-repair journey. No auth or permissions are changed.
    writeE2eEnv({ COPSE_PRESERVE_PATH: '1', PATH: '/usr/bin:/bin' })
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({})
    resetUserData()
    if (scratch) removeE2eTree(scratch)
  })

  it('keeps the unsent draft, identifies setup, and retries after repairing the command in Settings', async function () {
    if (process.platform === 'win32') this.skip()
    await setComposerValue(PROMPT)
    await browser.execute(() => {
      const inputBar = document.getElementById('input-bar')
      if (!inputBar) throw new Error('Missing composer')
      const transfer = new DataTransfer()
      transfer.items.add(
        new File(['Keep the amber theme and preserve existing work.'], 'requirements.txt', {
          type: 'text/plain',
        }),
      )
      inputBar.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      )
    })
    await expect($('.attachment-chip-label')).toHaveText('requirements.txt')
    const started = Date.now()
    await $('.submit-btn').click()
    const error = $('.composer-checkout-error')
    await error.waitForDisplayed({ timeout: 15_000 })
    await expect(error).toHaveText(
      expect.stringContaining('configured command is missing or not executable'),
    )
    await expect(error).toHaveText(expect.stringContaining('Settings → General → Models & agents'))
    assert.equal(await composerText(), PROMPT)
    await expect($('.attachment-chip-label')).toHaveText('requirements.txt')
    console.info(
      `[readiness] missing command detected in ${String(Date.now() - started)}ms; draft and attachment retained`,
    )
    await expect($('.msg-user')).not.toExist()
    await expect($('.msg-assistant')).not.toExist()
    await expect($('.submit-btn')).toBeEnabled()
    await saveAppScreenshot('acp-command-preflight.png')

    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed()
    await $('.acp-row[data-row="agent:readiness-fixture"]').$('button=Options').click()
    const card = $('.acp-agent-card')
    await card.$('label*=Command').$('input').setValue(command)
    await card.$('button=Save').click()
    await $('#settings-close').click()
    assert.equal(await composerText(), PROMPT)
    await expect($('.attachment-chip-label')).toHaveText('requirements.txt')
    await $('.composer-checkout-retry-btn').click()
    await browser.waitUntil(
      async () =>
        (await $('.messages-list').getText()).includes(
          'The repaired agent received the preserved request.',
        ),
      { timeout: 30_000 },
    )
    assert.equal(await composerText(), '')
    await expect(error).not.toBeDisplayed()
    await expect($('.msg-user')).toHaveText(expect.stringContaining(PROMPT))
    await saveAppScreenshot('acp-command-preflight-recovered.png')
  })
})

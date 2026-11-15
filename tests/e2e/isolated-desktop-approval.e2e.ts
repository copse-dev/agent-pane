import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { copseDataRoot } from '@copse/store-kit/copse-paths.ts'
import { readAppleDesktopPin } from '../../scripts/lib/apple-desktop-pin.mts'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import {
  expectAssistantReply,
  installMockScenario,
  prepareMockToolTurn,
  prepareMockTurn,
} from './helpers/mock-scenario.ts'
import {
  readSeededSettings,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSettings,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

// Apple container is a native Apple-silicon feature; Linux has no host fallback.
const supported = process.platform === 'darwin' && process.arch === 'arm64'

const containerListSchema = z.array(z.object({ configuration: z.object({ id: z.string() }) }))

/** Names of guest VMs the Apple engine knows about, running or not. */
function isolatedDesktopVms(): string[] {
  const output = execFileSync('container', ['list', '--all', '--format', 'json'], {
    encoding: 'utf8',
    env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: homedir() },
  })
  const listed = safeJsonParse(output, decodeWithSchema(containerListSchema))
  if (!listed) throw new Error('container list returned unexpected JSON')
  return listed
    .map((entry) => entry.configuration.id)
    .filter((id) => id.startsWith('copse-desktop-probe-'))
}

async function importTrustedDesktopPin(): Promise<void> {
  // Import only the builder's validated image identity, never a host profile or key.
  const digest = await readAppleDesktopPin({ COPSE_DIR: join(homedir(), '.copse') })
  const directory = join(copseDataRoot(), 'isolated-desktop')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(directory, 'image-pin.json'), JSON.stringify({ version: 1, digest }), {
    mode: 0o600,
  })
}

;(supported ? describe : describe.skip)('isolated Copse desktop consent', function () {
  this.timeout(60_000)
  let acpScratch = ''
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-isolated-desktop-approval', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    writeSettings({
      ...readSeededSettings(),
      extraProviders: [
        {
          slug: 'isolated-approval',
          label: 'Approval fixture',
          baseUrl: 'http://127.0.0.1:1/v1',
          models: [{ id: 'demo', contextWindow: 8192 }],
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (acpScratch) removeE2eTree(acpScratch)
  })

  it('names the VM, fixed model and budget before any guest starts', async () => {
    const scenario = await prepareMockToolTurn(
      'Open an isolated Copse desktop.',
      {
        name: 'isolated_copse',
        args: { action: 'start', model: 'isolated-approval:demo' },
      },
      'The isolated desktop was not started.',
    )
    await submitComposer()
    const dialog = $('#approval-dialog')
    try {
      await dialog.waitForDisplayed({ timeout: 10_000 })
    } catch (error) {
      const visibleText = await browser.execute(() => document.body.innerText.slice(-6000))
      throw new Error('Isolated desktop consent did not appear. Visible UI: ' + visibleText, {
        cause: error,
      })
    }
    await expect(dialog.$('.approval-heading')).toHaveText('Allow isolated Copse control?')
    await expect(dialog.$('.approval-body')).toBeDisplayed()
    await expect(dialog.$('.approval-remember-input')).not.toBeDisplayed()
    for (const text of [
      'disposable Apple container VM',
      'isolated-approval:demo',
      '100,000',
      '15 minutes',
      'No host folders',
      // The grant outlives the turn, so consent says how it ends instead.
      'stays up between turns',
      'Stop or archiving the thread deletes it',
    ]) {
      await expect(dialog.$('.approval-body')).toHaveText(expect.stringContaining(text))
    }
    const bodyFits = await dialog
      .$('.approval-body')
      .getElement()
      .then((body) =>
        browser.execute((element) => element.scrollHeight <= element.clientHeight + 1, body),
      )
    expect(bodyFits).toBe(true)
    await saveAppScreenshot('isolated-desktop-approval.png')
    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await scenario.waitForComplete()
    await scenario.assertComplete()
  })

  it('approves a real VM, captures its screen and revokes it through the registered tool', async function () {
    this.timeout(120_000)
    await importTrustedDesktopPin()
    const scenario = await prepareMockTurn('Test the approved isolated desktop.', [
      {
        toolCalls: [
          { name: 'isolated_copse', args: { action: 'start', model: 'isolated-approval:demo' } },
        ],
      },
      {
        expectToolResults: [{ name: 'isolated_copse', includes: 'Started isolated desktop' }],
        toolCalls: [{ name: 'isolated_copse', args: { action: 'screenshot' } }],
      },
      {
        expectToolResults: [{ name: 'isolated_copse', includes: 'screenshot is attached' }],
        toolCalls: [{ name: 'isolated_copse', args: { action: 'stop' } }],
      },
      {
        expectToolResults: [{ name: 'isolated_copse', includes: 'VM deleted' }],
        text: 'The approved isolated desktop was captured and deleted.',
      },
    ])
    await submitComposer()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Allow isolated Copse control?')
    await dialog.$('.approval-approve').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await scenario.waitForComplete(100_000)
    await scenario.assertComplete()
    await expectAssistantReply('The approved isolated desktop was captured and deleted.')
    const preview = $('.tool-result-preview-image')
    await preview.waitForDisplayed({ timeout: 10_000 })
    const dimensions = await preview
      .getElement()
      .then((element) =>
        browser.execute(
          (image) =>
            image instanceof HTMLImageElement
              ? { width: image.naturalWidth, height: image.naturalHeight }
              : null,
          element,
        ),
      )
    expect(dimensions).toEqual({ width: 1280, height: 800 })
    await preview.scrollIntoView({ block: 'center' })
    await saveAppScreenshot('isolated-desktop-approved.png')
  })

  it('starts and stops a real VM through the authenticated ACP bridge and consent UI', async function () {
    this.timeout(120_000)
    // Inject a scripted agent at the supported executable boundary. The MCP
    // bridge, registry, consent service and Apple VM transport remain real.
    const workspace = seedStableWorkspace()
    acpScratch = mkdtempSync(join(workspace, 'isolated-desktop-acp-'))
    const fixture = join(acpScratch, 'agent.cjs')
    buildSync({
      entryPoints: ['tests/fixtures/isolated-desktop-acp-agent.mjs'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: fixture,
    })
    seedEmptyProject(workspace, 'e2e-isolated-desktop-acp', {
      subagentsEnabled: false,
      model: 'acp:isolated-desktop-fixture',
      registeredAcpAgents: [
        { id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: false },
        {
          id: 'isolated-desktop-fixture',
          title: 'Desktop acceptance agent',
          command: process.execPath,
          args: [fixture, join(E2E_SCREENSHOT_DIR, 'isolated-desktop-acp-guest.png')],
          enabled: true,
        },
      ],
    })
    writeSettings({
      ...readSeededSettings(),
      extraProviders: [
        {
          slug: 'isolated-approval',
          label: 'Approval fixture',
          baseUrl: 'http://127.0.0.1:1/v1',
          models: [{ id: 'demo', contextWindow: 8192 }],
        },
      ],
    })
    await importTrustedDesktopPin()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await setComposerValue('Verify isolated desktop control through ACP.')
    await submitComposer()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Allow isolated Copse control?')
    await expect(dialog.$('.approval-body')).toHaveText(
      expect.stringContaining('isolated-approval:demo'),
    )
    await expect(dialog.$('.approval-remember-input')).not.toBeDisplayed()
    await saveAppScreenshot('isolated-desktop-acp-approval.png')
    await dialog.$('.approval-approve').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await browser.waitUntil(
      async () =>
        (await $('.messages-list').getText()).includes(
          'Authenticated ACP desktop captured, deleted and revoked.',
        ),
      { timeout: 90_000, timeoutMsg: 'The authenticated ACP desktop journey did not finish' },
    )
    await expectAssistantReply('Authenticated ACP desktop captured, deleted and revoked.')
    await waitForAgentIdle()
    await saveAppScreenshot('isolated-desktop-acp-complete.png')
  })

  it('keeps an approved VM between turns, and archive asks before deleting it', async function () {
    this.timeout(240_000)
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-isolated-desktop-cross-turn', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    writeSettings({
      ...readSeededSettings(),
      extraProviders: [
        {
          slug: 'isolated-approval',
          label: 'Approval fixture',
          baseUrl: 'http://127.0.0.1:1/v1',
          models: [{ id: 'demo', contextWindow: 8192 }],
        },
      ],
    })
    await importTrustedDesktopPin()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    expect(isolatedDesktopVms()).toEqual([])
    const first = 'Start the isolated desktop and leave it running.'
    const second = 'Capture the isolated desktop.'
    const scenario = await installMockScenario({
      title: 'Keep the isolated desktop',
      turns: [
        {
          user: first,
          responses: [
            {
              toolCalls: [
                {
                  name: 'isolated_copse',
                  args: { action: 'start', model: 'isolated-approval:demo' },
                },
              ],
            },
            {
              expectToolResults: [{ name: 'isolated_copse', includes: 'Started isolated desktop' }],
              text: 'The isolated desktop is running.',
            },
          ],
        },
        {
          user: second,
          responses: [
            { toolCalls: [{ name: 'isolated_copse', args: { action: 'screenshot' } }] },
            {
              expectToolResults: [{ name: 'isolated_copse', includes: 'screenshot is attached' }],
              text: 'The isolated desktop is still running.',
            },
          ],
        },
      ],
    })
    await setComposerValue(first)
    await submitComposer()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await dialog.$('.approval-approve').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await scenario.waitForTurns(1, 100_000)
    await expectAssistantReply('The isolated desktop is running.')
    await waitForAgentIdle()
    // The turn has ended; the guest must still be there.
    const vms = isolatedDesktopVms()
    expect(vms).toHaveLength(1)

    // A new turn reuses the same guest without a second consent. A fresh
    // consent dialog would hold the turn, and a deleted guest would answer
    // "This thread has no isolated desktop" instead of attaching a screenshot.
    await setComposerValue(second)
    await submitComposer()
    await scenario.waitForTurns(2, 60_000)
    await expect(dialog).not.toBeDisplayed()
    await scenario.assertComplete()
    await expectAssistantReply('The isolated desktop is still running.')
    await waitForAgentIdle()
    expect(isolatedDesktopVms()).toEqual(vms)
    const preview = $('.tool-result-preview-image')
    await preview.waitForDisplayed({ timeout: 10_000 })
    await preview.scrollIntoView({ block: 'center' })
    await saveAppScreenshot('isolated-desktop-second-turn.png')

    // Archive treats the idle thread's live guest as running work.
    const row = $('.chat-row.selected')
    const threadId = await row.getAttribute('data-thread-id')
    if (!threadId) throw new Error('The selected chat row has no thread id')
    const openArchive = async (): Promise<void> => {
      await row.moveTo()
      await row.$('.chat-menu-btn').click()
      await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
      await $('.context-menu-item=Archive').click()
    }
    await openArchive()
    const confirm = $('#confirm-dialog')
    await confirm.waitForDisplayed({ timeout: 10_000 })
    await expect(confirm.$('.confirm-dialog-message')).toHaveText(
      expect.stringContaining('Stop running work and archive'),
    )
    await saveAppScreenshot('isolated-desktop-archive-confirm.png')
    await confirm.$('.confirm-dialog-cancel').click()
    expect(isolatedDesktopVms()).toEqual(vms)
    await openArchive()
    await confirm.waitForDisplayed({ timeout: 10_000 })
    await confirm.$('.confirm-dialog-confirm').click()
    await $(`.chat-row[data-thread-id="${threadId}"]`).waitForExist({
      reverse: true,
      timeout: 30_000,
    })
    await browser.waitUntil(() => isolatedDesktopVms().length === 0, {
      timeout: 30_000,
      timeoutMsg: 'Archiving left the isolated desktop VM behind',
    })
  })
})

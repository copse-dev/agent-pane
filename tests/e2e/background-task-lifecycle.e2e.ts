import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'

const COMMAND = `node -e "setTimeout(() => console.log('background-complete'), 5000)"`

async function runBackgroundDirective(args: Record<string, unknown>): Promise<void> {
  await setComposerValue(`[[mcp:run_background ${JSON.stringify(args)}]]`)
  await $('.submit-btn').click()
  await browser.waitUntil(
    async () => {
      const stop = $('.stop-btn')
      return (await stop.isExisting()) && (await stop.getProperty('hidden')) !== true
    },
    { timeout: 15_000, interval: 100, timeoutMsg: 'agent did not start' },
  )
  await browser.waitUntil(
    async () => {
      const dialog = $('#approval-dialog')
      if ((await dialog.isExisting()) && (await dialog.getProperty('open')) === true) {
        await dialog.$('.approval-approve').click()
      }
      const stop = $('.stop-btn')
      return (await stop.getProperty('hidden')) === true
    },
    { timeout: 30_000, interval: 100, timeoutMsg: 'agent did not return to idle' },
  )
  await waitForAgentIdle(30_000)
}

async function latestToolResult(): Promise<WebdriverIO.Element> {
  const cards = await $$('.tool-card')
  const card = cards.at(-1)
  assert.ok(card, 'expected a background tool card')
  if ((await card.getAttribute('open')) === null) {
    await card.$('summary.tool-card-header').click()
  }
  return card.$('.tool-result')
}

describe('session-scoped background task lifecycle', function () {
  this.timeout(90_000)

  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-background-task-lifecycle', {
      backgroundTasksEnabled: true,
      subagentsEnabled: false,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('survives a renderer reload but does not wake the agent when it exits', async () => {
    await runBackgroundDirective({ action: 'start', command: COMMAND })
    await expect(await latestToolResult()).toHaveText(expect.stringContaining('running'))

    const assistantCount = (await $$('.msg-assistant')).length
    await browser.execute(() => window.location.reload())
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.pause(5_500)

    assert.equal(
      (await $$('.msg-assistant')).length,
      assistantCount,
      'background completion must not dispatch an agent continuation today',
    )

    await runBackgroundDirective({ action: 'list' })
    const result = await latestToolResult()
    await expect(result).toHaveText(expect.stringContaining('background-complete'))
    await expect(result).toHaveText(expect.stringContaining('exited (code 0)'))
  })
})

import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-guarded-yolo-project'

async function waitForAgentIdle(timeoutMs = 60_000): Promise<void> {
  await browser.waitUntil(async () => (await $('.submit-btn').getText()) === 'Send', {
    timeout: timeoutMs,
    interval: 250,
    timeoutMsg: 'Agent did not return to idle (submit button Send)',
  })
}

async function enableGuardedYolo(captureWarning = false): Promise<void> {
  await $('.footer-overflow-trigger').click()
  const items = await $$('.footer-overflow-item')
  const enableItem = await items.find(async (item) =>
    (await item.getText()).includes('Enable Guarded YOLO'),
  )
  if (!enableItem) throw new Error('Guarded YOLO footer action was not available')
  await enableItem.click()

  const dialog = await $('#approval-dialog')
  await dialog.waitForDisplayed({ timeout: 10_000 })
  await expect(dialog.$('.approval-heading')).toHaveText('Enable Guarded YOLO for this thread?')
  const body = await dialog.$('.approval-body').getText()
  expect(body).toContain('will run without approval in this thread')
  expect(body).toContain('deterministic host-owned checker')
  expect(body).toContain('stays enabled for this thread until you disable it or restart the app')
  if (captureWarning) {
    await saveElementScreenshot('#approval-dialog', 'guarded-yolo-opt-in.png')
  }
  await dialog.$('.approval-approve').click()

  const banner = await $('.guarded-yolo-banner')
  await banner.waitForDisplayed({ timeout: 10_000 })
  await expect(banner).toHaveAttribute('data-phase', 'armed')
}

describe('Guarded YOLO shell mode', function () {
  this.timeout(120_000)
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('requires explicit opt-in and stays active for the thread across turns', async () => {
    await enableGuardedYolo(true)

    await setComposerValue('[[mock:delay_ms 3000]] [[mcp:run_shell {"command":"cat /etc/hosts"}]]')
    await $('.submit-btn').click()

    const banner = await $('.guarded-yolo-banner')
    await expect(banner).toHaveAttribute('data-phase', 'active', { wait: 10_000 })
    const bannerText = await banner.getText()
    expect(bannerText).toContain('active for this thread')
    expect(bannerText).toMatch(/Project sandbox|No OS sandbox/)
    await saveElementScreenshot('.guarded-yolo-banner', 'guarded-yolo-active.png')

    await waitForAgentIdle()
    await expect(banner).toBeDisplayed()
    await expect(banner).toHaveAttribute('data-phase', 'active')
    await expect($('#approval-dialog')).not.toBeDisplayed()

    await setComposerValue('[[mock:delay_ms 1000]] [[mcp:run_shell {"command":"pwd"}]]')
    await $('.submit-btn').click()
    await expect(banner).toHaveAttribute('data-phase', 'active', { wait: 10_000 })
    await waitForAgentIdle()
    await expect(banner).toHaveAttribute('data-phase', 'active')
    await expect($('#approval-dialog')).not.toBeDisplayed()
  })

  it('keeps a non-bypassable confirmation for bounded destructive work', async () => {
    const banner = await $('.guarded-yolo-banner')
    await expect(banner).toHaveAttribute('data-phase', 'active')
    await setComposerValue(
      '[[mcp:run_shell {"command":"rm -rf tests/e2e/.bounded-delete-missing"}]]',
    )
    await $('.submit-btn').click()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Guarded YOLO safety check')
    expect(await dialog.$('.approval-advice').getText()).toContain('recursive/forced delete')
    expect(await dialog.$('.approval-body').getText()).toContain(
      'rm -rf tests/e2e/.bounded-delete-missing',
    )
    expect(await dialog.$('.approval-body').getText()).not.toContain('Potential harm')
    expect(await dialog.$('.approval-advice').getText()).toContain(
      'Guarded YOLO cannot skip this confirmation',
    )
    await saveElementScreenshot('#approval-dialog', 'guarded-yolo-harm-prompt.png')
    await dialog.$('.approval-reject').click()
    await waitForAgentIdle()
    await expect($('.guarded-yolo-banner')).toHaveAttribute('data-phase', 'active')
  })

  it('hard-denies catastrophic deletion without offering approval', async () => {
    await expect($('.guarded-yolo-banner')).toHaveAttribute('data-phase', 'active')
    await setComposerValue('[[mcp:run_shell {"command":"rm -rf /"}]]')
    await $('.submit-btn').click()
    await waitForAgentIdle()

    await expect($('#approval-dialog')).not.toBeDisplayed()
    const failedTool = await $('.tool-card[data-status="error"]')
    await failedTool.waitForDisplayed({ timeout: 30_000 })
    // Tool cards are collapsed <details> whose body is built lazily
    // (`lazyToolCardBodies` in conversation.ts). Until the card opens, the
    // denial reason is not in the DOM at all and `getText()` returns only the
    // summary — i.e. the `rm -rf /` label, never the harm-gate reason. Open it
    // first, then wait for the deferred body to build.
    await failedTool.$('summary.tool-card-header').click()
    await browser.waitUntil(
      async () => (await failedTool.getText()).includes('Guarded YOLO harm gate'),
      {
        timeout: 10_000,
        interval: 250,
        timeoutMsg: 'Opened error tool card never rendered the Guarded YOLO harm gate reason',
      },
    )
    expect(await failedTool.getText()).toContain('Guarded YOLO harm gate')
    await saveElementScreenshot('.tool-card[data-status="error"]', 'guarded-yolo-hard-deny.png')
  })
})

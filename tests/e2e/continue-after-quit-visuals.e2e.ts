import { submitComposer } from './helpers/composer.ts'
import { prepareMockTurn } from './helpers/mock-scenario.ts'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

/**
 * What a user sees of work that carries on after Copse closes: the Settings
 * switch, the close question when only a container run is going, and a run the
 * user stopped reading as stopped rather than failed.
 *
 * A real container run needs Docker, so the run states come from snapshots
 * pushed down the same channel main uses (`test:emitContainerRun`), and the
 * close question is told which thread has a run going. What main decides is
 * unit-tested in `container-run-service.test.ts` and `close-confirm.test.ts`.
 */

const PROJECT_ID = 'e2e-continue-after-quit-visuals'
const SETTING_FIELDSET = '[data-testid="continue-after-quit-settings"]'

let threadId = ''

/** A thread to hang the run on: start a held turn, note its id, stop it. */
async function createThread(): Promise<string> {
  await prepareMockTurn(
    'Clear the lint backlog.',
    [{ waitFor: 'visuals-hold', text: 'Done.' }],
    true,
  )
  await submitComposer()
  let id = ''
  await browser.waitUntil(
    async () => {
      const ids = await browser.execute(async () => await window.api.agent.runningThreadIds())
      id = ids[0] ?? ''
      return id !== ''
    },
    { timeout: 30_000, timeoutMsg: 'expected the turn to start' },
  )
  await browser.execute(async (target) => {
    await window.api.agent.abort(target)
  }, id)
  await $('.stop-btn').waitForDisplayed({ reverse: true, timeout: 15_000 })
  return id
}

function runSnapshot(
  phase: 'running' | 'failed',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Date.now()
  return {
    threadId,
    runtimeId: 'e2e-visuals-runtime',
    phase,
    startedAt: now - 60_000,
    finishedAt: phase === 'failed' ? now : null,
    prompt: 'Clear the lint backlog.',
    model: 'claude-sonnet-4-6',
    egressAllowlist: ['https://api.anthropic.com'],
    credential: 'key',
    log: [],
    warnings: [],
    checkout: null,
    record: null,
    error: null,
    continuedFrom: null,
    ...extra,
  }
}

async function emitRun(progress: Record<string, unknown>): Promise<void> {
  await browser.execute(async (snapshot) => {
    const bridge = window.__copseE2e
    if (!bridge) throw new Error('__copseE2e.emitContainerRun unavailable')
    await bridge.emitContainerRun(snapshot)
  }, progress)
}

describe('work that carries on after Copse closes', function () {
  this.timeout(180_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    resetUserData()
    // The setting is left unseeded so the screenshots show the default (on).
    seedEmptyProject(seedStableWorkspace(), PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      windowBounds: { width: 1280, height: 800 },
      containerRunsEnabled: true,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    threadId = await createThread()
  })

  after(() => {
    resetUserData()
  })

  it('shows the When Copse closes switch, on by default', async () => {
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed()
    await $('#settings-dialog button[data-section="agent"]').click()
    const fieldset = $(SETTING_FIELDSET)
    await fieldset.scrollIntoView({ block: 'center' })
    await expect(fieldset.$('legend')).toHaveText('When Copse closes')
    await expect(fieldset.$('input[name="continueTurnsAfterQuit"]')).toBeSelected()
    expect((await fieldset.getText()).replace(/\s+/g, ' ')).toContain(
      'Keep running turns and container runs going after Copse closes',
    )
    await saveElementScreenshot(SETTING_FIELDSET, 'settings-continue-after-quit.png')
    await browser.keys('Escape')
    await $('#settings-dialog').waitForDisplayed({ reverse: true, timeout: 15_000 })
  })

  it('says a container run keeps going when Copse closes', async () => {
    await browser.execute(async (target) => {
      const bridge = window.__copseE2e
      if (!bridge) throw new Error('__copseE2e.setCloseConfirmContainerRuns unavailable')
      await bridge.setCloseConfirmContainerRuns([target])
      window.__closeConfirmAnswers = []
      const answers = window.__closeConfirmAnswers
      void bridge.requestCloseConfirm().then((confirmed) => answers.push(confirmed))
    }, threadId)

    const dialog = await $('#confirm-dialog').getElement()
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.confirm-dialog-message')).toHaveText(
      'Close Copse while a container run is going?',
    )
    const detail = await dialog.$('.confirm-dialog-detail').getText()
    expect(detail).toContain('has a container run going.')
    expect(detail).toContain('It keeps going outside Copse, and you can stop it from Copse')
    await expect(dialog.$('.confirm-dialog-confirm')).toHaveText('Close')
    await expect(dialog.$('.confirm-dialog-cancel')).toHaveText('Keep Copse open')
    await saveElementScreenshot('#confirm-dialog', 'close-confirm-container-run.png')

    await dialog.$('.confirm-dialog-cancel').click()
    await browser.waitUntil(
      async () => (await browser.execute(() => window.__closeConfirmAnswers ?? [])).length === 1,
      { timeout: 15_000, timeoutMsg: 'expected the close answer to reach main' },
    )
    expect(await browser.execute(() => window.__closeConfirmAnswers ?? [])).toEqual([false])
    await browser.execute(async () => {
      await window.__copseE2e?.setCloseConfirmContainerRuns([])
    })
  })

  it('shows a run the user stopped as Stopped, not Failed', async () => {
    await emitRun(runSnapshot('running'))
    const banner = $('.container-run-banner')
    await banner.waitForDisplayed({ timeout: 15_000 })
    await expect(banner).toHaveAttribute('data-phase', 'running')

    await emitRun(runSnapshot('failed', { stoppedByUser: true, error: 'Stopped by the user.' }))
    await browser.waitUntil(async () => (await banner.getAttribute('data-phase')) === 'failed', {
      timeout: 15_000,
      timeoutMsg: 'expected the banner to show the run ended',
    })
    expect(await banner.getText()).toContain('Container run: stopped. Stopped by you.')
    // Not the failure hue: a run the user stopped did nothing wrong.
    expect(await banner.getAttribute('data-stopped')).not.toBe(null)
    const toast = $('.toast-info*=Container run stopped.')
    await toast.waitForDisplayed({ timeout: 15_000 })
    await saveElementScreenshot('.container-run-banner', 'container-run-stopped-banner.png')
    await saveElementScreenshot('.toast-host', 'container-run-stopped-toast.png')
  })
})

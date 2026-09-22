import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'

const PROJECT_ID = 'e2e-guarded-yolo-project'
let workspaceRoot = ''

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
  expect(body).toContain('GitHub CLI writes')
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

// These confirmations and hard denials must execute in CI. #1680 retains the
// historical session-death investigation; a skip is not compensating coverage.
describe('Guarded YOLO shell mode', function () {
  this.timeout(120_000)
  before(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-guarded-yolo-'))
    resetUserData()
    seedEmptyProject(workspaceRoot, PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  afterEach(async () => {
    const dialog = await $('#approval-dialog')
    if (await dialog.isDisplayed()) {
      await dialog.$('.approval-reject').click()
      await waitForAgentIdle()
    }
  })

  after(() => {
    resetUserData()
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
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
    expect(bannerText).toMatch(/GitHub writes still ask/)
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
    expect(await dialog.$('.approval-advice').getText()).toContain(
      'Deletes files and folders recursively (rm -rf)',
    )
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

  it('runs uncertain script code only after one-time consent', async () => {
    const marker = join(workspaceRoot, 'consent-marker.txt')
    writeFileSync(
      join(workspaceRoot, 'shutdown-report.mts'),
      [
        "import { appendFileSync } from 'node:fs'",
        'console.log("shutdown report")',
        'appendFileSync("consent-marker.txt", "ran\\n")',
      ].join('\n'),
    )
    const command = 'node shutdown-report.mts'
    const submitCommand = async (): Promise<void> => {
      await setComposerValue(`[[mcp:run_shell ${JSON.stringify({ command })}]]`)
      await $('.submit-btn').click()
      await $('#approval-dialog').waitForDisplayed({ timeout: 30_000 })
    }

    await submitCommand()
    const dialog = await $('#approval-dialog')
    await expect(dialog.$('.approval-heading')).toHaveText('Guarded YOLO safety check')
    expect(await dialog.$('.approval-body').getText()).toContain(command)
    expect(await dialog.$('.approval-advice').getText()).toContain('could not be confirmed')
    expect(await dialog.getText()).toMatch(/Runs (inside|outside) the project sandbox/)
    for (const checkbox of await dialog.$$('input[type="checkbox"]')) {
      await expect(checkbox).not.toBeDisplayed()
    }
    expect(existsSync(marker)).toBe(false)
    await saveElementScreenshot('#approval-dialog', 'guarded-yolo-uncertain-power-prompt.png')
    await dialog.$('.approval-reject').click()
    await waitForAgentIdle()
    expect(existsSync(marker)).toBe(false)

    await submitCommand()
    await $('#approval-dialog .approval-approve').click()
    await waitForAgentIdle()
    expect(readFileSync(marker, 'utf8')).toBe('ran\n')

    // Consent belongs to the invocation; a retry must ask again.
    await submitCommand()
    expect(readFileSync(marker, 'utf8')).toBe('ran\n')
    await $('#approval-dialog .approval-reject').click()
    await waitForAgentIdle()
    expect(readFileSync(marker, 'utf8')).toBe('ran\n')
  })

  it('hard-denies catastrophic deletion without offering approval', async () => {
    await expect($('.guarded-yolo-banner')).toHaveAttribute('data-phase', 'active')
    await setComposerValue('[[mcp:run_shell {"command":"rm -rf /"}]]')
    await $('.submit-btn').click()
    // Idle can still describe the previous turn until the new tool is rendered.
    await browser.waitUntil(
      async () => {
        const latest = (await $$('.tool-card-rollup')).at(-1)
        return latest !== undefined && (await latest.getText()).includes('rm -rf /')
      },
      { timeout: 30_000, timeoutMsg: 'The catastrophic command was never rendered' },
    )
    await waitForAgentIdle()

    await expect($('#approval-dialog')).not.toBeDisplayed()
    const rollups = await $$('.tool-card-rollup[data-status="error"]')
    const rollup = rollups.at(-1)
    if (rollup && !(await rollup.getProperty('open'))) {
      await rollup.$('summary.tool-card-header').click()
    }
    const failures = await $$('.tool-card[data-tool-id][data-status="error"]')
    const failedTool = failures.at(-1)
    if (!failedTool) throw new Error('Expected the catastrophic command to be denied')
    await failedTool.waitForDisplayed({ timeout: 30_000 })
    if (!(await failedTool.getProperty('open'))) {
      await failedTool.$('summary.tool-card-header').click()
    }
    await browser.waitUntil(
      async () => (await failedTool.getText()).includes('Guarded YOLO harm gate'),
      {
        timeout: 10_000,
        interval: 250,
        timeoutMsg: 'Opened error tool card never rendered the Guarded YOLO harm gate reason',
      },
    )
    expect(await failedTool.getText()).toContain('Guarded YOLO harm gate')
    await saveElementScreenshot(
      `.tool-card[data-tool-id="${await failedTool.getAttribute('data-tool-id')}"]`,
      'guarded-yolo-hard-deny.png',
    )
  })
})

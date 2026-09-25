import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedE2eViewport } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { approveUnsandboxedTerminalIfPrompted } from './helpers/terminal-approval.ts'

describe('Process manager', function () {
  this.timeout(90_000)

  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-process-manager')
    seedE2eViewport()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows live tasks, jumps to their thread, and stops an owned terminal', async () => {
    const originalThreadId = await $('.chat-row.selected').getAttribute('data-thread-id')
    assert.ok(originalThreadId)
    await $('.prompt-input').click()
    await browser.keys('Keep this thread for the process manager check')

    await $('.titlebar-btn[aria-label="Open terminal"]').click()
    await approveUnsandboxedTerminalIfPrompted()
    const terminalInput = $('.xterm-helper-textarea')
    await terminalInput.waitForExist({ timeout: 15_000 })
    await terminalInput.click()
    if (process.platform !== 'win32') await browser.keys(['sleep 90', '\uE007'])
    await $('.prompt-input').click()

    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'Shift', 'p'])
    const dialog = $('#process-manager-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await browser.waitUntil(async () => (await $$('.process-manager-rows tr')).length > 0, {
      timeout: 10_000,
    })
    await expect(dialog.$('h2')).toHaveText('Process Manager')
    await expect(dialog.$('.process-manager-rows')).toHaveText(
      expect.stringContaining('Copse main'),
    )
    const ownedSelector = `.process-manager-rows tr[data-thread-id="${originalThreadId}"][data-kind="Terminal"]`
    const ownedRow = dialog.$(ownedSelector)
    await ownedRow.waitForDisplayed({ timeout: 10_000 })
    await expect(ownedRow.$('.process-manager-type')).toHaveText('Terminal')
    await expect(ownedRow.$('.process-manager-thread')).toHaveText('New Thread')
    await expect(ownedRow.$('.process-manager-actions-button')).toBeDisplayed()
    assert.equal(
      await dialog
        .$('.process-manager-rows tr[data-thread-id=""] .process-manager-actions-button')
        .isExisting(),
      false,
    )
    if (process.platform !== 'win32') {
      await browser.waitUntil(
        async () =>
          await browser.execute(
            (threadId) =>
              [
                ...document.querySelectorAll(
                  `.process-manager-rows tr[data-thread-id="${threadId}"][data-kind="Command"] .process-manager-name`,
                ),
              ].some((name) => name.textContent === 'sleep'),
            originalThreadId,
          ),
        { timeout: 10_000 },
      )
    }

    const tableGeometry = await browser.execute(() => {
      const table = document.querySelector<HTMLTableElement>('.process-manager-table')
      if (!table) throw new Error('Process table is missing')
      return {
        layout: getComputedStyle(table).tableLayout,
        widths: [...table.querySelectorAll('thead th')].map(
          (heading) => heading.getBoundingClientRect().width,
        ),
      }
    })
    assert.equal(tableGeometry.layout, 'fixed')
    const firstSample = Number(await dialog.getAttribute('data-sampled-at'))
    assert.ok(firstSample > 0)
    await browser.waitUntil(
      async () => Number(await dialog.getAttribute('data-sampled-at')) > firstSample,
      {
        timeout: 8_000,
      },
    )
    assert.deepEqual(
      await browser.execute(() =>
        [...document.querySelectorAll('.process-manager-table thead th')].map(
          (heading) => heading.getBoundingClientRect().width,
        ),
      ),
      tableGeometry.widths,
      'metric refresh must not shift the table columns',
    )

    const memorySort = dialog.$('.process-manager-sort=Memory')
    await memorySort.click()
    await expect(dialog.$('th[aria-sort="descending"]')).toHaveText('Memory')
    assert.equal(
      await browser.execute(() => {
        const button = document.querySelector(
          '.process-manager-table th[aria-sort="descending"] button',
        )
        if (!button) throw new Error('Descending sort button is missing')
        return getComputedStyle(button, '::after').borderTopWidth
      }),
      '6px',
    )
    await memorySort.click()
    await expect(dialog.$('th[aria-sort="ascending"]')).toHaveText('Memory')
    assert.equal(
      await browser.execute(() => {
        const button = document.querySelector(
          '.process-manager-table th[aria-sort="ascending"] button',
        )
        if (!button) throw new Error('Ascending sort button is missing')
        return getComputedStyle(button, '::after').borderBottomWidth
      }),
      '6px',
    )
    await memorySort.click()
    const values = await browser.execute(() =>
      [...document.querySelectorAll('#process-manager-dialog tbody tr td:nth-child(5)')]
        .map((cell) => Number.parseFloat(cell.textContent ?? ''))
        .filter(Number.isFinite),
    )
    assert.deepEqual(
      values,
      [...values].sort((a, b) => b - a),
    )
    await saveAppScreenshot('process-manager.png')

    await dialog.$('[aria-label="Close process manager"]').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 5_000 })
    const lastSample = await dialog.getAttribute('data-sampled-at')
    await browser.pause(1_200)
    assert.equal(await dialog.getAttribute('data-sampled-at'), lastSample)

    await $('.project-new-thread-btn').click()
    await browser.waitUntil(
      async () =>
        (await $('.chat-row.selected').getAttribute('data-thread-id')) !== originalThreadId,
      { timeout: 10_000 },
    )
    await $('.prompt-input').click()
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'Shift', 'p'])
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await dialog.$(ownedSelector).waitForDisplayed({ timeout: 10_000 })
    await dialog.$(`${ownedSelector} .process-manager-actions-button`).click()
    await $('.context-menu-item=Jump to thread').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 5_000 })
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', originalThreadId)

    await $('.prompt-input').click()
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'Shift', 'p'])
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await dialog.$(ownedSelector).waitForDisplayed({ timeout: 10_000 })
    await dialog.$(ownedSelector).click({ button: 'right' })
    await expect($('.context-menu-item=Stop terminal')).toBeDisplayed()
    await saveAppScreenshot('process-manager-actions.png')
    await $('.context-menu-item=Stop terminal').click()
    await expect($('#confirm-dialog')).toBeDisplayed()
    await $('#confirm-dialog .confirm-dialog-confirm').click()
    await browser.waitUntil(async () => !(await dialog.$(ownedSelector).isExisting()), {
      timeout: 10_000,
    })
    await expect($('.xterm-rows')).toHaveText(expect.stringContaining('Terminal stopped'))
  })
})

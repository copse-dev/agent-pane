import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

describe('Process Manager network activity', () => {
  it('shows live commands and connections, filters them, and updates completed activity', async () => {
    await browser.url('/')
    await $('.prompt-input').waitForExist()
    await browser.execute(() => {
      const now = 1_800_000_000_000
      window.api.processManager.snapshot = async () => ({
        sampledAt: now,
        processes: [],
        network: {
          dropped: 0,
          rows: [
            {
              id: 4,
              source: 'command',
              label: 'gh pr checks',
              target: null,
              threadId: null,
              projectId: null,
              startedAt: now - 2300,
              endedAt: null,
              status: 'running',
              exitCode: null,
              bytesSent: null,
              bytesReceived: null,
            },
            {
              id: 3,
              source: 'container',
              label: 'Container connection',
              target: 'api.github.com:443',
              threadId: null,
              projectId: null,
              startedAt: now - 5100,
              endedAt: null,
              status: 'active',
              exitCode: null,
              bytesSent: 1400,
              bytesReceived: 24800,
            },
            {
              id: 2,
              source: 'sandbox',
              label: 'Sandbox connection',
              target: 'registry.npmjs.org:443',
              threadId: null,
              projectId: null,
              startedAt: now - 10000,
              endedAt: now - 10000,
              status: 'blocked',
              exitCode: null,
              bytesSent: null,
              bytesReceived: null,
            },
            {
              id: 1,
              source: 'command',
              label: 'git fetch',
              target: null,
              threadId: null,
              projectId: null,
              startedAt: now - 18000,
              endedAt: now - 15300,
              status: 'completed',
              exitCode: 0,
              bytesSent: null,
              bytesReceived: null,
            },
          ],
        },
      })
    })
    await browser.keys(['Control', 'Shift', 'p'])
    const dialog = $('#process-manager-dialog')
    await dialog.waitForDisplayed()
    await dialog.$('button=Network').click()
    const tabStyle = await browser.execute(() => {
      const tab = document.querySelector('.process-manager-tab[aria-pressed="true"]')
      if (!tab) throw new Error('Expected an active section tab')
      const style = getComputedStyle(tab)
      return {
        radius: style.borderRadius,
        underline: style.borderBottomWidth,
        shadow: style.boxShadow,
      }
    })
    expect(tabStyle).toEqual({ radius: '0px', underline: '2px', shadow: 'none' })
    await expect($$('.network-activity-table tbody tr')).toBeElementsArrayOfSize(4)
    await expect($('.network-activity-summary')).toHaveText(
      '2 active · 4 shown · Recent session activity',
    )
    await expect($('.network-activity-table')).toHaveText(expect.stringContaining('24.2 KiB'))
    const fits = await browser.execute(() => {
      const dialog = document.querySelector('#process-manager-dialog')
      const table = document.querySelector('.network-activity-table')
      if (!dialog || !table) return false
      return table.getBoundingClientRect().right <= dialog.getBoundingClientRect().right
    })
    expect(fits).toBe(true)
    await saveAppScreenshot('process-manager-network.png')
    await $('.network-activity-toolbar input[type="checkbox"]').click()
    await expect($$('.network-activity-table tbody tr')).toBeElementsArrayOfSize(2)
    await $('.network-activity-search').setValue('github')
    await expect($$('.network-activity-table tbody tr')).toBeElementsArrayOfSize(1)
    await browser.execute(() => {
      const snapshot = window.api.processManager.snapshot
      window.api.processManager.snapshot = async () => {
        const current = await snapshot()
        return {
          ...current,
          network: current.network
            ? {
                ...current.network,
                rows: current.network.rows.map((row) =>
                  row.id === 3 ? { ...row, endedAt: current.sampledAt, status: 'closed' } : row,
                ),
              }
            : undefined,
        }
      }
    })
    await expect($('.network-activity-empty')).toHaveText('No activity matches these filters.')
    await $('.network-activity-toolbar input[type="checkbox"]').click()
    await expect($('.network-activity-table')).toHaveText(expect.stringContaining('Closed'))
    await dialog.$('button=Processes').click()
    await expect($('.network-activity-panel')).not.toBeDisplayed()
    await dialog.$('[aria-label="Close process manager"]').click()
  })
})

import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// Mock only the IPC boundary; exercise Settings' real verification and recovery UI.
describe('Agent connection verification', () => {
  it('does not show Ready for credentials alone, and allows retry after rejection', async () => {
    await browser.url('/?scenario=site-providers')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.execute(() => {
      const get = window.api.settings.get
      window.api.settings.get = async (key): ReturnType<typeof get> =>
        key === 'registeredAcpAgents'
          ? [{ id: 'claude-acp', title: 'Claude', command: 'claude-agent-acp', enabled: true }]
          : get(key)
      window.api.acp.detectAgents = async (): ReturnType<typeof window.api.acp.detectAgents> => [
        {
          id: 'claude-acp',
          title: 'Claude',
          command: 'claude-agent-acp',
          args: [],
          installed: true,
          path: '/usr/local/bin/claude-agent-acp',
          running: false,
        },
      ]
      window.api.acp.authStatus = async (): ReturnType<typeof window.api.acp.authStatus> => [
        { id: 'claude-acp', state: 'signed-in' },
      ]
      window.api.acp.probeAgent = async (): ReturnType<typeof window.api.acp.probeAgent> => {
        throw new Error('Internal error')
      }
    })
    await $('[aria-label="Settings"]').click()
    const row = $('[data-row="agent:claude-acp"]')
    await row.waitForDisplayed({ timeout: 15_000 })
    await row.scrollIntoView({ block: 'center' })
    await expect(row.$('.acp-row-chip')).toHaveText('Not verified')
    await expect(row.$('button=Sign in')).toBeDisplayed()
    await row.$('button=Verify connection').click()
    await expect(row.$('[role="status"]')).toHaveText('Connection could not be verified.', {
      containing: true,
    })
    await expect(row.$('.acp-row-chip')).toHaveText('Not verified')
    const overflow = await browser.execute(() => {
      const row = document.querySelector('[data-row="agent:claude-acp"]')
      return row ? row.scrollWidth - row.clientWidth : -1
    })
    assert.equal(overflow, 0, 'verification controls must fit in the row')
    await saveElementScreenshot(
      '[data-row="agent:claude-acp"]',
      'demo-agent-verification-failed.png',
    )
    await browser.execute(() => {
      window.api.acp.probeAgent = async (): ReturnType<typeof window.api.acp.probeAgent> => ({
        models: null,
        modes: null,
      })
    })
    await row.$('button=Verify connection').click()
    await expect(row.$('.acp-row-chip')).toHaveText('Ready')
    await expect(row.$('[role="status"]')).not.toExist()
    await expect(row.$('button=Sign in')).not.toExist()
    await saveElementScreenshot(
      '[data-row="agent:claude-acp"]',
      'demo-agent-verification-ready.png',
    )
  })
})

import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted MCP server sign-in', () => {
  before(async () => {
    await browser.url('/?scenario=mcp-sign-in')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="mcp"]').click()
    await $('#mcp-server-list .mcp-server-row').waitForDisplayed()
  })

  // Rows are re-rendered on every state change, so look the row up each time.
  async function row(name: string): Promise<WebdriverIO.Element> {
    const rows = await $$('#mcp-server-list .mcp-server-row')
    for (const candidate of rows) {
      const summary = await candidate.$('.mcp-server-summary').getText()
      if (summary.startsWith(`${name} (`)) return candidate
    }
    throw new Error(`no MCP row for ${name}`)
  }

  it('offers Sign in for a server that needs OAuth and Sign out for one signed in', async () => {
    const needs = await row('design-system')
    await expect(needs.$('.mcp-server-summary')).toHaveText(
      expect.stringContaining('sign-in required'),
    )
    await expect(needs.$('.mcp-auth-btn')).toHaveText('Sign in')
    await expect(needs.$('.mcp-server-detail')).toHaveText("Sign in to use this server's tools.")

    const signedIn = await row('issues')
    await expect(signedIn.$('.mcp-server-summary')).toHaveText(expect.stringContaining('connected'))
    await expect(signedIn.$('.mcp-auth-btn')).toHaveText('Sign out')

    // The sign-in button sits in the header row with the other controls.
    const [button, header] = await Promise.all([
      needs.$('.mcp-auth-btn').getLocation('y'),
      needs.$('.mcp-server-summary').getLocation('y'),
    ])
    assert.ok(Math.abs(button - header) < 12, 'sign-in button aligns with the server header')

    await saveElementScreenshot('#mcp-server-list', 'mcp-sign-in-states.png')
  })

  it('waits for the browser and can be cancelled', async () => {
    await (await row('design-system')).$('.mcp-auth-btn').click()
    await browser.waitUntil(
      async () =>
        (await (await row('design-system')).$('.mcp-auth-btn').getText()) === 'Cancel sign-in',
    )
    const waiting = await row('design-system')
    await expect(waiting.$('.mcp-server-detail')).toHaveText(
      'Continue in your browser to finish signing in.',
    )
    await saveElementScreenshot('#mcp-server-list', 'mcp-sign-in-waiting.png')

    await waiting.$('.mcp-auth-btn').click()
    await browser.waitUntil(
      async () => (await (await row('design-system')).$('.mcp-auth-btn').getText()) === 'Sign in',
    )
    await expect((await row('design-system')).$('.mcp-server-detail')).toHaveText(
      "Sign in to use this server's tools.",
    )
  })
})

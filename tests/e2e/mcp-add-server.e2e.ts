import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  resetUserMcpConfig,
  seedEmptyProject,
  seedUserMcpConfig,
} from './helpers/seed-config.ts'

// Settings → MCP servers → Add server writes Copse's own userData mcp.json,
// the same user source the registry reads, and the new server connects.
const STDIO_SERVER = join(process.cwd(), 'tests/e2e/fixtures/mock-mcp-server.mts')

function userMcpConfigPath(): string {
  const root = process.env['COPSE_PANEL_USER_DATA']
  if (!root) throw new Error('MCP fixtures require an isolated WDIO user-data directory')
  return join(root, 'mcp.json')
}

function savedServers(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(userMcpConfigPath(), 'utf8'))
  assert.ok(parsed !== null && typeof parsed === 'object' && 'mcpServers' in parsed)
  const servers = parsed.mcpServers
  assert.ok(servers !== null && typeof servers === 'object')
  return { ...servers }
}

async function setValue(selector: string, value: string): Promise<void> {
  const field = $(selector)
  await field.waitForDisplayed({ timeout: 10_000 })
  await field.setValue(value)
}

describe('MCP add server', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-mcp-add-server', { subagentsEnabled: false })
    // An existing (empty) user config is what lets e2e load configured servers
    // at all; it keeps them to this isolated file.
    seedUserMcpConfig({})
    await browser.reloadSession()
  })

  after(() => {
    resetUserMcpConfig()
    resetUserData()
  })

  it('adds a stdio server that connects and lists its tools, then removes it', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    const settings = $('#settings-dialog')
    await settings.waitForDisplayed({ timeout: 15_000 })
    await settings.$('.settings-nav-btn[data-section="mcp"]').click()
    await expect($('#mcp-server-list')).toHaveText(expect.stringContaining('No servers configured'))

    await $('#mcp-add-btn').click()
    await expect($('#mcp-server-editor')).toBeDisplayed()
    await expect($('.mcp-editor-heading')).toHaveText('Add an MCP server')
    await setValue('#mcp-editor-name', 'docs-fixture')
    await setValue('#mcp-editor-command', 'node')
    await setValue('#mcp-editor-args', `--experimental-strip-types\n${STDIO_SERVER}`)
    await $('button=Add variable').click()
    await setValue('.mcp-editor-secret-key', 'DOCS_TOKEN')
    await setValue('.mcp-editor-secret-value', 'e2e-secret')
    // The form runs past one frame: capture its top, then its secrets and its
    // own Save server / Cancel row, which sit above Settings' sticky bar.
    await saveAppScreenshot('mcp-add-server-form.png', undefined, async () => {
      await $('.mcp-editor-heading').scrollIntoView({ block: 'start' })
    })
    await saveAppScreenshot('mcp-add-server-form-secrets.png', undefined, async () => {
      await $('#mcp-editor-save').scrollIntoView({ block: 'center' })
    })

    await $('#mcp-editor-save').click()
    await expect($('#mcp-server-editor')).not.toBeDisplayed()
    const row = $('.mcp-server-row[data-mcp-server="docs-fixture"].mcp-state-connected')
    await row.waitForDisplayed({ timeout: 30_000 })
    await expect(row.$('.mcp-server-summary')).toHaveText(
      expect.stringContaining('docs-fixture (stdio)'),
    )
    await expect(row.$('.mcp-origin-chip')).toHaveText(expect.stringMatching(/your config/i))
    await expect(row.$('.mcp-server-detail')).toHaveText(expect.stringContaining('echo'))
    await expect(row.$('.mcp-edit-btn')).toBeDisplayed()
    await expect(row.$('.mcp-remove-btn')).toBeDisplayed()
    assert.deepEqual(savedServers(), {
      'docs-fixture': {
        command: 'node',
        args: ['--experimental-strip-types', STDIO_SERVER],
        env: { DOCS_TOKEN: 'e2e-secret' },
      },
    })
    // The renderer is told the key, never the stored value.
    const listed = await browser.execute(() => window.api.mcp.listUserServers())
    assert.doesNotMatch(JSON.stringify(listed), /e2e-secret/)
    await row.scrollIntoView({ block: 'center' })
    await saveAppScreenshot('mcp-add-server-connected.png')

    await row.$('.mcp-remove-btn').click()
    await $('#confirm-dialog').waitForDisplayed({ timeout: 10_000 })
    await $('#confirm-dialog .confirm-dialog-confirm').click()
    await expect($('.mcp-server-row[data-mcp-server="docs-fixture"]')).not.toBeExisting()
    assert.deepEqual(savedServers(), {})
    await settings.$('#settings-close').click()
  })
})

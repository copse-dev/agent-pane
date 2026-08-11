import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  AGENT_PLUGIN_SCHEMA,
  resetAgentPlugins,
  resetUserData,
  seedAgentPlugin,
  seedEmptyProject,
} from './helpers/seed-config.ts'

// Settings information architecture: Customise, MCP servers, Storage.
//
// Three separate lists — Sources, Plugins, and Cursor plugins — each answered a
// slice of "what is extending Copse", so answering the whole question meant
// visiting three places and knowing which held which. They are one section now
// ("Customise"), Cursor-installed plugins merged into the single plugin list.
// Worktrees left with them: managing disk is not customisation, so it has its
// own item ("Storage").
//
// MCP stayed separate on purpose, and gained the two things that make it a
// *lens* rather than a status list: every row says who asked for the server,
// and servers a plugin declares but nothing runs are disclosed rather than
// omitted. That second part is what only a real launch can prove — the row
// exists because a package on disk went through discovery.
//
// Screenshots of all three land in tests/e2e/screenshots for visual review.

function settingsSection(section: string) {
  return $(`.settings-section[data-section="${section}"]`)
}

const PLUGIN_ID = 'acme.mcp-declarer'

describe('settings → Customise / MCP / Storage', function () {
  this.timeout(60_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    resetAgentPlugins()

    // A plugin that declares an MCP server. Discovery seeds it **off**, so the
    // server it names is doubly not running — which is exactly the state the
    // MCP section has to disclose rather than silently omit.
    seedAgentPlugin(
      PLUGIN_ID,
      {
        $schema: AGENT_PLUGIN_SCHEMA,
        name: PLUGIN_ID,
        version: '0.3.0',
        description: 'Declares an MCP server Copse does not start.',
      },
      {
        mcp: {
          $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
          mcpServers: { declared_reviewer: { type: 'stdio', command: './bin/reviewer' } },
        },
      },
    )

    seedEmptyProject(process.cwd(), 'e2e-customise-storage')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    resetAgentPlugins()
  })

  it('offers Customise and Storage instead of Sources and Plugins', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()

    await expect(dialog.$('button[data-section="customise"]')).toBeDisplayed()
    await expect(dialog.$('button[data-section="storage"]')).toBeDisplayed()
    // The old items are gone rather than aliased — two routes to one list is
    // the ambiguity this restructure exists to remove.
    assert.equal(await dialog.$('button[data-section="sources"]').isExisting(), false)
    assert.equal(await dialog.$('button[data-section="plugins"]').isExisting(), false)
  })

  it('gathers everything extending Copse under Customise, plugins included', async () => {
    await $('#settings-dialog').$('button[data-section="customise"]').click()
    const customise = settingsSection('customise')
    await expect(customise).toBeDisplayed()

    // The lists that used to be Sources, and the one that used to be its own
    // section, now share a page.
    await expect(customise.$('legend=Instruction files')).toBeDisplayed()
    await expect(customise.$('legend=Skills')).toBeDisplayed()
    await expect(customise.$('legend=Plugins')).toBeDisplayed()
    // Cursor plugins merged *into* the plugin list rather than sitting beside it,
    // and into its enabled/disabled grouping rather than a section of their own.
    assert.equal(await customise.$('legend=Cursor plugins').isExisting(), false)
    const groupHeadings = await customise.$$('.plugins-group-heading').map((h) => h.getText())
    assert.ok(
      !groupHeadings.includes('From Cursor'),
      'origin is a badge on the row, not a section of its own',
    )

    // Worktrees moved out — managing disk is not customising behaviour.
    assert.equal(await customise.$('#sources-worktrees-list').isExisting(), false)

    const row = customise.$(`.plugin-row[data-plugin-id="${PLUGIN_ID}"]`)
    await row.waitForExist({ timeout: 15_000 })
    // First-party plugins list in the same place, so this really is one list.
    await expect(customise.$('.plugin-row[data-plugin-id="copse.todos"]')).toBeDisplayed()

    await saveElementScreenshot('#settings-dialog', 'settings-customise.png')
  })

  it('shows worktrees under Storage', async () => {
    await $('#settings-dialog').$('button[data-section="storage"]').click()
    const storage = settingsSection('storage')
    await expect(storage).toBeDisplayed()
    await expect(storage.$('legend=Worktrees')).toBeDisplayed()
    const list = storage.$('#sources-worktrees-list')
    await list.waitForExist({ timeout: 15_000 })

    await saveElementScreenshot('#settings-dialog', 'settings-storage.png')
  })

  it('discloses and attributes what a plugin declares', async () => {
    await $('#settings-dialog').$('button[data-section="mcp"]').click()
    const mcp = settingsSection('mcp')
    await expect(mcp).toBeDisplayed()

    // The disabled plugin's declaration is disclosed, attributed, and inert.
    const declared = mcp.$('#mcp-declared-fieldset')
    await declared.waitForDisplayed({ timeout: 20_000 })
    const declaredRow = declared.$(`.mcp-declared-row[data-plugin-id="${PLUGIN_ID}"]`)
    await declaredRow.waitForExist({ timeout: 15_000 })
    const text = await declaredRow.getText()
    assert.match(text, /declared_reviewer \(stdio\)/)
    assert.match(text, /not running/)
    const origin = declaredRow.$('.mcp-origin-chip')
    await origin.waitForExist({ timeout: 15_000 })
    assert.equal(await origin.getAttribute('data-mcp-origin'), 'plugin')
    assert.equal((await origin.getText()).toLowerCase(), PLUGIN_ID)
    // A declaration is not a control: nothing here implies Copse could start it.
    assert.equal(await declaredRow.$('.toggle-switch').isExisting(), false)

    await saveElementScreenshot('#settings-dialog', 'settings-mcp-lens.png')
  })
})

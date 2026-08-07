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

// Agent Plugins discovery — Stage A of docs/plans/agent-plugins-migration.md.
//
// The unit tests pin the parse and the disk walk. What only the real app can
// answer is whether a directory dropped into the plugin root actually becomes a
// row a user can see and toggle — the whole point of the stage — and whether
// the properties that make it *safe* survive the trip through IPC and into the
// renderer:
//
//   - a discovered plugin is a **user** plugin, not first-party;
//   - it arrives **disabled**, so a manifest appearing on disk never starts
//     contributing before anyone looks at it;
//   - the user can still turn it on, and that choice persists;
//   - a malformed neighbour does not take the list (or the app) down with it.
//
// The last one is the reason this is an e2e rather than a component test:
// discovery runs at boot, so "one bad directory breaks startup" is a failure
// mode only a real launch can rule out.

function settingsSection(section: string) {
  return $(`.settings-section[data-section="${section}"]`)
}

const GOOD_PLUGIN_ID = 'acme.reviewer'

describe('agent plugins discovery', function () {
  this.timeout(60_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    resetAgentPlugins()

    // A conformant package: core metadata at the top level, every Copse
    // contribution kind under the reverse-domain namespace.
    seedAgentPlugin(
      GOOD_PLUGIN_ID,
      {
        $schema: AGENT_PLUGIN_SCHEMA,
        name: GOOD_PLUGIN_ID,
        version: '1.2.0',
        description: 'Review helpers from an Agent Plugins package.',
        repository: 'https://github.com/acme/reviewer',
        license: 'MIT',
        extensions: {
          'dev.copse': {
            stability: 'experimental',
            prompt: [{ id: 'review-steering', text: 'Prefer small diffs.' }],
            settings: {
              strictness: { kind: 'number', title: 'Strictness', default: 2 },
            },
            storage: { namespace: 'acme-reviewer' },
          },
        },
      },
      {
        skill: 'summarize',
        mcp: {
          $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
          mcpServers: { local: { type: 'stdio', command: './bin/server' } },
        },
      },
    )

    // Three ways to be broken, all of which must be survivable: unparseable
    // JSON, a name violating §5.5, and a `dev.copse` block Copse rejects while
    // the file stays a valid Agent Plugin.
    seedAgentPlugin('broken-json', '{ not json')
    seedAgentPlugin('broken-name', { $schema: AGENT_PLUGIN_SCHEMA, name: 'Not A Valid Name' })
    seedAgentPlugin('broken-extension', {
      $schema: AGENT_PLUGIN_SCHEMA,
      name: 'broken.extension',
      extensions: { 'dev.copse': { stability: 'super-stable' } },
    })

    seedEmptyProject(process.cwd(), 'e2e-agent-plugins')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    resetAgentPlugins()
  })

  it('lists a discovered package as a disabled user plugin, and survives bad neighbours', async () => {
    // Reaching the prompt at all is the first assertion: discovery runs during
    // boot, so three malformed directories must not stop the app starting.
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="customise"]').click()

    const plugins = settingsSection('customise')
    await expect(plugins).toBeDisplayed()

    const row = plugins.$(`.plugin-row[data-plugin-id="${GOOD_PLUGIN_ID}"]`)
    await row.waitForExist({ timeout: 15_000 })

    // A disk manifest cannot promote itself: trust is host-assigned.
    await expect(row.$('.plugin-badge-user')).toBeDisplayed()
    assert.equal(await row.$('.plugin-badge-first-party').isExisting(), false)

    // Seeded off. This is the property that makes dropping a directory into the
    // plugin root safe, and it is worth an explicit assertion rather than a
    // side effect of the default-disabled list.
    assert.equal(await row.getAttribute('data-enabled'), 'false')
    const cls = (await row.getAttribute('class')) ?? ''
    assert.ok(cls.includes('plugin-row-disabled'), 'a newly discovered plugin must render greyed')

    // Manifest metadata reaches the row.
    const rowText = await row.getText()
    assert.match(rowText, /Review helpers from an Agent Plugins package/)
    assert.match(rowText, /1\.2\.0/)

    // Not one of the broken three became a row.
    for (const id of ['Not A Valid Name', 'broken.extension', 'broken-json']) {
      assert.equal(
        await plugins.$(`.plugin-row[data-plugin-id="${id}"]`).isExisting(),
        false,
        `${id} must not register`,
      )
    }

    // First-party plugins still list alongside it — discovery adds rows, it does
    // not replace the registry.
    await expect(plugins.$('.plugin-row[data-plugin-id="copse.todos"]')).toBeDisplayed()

    await row.scrollIntoView()
    await saveElementScreenshot(
      `.plugin-row[data-plugin-id="${GOOD_PLUGIN_ID}"]`,
      'agent-plugin-discovered-row.png',
    )
  })

  it('renders the manifest-declared setting and persists an explicit enable', async () => {
    const plugins = settingsSection('customise')
    const row = plugins.$(`.plugin-row[data-plugin-id="${GOOD_PLUGIN_ID}"]`)

    // The `dev.copse` settings schema renders through the same generic field
    // machinery a first-party plugin uses.
    await row.$('.plugin-settings-summary').click()
    const strictness = row.$('input.plugin-setting-number[data-setting-key="strictness"]')
    await expect(strictness).toBeDisplayed()
    assert.equal(await strictness.getValue(), '2')

    // Turning it on is the user's decision, and it has to stick — the seed-off
    // must happen exactly once, never re-applied on the next discovery pass.
    await row.$('label.plugin-toggle').click()
    await browser.waitUntil(async () => (await row.getAttribute('data-enabled')) === 'true', {
      timeout: 5_000,
      timeoutMsg: 'expected the discovered plugin to enable',
    })

    await saveElementScreenshot('#settings-dialog', 'settings-plugins-agent-plugin.png')

    await browser.keys('Escape')
    await dialogClosed()
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed()
    await $('#settings-dialog').$('button[data-section="customise"]').click()

    const reopened = settingsSection('customise').$(
      `.plugin-row[data-plugin-id="${GOOD_PLUGIN_ID}"]`,
    )
    await reopened.waitForExist({ timeout: 15_000 })
    assert.equal(
      await reopened.getAttribute('data-enabled'),
      'true',
      'a plugin the user enabled must not be re-seeded off on the next boot',
    )
  })
})

async function dialogClosed(): Promise<void> {
  await $('#settings-dialog').waitForDisplayed({ reverse: true })
}

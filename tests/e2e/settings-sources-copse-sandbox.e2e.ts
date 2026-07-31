import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

// F3 (docs/plans/hooks-and-feature-packs.md, decision 7): hooks are sandboxed by
// default; the Copse `sandbox: false` escape runs a hook OUTSIDE the project
// sandbox. Sources badges that escape "outside sandbox" so the granted risk is
// visible — this proves the renderer-visible surfacing (AGENTS.md: visual change
// ⇒ WDIO visual).
const PROJECT_ID = 'e2e-settings-sources-copse-sandbox'

describe('settings sources hooks (Copse sandbox escape)', () => {
  let workspaceRoot = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-e2e-copse-sandbox-'))
    mkdirSync(join(workspaceRoot, '.copse'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, '.copse', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          // The escape: this hook opts OUT of the project sandbox (decision 7).
          toolGate: [{ command: './hooks/guard-unsandboxed.sh', sandbox: false }],
        },
      }),
      'utf8',
    )

    const trustedRoot = realpathSync(workspaceRoot)
    seedEmptyProject(workspaceRoot, PROJECT_ID, { developerMode: true })
    // Project Copse hooks are only discovered for a trusted workspace.
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      trustedWorkspaceRoots: [trustedRoot],
      [`threads:${PROJECT_ID}`]: [],
    })

    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('badges a `sandbox: false` Copse hook "outside sandbox" in Settings → Sources', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="sources"]').click()

    const sources = dialog.$('.settings-section[data-section="sources"]')
    await expect(sources).toBeDisplayed()
    await expect(sources.$('legend=Hooks')).toBeDisplayed()

    const hooksList = sources.$('#sources-hooks-list')
    await browser.waitUntil(
      async () => {
        // The badge label is CSS-uppercased in the rendered text, so match
        // case-insensitively (the DOM class assertion below pins the exact node).
        const text = (await hooksList.getText()).toLowerCase()
        return text.includes('toolgate') && text.includes('outside sandbox')
      },
      {
        timeout: 15_000,
        timeoutMsg: 'expected the Copse sandbox:false hook badged "outside sandbox"',
      },
    )

    const text = await hooksList.getText()
    assert.match(text, /toolGate/)
    assert.match(text, /Copse · \.\/hooks\/guard-unsandboxed\.sh/)
    assert.match(text, /outside sandbox/i)

    const badge = hooksList.$('.sources-badge-unsandboxed')
    await expect(badge).toBeDisplayed()
    assert.match((await badge.getText()).trim(), /^outside sandbox$/i)

    // Scroll the Hooks fieldset into view — Sources is long (skills list) and the
    // section screenshot would otherwise capture only Instructions + Skills.
    await browser.execute(() => {
      const hooks = document.querySelector('#sources-hooks-list')
      hooks?.closest('fieldset')?.scrollIntoView({ block: 'start' })
    })
    await browser.pause(100)

    await saveElementScreenshot(
      'fieldset:has(#sources-hooks-list)',
      'settings-sources-copse-sandbox.png',
    )
  })
})

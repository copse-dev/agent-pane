import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  parkPointer,
  pinTextForCapture,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const PROJECT_ID = 'e2e-hook-test-cwd'
const COMMAND = 'node scripts/report-cwd.cjs'
const root = join(tmpdir(), 'copse-e2e', 'hook-test-cwd')

describe('Sources Test project hook working directory', function () {
  this.timeout(60_000)
  before(async () => {
    removeE2eTree(root)
    mkdirSync(join(root, '.copse'), { recursive: true })
    mkdirSync(join(root, 'scripts'))
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeFileSync(
      join(root, 'scripts/report-cwd.cjs'),
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({note:'Hook ran from '+process.cwd()})))",
    )
    writeFileSync(
      join(root, '.copse/hooks.json'),
      JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [{ command: COMMAND }] } }),
    )
    resetUserData()
    seedEmptyProject(root, PROJECT_ID, { developerMode: true })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: root, name: 'hook-project' }],
      activeProjectId: PROJECT_ID,
      trustedWorkspaceRoots: [realpathSync(root)],
      [`threads:${PROJECT_ID}`]: [],
    })
    await browser.reloadSession()
  })
  after(() => {
    resetUserData()
    removeE2eTree(root)
  })

  it('tests the project-relative script and shows its successful actual working directory', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await dialog.$('button[data-section="customise"]').click()
    const list = dialog.$('#sources-hooks-list')
    const selector =
      './/div[@class="sources-row"]' +
      '[.//span[@class="sources-row-title" and text()="beforeSubmitPrompt"]]' +
      '[div[@class="sources-row-header"]/span[contains(@class,"sources-badge") and text()="project"]]' +
      `[div[@class="sources-row-detail" and text()="Copse · ${COMMAND}"]]`
    const row = list.$(selector)
    await row.waitForExist({ timeout: 15_000 })
    await expect(row.$('.sources-row-detail')).toHaveText(`Copse · ${COMMAND}`)
    const test = row.$('.sources-hook-test-btn')
    await test.scrollIntoView({ block: 'center' })
    await test.click()
    const result = row.$('.hook-test')
    await expect(result.$('.hook-test-summary')).toHaveText(expect.stringContaining('exit 0'))
    await expect(result.$('.hook-test-summary')).toHaveText(expect.stringContaining('parsed ok'))
    if (process.platform === 'darwin') {
      await expect(result.$('.hook-test-summary')).toHaveText(expect.stringContaining('sandboxed'))
    }
    assert.match(await result.$('.hook-test-summary').getText(), /\d+ ms/)
    const stdin = result.$(
      './/div[@class="hook-test-stream"][div[@class="hook-test-stream-label" and text()="stdin"]]/pre',
    )
    await expect(stdin).toHaveText(expect.stringContaining(root))
    const stdout = result.$(
      './/div[@class="hook-test-stream"][div[@class="hook-test-stream-label" and text()="stdout"]]/pre',
    )
    await expect(stdout).toHaveText(JSON.stringify({ note: `Hook ran from ${realpathSync(root)}` }))
    const stderr = result.$(
      './/div[@class="hook-test-stream"][div[@class="hook-test-stream-label" and text()="stderr"]]/pre',
    )
    await expect(stderr).toHaveText('(empty)')
    // Only this exact hook has been tested; do not capture host user-hook rows.
    const capture = '#sources-hooks-list .sources-row:has(.hook-test:not([hidden]))'
    await expect($(capture).$('.sources-row-detail')).toHaveText(`Copse · ${COMMAND}`)
    assert.equal(await browser.$$(capture).length, 1)
    const restoreDuration = await pinTextForCapture(capture, /^\d+ ms$/, '40 ms')
    const paths = [realpathSync(root), root]
      .map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')
    const restorePath = await pinTextForCapture(
      capture,
      new RegExp(paths, 'g'),
      '/tmp/copse-e2e/hook-test-cwd',
    )
    try {
      await row.scrollIntoView({ block: 'center' })
      await saveElementScreenshot(capture, 'settings-sources-hook-cwd.png', {
        beforeCapture: async () => {
          await parkPointer()
          const bounds = await browser.execute((selector) => {
            const card = document.querySelector(selector)
            const viewport = card?.closest('.settings-content')
            const app = document.getElementById('app')
            const footer = document.querySelector('.settings-buttons')
            if (!card || !viewport || !app || !footer) throw new Error('Hook capture frame missing')
            const rect = card.getBoundingClientRect()
            const scroll = viewport.getBoundingClientRect()
            const frame = app.getBoundingClientRect()
            return {
              top: rect.top,
              bottom: rect.bottom,
              visibleTop: Math.max(scroll.top, frame.top),
              visibleBottom: Math.min(
                scroll.bottom,
                frame.bottom,
                footer.getBoundingClientRect().top,
              ),
            }
          }, capture)
          assert.ok(
            bounds.top >= bounds.visibleTop - 1 && bounds.bottom <= bounds.visibleBottom + 1,
            `Complete hook result must fit the natural settings viewport: ${JSON.stringify(bounds)}`,
          )
        },
      })
    } finally {
      await restorePath()
      await restoreDuration()
    }
  })
})

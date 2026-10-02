import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-apply-patch-card'

const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/greeting.ts',
  '@@ export function greet',
  '-  return "hello"',
  '+  return "hello, world"',
  '*** Add File: src/farewell.ts',
  '+export function farewell(): string {',
  '+  return "goodbye"',
  '+}',
  '*** Delete File: src/legacy.ts',
  '*** End Patch',
].join('\n')

describe('apply_patch tool card', () => {
  let workspace = ''

  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspace = seedStableWorkspace({
      files: {
        'src/greeting.ts': 'export function greet(): string {\n  return "hello"\n}\n',
        'src/legacy.ts': 'export const legacy = true\n',
      },
    })
    seedEmptyProject(workspace, PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('edits three files in one call and lists each with its line counts', async function () {
    this.timeout(90_000)
    const prompt = 'Update the greeting, add a farewell, and drop the legacy module.'
    const reply = 'Patched the greeting, added farewell.ts, and removed legacy.ts.'
    const scenario = await installMockScenario({
      title: 'Apply a three-file patch',
      turns: [
        {
          user: prompt,
          responses: [
            { toolCalls: [{ name: 'apply_patch', args: { input: PATCH } }] },
            {
              text: reply,
              expectToolResults: [{ name: 'apply_patch', includes: 'apply_patch handled 3 files' }],
            },
          ],
        },
      ],
    })

    await setComposerValue(prompt)
    await submitComposer()
    await waitForAgentIdle()
    await expectAssistantReply(reply)
    await scenario.assertComplete()

    // Edits and the new file land directly (clean scratch repo). The deletion goes
    // through the same approval queue as delete_file: in a shared checkout it is
    // staged, so legacy.ts is still on disk until the user accepts it.
    assert.equal(
      readFileSync(join(workspace, 'src/greeting.ts'), 'utf8'),
      'export function greet(): string {\n  return "hello, world"\n}\n',
    )
    assert.equal(
      readFileSync(join(workspace, 'src/farewell.ts'), 'utf8'),
      'export function farewell(): string {\n  return "goodbye"\n}\n',
    )
    assert.equal(existsSync(join(workspace, 'src/legacy.ts')), true)

    // The card summarises the patch and, once opened, lists every file.
    const card = $('.tool-card:not(.tool-card-rollup)')
    await card.waitForExist({ timeout: 15_000 })

    // A settled card can still be auto-collapsing when we look. Click a header only
    // while its <details> is closed (a click on an open one would close it), and
    // finish once the file list has actually laid out.
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const rollup = document.querySelector<HTMLDetailsElement>('.tool-card-rollup')
          const inner = document.querySelector<HTMLDetailsElement>(
            '.tool-card:not(.tool-card-rollup)',
          )
          if (rollup && !rollup.open) rollup.querySelector('summary')?.click()
          else if (inner && !inner.open) inner.querySelector('summary')?.click()
          const list = document.querySelector('.tool-patch-files')
          return (list?.getBoundingClientRect().height ?? 0) > 0
        }),
      { timeout: 15_000, interval: 300, timeoutMsg: 'expected the patch file list to lay out' },
    )
    await expect(card.$('.tool-name')).toHaveText('Patched 3 files')
    await expect(card.$('.tool-stat-add')).toHaveText('+4')
    await expect(card.$('.tool-stat-del')).toHaveText('-2')
    const rows = await card.$$('.tool-patch-file')
    assert.equal(rows.length, 3)
    const seen = await browser.execute(() =>
      [...document.querySelectorAll('.tool-patch-file')].map((row) => [
        row.getAttribute('data-op'),
        row.querySelector('.tool-patch-path')?.textContent ?? '',
        row.querySelector('.tool-stat-add')?.textContent ?? '',
        row.querySelector('.tool-stat-del')?.textContent ?? '',
      ]),
    )
    assert.deepEqual(seen, [
      ['update', 'src/greeting.ts', '+1', '-1'],
      ['add', 'src/farewell.ts', '+3', '-0'],
      ['delete', 'src/legacy.ts', '', ''],
    ])

    // Rows must not overflow the card or collide (path column takes the slack).
    const geometry = await browser.execute(() => {
      const list = document.querySelector('.tool-patch-files')
      const cardEl = document.querySelector('.tool-card')
      if (!list || !cardEl) return null
      const listBox = list.getBoundingClientRect()
      const cardBox = cardEl.getBoundingClientRect()
      return { listRight: listBox.right, cardRight: cardBox.right, listHeight: listBox.height }
    })
    assert.ok(geometry, 'expected the patch file list to render')
    assert.ok(geometry.listRight <= geometry.cardRight + 1, 'file list stays inside the card')
    assert.ok(geometry.listHeight > 0, 'file list has height')

    await saveAppScreenshot('apply-patch-card.png')
  })
})

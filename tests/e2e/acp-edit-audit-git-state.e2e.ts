import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'

const ROUTE = 'acp:audit-fixture#fixture-sonnet'

/**
 * A finished turn folds its tool cards away, and each card is a <details>.
 * Click open every closed fold around `selector`, outermost first, as a user would.
 */
async function openFoldsAround(selector: string): Promise<void> {
  for (let depth = 0; depth < 5; depth++) {
    const marked = await browser.execute((sel) => {
      document.querySelector('[data-e2e-fold]')?.removeAttribute('data-e2e-fold')
      let outermost: HTMLDetailsElement | null = null
      for (let node = document.querySelector(sel); node; node = node.parentElement) {
        if (node instanceof HTMLDetailsElement && !node.open) outermost = node
      }
      outermost?.setAttribute('data-e2e-fold', '')
      return outermost !== null
    }, selector)
    if (!marked) return
    await $('[data-e2e-fold] > summary').click()
  }
  throw new Error(`folds around ${selector} would not open`)
}

// #4006: the agent's own shell writes past the diff queue, and the turn-end
// audit says which file is the only copy and which git can give back.
describe('ACP edit audit git state', function () {
  this.timeout(90_000)
  const originalPath = process.env['PATH']
  const originalPreservePath = process.env['COPSE_PRESERVE_PATH']
  let fixtureBin = ''
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    fixtureBin = mkdtempSync(join(tmpdir(), 'copse-acp-audit-bin-'))
    const windows = process.platform === 'win32'
    const fixturePath = join(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')
    for (const command of ['fixture-acp', 'codex-acp']) {
      const executable = join(fixtureBin, windows ? `${command}.cmd` : command)
      writeFileSync(
        executable,
        windows
          ? `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`
          : `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(fixturePath).href)})\n`,
      )
      if (!windows) chmodSync(executable, 0o755)
    }
    writeE2eEnv({
      COPSE_PRESERVE_PATH: '1',
      PATH: [
        fixtureBin,
        ...(windows
          ? [join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')]
          : ['/usr/bin', '/bin']),
      ].join(delimiter),
    })
    seedEmptyProject(seedStableWorkspace(), 'e2e-acp-edit-audit-git-state', {
      model: ROUTE,
      registeredAcpAgents: [
        // Keep the ambient Codex adapter-install approval out of this journey.
        { id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: false },
        {
          id: 'audit-fixture',
          title: 'Audit fixture agent',
          command: 'fixture-acp',
          enabled: true,
          model: 'fixture-sonnet',
          availableModels: [{ value: 'fixture-sonnet', label: 'Fixture model' }],
          modelsProbedAt: Date.now(),
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    writeE2eEnv({ COPSE_PRESERVE_PATH: originalPreservePath, PATH: originalPath })
    resetUserData()
    if (fixtureBin) removeE2eTree(fixtureBin)
  })

  it('marks the only copy apart from content git already has', async () => {
    await setComposerValue(
      'write-files:docs/plan.md=Draft plan;docs/notes-copy.md<docs/notes.md;' +
        'src/greeting.ts=export const greet = 1;-scripts/shell-check.ts',
    )
    await submitComposer()

    const card = $('[data-tool-id^="acp-edit-audit-"]')
    await card.waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => (await card.getAttribute('data-status')) === 'done', {
      timeout: 30_000,
      timeoutMsg: 'the edit audit never finished',
    })
    await openFoldsAround('[data-tool-id^="acp-edit-audit-"]')
    const result = card.$('.tool-result')
    await result.waitForDisplayed({ timeout: 10_000 })
    const text = await result.getText()
    expect(text).toContain(
      'docs/plan.md (new, untracked): this version is in no commit, so the file on disk is the only copy',
    )
    expect(text).toContain(
      'docs/notes-copy.md (new, untracked): git already has this exact content',
    )
    expect(text).toContain(
      'src/greeting.ts (edited): this version is in no commit, so the file on disk is the only copy',
    )
    expect(text).toContain('scripts/shell-check.ts (deleted)')
    expect(text).toContain('live work, not a duplicate: deleting it loses it')
    await saveElementScreenshot('[data-tool-id^="acp-edit-audit-"]', 'acp-edit-audit-git-state.png')
  })
})

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { readWorktreePreparationPlan } from '../../src/main/services/worktree-preparation-plan.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { parkPointer, saveElementScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const PROJECT_ID = 'e2e-automation-preparation-setup'
const root = join(tmpdir(), 'copse-e2e', 'automation-preparation-setup')
const nested = join(root, 'packages/app')
const PROJECT_MENU = `.project-entry[data-project-id="${PROJECT_ID}"] .project-menu-btn`

async function openEditor(create: boolean): Promise<void> {
  await $(PROJECT_MENU).waitForClickable({ timeout: 15_000 })
  await $(PROJECT_MENU).click()
  await $(`.context-menu-item=${create ? 'New automation…' : 'Automations'}`).click()
  await expect($('#automation-dialog')).toBeDisplayed()
  if (!create) await $('#automation-dialog').$('.automation-row-btn=Edit').click()
  await expect($('#automation-dialog .automation-form')).toBeDisplayed()
}

async function assertDialogFits(selector: string): Promise<void> {
  const bounds = await browser.execute((sel: string) => {
    const element = document.querySelector(sel)
    const dialog = element?.getBoundingClientRect()
    const app = document.getElementById('app')?.getBoundingClientRect()
    if (!dialog || !app || !element) throw new Error('Missing setup review capture frame')
    const action = element.querySelector('.confirm-dialog-confirm')?.getBoundingClientRect()
    return {
      left: dialog.left,
      right: dialog.right,
      top: dialog.top,
      bottom: dialog.bottom,
      frameLeft: Math.max(0, app.left),
      frameRight: Math.min(window.innerWidth, app.right),
      frameTop: Math.max(0, app.top),
      frameBottom: Math.min(window.innerHeight, app.bottom),
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      action: action ? { top: action.top, bottom: action.bottom } : null,
    }
  }, selector)
  assert.ok(
    bounds.left >= bounds.frameLeft &&
      bounds.right <= bounds.frameRight &&
      bounds.top >= bounds.frameTop &&
      bounds.bottom <= bounds.frameBottom,
    `setup dialog must fit its visible app frame: ${JSON.stringify(bounds)}`,
  )
  assert.ok(bounds.scrollWidth <= bounds.clientWidth, 'setup details must wrap within the dialog')
  if (bounds.action) {
    assert.ok(
      bounds.action.top >= bounds.frameTop && bounds.action.bottom <= bounds.frameBottom,
      `the complete setup confirmation action must fit: ${JSON.stringify(bounds)}`,
    )
  }
}

async function assertSaveErrorVisible(): Promise<void> {
  const bounds = await browser.execute(() => {
    const error = document
      .querySelector('#automation-dialog .automation-status-error')
      ?.getBoundingClientRect()
    const viewport = document
      .querySelector('#automation-dialog .automation-dialog-body')
      ?.getBoundingClientRect()
    const app = document.getElementById('app')?.getBoundingClientRect()
    if (!error || !viewport || !app) throw new Error('Missing Save error frame')
    const viewportTop = Math.max(viewport.top, app.top, 0)
    const viewportBottom = Math.min(viewport.bottom, app.bottom, window.innerHeight)
    return {
      errorTop: error.top,
      errorBottom: error.bottom,
      viewportTop,
      viewportBottom,
      visible: error.top >= viewportTop && error.bottom <= viewportBottom,
    }
  })
  console.info('[automation-preparation-setup] natural Save error frame', bounds)
  assert.ok(
    bounds.visible,
    `failed Save must reveal its complete status: ${JSON.stringify(bounds)}`,
  )
}

async function assertSavedSetupReviewVisible(): Promise<void> {
  const bounds = await browser.execute(() => {
    const dialog = document.getElementById('automation-dialog')
    const viewport = dialog?.querySelector('.automation-dialog-body')?.getBoundingClientRect()
    const app = document.getElementById('app')?.getBoundingClientRect()
    const group = dialog?.querySelector('.automation-preparation-setup')
    const hint = dialog?.querySelector('.automation-preparation-proposal-hint')
    const saved = Array.from(dialog?.querySelectorAll('.automation-permission-row') ?? []).find(
      (row) => row.textContent.includes('Prepare worktree (packages/app)'),
    )
    const detail = saved?.querySelector('.automation-permission-detail')
    const list = saved?.closest('.automation-permission-list')?.getBoundingClientRect()
    if (!viewport || !app || !group || !hint || !saved || !detail || !list)
      throw new Error('Missing saved setup review frame')
    const top = Math.max(0, viewport.top, app.top)
    const bottom = Math.min(innerHeight, viewport.bottom, app.bottom)
    const left = Math.max(0, viewport.left, app.left)
    const right = Math.min(innerWidth, viewport.right, app.right)
    const innerTop = Math.max(top, list.top)
    const innerBottom = Math.min(bottom, list.bottom)
    const innerLeft = Math.max(left, list.left)
    const innerRight = Math.min(right, list.right)
    const boundsOf = (
      element: Element,
    ): Record<'top' | 'bottom' | 'left' | 'right' | 'width' | 'height', number> => {
      const rect = element.getBoundingClientRect()
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      }
    }
    const elements = [group, hint].map(boundsOf)
    const savedElements = [saved, detail].map(boundsOf)
    return {
      viewport: { top, bottom, left, right },
      innerViewport: { top: innerTop, bottom: innerBottom, left: innerLeft, right: innerRight },
      elements,
      savedElements,
      savedScope: detail.textContent,
      visible:
        elements.every(
          (rect) =>
            rect.width > 0 &&
            rect.height > 0 &&
            rect.top >= top &&
            rect.bottom <= bottom &&
            rect.left >= left &&
            rect.right <= right,
        ) &&
        savedElements.every(
          (rect) =>
            rect.width > 0 &&
            rect.height > 0 &&
            rect.top >= innerTop &&
            rect.bottom <= innerBottom &&
            rect.left >= innerLeft &&
            rect.right <= innerRight,
        ),
    }
  })
  console.info('[automation-preparation-setup] saved review frame', bounds)
  assert.ok(
    bounds.visible,
    `new-review guidance and the saved grant must fit together: ${JSON.stringify(bounds)}`,
  )
}

async function reviewAndSelect(capture = false): Promise<void> {
  const editor = $('#automation-dialog')
  await editor.$('.automation-preparation-directory').setValue('packages/app')
  await editor.$('.automation-preparation-network').selectByAttribute('value', 'offline')
  await editor.$('.automation-preparation-review-btn').click()
  const review = $('#confirm-dialog')
  await expect(review).toBeDisplayed()
  await expect(review.$('.confirm-dialog-message')).toHaveText(
    'Allow this setup for “Nightly customer-app check”?',
  )
  await expect(review.$('.automation-preparation-review-commands')).toHaveText(
    expect.stringContaining("'npm' 'ci' '--ignore-scripts'"),
  )
  await expect(review.$('.automation-preparation-review-commands')).toHaveText(
    expect.stringContaining("'node' 'scripts/prepare.cjs'"),
  )
  await expect(review.$('.confirm-dialog-detail')).toHaveText(
    expect.stringContaining('Folder: packages/app'),
  )
  await expect(review.$('.confirm-dialog-detail')).toHaveText(
    expect.stringContaining('Network: blocked for every subprocess'),
  )
  await expect(review.$('.confirm-dialog-detail')).toHaveText(
    expect.stringContaining('Writes are limited to this project and Copse-managed caches'),
  )
  assert.equal(existsSync(join(nested, 'executed.txt')), false, 'preview must not execute setup')
  if (capture) {
    await saveElementScreenshot('#confirm-dialog', 'automation-preparation-setup-review.png', {
      beforeCapture: async () => {
        await parkPointer()
        await assertDialogFits('#confirm-dialog')
      },
    })
    await review.$('.confirm-dialog-cancel').click()
    assert.deepEqual(
      await browser.execute(async (id: string) => window.api.automations.list(id), PROJECT_ID),
      [],
    )
    await editor.$('.automation-preparation-review-btn').click()
    await expect(review).toBeDisplayed()
  }
  await review.$('.confirm-dialog-confirm').click()
  await expect(review).not.toBeDisplayed()
  await expect(editor.$('.automation-status')).toHaveText(
    'Reviewed setup selected. Save the automation to keep it.',
  )
}

describe('upfront automation worktree setup', function () {
  this.timeout(60_000)
  before(async () => {
    removeE2eTree(root)
    mkdirSync(join(nested, '.copse'), { recursive: true })
    mkdirSync(join(nested, 'scripts'))
    writeFileSync(join(nested, 'package.json'), '{"packageManager":"npm@11.12.0"}')
    writeFileSync(join(nested, 'package-lock.json'), '{}')
    writeFileSync(
      join(nested, 'scripts/prepare.cjs'),
      "require('node:fs').writeFileSync('executed.txt', 'ran')",
    )
    writeFileSync(
      join(nested, '.copse/worktree-preparation.json'),
      JSON.stringify({
        version: 1,
        inputs: ['scripts/prepare.cjs'],
        prepare: [{ command: 'node', args: ['scripts/prepare.cjs'] }],
        checks: [{ name: 'Generated setup output', path: 'executed.txt' }],
      }),
    )
    resetUserData()
    seedEmptyProject(root, PROJECT_ID, { model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: root, name: 'customer-app' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [],
      pluginDisabled: ['copse.automations'],
      pluginMigration: { automationsEnablement: true },
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    resetUserData()
    removeE2eTree(root)
  })

  it('reviews and saves an exact setup before any run, then retains it across restart', async () => {
    await openEditor(true)
    let editor = $('#automation-dialog')
    await editor.$('.automation-name-input').setValue('Nightly customer-app check')
    await editor
      .$('.automation-prompt-input')
      .setValue('Prepare this project, then review its open work.')
    await editor.$('.automation-enabled-input').click()
    await reviewAndSelect(true)
    assert.deepEqual(
      await browser.execute(async (id: string) => window.api.automations.list(id), PROJECT_ID),
      [],
    )
    await editor.$('.automation-save-btn').click()
    await expect(editor.$('.automation-form')).not.toBeDisplayed()
    const saved = await browser.execute(
      async (id: string) => window.api.automations.list(id),
      PROJECT_ID,
    )
    assert.equal(saved.length, 1)
    assert.equal(saved[0]?.lastCreatedThreadId, undefined)
    assert.deepEqual(saved[0]?.permissions, [
      {
        kind: 'worktree-preparation',
        toolName: 'prepare_worktree',
        directory: 'packages/app',
        planFingerprint: readWorktreePreparationPlan(nested).contentFingerprint,
        offline: true,
      },
    ])
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await openEditor(false)
    editor = $('#automation-dialog')
    const row = editor.$('.automation-permission-row*=Prepare worktree')
    await expect(row.$('input')).toBeSelected()
    await expect(row).toHaveText(expect.stringContaining('Offline'))
    await expect(row).toHaveText(expect.stringContaining('packages/app'))
    await row.scrollIntoView({ block: 'center' })
    await expect(editor.$('.automation-preparation-review-btn')).toHaveText('Review another setup')
    await expect(editor.$('.automation-preparation-proposal-hint')).toHaveText(
      'These fields are for another setup review. Saved setup permissions below keep their listed folder and network scope.',
    )
    await saveElementScreenshot('#automation-dialog', 'automation-preparation-setup-saved.png', {
      beforeCapture: async () => {
        await row.scrollIntoView({ block: 'end' })
        await editor.$('.automation-preparation-setup').scrollIntoView({ block: 'start' })
        await browser.execute(() => {
          const list = document.querySelector<HTMLElement>(
            '#automation-dialog .automation-permission-list',
          )
          if (!list) throw new Error('Missing saved setup permissions list')
          list.scrollTop = list.scrollHeight
        })
        await parkPointer()
        await assertDialogFits('#automation-dialog')
        await assertSavedSetupReviewVisible()
      },
    })
    await row.scrollIntoView({ block: 'center' })
    await row.$('.automation-permission-switch').click()
    await expect(row.$('input')).not.toBeSelected()
    await editor.$('.automation-save-btn').click()
    await expect(editor.$('.automation-form')).not.toBeDisplayed()
    const revoked = await browser.execute(
      async (id: string) => window.api.automations.list(id),
      PROJECT_ID,
    )
    assert.equal(revoked[0]?.permissions, undefined)
  })

  it('refuses changed inputs at Save and allows an exact re-review to recover', async () => {
    const editor = $('#automation-dialog')
    await editor.$('.automation-row-btn=Edit').click()
    await reviewAndSelect()
    const previous = readWorktreePreparationPlan(nested).contentFingerprint
    writeFileSync(join(nested, 'package-lock.json'), '{"lockfileVersion":3}')
    const current = readWorktreePreparationPlan(nested).contentFingerprint
    assert.notEqual(current, previous)
    await editor.$('.automation-save-btn').click()
    await expect(editor.$('.automation-form')).toBeDisplayed()
    await expect(editor.$('.automation-status-error')).toHaveText(
      'Worktree setup has changed. Review it again before saving.',
    )
    await assertSaveErrorVisible()
    const unchanged = await browser.execute(
      async (id: string) => window.api.automations.list(id),
      PROJECT_ID,
    )
    assert.equal(unchanged[0]?.permissions, undefined)
    await saveElementScreenshot('#automation-dialog', 'automation-preparation-setup-changed.png', {
      beforeCapture: async () => {
        await assertSaveErrorVisible()
        await parkPointer()
        await assertDialogFits('#automation-dialog')
      },
    })
    await reviewAndSelect()
    await editor.$('.automation-save-btn').click()
    await expect(editor.$('.automation-form')).not.toBeDisplayed()
    const saved = await browser.execute(
      async (id: string) => window.api.automations.list(id),
      PROJECT_ID,
    )
    assert.equal(saved[0]?.permissions?.length, 1)
    assert.equal(saved[0].permissions[0]?.kind, 'worktree-preparation')
    assert.deepEqual(saved[0].permissions, [
      {
        kind: 'worktree-preparation',
        toolName: 'prepare_worktree',
        directory: 'packages/app',
        planFingerprint: current,
        offline: true,
      },
    ])
    assert.equal(existsSync(join(nested, 'executed.txt')), false)
    assert.equal(existsSync(join(nested, 'node_modules')), false)
  })
})

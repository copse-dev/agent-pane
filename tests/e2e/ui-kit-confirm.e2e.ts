import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-ui-kit-confirm'

interface ConfirmPaint {
  background: string
  color: string
  accentFill: string
  danger: string
  textOnDanger: string
  confirmGeometry: string
  cancelGeometry: string
}

/** Computed paint of the open confirm dialog's buttons, with the tokens resolved to rgb(). */
async function readConfirmPaint(): Promise<ConfirmPaint | null> {
  return browser.execute(() => {
    const confirm = document.querySelector<HTMLElement>('#confirm-dialog .confirm-dialog-confirm')
    const cancel = document.querySelector<HTMLElement>('#confirm-dialog .confirm-dialog-cancel')
    if (!confirm || !cancel) return null
    // Resolve a token the way the cascade does, via a probe in the same scope.
    const resolve = (token: string): string => {
      const probe = document.createElement('span')
      probe.style.color = `var(${token})`
      confirm.parentElement?.append(probe)
      const value = getComputedStyle(probe).color
      probe.remove()
      return value
    }
    const geometry = (button: HTMLElement): string => {
      const style = getComputedStyle(button)
      return [
        button.getBoundingClientRect().height,
        style.borderRadius,
        style.paddingTop,
        style.paddingInline,
        style.fontSize,
        style.fontWeight,
      ].join(' ')
    }
    const style = getComputedStyle(confirm)
    return {
      background: style.backgroundColor,
      color: style.color,
      accentFill: resolve('--accent-fill'),
      danger: resolve('--danger'),
      textOnDanger: resolve('--text-on-danger'),
      confirmGeometry: geometry(confirm),
      cancelGeometry: geometry(cancel),
    }
  })
}

function contrast(a: string, b: string): number {
  const luminance = (rgb: string): number => {
    const channels = (rgb.match(/\d+(?:\.\d+)?/g) ?? []).slice(0, 3).map(Number)
    assert.equal(channels.length, 3, `expected an rgb() colour, got ${rgb}`)
    const [r = 0, g = 0, b = 0] = channels.map((value) => {
      const srgb = value / 255
      return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Danger confirms keep the danger fill and a readable label, never the accent (#3065). */
async function assertDangerConfirmPaint(theme: string): Promise<void> {
  const paint = await readConfirmPaint()
  assert.ok(paint, 'missing confirm dialog buttons')
  assert.notEqual(paint.background, paint.accentFill, `${theme}: danger confirm painted accent`)
  assert.equal(paint.background, paint.danger, `${theme}: danger confirm fill`)
  assert.equal(paint.color, paint.textOnDanger, `${theme}: danger confirm label`)
  const ratio = contrast(paint.color, paint.background)
  assert.ok(ratio >= 4.5, `${theme}: label contrast ${ratio.toFixed(2)}:1`)
  // Same shared pill geometry as the Cancel action beside it.
  assert.equal(paint.confirmGeometry, paint.cancelGeometry, `${theme}: confirm geometry`)

  // `.ui-btn:hover` must not swap the danger fill for --bg-hover.
  await $('#confirm-dialog .confirm-dialog-confirm').moveTo()
  const hovered = await readConfirmPaint()
  assert.equal(hovered?.background, paint.danger, `${theme}: hovered danger confirm fill`)
  await $('#confirm-dialog .confirm-dialog-message').moveTo()
}

async function openDeleteThreadConfirm(): Promise<void> {
  // Dispatch in-page (same pattern as file-search-palette): Electron may
  // swallow a real Ctrl/Cmd+W before the renderer shortcut handler runs.
  await browser.execute(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'w', metaKey: true, ctrlKey: true, bubbles: true }),
    )
  })
  await $('#confirm-dialog').waitForDisplayed({ timeout: 10_000 })
}

async function switchTheme(theme: 'light' | 'dark'): Promise<void> {
  await $('[aria-label="Settings"]').click()
  await $('.settings-nav-btn[data-section="appearance"]').click()
  await $('select[name="theme"]').waitForDisplayed({ timeout: 30_000 })
  await browser.execute((next) => {
    const select = document.querySelector<HTMLSelectElement>('select[name="theme"]')
    if (!select) return
    select.value = next
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }, theme)
  await $('.settings-buttons button[type="submit"]').click()
  await $('#settings-dialog').waitForDisplayed({ reverse: true, timeout: 30_000 })
  await browser.waitUntil(
    async () =>
      browser.execute((next) => document.documentElement.dataset['theme'] === next, theme),
    { timeout: 10_000, timeoutMsg: `expected the ${theme} theme to apply` },
  )
}

/**
 * Visual eval for the first UI-kit slice: confirm dialog buttons/actions use
 * `.ui-btn*` + `<copse-ui-actions>` instead of screen-local button CSS.
 */
describe('UI kit confirm dialog', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: 'thread-b',
      [`threads:${PROJECT_ID}`]: [
        {
          id: 'thread-a',
          title: 'Keep me',
          status: 'idle',
          messages: [
            {
              id: 'msg-a',
              role: 'user',
              content: 'Stay around.',
              toolCalls: [],
              createdAt: now,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'thread-b',
          title: 'Delete candidate',
          status: 'idle',
          messages: [
            {
              id: 'msg-b',
              role: 'user',
              content: 'Candidate for delete.',
              toolCalls: [],
              createdAt: now + 1,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now + 1,
          updatedAt: now + 1,
        },
      ],
    })
    seedE2eViewport()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
    await expect($('.chat-row.selected .chat-title')).toHaveText('Delete candidate')
  })

  after(() => {
    resetUserData()
  })

  it('renders kit buttons in the confirm dialog', async function () {
    this.timeout(60_000)

    await browser.waitUntil(async () => (await $$('.chats-list .chat-row')).length >= 2, {
      timeout: 15_000,
      timeoutMsg: 'expected two seeded chat rows',
    })

    await openDeleteThreadConfirm()
    const dialog = await $('#confirm-dialog')
    await expect(await dialog.$('.confirm-dialog-message')).toHaveText('Delete this thread?')
    await expect(await dialog.$('copse-ui-actions.ui-actions')).toExist()
    await expect(await dialog.$('button.ui-btn.ui-btn-secondary.confirm-dialog-cancel')).toHaveText(
      'Cancel',
    )
    await expect(await dialog.$('button.ui-btn.ui-btn-danger.confirm-dialog-confirm')).toHaveText(
      'Delete',
    )

    const capBoxStyle = await browser.execute(() => {
      const button = document.querySelector<HTMLElement>('.confirm-dialog-cancel')
      if (!button) return null
      const style = getComputedStyle(button)
      return {
        trim: style.getPropertyValue('text-box-trim'),
        edge: style.getPropertyValue('text-box-edge'),
        alignContent: style.alignContent,
      }
    })
    assert.deepEqual(capBoxStyle, {
      trim: 'trim-both',
      edge: 'cap alphabetic',
      alignContent: 'center',
    })

    await assertDangerConfirmPaint('dark')
    await saveElementScreenshot('#confirm-dialog', 'ui-kit-confirm-dialog.png')

    await dialog.$('.confirm-dialog-cancel').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
  })

  it('keeps the danger fill and a readable label in the light theme', async function () {
    this.timeout(90_000)
    await switchTheme('light')
    await openDeleteThreadConfirm()
    await expect($('#confirm-dialog .confirm-dialog-message')).toHaveText('Delete this thread?')
    await assertDangerConfirmPaint('light')
    await saveElementScreenshot('#confirm-dialog', 'ui-kit-confirm-dialog-light.png')

    await $('#confirm-dialog .confirm-dialog-cancel').click()
    await $('#confirm-dialog').waitForDisplayed({ reverse: true, timeout: 10_000 })
  })
})

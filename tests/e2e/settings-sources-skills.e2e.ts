import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-settings-sources-skills'
const SKILL_NAME = 'origin-hover-skill'
const SKILL_DESC = 'E2E skill used to prove Sources hover shows the on-disk path.'

describe('settings sources skills origin hover', () => {
  let workspaceRoot = ''
  let skillPath = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-e2e-sources-skills-'))
    const skillDir = join(workspaceRoot, '.cursor', 'skills', SKILL_NAME)
    mkdirSync(skillDir, { recursive: true })
    skillPath = join(skillDir, 'SKILL.md')
    writeFileSync(
      skillPath,
      `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESC}\n---\n\n# Origin hover\n`,
      'utf8',
    )

    seedEmptyProject(workspaceRoot, PROJECT_ID)
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('lists skills with source badge and reveals path on hover', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="customise"]').click()

    const sources = dialog.$('.settings-section[data-section="customise"]')
    await expect(sources).toBeDisplayed()
    await expect(sources.$('legend=Skills')).toBeDisplayed()

    const skillsList = sources.$('#sources-skills-list')
    await browser.waitUntil(async () => (await skillsList.getText()).includes(SKILL_NAME), {
      timeout: 15_000,
      timeoutMsg: `expected ${SKILL_NAME} in Sources → Skills`,
    })

    const rowInfo = await browser.execute((name: string) => {
      const list = document.querySelector('#sources-skills-list')
      for (const row of list?.querySelectorAll<HTMLElement>('.sources-row') ?? []) {
        const title = row.querySelector('.sources-row-title')?.textContent
        if (title !== name) continue
        const header = row.querySelector('.sources-row-header')
        const hover = row.querySelector<HTMLElement>('.sources-row-hover-detail')
        return {
          badge: row.querySelector('.sources-badge')?.textContent ?? '',
          detail: row.querySelector('.sources-row-detail')?.textContent ?? '',
          titleAttr: row.title,
          hoverPath: hover?.textContent ?? '',
          hoverDisplay: hover ? getComputedStyle(hover).display : 'missing',
          hoverInHeader: Boolean(header && hover && header.contains(hover)),
          hoverInPrimary: Boolean(
            row.querySelector('.sources-row-primary')?.contains(hover ?? null),
          ),
          restingHeight: row.getBoundingClientRect().height,
        }
      }
      return null
    }, SKILL_NAME)

    assert.ok(rowInfo, `row for ${SKILL_NAME}`)
    assert.equal(rowInfo.badge, 'project')
    assert.equal(rowInfo.detail, SKILL_DESC)
    assert.equal(rowInfo.titleAttr, skillPath)
    assert.equal(rowInfo.hoverPath, skillPath)
    assert.equal(rowInfo.hoverDisplay, 'none', 'path stays hidden until hover')
    assert.equal(rowInfo.hoverInHeader, true, 'path lives in the header gutter')
    assert.equal(rowInfo.hoverInPrimary, true, 'path lives in the primary title slot')

    // Resting list: path chrome stays out of the way.
    await browser.execute((name: string) => {
      const list = document.querySelector('#sources-skills-list')
      for (const row of list?.querySelectorAll<HTMLElement>('.sources-row') ?? []) {
        if (row.querySelector('.sources-row-title')?.textContent !== name) continue
        row.setAttribute('data-e2e-skill-origin', 'resting')
        row.scrollIntoView({ block: 'center' })
        return
      }
    }, SKILL_NAME)
    await browser.pause(100)
    await saveElementScreenshot(
      '#sources-skills-list .sources-row[data-e2e-skill-origin="resting"]',
      'settings-sources-skills-origin-resting.png',
    )

    // Hover: reveal the on-disk path in the title→badge gutter (same row height).
    // Use a long synthetic path so intrinsic min-content would blow the column
    // without the primary-slot containment.
    await browser.execute(
      (name: string, longPath: string) => {
        const list = document.querySelector('#sources-skills-list')
        for (const row of list?.querySelectorAll<HTMLElement>('.sources-row') ?? []) {
          if (row.querySelector('.sources-row-title')?.textContent !== name) continue
          row.removeAttribute('data-e2e-skill-origin')
          row.setAttribute('data-e2e-skill-origin', 'hover')
          row.classList.add('sources-row-hover-force')
          const hover = row.querySelector<HTMLElement>('.sources-row-hover-detail')
          const bdi = hover?.querySelector('bdi')
          if (bdi) bdi.textContent = longPath
          if (hover && !hover.querySelector('bdi')) hover.textContent = longPath
          const style = document.createElement('style')
          style.textContent = `
          .sources-row-hover-force .sources-row-hover-detail { display: block !important; }
          .sources-row-hover-force .sources-row-title {
            flex: 0 1 auto;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            word-break: normal;
          }
        `
          document.head.append(style)
          row.scrollIntoView({ block: 'center' })
          return
        }
      },
      SKILL_NAME,
      '/Users/jonathankingston/.cursor/plugins/cache/cursor-public/long-plugin-id-aaaaaaaa/skills/ai-writing-signs-report/SKILL.md',
    )

    const hoverMetrics = await browser.execute((name: string) => {
      const list = document.querySelector('#sources-skills-list')
      for (const row of list?.querySelectorAll<HTMLElement>('.sources-row') ?? []) {
        if (row.querySelector('.sources-row-title')?.textContent !== name) continue
        const hover = row.querySelector<HTMLElement>('.sources-row-hover-detail')
        if (!hover) return null
        const style = getComputedStyle(hover)
        return {
          display: style.display,
          height: row.getBoundingClientRect().height,
          truncated: hover.scrollWidth > hover.clientWidth + 1,
          overflow: style.overflow,
          textOverflow: style.textOverflow,
          direction: style.direction,
          rowOverflows: row.scrollWidth > row.clientWidth + 1,
          width: style.width,
        }
      }
      return null
    }, SKILL_NAME)
    assert.ok(hoverMetrics)
    assert.equal(hoverMetrics.display, 'block')
    assert.equal(
      Math.round(hoverMetrics.height),
      Math.round(rowInfo.restingHeight),
      'hover must not grow the row',
    )
    assert.equal(hoverMetrics.overflow, 'hidden')
    assert.equal(hoverMetrics.textOverflow, 'ellipsis')
    assert.equal(hoverMetrics.direction, 'rtl', 'left-elide long paths')
    assert.equal(hoverMetrics.rowOverflows, false, 'long path must not widen the row')
    assert.equal(hoverMetrics.truncated, true, 'long path ellipsizes in the primary gutter')

    // Also prove truncation under an explicitly tight width (reference shot).
    const truncatedTight = await browser.execute(() => {
      const row = document.querySelector<HTMLElement>(
        '#sources-skills-list .sources-row[data-e2e-skill-origin="hover"]',
      )
      const hover = row?.querySelector<HTMLElement>('.sources-row-hover-detail')
      if (!row || !hover) return false
      row.style.maxWidth = '420px'
      return hover.scrollWidth > hover.clientWidth + 1 && row.scrollWidth <= row.clientWidth + 1
    })
    assert.equal(truncatedTight, true, 'path ellipsizes when the header gutter is tight')

    await browser.pause(100)
    await saveElementScreenshot(
      '#sources-skills-list .sources-row[data-e2e-skill-origin="hover"]',
      'settings-sources-skills-origin-hover.png',
    )
  })
})

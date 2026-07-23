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
    await dialog.$('button[data-section="sources"]').click()

    const sources = dialog.$('.settings-section[data-section="sources"]')
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
        const hover = row.querySelector<HTMLElement>('.sources-row-hover-detail')
        return {
          badge: row.querySelector('.sources-badge')?.textContent ?? '',
          detail: row.querySelector('.sources-row-detail')?.textContent ?? '',
          titleAttr: row.title,
          hoverPath: hover?.textContent ?? '',
          hoverDisplay: hover ? getComputedStyle(hover).display : 'missing',
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

    // Hover: reveal the on-disk path under the description.
    await browser.execute((name: string) => {
      const list = document.querySelector('#sources-skills-list')
      for (const row of list?.querySelectorAll<HTMLElement>('.sources-row') ?? []) {
        if (row.querySelector('.sources-row-title')?.textContent !== name) continue
        row.removeAttribute('data-e2e-skill-origin')
        row.setAttribute('data-e2e-skill-origin', 'hover')
        row.classList.add('sources-row-hover-force')
        const style = document.createElement('style')
        style.textContent =
          '.sources-row-hover-force .sources-row-hover-detail { display: block !important; }'
        document.head.append(style)
        row.scrollIntoView({ block: 'center' })
        return
      }
    }, SKILL_NAME)

    const hoverVisible = await browser.execute((name: string) => {
      const list = document.querySelector('#sources-skills-list')
      for (const row of list?.querySelectorAll<HTMLElement>('.sources-row') ?? []) {
        if (row.querySelector('.sources-row-title')?.textContent !== name) continue
        const hover = row.querySelector<HTMLElement>('.sources-row-hover-detail')
        return hover ? getComputedStyle(hover).display : 'missing'
      }
      return 'missing'
    }, SKILL_NAME)
    assert.equal(hoverVisible, 'block')

    await browser.pause(100)
    await saveElementScreenshot(
      '#sources-skills-list .sources-row[data-e2e-skill-origin="hover"]',
      'settings-sources-skills-origin-hover.png',
    )
  })
})

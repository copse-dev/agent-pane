import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedJobDescriptionMetadataFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('markdown job description metadata', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedJobDescriptionMetadataFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders JD metadata lines as prose, not a false-positive table', async () => {
    await $('.messages-list').waitForExist({ timeout: 30_000 })
    await $('.message-text').waitForExist({ timeout: 30_000 })

    const result = await browser.execute(() => {
      const textEl = document.querySelector('.message-text')
      if (!textEl) return { error: 'no message text' }
      const text = textEl.textContent ?? ''
      const metadataTables = textEl.querySelectorAll('table')
      const benefitsTable = [...metadataTables].find((table) =>
        (table.textContent ?? '').includes('Category'),
      )
      const falsePositiveTable = [...metadataTables].find((table) =>
        (table.textContent ?? '').includes('Department'),
      )
      return {
        text,
        tableCount: metadataTables.length,
        hasDepartment: text.includes('Department'),
        hasEmploymentType: text.includes('Employment Type'),
        hasSalary: text.includes('$160,000'),
        hasBenefitsTable: benefitsTable !== undefined,
        hasMetadataTable: falsePositiveTable !== undefined,
      }
    })

    expect(result).not.toHaveProperty('error')
    expect(result.hasDepartment).toBe(true)
    expect(result.hasEmploymentType).toBe(true)
    expect(result.hasSalary).toBe(true)
    expect(result.tableCount).toBe(1)
    expect(result.hasBenefitsTable).toBe(true)
    expect(result.hasMetadataTable).toBe(false)

    await saveAppScreenshot('markdown-jd-metadata.png')
  })
})

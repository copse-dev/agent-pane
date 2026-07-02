import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedE2eViewport,
  seedMarkdownWorkspaceLinkFixture,
} from './helpers/seed-config.ts'

describe('markdown workspace links', () => {
  before(async () => {
    resetUserData()
    seedE2eViewport()
    seedMarkdownWorkspaceLinkFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders root-relative markdown links and opens the file on click', async () => {
    const link = await $('.message-text a[data-workspace-link]')
    await link.waitForExist({ timeout: 30_000 })
    await expect(link).toHaveAttribute('href', '/docs/type-safety.md')
    await expect(link).toHaveAttribute('class', expect.stringContaining('workspace-markdown-link'))
    await expect(link).toHaveText('Type safety guide')

    await saveAppScreenshot('markdown-workspace-links.png')

    await link.click()
    const fileRow = await $('.file-tree .tree-row[title="docs/type-safety.md"]')
    await fileRow.waitForDisplayed({ timeout: 20_000 })

    await assertNoErrorToasts('markdown workspace link click')
  })
})

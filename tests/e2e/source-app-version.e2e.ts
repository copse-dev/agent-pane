import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const optionsSchema = z.object({
  applicationName: z.string(),
  applicationVersion: z.string(),
  version: z.string(),
  iconPath: z.string(),
})

describe('source-build Copse identity', () => {
  let directory = ''
  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'copse-about-options-'))
    writeE2eEnv({ COPSE_E2E_ABOUT_OPTIONS: join(directory, 'options.json') })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-source-app-version')
    await browser.reloadSession()
  })
  after(() => {
    writeE2eEnv({ COPSE_E2E_ABOUT_OPTIONS: undefined })
    resetUserData()
    rmSync(directory, { recursive: true, force: true })
  })

  it('uses the package version in native About options and the real Settings/license IPC', async () => {
    const metadata = safeJsonParse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
      decodeWithSchema(z.object({ version: z.string() })),
    )
    assert.ok(metadata)
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="about"]').click()
    await expect($('.about-version')).toHaveText(metadata.version)
    await browser.waitUntil(
      async () => (await $('.about-licenses-status').getText()).includes('components'),
      {
        timeout: 15_000,
      },
    )
    const options = safeJsonParse(
      readFileSync(join(directory, 'options.json'), 'utf8'),
      decodeWithSchema(optionsSchema),
    )
    assert.ok(options)
    assert.equal(options.applicationName, 'Copse')
    assert.equal(options.applicationVersion, metadata.version)
    assert.match(options.version, /^[0-9a-f]{7}$/)
    assert.equal(existsSync(options.iconPath), true)
    await saveElementScreenshot('.about-copse', 'source-app-version.png')
  })
})

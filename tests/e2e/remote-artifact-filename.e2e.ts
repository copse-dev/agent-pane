import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { formatRemoteArtifactsSummary } from '../../src/main/services/remote/remote-agent-client.ts'
import { resetUserData, seedRemoteArtifactFilenameFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const ARTIFACT_PATH = 'artifacts/report` [Injected](https://evil.example).txt'

describe('remote artifact filename markdown', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedRemoteArtifactFilenameFixture(
      process.cwd(),
      formatRemoteArtifactsSummary({
        agentId: 'bc-e2e-artifact-filename',
        baseUrl: 'https://api.cursor.com',
        artifacts: [{ path: ARTIFACT_PATH, sizeBytes: 4096 }],
      }),
    )
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders a backtick and link-shaped text as one code span', async () => {
    const message = $('.msg-assistant .message-text')
    await message.waitForDisplayed({ timeout: 30_000 })

    const code = message.$('code')
    await code.waitForDisplayed()
    assert.equal(await code.getText(), ARTIFACT_PATH)
    await expect(message.$$('a')).toBeElementsArrayOfSize(1)
    await expect(message.$('a')).toHaveText('Open')
    assert.equal(await message.$('a*=Injected').isExisting(), false)

    await saveAppScreenshot('remote-artifact-backtick-filename.png')
  })
})

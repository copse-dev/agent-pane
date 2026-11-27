import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { installMockScenario, expectAssistantReply } from './helpers/mock-scenario.ts'
import { setComposerValue } from './helpers/composer.ts'

describe('external file attachments', () => {
  const externalDir = mkdtempSync(join(tmpdir(), 'copse-external-attachment-'))
  const filePath = join(externalDir, 'artwork.ai')

  before(async () => {
    writeFileSync(filePath, 'EXTERNAL-ARTWORK-FIXTURE')
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-external-attachment')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(externalDir, { recursive: true, force: true })
  })

  it('attaches the selected external file and delivers its contents to the agent', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.attach-file-input').setValue(filePath)
    await expect($('.attachment-chip-label')).toHaveText('artwork.ai')
    await saveAppScreenshot('external-file-attachment.png')

    await installMockScenario({
      title: 'Read selected external file',
      turns: [
        {
          user: { includes: 'EXTERNAL-ARTWORK-FIXTURE' },
          responses: [{ text: 'The selected artwork reached the agent.' }],
        },
      ],
    })
    await setComposerValue('Read the selected file.')
    await $('.submit-btn').click()
    await expectAssistantReply('The selected artwork reached the agent.')
  })
})

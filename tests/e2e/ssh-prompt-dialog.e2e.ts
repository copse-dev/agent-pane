import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-ssh-prompt-project'

type SshPromptKind = 'confirm' | 'secret'

async function requestPrompt(prompt: string, kind: SshPromptKind): Promise<void> {
  await browser.execute(
    (requestPromptText: string, requestKind: SshPromptKind) => {
      const bridge = (
        window as unknown as {
          __copseE2e?: {
            requestSshPrompt: (text: string, promptKind: SshPromptKind) => Promise<unknown>
          }
        }
      ).__copseE2e
      if (!bridge?.requestSshPrompt) throw new Error('__copseE2e.requestSshPrompt unavailable')
      void bridge.requestSshPrompt(requestPromptText, requestKind)
    },
    prompt,
    kind,
  )
}

describe('SSH prompt dialog', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID)
    seedE2eViewport()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('renders authentication prompts and treats Escape as cancellation', async function () {
    this.timeout(60_000)

    await requestPrompt("Enter passphrase for key '/Users/test/.ssh/id_ed25519':", 'secret')
    const dialog = await $('#ssh-prompt-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect(await dialog.$('.ssh-prompt-title')).toHaveText('SSH authentication')
    await expect(await dialog.$('.ssh-prompt-body')).toHaveText(
      expect.stringContaining('id_ed25519'),
    )
    await expect(await dialog.$('.ssh-prompt-input')).toHaveAttribute('type', 'password')
    await saveElementScreenshot('#ssh-prompt-dialog', 'ssh-prompt-secret.png')

    await browser.keys(['Escape'])
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })

    // If Escape only closes the native dialog without resolving the active
    // request, this second prompt remains queued forever.
    await requestPrompt(
      'The authenticity of host github.com cannot be established. Continue connecting?',
      'confirm',
    )
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect(await dialog.$('.ssh-prompt-body')).toHaveText(
      expect.stringContaining('authenticity of host github.com'),
    )
    await expect(await dialog.$('.ssh-prompt-secret-field')).not.toBeDisplayed()
    await expect(await dialog.$('.ssh-prompt-submit')).toHaveText('Continue')
    await saveElementScreenshot('#ssh-prompt-dialog', 'ssh-prompt-host-key.png')

    await dialog.$('.ssh-prompt-cancel').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
  })
})

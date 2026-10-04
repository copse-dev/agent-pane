import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-ssh-prompt-project'

type SshPromptKind = 'confirm' | 'secret'

async function requestPrompt(prompt: string, kind: SshPromptKind): Promise<void> {
  await browser.execute(
    (requestPromptText: string, requestKind: SshPromptKind) => {
      const bridge = window.__copseE2e
      if (!bridge) throw new Error('__copseE2e.requestSshPrompt unavailable')
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
    const dialog = await $('#ssh-prompt-dialog').getElement()
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect(await dialog.$('.ssh-prompt-title').getElement()).toHaveText('SSH authentication')
    await expect(await dialog.$('.ssh-prompt-body').getElement()).toHaveText(
      expect.stringContaining('id_ed25519'),
    )
    await expect(await dialog.$('.ssh-prompt-input').getElement()).toHaveAttribute(
      'type',
      'password',
    )
    const secretInput = await dialog.$('.ssh-prompt-input').getElement()
    await secretInput.setValue('hunter2')
    const mask = await secretInput.getCSSProperty('-webkit-text-security')
    expect(mask.value).toBe('disc')
    const fontSize = Number.parseFloat((await secretInput.getCSSProperty('font-size')).value ?? '')
    expect(fontSize).toBeGreaterThanOrEqual(16)
    // Session caching is opt-out, so the box is offered and pre-selected.
    await expect(await dialog.$('.ssh-prompt-remember').getElement()).toBeDisplayed()
    await expect(await dialog.$('.ssh-prompt-remember-input').getElement()).toBeSelected()
    await expect(await dialog.$('.ssh-prompt-remember-label').getElement()).toHaveText(
      'Remember for this session',
    )
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
    await expect(await dialog.$('.ssh-prompt-body').getElement()).toHaveText(
      expect.stringContaining('authenticity of host github.com'),
    )
    await expect(await dialog.$('.ssh-prompt-secret-field').getElement()).not.toBeDisplayed()
    // Host-key trust is recorded in known_hosts by OpenSSH — nothing to remember.
    await expect(await dialog.$('.ssh-prompt-remember').getElement()).not.toBeDisplayed()
    await expect(await dialog.$('.ssh-prompt-submit').getElement()).toHaveText('Continue')
    await saveElementScreenshot('#ssh-prompt-dialog', 'ssh-prompt-host-key.png')

    await dialog.$('.ssh-prompt-cancel').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
  })
})

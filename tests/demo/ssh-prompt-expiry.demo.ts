import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// Inject only the preload boundary; the real renderer owns queueing and modality.
describe('SSH prompt expiry', () => {
  it('removes an expired top-layer prompt and makes the composer usable', async () => {
    const script: unknown = await browser.sendCommandAndGetResult(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `Object.defineProperty(window, 'api', {
          configurable: true,
          set(api) {
            api.sshPrompt.onRequest = handler => {
              window.addEventListener('fixture-ssh-request', event => handler(event.detail));
              return () => {};
            };
            api.sshPrompt.onDismissed = handler => {
              window.addEventListener('fixture-ssh-dismissed', event => handler(event.detail));
              return () => {};
            };
            Object.defineProperty(window, 'api', { value: api, configurable: true });
          }
        })`,
      },
    )
    if (
      !script ||
      typeof script !== 'object' ||
      !('identifier' in script) ||
      typeof script.identifier !== 'string'
    ) {
      throw new Error('missing injected boundary script identifier')
    }
    try {
      await browser.url('/?scenario=footer-compact')
      await $('.prompt-input').waitForExist()
      await browser.execute(() => {
        window.dispatchEvent(
          new CustomEvent('fixture-ssh-request', {
            detail: {
              id: 'expired-connection',
              prompt: 'Passphrase for isolated workflow connection:',
              kind: 'secret',
              canRememberOnDevice: false,
            },
          }),
        )
      })
      await expect($('#ssh-prompt-dialog')).toBeDisplayed()
      await expect($('.ssh-prompt-input')).toBeFocused()
      await browser.execute(() => {
        window.dispatchEvent(
          new CustomEvent('fixture-ssh-dismissed', { detail: 'expired-connection' }),
        )
      })
      await expect($('#ssh-prompt-dialog')).not.toBeDisplayed()
      await $('.prompt-input').click()
      await $('.prompt-input').setValue('Continue reviewing main without changing files.')
      await expect($('.prompt-input')).toBeFocused()
      await expect($('.prompt-input')).toHaveText('Continue reviewing main without changing files.')
      await saveAppScreenshot('ssh-prompt-expired-composer-usable.png')
    } finally {
      await browser.sendCommand('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: script.identifier,
      })
    }
  })
})

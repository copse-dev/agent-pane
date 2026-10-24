import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('classifier settings with unavailable permission catalog', () => {
  it('loads saved connections and routes while disabling the unavailable permission control', async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    // Inject at the demo API boundary; product settings and permission policy are unchanged.
    await browser.execute(() => {
      window.api.classifiers.list = async (): ReturnType<typeof window.api.classifiers.list> => [
        {
          profile: {
            id: 'saved-classifier',
            label: 'Saved classifier',
            model: 'fixture-v1',
            timeoutMs: 30_000,
            connection: {
              type: 'http',
              protocol: 'systemone',
              baseUrl: 'https://classifier.example/v1',
              auth: 'bearer',
            },
          },
          hasKey: false,
          encrypted: null,
        },
      ]
      window.api.classifiers.screening = async (): ReturnType<
        typeof window.api.classifiers.screening
      > => 'saved-classifier'
      window.api.classifiers.background = async (): ReturnType<
        typeof window.api.classifiers.background
      > => 'saved-classifier'
      window.api.toolPermissions.list = async (): Promise<never> => {
        throw new Error('Permission catalog unavailable')
      }
    })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="classifiers"]').click()
    await expect($('[name="classifierScreening"]')).toHaveValue('saved-classifier')
    await expect($('[name="classifierBackground"]')).toHaveValue('saved-classifier')
    await expect($('[name="classifierToolPrompt"]')).toBeDisabled()
    await expect($('.classifier-status')).toHaveText(
      expect.stringContaining('Permission catalog unavailable'),
    )
    await saveElementScreenshot('#settings-dialog', 'settings-classifier-permission-failure.png')
    await $('.classifier-status').scrollIntoView({ block: 'center' })
    await expect($('.classifier-status')).toBeDisplayed()
    await saveElementScreenshot(
      '#settings-dialog',
      'settings-classifier-permission-failure-detail.png',
    )
  })
})

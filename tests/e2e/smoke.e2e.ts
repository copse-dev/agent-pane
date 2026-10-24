import { $, expect } from '@wdio/globals'

describe('smoke', () => {
  it('app opens and shows layout landmarks', async () => {
    const app = await $('#app').getElement()
    await app.waitForExist({ timeout: 30_000 })
    await expect(app).toBeDisplayed()
  })
})

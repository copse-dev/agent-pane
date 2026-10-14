import assert from 'node:assert/strict'
import { it } from 'node:test'
import { confirmMobileControl } from './mobile-control-confirmation.ts'

it('requires both native confirmation and the local-root trust acknowledgement', async () => {
  for (const response of [0, 1]) {
    for (const checkboxChecked of [false, true]) {
      const granted = await confirmMobileControl(
        async (options) => {
          assert.equal(options.defaultId, 0)
          assert.equal(options.cancelId, 0)
          assert.equal(options.checkboxChecked, false)
          assert.deepEqual(options.buttons, ['Cancel', 'Allow control'])
          assert.match(options.message, /My phone/)
          assert.match(options.detail ?? '', /Pairing code: 123456/)
          return { response, checkboxChecked }
        },
        'My phone',
        '123456',
      )
      assert.equal(granted, response === 1 && checkboxChecked)
    }
  }
})

it('never treats a failed native confirmation as a grant', async () => {
  await assert.rejects(
    confirmMobileControl(async () => {
      throw new Error('Window closed')
    }, 'My phone'),
    /Window closed/,
  )
})

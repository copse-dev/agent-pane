import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

const REMOVED = '11111111-2222-4333-8444-555555555555'
const RETAINED = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

// Inject host inventory and status events at the existing renderer API boundary.
// The real deletion/approval contracts are covered by native service tests.
describe('verified simulator removal', () => {
  before(async () => {
    await browser.url('/?scenario=vnc-discovered-ports')
    await browser.execute(
      (removed, retained) => {
        let deleted = false
        window.api.simulatorDesktop.list = async (): Promise<
          { udid: string; name: string; runtime: string }[]
        > => [
          ...(deleted ? [] : [{ udid: removed, name: 'Disposable phone', runtime: 'iOS 26.5' }]),
          { udid: retained, name: 'Retained phone', runtime: 'iOS 26.5' },
        ]
        window.api.simulatorDesktop.onStatus = (listener): (() => void) => {
          const closed = (): void => {
            listener({ id: 'retired-stream', status: 'closed' })
          }
          const verifiedRemoval = (): void => {
            deleted = true
            listener({ id: 'retired-stream', status: 'closed', detail: 'Simulator deleted' })
          }
          document.addEventListener('fixture:simulator-closed', closed)
          document.addEventListener('fixture:simulator-removed', verifiedRemoval)
          return (): void => {
            document.removeEventListener('fixture:simulator-closed', closed)
            document.removeEventListener('fixture:simulator-removed', verifiedRemoval)
          }
        }
      },
      REMOVED,
      RETAINED,
    )
    await $('[data-panel-control="vnc"]').waitForDisplayed({ timeout: 20_000 })
    await $('[data-panel-control="vnc"]').click()
  })

  it('keeps ordinary disconnections listed and refreshes only after verified removal', async () => {
    const removed = $(`.vnc-device-header[data-machine="simulator:${REMOVED}"]`)
    const retained = $(`.vnc-device-header[data-machine="simulator:${RETAINED}"]`)
    await removed.waitForDisplayed({ timeout: 20_000 })
    await retained.waitForDisplayed({ timeout: 20_000 })
    await browser.execute(() => document.dispatchEvent(new Event('fixture:simulator-closed')))
    await expect(removed).toBeDisplayed()
    await browser.execute(() => document.dispatchEvent(new Event('fixture:simulator-removed')))
    await removed.waitForExist({ reverse: true, timeout: 10_000 })
    await expect(retained).toBeDisplayed()
    await saveAppScreenshot('simulator-verified-removal.png')
  })
})

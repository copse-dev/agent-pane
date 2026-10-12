import { browser } from '@wdio/globals'

/** Freeze the fixture and Activity age clock before page modules initialize. */
export async function pinDemoClock(): Promise<void> {
  await browser.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source: 'Date.now = () => Date.UTC(2026, 6, 17, 9, 0, 0)',
  })
}

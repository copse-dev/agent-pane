import { browser } from '@wdio/globals'

/** Anchor Activity ages to a fixed date while preserving elapsed-time behavior. */
export async function pinDemoClock(): Promise<void> {
  await browser.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source:
      '(() => { const start = performance.now(); Date.now = () => Date.UTC(2026, 6, 17, 9, 0, 0) + Math.floor(performance.now() - start); })()',
  })
}

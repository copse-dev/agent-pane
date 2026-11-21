import { $, browser, expect } from '@wdio/globals'

describe('IPC size guard', () => {
  it('refuses an oversized call and leaves the window running (#4445)', async () => {
    const app = await $('#app').getElement()
    await app.waitForExist({ timeout: 30_000 })

    const outcome = await browser.execute(async () => {
      // A reload would lose this, so it shows the same page survived the call.
      document.documentElement.dataset['ipcSizeGuardProbe'] = 'kept'
      // `repeat` builds a rope: 2 GB of arguments by length, a few bytes in
      // memory. The preload refuses on the lengths before anything copies them.
      // Unguarded, serializing this call aborts the renderer process.
      const text = 'x'.repeat(402_653_185)
      try {
        await window.api.agent.suggestCommandSummary(Array.from({ length: 5 }, () => text))
        return 'sent'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
    expect(outcome).toContain('Too large to send in one request')
    expect(outcome).toContain('(agent:suggest-command-summary)')

    const probe = await browser.execute(() => document.documentElement.dataset['ipcSizeGuardProbe'])
    expect(probe).toBe('kept')
    await expect(app).toBeDisplayed()
  })
})

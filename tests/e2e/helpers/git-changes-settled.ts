import { browser } from '@wdio/globals'

/** Wait through the debounced watcher refresh, not only the first list paint. */
export async function waitForGitChangesSettled(): Promise<void> {
  let settledSince = 0
  await browser.waitUntil(
    async () => {
      const settled = await browser.execute(() => {
        const host = document.getElementById('git-changes-host')
        return Boolean(host && !host.querySelector('.pane-loading'))
      })
      if (!settled) {
        settledSince = 0
        return false
      }
      settledSince ||= Date.now()
      return Date.now() - settledSince >= 750
    },
    {
      timeout: 15_000,
      timeoutMsg: 'expected Changes to finish its watcher refresh before capture',
    },
  )
}

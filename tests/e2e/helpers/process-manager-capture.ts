import { browser } from '@wdio/globals'

const MASK_STYLE_ID = 'e2e-process-manager-mask'

/**
 * Hide the Process Manager's live readings so a capture is the same on every
 * run. PIDs, CPU %, memory and the "Updated" clock all come from the host
 * sample and change each time (~0.1-0.25% of the shot), which kept these
 * references showing up as candidates on unrelated PRs. A stylesheet rather
 * than a text rewrite: the dialog re-renders on every sample and would
 * overwrite edited cells. `color: transparent` keeps the column widths.
 */
export async function maskProcessManagerLiveValues(): Promise<void> {
  await browser.execute((id) => {
    if (document.getElementById(id)) return
    const style = document.createElement('style')
    style.id = id
    style.textContent =
      '#process-manager-dialog .process-manager-number,' +
      '#process-manager-dialog .process-manager-pid,' +
      '#process-manager-dialog .process-manager-summary,' +
      '#process-manager-dialog .process-manager-updated{color:transparent!important}'
    document.head.append(style)
  }, MASK_STYLE_ID)
}

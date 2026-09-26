import assert from 'node:assert/strict'
import { browser } from '@wdio/globals'

/** Whether a (single-line) element shows all of its text, and where it sits. */
export interface TextFit {
  text: string
  /** Its content is wider than its box, so it is ellipsized or clipped. */
  truncated: boolean
  /** Its `text-overflow` is `ellipsis`, so a truncation shows the `…`. */
  ellipsis: boolean
  left: number
  right: number
  width: number
}

/**
 * Measure the first element matching `selector`. `scrollWidth` is the text's
 * natural width in whole pixels and `clientWidth` the box, so a truncated
 * label reads `scrollWidth > clientWidth` whether it ellipsizes or just clips.
 * Returns null when nothing matches.
 */
export async function textFit(selector: string): Promise<TextFit | null> {
  return browser.execute((sel) => {
    const node = document.querySelector<HTMLElement>(sel)
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return {
      text: node.textContent,
      truncated: node.scrollWidth > node.clientWidth,
      ellipsis: getComputedStyle(node).textOverflow === 'ellipsis',
      left: rect.left,
      right: rect.right,
      width: rect.width,
    }
  }, selector)
}

/**
 * An automation schedule heading reads `<title> · <project> <N runs>`. The
 * project label is the part that gives way: the title keeps its full text and
 * the label ends before the run count instead of pushing it.
 */
export async function assertScheduleHeadingKeepsTitle(scheduleGroup: string): Promise<void> {
  const title = await textFit(`${scheduleGroup} .automation-schedule-title`)
  const owner = await textFit(`${scheduleGroup} .chat-thread-owner`)
  const count = await textFit(`${scheduleGroup} .automation-schedule-count`)
  assert.ok(title && owner && count, 'schedule heading is missing its title, owner or count')
  assert.equal(title.truncated, false, `schedule title was cut: ${JSON.stringify(title)}`)
  assert.equal(count.truncated, false, `run count was cut: ${JSON.stringify(count)}`)
  assert.ok(owner.ellipsis, 'the owner label must ellipsize when it gives way')
  assert.ok(
    owner.right <= count.left + 0.5,
    `owner label overlaps the run count: ${JSON.stringify({ owner, count })}`,
  )
}

/**
 * The composer footer keeps a short branch name whole. When the model name,
 * checkout and usage don't all fit, the footer goes compact and the long model
 * name gives way; the branch chip must not be squeezed to a clipped letter.
 */
export async function assertFooterBranchWhole(): Promise<void> {
  const label = await textFit('.input-footer .footer-branch-host .branch-picker-label')
  const footer = await browser.execute(() => {
    const node = document.querySelector<HTMLElement>('.input-footer')
    return node
      ? {
          compact: node.classList.contains('is-compact'),
          overflows: node.scrollWidth > node.clientWidth,
          model: document.querySelector('.input-footer .model-picker-label')?.textContent ?? '',
        }
      : null
  })
  assert.ok(label && footer, 'composer footer or its branch chip is missing')
  assert.equal(label.truncated, false, `branch chip cut: ${JSON.stringify({ label, footer })}`)
  assert.equal(footer.overflows, false, `footer overflows: ${JSON.stringify({ label, footer })}`)
}

/**
 * The Browser pane beside its Tabs list has a narrow toolbar. Every other
 * control is a fixed icon, so the address field must keep room to read the
 * host rather than being squeezed to `http://12`; the text Go button (Enter
 * does the same) is what gives way, and nothing spills past the toolbar.
 */
export async function assertBrowserAddressFieldRoomy(): Promise<void> {
  const toolbar = await browser.execute(() => {
    const bar = document.querySelector('.browser-tab-panel.is-active .browser-toolbar')
    const input = bar?.querySelector('.browser-url-input')
    const go = bar?.querySelector('.browser-go-btn')
    if (!bar || !input || !go) return null
    const barRect = bar.getBoundingClientRect()
    return {
      toolbarWidth: barRect.width,
      toolbarRight: barRect.right,
      controlsRight: Math.max(
        ...Array.from(bar.children, (child) => child.getBoundingClientRect().right),
      ),
      inputWidth: input.getBoundingClientRect().width,
      goShown: go.getClientRects().length > 0,
    }
  })
  assert.ok(toolbar, 'active browser toolbar is missing')
  const detail = JSON.stringify(toolbar)
  assert.ok(toolbar.toolbarWidth <= 360, `expected a narrow toolbar: ${detail}`)
  assert.equal(toolbar.goShown, false, `a narrow toolbar drops the text Go button: ${detail}`)
  assert.ok(toolbar.inputWidth >= 96, `address field squeezed: ${detail}`)
  assert.ok(toolbar.controlsRight <= toolbar.toolbarRight, `toolbar controls spill: ${detail}`)
}

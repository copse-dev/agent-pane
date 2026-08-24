import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
const PROJECT_ID = 'e2e-terminal-project'

async function xtermText(): Promise<string> {
  return browser.execute(() => document.querySelector('.xterm-rows')?.textContent ?? '')
}

describe('integrated terminal', () => {
  before(async function () {
    this.timeout(90_000)
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID)
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('opens a PTY shell, runs echo hello, and shows no spawn error', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]')
    await terminalBtn.click()

    await $('#pane-files').waitForDisplayed({ timeout: 10_000 })
    await expect(terminalBtn).toHaveElementClass('active')

    await $('.terminal-container .xterm').waitForExist({ timeout: 30_000 })
    // User-initiated integrated terminals always spawn outside the project
    // sandbox. `ensureTerminalPermitted` only warns about that when there is no
    // sandbox to be outside of — `decideTerminalPermission` returns `allow` once
    // `isProjectSandboxEnabled()` is true (permission-gate.ts).
    //
    // So the prompt tracks whether the sandbox actually came up, not the
    // platform. This used to key on `process.platform !== 'darwin'` because
    // Linux had no backend at all; now it does, and whether ASRT starts depends
    // on the host having bubblewrap and socat — the app degrades quietly when
    // either is missing. A platform check cannot express that; only observing
    // the dialog can. Assert the wording whenever it does appear, so an
    // unexpected *different* prompt still fails.
    const approval = await $('#approval-dialog')
    const unsandboxed = await approval
      .waitForDisplayed({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
    if (unsandboxed) {
      await expect(approval.$('.approval-heading')).toHaveText('Open unsandboxed terminal?')
      await approval.$('.approval-approve').click()
      await approval.waitForDisplayed({ reverse: true, timeout: 10_000 })
    }

    const chrome = await browser.execute(() => {
      const viewer = document.querySelector('.terminals-viewer-host')
      const container = document.querySelector('.terminal-container')
      if (!viewer || !container) return null
      const viewerStyle = getComputedStyle(viewer)
      const containerStyle = getComputedStyle(container)
      return {
        viewerBorderTopWidth: viewerStyle.borderTopWidth,
        containerPaddingTop: containerStyle.paddingTop,
        containerPaddingLeft: containerStyle.paddingLeft,
      }
    })
    expect(chrome).toEqual({
      viewerBorderTopWidth: '0px',
      containerPaddingTop: '0px',
      containerPaddingLeft: '0px',
    })

    const viewportPaint = await browser.execute(() => {
      const container = document.querySelector<HTMLElement>('.terminal-container')
      const viewport = container?.querySelector<HTMLElement>('.xterm-viewport')
      if (!container || !viewport) return null

      // Resolve the custom property through a real CSS color declaration so the
      // comparison stays correct if the terminal palette changes later.
      const probe = document.createElement('span')
      probe.style.color = 'var(--xterm-bg)'
      container.append(probe)
      const themeBackground = getComputedStyle(probe).color
      probe.remove()

      return {
        themeBackground,
        viewportBackground: getComputedStyle(viewport).backgroundColor,
      }
    })
    expect(viewportPaint).not.toBeNull()
    expect(viewportPaint?.viewportBackground).toBe(viewportPaint?.themeBackground)
    expect(viewportPaint?.viewportBackground).not.toBe('rgb(0, 0, 0)')

    await browser.waitUntil(
      async () => {
        const text = await xtermText()
        return (
          text.length > 0 &&
          !/posix_spawnp failed/i.test(text) &&
          !/Failed to start terminal/i.test(text)
        )
      },
      {
        timeout: 20_000,
        timeoutMsg: 'expected integrated terminal to spawn without posix_spawnp error',
      },
    )

    await saveAppScreenshot('terminal-shell-prompt.png')

    const helper = await $('.xterm-helper-textarea')
    await helper.click()
    await browser.keys(['echo', ' ', 'hello', '\uE007'])

    await browser.waitUntil(async () => (await xtermText()).includes('hello'), {
      timeout: 30_000,
      timeoutMsg: 'expected echo hello output in xterm buffer',
    })

    await saveAppScreenshot('terminal-echo-hello.png')
  })
})

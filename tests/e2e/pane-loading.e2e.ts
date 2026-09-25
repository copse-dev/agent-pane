import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

interface LoadingPane {
  button: string
  host: string
  label: string
  screenshot: string
}

const LOADING_PANES: LoadingPane[] = [
  {
    button: '[aria-label="Open changes"]',
    host: '#git-changes-host',
    label: 'Loading changes…',
    screenshot: 'pane-loading-changes.png',
  },
  {
    button: '[aria-label="Open pull requests"]',
    host: '#pr-list-host',
    label: 'Loading pull requests…',
    screenshot: 'pane-loading-pull-requests.png',
  },
  {
    button: '[aria-label="Open memories"]',
    host: '#memories-host',
    label: 'Loading memories…',
    screenshot: 'pane-loading-memories.png',
  },
  {
    button: '[aria-label="Open roadmap"]',
    host: '#roadmap-host',
    label: 'Loading roadmap…',
    screenshot: 'pane-loading-roadmap.png',
  },
]

interface HeaderPane {
  mode: string
  /** Titlebar mode button's aria-label. */
  button: string
  header: string
  title: string | null
  /** The header carries a toolbar that may wrap onto a second row. */
  wraps?: boolean
}

const HEADER_PANES: HeaderPane[] = [
  {
    mode: 'explorer',
    button: 'Toggle right panel',
    header: '#file-tree-host .pane-header',
    title: null,
  },
  {
    mode: 'terminal',
    button: 'Open terminal',
    header: '#terminals-list-host .pane-header',
    title: 'Shells',
  },
  {
    mode: 'changes',
    button: 'Open changes',
    header: '#git-changes-host .pane-header',
    title: 'Changes',
  },
  {
    mode: 'prs',
    button: 'Open pull requests',
    header: '#pr-list-host .pane-header',
    title: 'Pull requests',
  },
  {
    mode: 'memories',
    button: 'Open memories',
    header: '#memories-host .pane-header',
    title: 'Memories',
  },
  {
    mode: 'roadmap',
    button: 'Open roadmap',
    header: '#roadmap-host .pane-header',
    title: 'Roadmap',
    wraps: true,
  },
  {
    mode: 'browser',
    button: 'Open browser',
    header: '#browser-tabs-host .pane-header',
    title: 'Tabs',
  },
  {
    mode: 'vnc',
    button: 'Open remote desktop',
    header: '#vnc-controls-host .pane-header',
    title: 'Desktop',
  },
]

function pane(mode: string): HeaderPane {
  const found = HEADER_PANES.find((entry) => entry.mode === mode)
  if (!found) throw new Error(`unknown pane ${mode}`)
  return found
}

/**
 * Without an OS sandbox, the first shell asks before it spawns unsandboxed (see
 * terminal-display.e2e.ts). Allow it so the modal does not cover the titlebar.
 */
async function dismissUnsandboxedTerminalPrompt(): Promise<void> {
  const approval = $('#approval-dialog')
  const shown = await approval
    .waitForDisplayed({ timeout: 1_500 })
    .then(() => true)
    .catch(() => false)
  if (!shown) return
  await approval.$('.approval-approve').click()
  await approval.waitForDisplayed({ reverse: true, timeout: 10_000 })
}

/**
 * Only one pane is on screen at a time, so copy each header into a fixed column
 * as it is visited; the column is captured once as reviewable evidence that the
 * headers share one band and one title treatment.
 */
async function stackHeaderClone(selector: string): Promise<void> {
  await browser.execute((sel: string) => {
    const header = document.querySelector<HTMLElement>(`#pane-files ${sel}`)
    if (!header) return
    let stack = document.getElementById('e2e-pane-header-stack')
    if (!stack) {
      stack = document.createElement('div')
      stack.id = 'e2e-pane-header-stack'
      stack.style.cssText = [
        'position:fixed',
        'left:0',
        'top:0',
        'z-index:9999',
        'display:flex',
        'flex-direction:column',
        'background:var(--bg-elevated)',
        'border-right:1px solid var(--border)',
      ].join(';')
      document.body.append(stack)
    }
    const clone = header.cloneNode(true)
    if (!(clone instanceof HTMLElement)) return
    clone.style.width = `${String(header.getBoundingClientRect().width)}px`
    stack.append(clone)
  }, selector)
}

async function openAndFreezeLoadingPane(pane: LoadingPane): Promise<void> {
  const captured = await browser.execute(
    (buttonSelector: string, hostSelector: string) =>
      new Promise<boolean>((resolve) => {
        const filesPane = document.querySelector<HTMLElement>('#pane-files')
        const host = document.querySelector<HTMLElement>(hostSelector)
        const button = document.querySelector<HTMLButtonElement>(buttonSelector)
        if (!filesPane || !host || !button) {
          resolve(false)
          return
        }

        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (value: boolean): void => {
          if (settled) return
          settled = true
          observer.disconnect()
          if (timer !== undefined) clearTimeout(timer)
          resolve(value)
        }
        const capture = (): void => {
          if (!host.querySelector('.pane-loading')) return
          const snapshot = filesPane.cloneNode(true) as HTMLElement
          filesPane.id = 'pane-files-live'
          filesPane.hidden = true
          snapshot.dataset['loadingSnapshot'] = ''
          filesPane.after(snapshot)
          finish(true)
        }
        const observer = new MutationObserver(capture)
        observer.observe(host, { childList: true, subtree: true, characterData: true })
        button.click()
        capture()
        timer = setTimeout(() => finish(false), 5_000)
      }),
    pane.button,
    pane.host,
  )
  expect(captured).toBe(true)
}

interface TitleStyle {
  fontSize: string
  fontWeight: string
  textTransform: string
  letterSpacing: string
  color: string
}

interface HeaderMetrics {
  /** Edges relative to `#pane-files`, so every pane is measured on one axis. */
  top: number
  bottom: number
  height: number
  title: string | null
  titleStyle: TitleStyle | null
}

/** Geometry and title treatment of the displayed pane header under `#pane-files`. */
async function paneHeaderMetrics(selector: string): Promise<HeaderMetrics | null> {
  return await browser.execute((sel: string) => {
    const pane = document.querySelector<HTMLElement>('#pane-files')
    const header = pane?.querySelector<HTMLElement>(sel)
    if (!pane || !header || header.getClientRects().length === 0) return null
    const paneTop = pane.getBoundingClientRect().top
    const rect = header.getBoundingClientRect()
    const title = header.querySelector<HTMLElement>('.pane-header-title')
    const style = title ? getComputedStyle(title) : null
    return {
      top: rect.top - paneTop,
      bottom: rect.bottom - paneTop,
      height: rect.height,
      title: title?.textContent ?? null,
      titleStyle: style
        ? {
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            textTransform: style.textTransform,
            letterSpacing: style.letterSpacing,
            color: style.color,
          }
        : null,
    }
  }, selector)
}

/** `--pane-header-band-height` resolved to pixels. */
async function paneHeaderBand(): Promise<number> {
  return await browser.execute(() => {
    const probe = document.createElement('div')
    probe.style.height = 'var(--pane-header-band-height)'
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    document.body.appendChild(probe)
    const height = probe.getBoundingClientRect().height
    probe.remove()
    return height
  })
}

/**
 * Viewer chrome that paints (has a box) but holds nothing — the blank ruled
 * strip a cleared meta or files block leaves under the header.
 */
async function emptyViewerChrome(viewerSelector: string): Promise<string[]> {
  return await browser.execute((sel: string) => {
    const viewer = document.querySelector<HTMLElement>(`#pane-files ${sel}`)
    if (!viewer) return ['<missing viewer>']
    return [...viewer.children]
      .filter(
        (child) =>
          child.getClientRects().length > 0 &&
          child.getBoundingClientRect().height > 0 &&
          (child.textContent ?? '').trim() === '' &&
          child.querySelector('svg, img, canvas, .monaco-editor') === null,
      )
      .map((child) => child.className)
  }, viewerSelector)
}

async function restoreLivePane(): Promise<void> {
  await browser.execute(() => {
    document.querySelector('#pane-files[data-loading-snapshot]')?.remove()
    const live = document.querySelector<HTMLElement>('#pane-files-live')
    if (!live) return
    live.id = 'pane-files'
    live.hidden = false
  })
}

describe('async pane loading states', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-pane-loading', {
      okfMemoriesEnabled: true,
      roadmapPlansEnabled: true,
      vncEnabled: true,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows an honest pending state instead of a settled empty answer', async () => {
    const band = await paneHeaderBand()
    assert.ok(band > 0, 'expected --pane-header-band-height to resolve')
    const headers = new Map<string, HeaderMetrics>()
    for (const pane of LOADING_PANES) {
      await openAndFreezeLoadingPane(pane)

      const loading = await $(`#pane-files ${pane.host} .pane-loading`)
      await loading.waitForDisplayed({ timeout: 15_000 })
      await expect(loading).toHaveText(expect.stringContaining(pane.label))
      await expect(await loading.$('.ui-inline-status[data-status-kind="pending"]')).toBeDisplayed()

      const header = await paneHeaderMetrics(`${pane.host} .pane-header`)
      assert.ok(header, `expected a displayed .pane-header in ${pane.host}`)
      headers.set(pane.host, header)
      if (pane.host === '#pr-list-host') {
        // Nothing is selected while the list loads: the cleared PR meta must not
        // paint an empty padded, ruled strip above the pending message.
        assert.deepEqual(await emptyViewerChrome('#pr-viewer-host'), [])
      }

      await saveElementScreenshot('#pane-files', pane.screenshot)
      await restoreLivePane()
    }

    // One band and one title treatment: switching between these panes must not
    // move the header's bottom edge or restyle its label. Roadmap's header also
    // carries search + actions and may wrap, so it shares the top edge and
    // title only.
    const reference = headers.get('#git-changes-host')
    assert.ok(reference?.titleStyle)
    for (const [host, header] of headers) {
      assert.deepEqual(header.titleStyle, reference.titleStyle, `${host} title treatment`)
      assert.equal(header.top, reference.top, `${host} header top`)
      if (host === '#roadmap-host') continue
      assert.equal(header.height, band, `${host} header height`)
      assert.equal(header.bottom, reference.bottom, `${host} header bottom`)
    }
  })

  it('puts every right-panel pane header on one band', async () => {
    const band = await paneHeaderBand()
    const measured: Array<{ mode: string; header: HeaderMetrics }> = []
    for (const pane of HEADER_PANES) {
      const button = $(`.titlebar-btn[aria-label="${pane.button}"]`)
      await button.waitForDisplayed({ timeout: 10_000 })
      await button.click()
      await dismissUnsandboxedTerminalPrompt()
      await $(`#pane-files ${pane.header}`).waitForDisplayed({ timeout: 15_000 })
      const header = await paneHeaderMetrics(pane.header)
      assert.ok(header, `expected the ${pane.mode} header to be displayed`)
      assert.equal(header.title, pane.title, `${pane.mode} header title`)
      measured.push({ mode: pane.mode, header })
      await stackHeaderClone(pane.header)
    }

    const changes = measured.find((entry) => entry.mode === 'changes')?.header
    assert.ok(changes?.titleStyle)
    for (const { mode, header } of measured) {
      assert.equal(header.top, changes.top, `${mode} header top`)
      if (pane(mode).wraps) continue
      assert.equal(header.height, band, `${mode} header height`)
      assert.equal(header.bottom, changes.bottom, `${mode} header bottom`)
      if (header.titleStyle) {
        assert.deepEqual(header.titleStyle, changes.titleStyle, `${mode} title treatment`)
      }
    }

    await saveElementScreenshot('#e2e-pane-header-stack', 'pane-header-band.png')
    await browser.execute(() => document.getElementById('e2e-pane-header-stack')?.remove())
  })
})

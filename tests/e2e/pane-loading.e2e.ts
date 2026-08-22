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
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows an honest pending state instead of a settled empty answer', async () => {
    for (const pane of LOADING_PANES) {
      await openAndFreezeLoadingPane(pane)

      const loading = await $(`#pane-files ${pane.host} .pane-loading`)
      await loading.waitForDisplayed({ timeout: 15_000 })
      await expect(loading).toHaveText(expect.stringContaining(pane.label))
      await expect(await loading.$('.ui-inline-status[data-status-kind="pending"]')).toBeDisplayed()

      await saveElementScreenshot('#pane-files', pane.screenshot)
      await restoreLivePane()
    }
  })
})

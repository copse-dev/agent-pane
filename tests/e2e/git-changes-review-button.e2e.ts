import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../../src/shared/safe-json.ts'
import {
  prepareE2eScreenshot,
  parkPointer,
  savePreparedAppScreenshot,
} from './helpers/screenshot.ts'
import {
  cleanupGitChangesFixture,
  e2eWorkspaceDir,
  resetUserData,
  seedGitChangesFixture,
} from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

const DIAGNOSTIC_KEY = 'copse-git-changes-capture-observation'
const DIAGNOSTIC_PHASE = 'copse-git-changes-capture-phase'
const DIAGNOSTIC_STOP = 'copse-git-changes-capture-stop'
const ownerMetaSchema = z.object({
  id: z.string(),
  status: z.enum(['idle', 'running', 'error']),
  gitBranch: z.string().optional(),
  worktree: z
    .object({
      path: z.string(),
      branch: z.string(),
      baseCommit: z.string().optional(),
      createdAt: z.number().optional(),
      retiredAt: z.number().optional(),
    })
    .optional(),
})
const observationSchema = z.object({
  dropped: z.number(),
  records: z.array(z.record(z.string(), z.unknown())),
})

interface ChangesCaptureObservation {
  phase: (phase: string) => Promise<void>
  capture: (takeScreenshot: () => Promise<void>) => Promise<void>
  finish: () => Promise<void>
}

/** Read-only evidence for a Linux frame that was pending after the settled assertion. */
async function observeChangesCapture(): Promise<ChangesCaptureObservation> {
  const snapshots: Array<Record<string, unknown>> = []
  let captureStartedAt: number | null = null
  let captureCompletedAt: number | null = null
  await browser.execute(
    (key, phaseEvent, stopEvent) => {
      const records: Array<Record<string, unknown>> = []
      const hosts = new WeakMap<Node, number>()
      let nextHost = 0
      let dropped = 0
      let previous = ''
      let active = true
      let framePending = false
      const record = (phase: string, frameTime?: number): void => {
        if (!active) return
        const host = document.getElementById('git-changes-host')
        if (host && !hosts.has(host)) hosts.set(host, ++nextHost)
        const state = {
          host: host ? hosts.get(host) : null,
          text: host?.textContent.slice(0, 500) ?? null,
          selectedThread:
            document.querySelector('.chat-row.selected')?.getAttribute('data-thread-id') ?? null,
          workspace: document.querySelector('.workspace-name')?.textContent ?? null,
          branch: document.querySelector('.footer-branch-label')?.textContent ?? null,
          committedRows: [...document.querySelectorAll('.git-change-row-committed')]
            .slice(0, 8)
            .map((row) => row.textContent.slice(0, 100)),
        }
        const serialized = JSON.stringify(state)
        if (phase === 'mutation' && serialized === previous) return
        previous = serialized
        if (records.length === 32) {
          records.shift()
          dropped++
        }
        records.push({ phase, time: Date.now(), monotonic: performance.now(), frameTime, ...state })
        sessionStorage.setItem(key, JSON.stringify({ dropped, records }))
        // Observe ordinary paint callbacks without delaying the test or changing state.
        if (phase === 'mutation' && !framePending) {
          framePending = true
          requestAnimationFrame((first) => {
            record('raf-1', first)
            requestAnimationFrame((second) => {
              record('raf-2', second)
              framePending = false
            })
          })
        }
      }
      const phaseListener = (event: Event): void => {
        if (event instanceof CustomEvent && typeof event.detail === 'string') record(event.detail)
      }
      const observer = new MutationObserver(() => {
        record('mutation')
      })
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      })
      document.addEventListener(phaseEvent, phaseListener)
      document.addEventListener(
        stopEvent,
        () => {
          record('stopped')
          active = false
          observer.disconnect()
          document.removeEventListener(phaseEvent, phaseListener)
        },
        { once: true },
      )
      record('installed')
    },
    DIAGNOSTIC_KEY,
    DIAGNOSTIC_PHASE,
    DIAGNOSTIC_STOP,
  )

  return {
    async phase(phase: string): Promise<void> {
      const startedAt = Date.now()
      const context = await browser.execute(
        async (phase, event) => {
          document.dispatchEvent(new CustomEvent(event, { detail: phase }))
          return {
            time: Date.now(),
            navigation: await window.api.windowState.getNavigation(),
            workspace: await window.api.workspace.get(),
          }
        },
        phase,
        DIAGNOSTIC_PHASE,
      )
      const metaPath = join(
        e2eWorkspaceDir(),
        'e2e-git-changes-project',
        'e2e-git-changes-thread',
        'meta.json',
      )
      const raw = existsSync(metaPath) ? readFileSync(metaPath, 'utf8') : null
      snapshots.push({
        phase,
        startedAt,
        context,
        metaSha256: raw === null ? null : createHash('sha256').update(raw).digest('hex'),
        owner: raw === null ? null : safeJsonParse(raw, decodeWithSchema(ownerMetaSchema)),
      })
    },
    async capture(takeScreenshot: () => Promise<void>): Promise<void> {
      captureStartedAt = Date.now()
      await takeScreenshot()
      captureCompletedAt = Date.now()
    },
    async finish(): Promise<void> {
      // Diagnostic failures must remain visible without replacing an owning assertion failure.
      try {
        await browser.execute((event) => document.dispatchEvent(new Event(event)), DIAGNOSTIC_STOP)
        const raw = await browser.execute((key) => sessionStorage.getItem(key), DIAGNOSTIC_KEY)
        const observation =
          raw === null ? null : safeJsonParse(raw, decodeWithSchema(observationSchema))
        const image = join(SCREENSHOT_DIR, 'git-changes-review-button.png')
        const imageSha256 =
          captureCompletedAt !== null && existsSync(image)
            ? createHash('sha256').update(readFileSync(image)).digest('hex')
            : null
        const specSha256 = createHash('sha256')
          .update(readFileSync(join(process.cwd(), 'tests/e2e/git-changes-review-button.e2e.ts')))
          .digest('hex')
        console.info(
          '[git-changes-capture-observation]',
          JSON.stringify({
            specSha256,
            captureStartedAt,
            captureCompletedAt,
            imageSha256,
            snapshots,
            observation,
          }),
        )
      } catch (error) {
        console.info(
          '[git-changes-capture-observation]',
          JSON.stringify({ unavailable: String(error), captureStartedAt, captureCompletedAt }),
        )
      }
    },
  }
}

async function openChanges(): Promise<void> {
  await browser.waitUntil(
    async () => (await (await $('.workspace-name').getElement()).getText()) !== 'No folder',
    { timeout: 60_000, timeoutMsg: 'expected a restored workspace before opening Changes' },
  )
  await $('.prompt-input').waitForExist({ timeout: 60_000 })
  await $('.titlebar-btn[aria-label="Open changes"]').waitForExist({ timeout: 30_000 })
  await $('.titlebar-btn[aria-label="Open changes"]').click()
  await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })
  await $('.git-changes-header').waitForExist({ timeout: 30_000 })
}

// Visual eval for the "Review" gesture in the Changes view
// (docs/plans/copse-reviewer.md, P9): the button sits in the Changes header
// beside the bulk actions, only while the `copse.review` plugin is enabled —
// a level-3 contribution that follows the plugin's atomic toggle like the
// plugin-gated pane controls — and is enabled while the thread is idle.
describe('Changes view "Review" gesture', function () {
  this.timeout(120_000)

  let repoRoot = ''

  after(() => {
    resetUserData()
    if (repoRoot) cleanupGitChangesFixture(repoRoot)
  })

  it('shows Review in the Changes header once the review plugin is enabled', async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    repoRoot = seedGitChangesFixture({ reviewEnabled: true })
    await browser.reloadSession()
    await openChanges()

    const button = $('.git-changes-header .git-changes-review-btn')
    await button.waitForDisplayed({ timeout: 30_000 })
    await expect(button).toHaveText('Review')
    await expect(button).toBeEnabled()
    const placement = await browser.execute(() => {
      const header = document.querySelector('.git-changes-header')
      const children = [...(header?.children ?? [])].map((node) => node.className)
      return {
        afterTitle:
          children.indexOf('git-changes-review-btn') > children.indexOf('pane-header-title'),
        beforePopout:
          children.indexOf('git-changes-review-btn') <
          children.findIndex((name) => name.includes('pane-popout')),
      }
    })
    expect(placement.afterTitle).toBe(true)
    expect(placement.beforePopout).toBe(true)

    const diagnostic = await observeChangesCapture()
    try {
      await diagnostic.phase('before-prepare')
      await prepareE2eScreenshot()
      await diagnostic.phase('after-prepare')
      await parkPointer()
      await $('.git-change-row*=committed.ts').waitForDisplayed({ timeout: 30_000 })
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const host = document.getElementById('git-changes-host')
            return (
              Boolean(host && !host.textContent.includes('Checking committed changes')) &&
              [...document.querySelectorAll('#git-diff-viewer-host .scrollbar.horizontal')].every(
                (element) => getComputedStyle(element).opacity === '0',
              )
            )
          }),
        { timeout: 30_000, timeoutMsg: 'Changes list and diff chrome did not settle' },
      )
      await diagnostic.phase('settled-wait-passed')
      await diagnostic.capture(() => savePreparedAppScreenshot('git-changes-review-button.png'))
      await diagnostic.phase('helper-returned')
    } finally {
      await diagnostic.finish()
    }
  })

  it('hides Review while the review plugin is off', async () => {
    resetUserData()
    cleanupGitChangesFixture(repoRoot)
    repoRoot = seedGitChangesFixture()
    await browser.reloadSession()
    await openChanges()

    // The gate resolves asynchronously through `plugins:list`; wait for the
    // header to settle before reading the button's state.
    await $(
      '#git-changes-host .git-changes-refresh-btn[aria-label="Refresh changes"]',
    ).waitForDisplayed({ timeout: 30_000 })
    await browser.pause(500)
    const hidden = await browser.execute(
      () => document.querySelector<HTMLElement>('.git-changes-review-btn')?.hidden ?? null,
    )
    expect(hidden).toBe(true)
  })
})

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

const PROJECT = 'e2e-native-legacy-provenance'

describe('native legacy PR lookup', function () {
  this.timeout(180_000)
  let root = ''

  before(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'copse-legacy-provenance-')))
    resetUserData()
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'unavailable' })
    // Seed historical files before Electron opens them. Creating 1,000 live
    // threads through IPC both broadcasts every update and times out WebDriver
    // before the lookup under measurement even starts.
    const metadata = {
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
    }
    writeSeedConfig({
      projects: [{ id: PROJECT, path: root, name: 'Legacy provenance', worktreeMode: 'never' }],
      activeProjectId: PROJECT,
      activeThreadId: 'active',
      [`threads:${PROJECT}`]: [
        { ...metadata, id: 'active', title: 'New chat', createdAt: 3000, updatedAt: 3000 },
        // Keep the legacy rows outside the sidebar's initial window, so its
        // visible-row backfill cannot satisfy the lookup before we measure it.
        ...Array.from({ length: 20 }, (_, index) => ({
          ...metadata,
          id: `recent-${String(index)}`,
          title: `Recent chat ${String(index)}`,
          prRefs: [],
          messages: [
            {
              id: `recent-message-${String(index)}`,
              role: 'user',
              content: 'Recent discussion without PR links.',
              toolCalls: [],
              createdAt: 2000 + index,
            },
          ],
          createdAt: 2000 + index,
          updatedAt: 2000 + index,
        })),
        ...Array.from({ length: 1000 }, (_, index) => ({
          ...metadata,
          id: `legacy-${String(index)}`,
          title: `Legacy chat ${String(index)}`,
          messages: [
            {
              id: `legacy-message-${String(index)}`,
              role: 'user',
              content:
                index % 10 === 0
                  ? `Review https://github.com/acme/widgets/pull/2002. ${'Project context. '.repeat(64)}`
                  : 'A discussion without PR links.',
              toolCalls: [],
              createdAt: index + 1,
            },
          ],
          createdAt: index + 1,
          updatedAt: index + 1,
        })),
      ],
    })
    await browser.reloadSession()
    await $('.chat-row.selected').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    writeE2eEnv({})
    resetUserData()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('completes an offscreen legacy lookup while the Electron renderer keeps drawing', async () => {
    const timing = await browser.execute(async (project) => {
      const pr = {
        owner: 'acme',
        repo: 'widgets',
        number: 2002,
        url: 'https://github.com/acme/widgets/pull/2002',
      }
      const metas = await window.api.threads.loadProject(project)
      const unscanned = metas.filter(
        (thread) => thread.id.startsWith('legacy-') && thread.prRefs === undefined,
      ).length
      let frames = 0
      let previous = performance.now()
      let maxFrameGapMs = 0
      let frame = 0
      const draw = (now: number): void => {
        frames++
        maxFrameGapMs = Math.max(maxFrameGapMs, now - previous)
        previous = now
        frame = requestAnimationFrame(draw)
      }
      frame = requestAnimationFrame(draw)
      const started = performance.now()
      const rows = await window.api.gh.prThreadRelationships(pr)
      const firstLookupMs = performance.now() - started
      cancelAnimationFrame(frame)
      const warmStarted = performance.now()
      const warmRows = await window.api.gh.prThreadRelationships(pr)
      return {
        unscanned,
        visibleLegacy: document.querySelectorAll('.chat-row[data-thread-id^="legacy-"]').length,
        matches: rows.length,
        warmMatches: warmRows.length,
        lastOffscreenFound: rows.some((row) => row.threadId === 'legacy-990'),
        produced: rows.filter((row) => row.kinds.includes('produced')).length,
        firstLookupMs,
        warmLookupMs: performance.now() - warmStarted,
        frames,
        maxFrameGapMs,
      }
    }, PROJECT)
    assert.equal(timing.unscanned, 1000)
    assert.equal(timing.visibleLegacy, 0)
    assert.equal(timing.matches, 100)
    assert.equal(timing.warmMatches, 100)
    assert.equal(timing.lastOffscreenFound, true)
    assert.equal(timing.produced, 0)
    assert.ok(timing.frames > 0, 'renderer must draw during the main-process scan')
    const artifacts = join(process.cwd(), 'tests/e2e/artifacts')
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(
      join(artifacts, 'pr-native-legacy-profile.json'),
      `${JSON.stringify(timing, null, 2)}\n`,
    )
    console.log(`Native legacy profile: ${JSON.stringify(timing)}`)
  })
})

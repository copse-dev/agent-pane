import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import {
  resetUserData,
  seedEmptyProject,
  writeSeedConfig,
  seedE2eViewport,
  seedE2eThreePaneLayout,
} from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { submitComposer } from './helpers/composer.ts'
import { agentIsIdle, waitForAgentIdle } from './helpers.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT = 'e2e-native-pr-provenance'
const PR = {
  owner: 'acme',
  repo: 'widgets',
  number: 1001,
  url: 'https://github.com/acme/widgets/pull/1001',
}

describe('native PR and commit provenance', function () {
  this.timeout(180_000)
  let root = ''
  let producer = ''
  const originalPath = process.env['PATH'] ?? ''
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

  before(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'copse-native-provenance-')))
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Copse Test')
    git('config', 'user.email', 'copse@example.invalid')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '/dev/null')
    git('commit', '--allow-empty', '-qm', 'initial')
    git('checkout', '-qb', 'work')
    git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
    writeFileSync(join(root, 'change.txt'), 'real local provenance commit\n')
    const bin = join(root, 'fixture-bin')
    mkdirSync(bin)
    // Keep the CLI outside the checkout's committed files.
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\nexec node '${join(process.cwd(), 'tests/e2e/fixtures/provenance-gh.cjs')}' "$@"\n`,
      { mode: 0o700 },
    )
    writeFileSync(join(root, '.git/info/exclude'), 'fixture-bin/\n')
    resetUserData()
    writeE2eEnv({
      COPSE_AGENT_EVAL: '1',
      COPSE_PRESERVE_PATH: '1',
      PATH: `${bin}:${originalPath}`,
      COPSE_PANEL_MOCK_GH: '1',
      COPSE_PANEL_MOCK_GH_STATUS: 'ready',
    })
    seedEmptyProject(root, PROJECT, { subagentsEnabled: false, model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [{ id: PROJECT, path: root, name: 'Native provenance', worktreeMode: 'never' }],
      activeProjectId: PROJECT,
    })
    seedE2eViewport()
    seedE2eThreePaneLayout()
    await browser.reloadSession()
    await $('.chat-row.selected').waitForExist({ timeout: 30_000 })
    producer = await $('.chat-row.selected').getAttribute('data-thread-id')
  })

  after(() => {
    writeE2eEnv({ COPSE_AGENT_EVAL: undefined, COPSE_PRESERVE_PATH: undefined, PATH: originalPath })
    resetUserData()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  async function runTool(
    name: string,
    args: Record<string, unknown>,
    prompt: string,
  ): Promise<void> {
    const scenario = await prepareMockToolTurn(
      prompt,
      { name, args },
      'The provenance check is complete.',
    )
    await submitComposer()
    await browser.waitUntil(
      async () => {
        const approve = $('#approval-dialog .approval-approve')
        if (await approve.isDisplayed()) await approve.click()
        return agentIsIdle()
      },
      { timeout: 60_000, interval: 100 },
    )
    await waitForAgentIdle(30_000)
    await scenario.waitForComplete()
    await scenario.assertComplete()
  }

  async function assertRelations(): Promise<void> {
    const result = await browser.execute(
      async ({ project, pr, producerId }) => ({
        pr: await window.api.gh.prThreadRelationships(pr),
        thread: await window.api.gh.threadPrRelationships(producerId),
        metas: await window.api.threads.loadProject(project),
      }),
      { project: PROJECT, pr: PR, producerId: producer },
    )
    assert.ok(result.pr.some((row) => row.threadId === producer && row.kinds.includes('produced')))
    assert.ok(
      result.pr.some(
        (row) =>
          row.threadId === 'related' &&
          row.kinds.includes('referenced') &&
          !row.kinds.includes('produced'),
      ),
    )
    assert.ok(
      result.thread.some((row) => row.pr.number === PR.number && row.kinds.includes('produced')),
    )
    assert.equal(
      result.metas.find((thread) => thread.id === producer)?.commitProductions?.[0]?.sha,
      git('rev-parse', 'HEAD'),
    )
  }

  async function showRelationships(screenshot: string): Promise<void> {
    const pane = $('#pane-files')
    if (!(await pane.isDisplayed()))
      await $('.titlebar-btn[aria-label="Toggle right panel"]').click()
    await $('[aria-label="Open pull requests"]').click()
    await $('.pr-list-row*=#1001').waitForExist({ timeout: 15_000 })
    await $('.pr-list-row*=#1001').click()
    await expect($(`.pr-thread-link[data-thread-id="${producer}"]`)).toHaveAttribute(
      'data-relationship',
      'produced',
    )
    await expect($('.pr-thread-link[data-thread-id="related"]')).toHaveAttribute(
      'data-relationship',
      'related',
    )
    await saveElementScreenshot('#pane-files', screenshot)
  }

  it('records actual tools, shows both directions, and reports exact and unknown commits', async () => {
    await runTool(
      'git_commit',
      { message: 'Native provenance commit', stage_all: true },
      'Commit the pending provenance fixture change.',
    )
    assert.equal(git('rev-list', '--count', 'HEAD'), '2')
    await runTool(
      'gh_pr_create',
      {
        title: 'Native provenance fixture',
        owner: 'acme',
        repo: 'widgets',
        head: 'work',
        base: 'main',
        draft: true,
      },
      'Create a draft PR for the provenance fixture.',
    )
    await browser.execute(async (project) => {
      await window.api.threads.create(project, {
        id: 'related',
        title: 'Separate reviewing chat',
        status: 'idle',
        messages: [
          {
            id: 'related-message',
            role: 'user',
            content:
              'Review https://github.com/acme/widgets/pull/1001 and https://github.com/acme/widgets/pull/55',
            toolCalls: [],
            createdAt: 1,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: 1,
        updatedAt: 1,
      })
    }, PROJECT)
    await assertRelations()
    await runTool(
      'gh_pr_view',
      { number: PR.number, include_checks: false },
      'Show the PR and exact commit provenance.',
    )
    const messages = await browser.execute(
      async ({ project, id }) => window.api.threads.loadMessages(project, id),
      { project: PROJECT, id: producer },
    )
    const output =
      messages.flatMap((message) => message.toolCalls).find((call) => call.name === 'gh_pr_view')
        ?.result ?? ''
    assert.match(output, /Producing threads:/)
    assert.ok(output.includes(`${git('rev-parse', 'HEAD')}: recorded in ${producer}`))
    assert.ok(output.includes(`${'f'.repeat(40)}: unknown`))
    await browser.execute(
      async ({ project, id }) => {
        await window.api.threads.updateMeta(project, id, { title: 'Implementation chat' })
      },
      { project: PROJECT, id: producer },
    )
    await browser.refresh()
    await $('.chat-row.selected').waitForExist({ timeout: 30_000 })
    await showRelationships('pr-native-provenance.png')
  })

  it('retains producing and related chats after an offline process restart', async () => {
    writeE2eEnv({ COPSE_PANEL_MOCK_GH_STATUS: 'unavailable' })
    await browser.reloadSession()
    await $('.chat-row.selected').waitForExist({ timeout: 30_000 })
    await assertRelations()
    await showRelationships('pr-native-provenance-offline-restart.png')
    await expect($('#pane-files')).toHaveText('Install GitHub CLI', { containing: true })
    const related = await browser.execute(async () =>
      window.api.gh.threadPrRelationships('related'),
    )
    assert.deepEqual(
      related.map((row) => row.pr.number).sort((a, b) => a - b),
      [55, 1001],
    )
    await $('.pr-thread-link[data-thread-id="related"]').click()
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', 'related')
    await expect($('.git-changes-section-title*=Related PRs')).toHaveText(
      expect.stringMatching(/related PRs · this thread \(2\)/i),
    )
    await expect($('.pr-list-row[data-pr-section="linked"]*=#55')).toExist()
    await expect($('.pr-list-row[data-pr-section="linked"]*=#1001')).toExist()
    await saveElementScreenshot('#pane-files', 'thread-native-multiple-prs-offline.png')
  })

  it('completes an offscreen legacy lookup while the Electron renderer keeps drawing', async () => {
    const timing = await browser.execute(async (project) => {
      const pr = {
        owner: 'acme',
        repo: 'widgets',
        number: 2002,
        url: 'https://github.com/acme/widgets/pull/2002',
      }
      await Promise.all(
        Array.from({ length: 1000 }, (_, index) =>
          window.api.threads.create(project, {
            id: `legacy-${String(index)}`,
            title: `Legacy chat ${String(index)}`,
            status: 'idle',
            messages: [
              {
                id: `legacy-message-${String(index)}`,
                role: 'user',
                content:
                  index % 10 === 0
                    ? `Review ${pr.url}. ${'Project context. '.repeat(64)}`
                    : 'A discussion without PR links.',
                toolCalls: [],
                createdAt: index + 1,
              },
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: index + 1,
            updatedAt: index + 1,
          }),
        ),
      )
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

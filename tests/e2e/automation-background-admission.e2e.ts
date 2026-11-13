import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { BEST_VALUE_CHAT_MODEL } from '../../src/shared/lm-studio-defaults.ts'
import { loadProjectThreads } from '../../src/main/services/thread-store.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { parkPointer, pinTextForCapture, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT = 'e2e-automation-background-admission'
const SCHEDULE = 'background-server'
const PROMPT = 'Start the project server in the background.'
const COMMAND =
  'echo $$ > .copse-fixture-pid; while test ! -f .copse-fixture-release; do printf . >> .copse-fixture-heartbeat; sleep 0.1; done'
const runs = async (): Promise<Awaited<ReturnType<typeof loadProjectThreads>>> =>
  (await loadProjectThreads(PROJECT)).filter((thread) => thread.automation?.scheduleId === SCHEDULE)

const captureStates: unknown[] = []

async function recordActionState(phase: string): Promise<{ ready: boolean; layout: string }> {
  const state = await browser.execute(() => {
    const row = document.querySelector('#automation-dialog .automation-row')
    const actions = row?.querySelector('.automation-row-actions')
    const ancestry = []
    for (let element = actions; element; element = element.parentElement) {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      ancestry.push({
        tag: element.tagName,
        id: element.id,
        className: element.className,
        hidden: element.hasAttribute('hidden'),
        inert: element.hasAttribute('inert'),
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        clipPath: style.clipPath,
        transform: style.transform,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      })
    }
    return {
      phaseTime: Date.now(),
      viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
      userAgent: navigator.userAgent,
      row: row?.outerHTML ?? null,
      actions: actions?.outerHTML ?? null,
      ancestry,
      buttons: [...(actions?.querySelectorAll('button') ?? [])].map((button) => {
        const rect = button.getBoundingClientRect()
        const style = getComputedStyle(button)
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return {
          text: button.textContent,
          disabled: button.disabled,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          withinViewport:
            rect.width > 0 &&
            rect.height > 0 &&
            rect.left >= 0 &&
            rect.top >= 0 &&
            rect.right <= innerWidth &&
            rect.bottom <= innerHeight,
          centerHitsControl: hit !== null && button.contains(hit),
          hit: hit?.outerHTML ?? null,
        }
      }),
    }
  })
  captureStates.push({ phase, state })
  const dir = join(process.cwd(), 'e2e-failure-artifacts')
  mkdirSync(dir, { recursive: true })
  // Keep successful capture states too: DOM checks can pass while a PNG omits
  // controls, and cleanup would otherwise erase the evidence needed to tell why.
  writeFileSync(
    join(dir, 'automation-background-actions.json'),
    JSON.stringify(captureStates, null, 2),
  )
  // CI uploads failure artifacts only on red jobs. Its logs retain this
  // successful boundary too, if a later image review finds missing controls.
  if (phase === 'capture-ready' || phase === 'capture-saved' || phase === 'failure-before-cleanup')
    console.info('Automation action capture evidence:', JSON.stringify(captureStates))
  return {
    ready:
      state.buttons.length === 3 &&
      state.ancestry.every(
        (element) =>
          !element.hidden &&
          !element.inert &&
          element.display !== 'none' &&
          element.visibility === 'visible' &&
          Number(element.opacity) > 0,
      ) &&
      state.buttons.every(
        (button) =>
          !button.disabled &&
          button.display !== 'none' &&
          button.visibility === 'visible' &&
          Number(button.opacity) > 0 &&
          button.withinViewport &&
          button.centerHitsControl,
      ),
    layout: JSON.stringify({ buttons: state.buttons, ancestry: state.ancestry }),
  }
}

async function openManager(): Promise<void> {
  await $(`.project-entry[data-project-id="${PROJECT}"] .project-menu-btn`).click()
  await $('.context-menu-item=Automations').waitForDisplayed({ timeout: 10_000 })
  await $('.context-menu-item=Automations').click()
}

async function start(count: number): Promise<void> {
  const scenario = await installMockScenario(
    {
      title: 'Project server',
      turns: [
        {
          user: PROMPT,
          responses: [
            {
              toolCalls: [{ name: 'run_background', args: { action: 'start', command: COMMAND } }],
            },
            { text: 'The project server is running in the background.' },
          ],
        },
      ],
    },
    null,
  )
  await openManager()
  await $('#automation-dialog .automation-run-btn').click()
  await expect($('#automation-dialog .automation-status')).toHaveText('Started “Project server”.')
  await browser.waitUntil(
    async () => {
      const approval = $('#approval-dialog')
      if ((await approval.isExisting()) && (await approval.getProperty('open')) === true) {
        await approval.$('.approval-reject').click()
        throw new Error('Unexpected approval in the contained background fixture')
      }
      const all = await runs()
      return (
        all.length === count &&
        all.every(
          (thread) =>
            thread.status === 'idle' &&
            thread.messages.some(
              (message) => message.content === 'The project server is running in the background.',
            ) &&
            existsSync(join(thread.worktree?.path ?? '', '.copse-fixture-heartbeat')),
        )
      )
    },
    { timeout: 30_000, interval: 100 },
  )
  await scenario.assertComplete()
}

describe('automation admission beside an unbounded native background server', function () {
  this.timeout(90_000)
  before(async () => {
    resetUserData()
    const worktrees = process.env['COPSE_WORKTREES_DIR']
    assert.ok(worktrees)
    const root = join(dirname(worktrees), 'automation-server-project')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'README.md'), 'Project server fixture.\n')
    writeFileSync(join(root, '.gitignore'), '.copse-fixture-*\n')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Copse E2E',
        '-c',
        'user.email=e2e@example.invalid',
        'commit',
        '-qm',
        'seed',
      ],
      { cwd: root },
    )
    seedEmptyProject(root, PROJECT, {
      model: BEST_VALUE_CHAT_MODEL,
      subagentsEnabled: false,
      windowBounds: { width: 1280, height: 800 },
    })
    writeSeedConfig({
      projects: [{ id: PROJECT, path: root, name: 'server project' }],
      activeProjectId: PROJECT,
      [`threads:${PROJECT}`]: [],
      pluginDisabled: [],
      pluginMigration: { automationsEnablement: true },
      plugin: {
        copse: {
          automations: {
            storage: [
              {
                id: SCHEDULE,
                projectId: PROJECT,
                name: 'Project server',
                cron: '* * * * *',
                prompt: PROMPT,
                model: BEST_VALUE_CHAT_MODEL,
                enabled: false,
                maxLiveWorktrees: 1,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        },
      },
    })
    await browser.reloadSession()
    await $(`.project-entry[data-project-id="${PROJECT}"]`).waitForDisplayed({ timeout: 30_000 })
  })
  after(async () => {
    for (const thread of await runs()) {
      if (thread.worktree && existsSync(thread.worktree.path))
        writeFileSync(join(thread.worktree.path, '.copse-fixture-release'), '')
    }
    resetUserData()
  })
  afterEach(async function () {
    if (this.currentTest?.state !== 'failed') return
    try {
      await recordActionState('failure-before-cleanup')
    } catch (error) {
      console.warn('Could not retain automation action state', error)
    }
  })
  it('starts a distinct run while preserving the first server and its checkout', async () => {
    await start(1)
    const [first] = await runs()
    assert.ok(first?.worktree)
    const pidPath = join(first.worktree.path, '.copse-fixture-pid')
    const pid = readFileSync(pidPath, 'utf8')
    await $('#automation-dialog [aria-label="Close automations"]').click()
    await start(2)
    const all = await runs()
    assert.ok(
      all.some(
        (thread) => thread.id !== first.id && thread.worktree?.path !== first.worktree?.path,
      ),
    )
    assert.equal(existsSync(first.worktree.path), true)
    assert.equal(readFileSync(pidPath, 'utf8'), pid)
    // Linux sandboxes isolate PIDs. Observe the original checkout's process
    // directly rather than interpreting its namespace PID on the host.
    const heartbeat = join(first.worktree.path, '.copse-fixture-heartbeat')
    const previous = readFileSync(heartbeat).length
    await browser.waitUntil(() => readFileSync(heartbeat).length > previous, {
      timeout: 5_000,
      interval: 100,
      timeoutMsg: 'the first background process stopped when the next run started',
    })
    assert.deepEqual(all.find((thread) => thread.id === first.id)?.messages, first.messages)
    await expect($('#automation-dialog .automation-row-meta')).toHaveText(
      expect.stringContaining('1 live worktree max'),
    )
    const restores = [
      await pinTextForCapture(
        '#automation-dialog .automation-row-last-run',
        /^Last started .+$/,
        'Last started Jan 1, 2026, 12:00 AM',
      ),
    ]
    for (const run of all) {
      const selector = `.chat-row[data-thread-id="${run.id}"] .chat-title`
      const row = $(selector)
      if (!(await row.isExisting())) continue
      const text = await row.getText()
      if (/Latest · |\d{4}/.test(text)) {
        restores.push(
          await pinTextForCapture(
            selector,
            /^.+$/,
            text.startsWith('Latest · ')
              ? 'Latest · Jan 1, 2026, 12:00 AM'
              : 'Jan 1, 2026, 12:00 AM',
          ),
        )
      }
    }
    const branch = $('.footer-branch-label')
    if ((await branch.isExisting()) && /^copse\//.test(await branch.getText()))
      restores.push(
        await pinTextForCapture(
          '.footer-branch-label',
          /^copse\/.+$/,
          'copse/project-server-000001',
        ),
      )
    await parkPointer()
    await saveAppScreenshot('automation-background-server-admitted.png', undefined, async () => {
      const actions = $('#automation-dialog .automation-row-actions')
      await expect(actions.$$('button')).toBeElementsArrayOfSize(3)
      for (const label of ['Edit', 'Run now', 'Delete']) {
        await expect(actions.$(`button=${label}`)).toBeDisplayed()
        await expect(actions.$(`button=${label}`)).toBeEnabled()
      }
      let previous = ''
      let stable = 0
      // Read-only hit tests avoid WebDriver's clickability probe, which can
      // scroll a clipped control into view and change the state being captured.
      await browser.waitUntil(
        async () => {
          const { ready, layout } = await recordActionState('capture-after-resize')
          stable = ready && layout === previous ? stable + 1 : 0
          previous = layout
          return stable >= 2
        },
        {
          timeout: 5_000,
          interval: 100,
          timeoutMsg: 'automation actions never became visible and stable for capture',
        },
      )
      const final = await recordActionState('capture-ready')
      assert.equal(final.ready, true)
      assert.equal(final.layout, previous, 'automation actions changed at the capture boundary')
    })
    await recordActionState('capture-saved')
    for (const restore of restores) await restore()
  })
})

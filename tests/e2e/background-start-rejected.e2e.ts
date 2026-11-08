import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { loadProjectThreads } from '../../src/main/services/thread-store.ts'
import { agentIsIdle } from './helpers.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
  writeSeedConfig,
} from './helpers/seed-config.ts'

const PROJECT = 'background-start-consent'
const THREAD = 'preview-permission-000001'
const REPLY = 'The preview request is handled.'
let root = ''

type PreviewObservation = {
  thread: Awaited<ReturnType<typeof loadProjectThreads>>[number] | null
  gitStatus: string
  promptState: { startingCommit: string | null; dirty: boolean }
}

async function observePreview(): Promise<PreviewObservation> {
  return {
    thread: (await loadProjectThreads(PROJECT)).find((thread) => thread.id === THREAD) ?? null,
    gitStatus: execFileSync('git', ['status', '--porcelain=v1', '-uall'], {
      cwd: root,
      encoding: 'utf8',
    }),
    promptState: await browser.execute(
      ({ project, thread }) => window.api.git.promptState(project, thread),
      { project: PROJECT, thread: THREAD },
    ),
  }
}

async function requestPreview(prompt: string, approve: boolean): Promise<void> {
  const scenario = await installMockScenario({
    title: 'Preview permission check',
    turns: [
      {
        user: prompt,
        responses: [
          {
            toolCalls: [
              {
                name: 'run_background',
                args: {
                  action: 'start',
                  command: 'node server.cjs',
                  allow_port_binding: true,
                  timeout_ms: 10_000,
                  wake_on_completion: false,
                },
              },
            ],
          },
          { text: REPLY },
        ],
      },
    ],
  })
  await setComposerValue(prompt)
  await submitComposer()
  let prompts = 0
  await browser.waitUntil(
    async () => {
      const dialog = $('#approval-dialog')
      if ((await dialog.isExisting()) && (await dialog.getProperty('open')) === true) {
        const isPort =
          (await dialog.$('.approval-heading').getText()) ===
          'Allow this project to bind a local port?'
        if (isPort) prompts++
        if (isPort && approve) {
          const once = dialog.$('.approval-approve-once')
          if ((await once.isExisting()) && (await once.isDisplayed())) {
            await once.click()
          } else {
            await expect(dialog.$('.approval-remember-input')).not.toBeSelected()
            await dialog.$('.approval-approve').click()
          }
        } else {
          await dialog.$(isPort ? '.approval-reject' : '.approval-approve').click()
        }
      }
      return agentIsIdle()
    },
    { timeout: 45_000, interval: 100 },
  )
  await scenario.waitForComplete()
  await scenario.assertComplete()
  assert.equal(prompts, 1)
}

describe('truthful rejected background-start caption', function () {
  this.timeout(90_000)
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-background-caption-'))
    writeFileSync(join(root, '.gitignore'), 'starts.txt\n')
    writeFileSync(
      join(root, 'server.cjs'),
      [
        `require('node:fs').appendFileSync(${JSON.stringify(join(root, 'starts.txt'))}, 'start')`,
        "const server = require('node:http').createServer((q, r) => r.end('synthetic'))",
        "server.listen(0, '127.0.0.1', () => console.log('http://localhost:' + server.address().port))",
        'setTimeout(() => server.close(), 1500)',
        '',
      ].join('\n'),
    )
    const git = (...args: string[]): void => {
      execFileSync(
        'git',
        [
          '-c',
          'commit.gpgsign=false',
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@copse.invalid',
          ...args,
        ],
        { cwd: root },
      )
    }
    git('init', '-b', 'main')
    git('add', '.')
    git('commit', '-m', 'Synthetic local preview')
    resetUserData()
    seedEmptyProject(root, PROJECT, { subagentsEnabled: false, model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [{ id: PROJECT, name: 'Preview permissions', path: root }],
      activeProjectId: PROJECT,
      activeThreadId: THREAD,
      [`threads:${PROJECT}`]: [
        {
          id: THREAD,
          title: 'Preview permission check',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    resetUserData()
    removeE2eTree(root)
  })

  it('keeps a real approved start, reports rejection without starting, and retains the caption after reload', async () => {
    const artifactRoot = join(process.cwd(), 'tests/e2e/artifacts/background-start-rejected')
    mkdirSync(artifactRoot, { recursive: true })
    await requestPreview('Start this preview once.', true)
    await browser.waitUntil(() => readFileSync(join(root, 'starts.txt'), 'utf8') === 'start', {
      timeout: 10_000,
    })
    const beforeFirstExit = await observePreview()
    writeFileSync(
      join(artifactRoot, 'before-first-exit.json'),
      JSON.stringify(beforeFirstExit, null, 2) + '\n',
    )
    let cleanBeforeSecond = beforeFirstExit
    try {
      await browser.waitUntil(
        async () => {
          cleanBeforeSecond = await observePreview()
          const calls = cleanBeforeSecond.thread?.messages.flatMap((message) => message.toolCalls)
          return (
            calls?.length === 1 &&
            calls[0]?.commandPhase?.state === 'exited' &&
            calls[0].commandPhase.exitCode === 0 &&
            cleanBeforeSecond.gitStatus === '' &&
            !cleanBeforeSecond.promptState.dirty
          )
        },
        { timeout: 10_000, timeoutMsg: 'the approved preview did not exit with clean Git state' },
      )
    } finally {
      writeFileSync(
        join(artifactRoot, 'clean-before-second.json'),
        JSON.stringify(cleanBeforeSecond, null, 2) + '\n',
      )
    }
    assert.equal(cleanBeforeSecond.gitStatus, '')
    assert.equal(cleanBeforeSecond.promptState.dirty, false)
    const firstCalls =
      cleanBeforeSecond.thread?.messages.flatMap((message) => message.toolCalls) ?? []
    assert.equal(firstCalls.length, 1)
    assert.equal(firstCalls[0]?.commandPhase?.state, 'exited')
    assert.equal(firstCalls[0].commandPhase.exitCode, 0)
    await requestPreview('Do not approve this second preview.', false)
    await browser.waitUntil(
      async () => {
        const thread = (await loadProjectThreads(PROJECT)).find((thread) => thread.id === THREAD)
        const calls = thread?.messages.flatMap((message) => message.toolCalls) ?? []
        return (
          calls.length === 2 &&
          calls[0]?.commandPhase?.state === 'exited' &&
          calls[1]?.commandPhase?.state === 'not_started'
        )
      },
      { timeout: 10_000 },
    )
    const thread = (await loadProjectThreads(PROJECT)).find((thread) => thread.id === THREAD)
    writeFileSync(
      join(artifactRoot, 'history.json'),
      JSON.stringify(thread ?? null, null, 2) + '\n',
    )
    writeFileSync(
      join(artifactRoot, 'events.jsonl'),
      readFileSync(join(e2eWorkspaceDir(), PROJECT, THREAD, 'events.jsonl')),
    )
    assert.ok(thread)
    const calls = thread.messages.flatMap((message) => message.toolCalls)
    assert.equal(calls.length, 2)
    const approved = calls[0]
    const rejected = calls[1]
    assert.ok(approved)
    assert.ok(rejected)
    assert.equal(approved.commandPhase?.state, 'exited')
    assert.equal(approved.commandPhase.launched, true)
    assert.equal(approved.commandPhase.exitCode, 0)
    assert.equal(rejected.result, 'User rejected the run_background tool call.')
    assert.equal(rejected.commandPhase?.state, 'not_started')
    assert.equal(rejected.commandPhase.launched, false)
    assert.equal(readFileSync(join(root, 'starts.txt'), 'utf8'), 'start')
    const humanDirty = thread.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.dirty)
    const gitStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
    })
    writeFileSync(
      join(artifactRoot, 'before-dirty-assertions.json'),
      JSON.stringify({ approved, rejected, humanDirty, gitStatus }, null, 2) + '\n',
    )
    assert.deepEqual(humanDirty, [false, false])
    assert.equal(gitStatus, '')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const changeStats = await browser.execute(
      async ({ project, thread }) => window.api.git.changeStats(project, thread),
      { project: PROJECT, thread: THREAD },
    )
    assert.equal(changeStats, null)
    await expect($('.follow-up-bubble-changes')).not.toExist()
    await expect($('.follow-up-suggestions')).not.toBeDisplayed()
    await expect($('.prompt-input')).toHaveAttribute('data-placeholder', 'Message…')
    const approvedCard = $(`[data-tool-id="${approved.id}"]`)
    const rejectedCard = $(`[data-tool-id="${rejected.id}"]`)
    await expect(approvedCard).toHaveAttribute('data-status', 'done')
    await expect(rejectedCard).toHaveAttribute('data-status', 'interrupted')
    const labels = await browser.execute(
      ({ approvedId, rejectedId }) => {
        const visibleLabel = (id: string): HTMLElement | null => {
          const card = document.querySelector<HTMLElement>(`[data-tool-id="${CSS.escape(id)}"]`)
          const visibleCard = card?.closest<HTMLElement>('.tool-card-rollup') ?? card
          return visibleCard?.querySelector<HTMLElement>(':scope > summary .tool-name') ?? null
        }
        const element = visibleLabel(rejectedId)
        if (!element) return null
        const bounds = element.getBoundingClientRect()
        return {
          approved: visibleLabel(approvedId)?.textContent,
          rejected: element.textContent,
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          width: bounds.width,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
        }
      },
      { approvedId: approved.id, rejectedId: rejected.id },
    )
    assert.ok(labels)
    assert.equal(labels.approved, 'Started background task')
    assert.equal(labels.rejected, 'Did not start background task')
    assert.ok(labels.width > 0 && labels.left >= 0 && labels.right <= labels.viewportWidth)
    assert.ok(labels.top >= 0 && labels.bottom <= labels.viewportHeight)
    writeFileSync(
      join(artifactRoot, 'receipt.json'),
      JSON.stringify(
        {
          approved,
          rejected,
          starts: readFileSync(join(root, 'starts.txt'), 'utf8'),
          humanDirty,
          gitStatus,
          changeStats,
          followUpsVisible: await $('.follow-up-suggestions').isDisplayed(),
          composerPlaceholder: await $('.prompt-input').getAttribute('data-placeholder'),
          labels,
          nativeCardStatus: await rejectedCard.getAttribute('data-status'),
        },
        null,
        2,
      ) + '\n',
    )
    await saveAppScreenshot('background-start-rejected.png')
    assert.equal(readFileSync(join(root, 'starts.txt'), 'utf8'), 'start')
  })
})

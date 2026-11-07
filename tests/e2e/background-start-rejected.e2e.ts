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
    await requestPreview('Start this preview once.', true)
    await browser.waitUntil(() => readFileSync(join(root, 'starts.txt'), 'utf8') === 'start', {
      timeout: 10_000,
    })
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
    assert.ok(thread)
    const calls = thread.messages.flatMap((message) => message.toolCalls)
    assert.equal(calls.length, 2)
    const approved = calls[0]
    const rejected = calls[1]
    assert.ok(approved)
    assert.ok(rejected)
    assert.equal(approved.commandPhase?.state, 'exited')
    assert.equal(approved.commandPhase.launched, true)
    if (approved.commandPhase.exitCode !== undefined)
      assert.equal(approved.commandPhase.exitCode, 0)
    assert.equal(rejected.result, 'User rejected the run_background tool call.')
    assert.equal(rejected.commandPhase?.state, 'not_started')
    assert.equal(rejected.commandPhase.launched, false)
    assert.equal(readFileSync(join(root, 'starts.txt'), 'utf8'), 'start')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
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
    const artifactRoot = join(process.cwd(), 'tests/e2e/artifacts/background-start-rejected')
    mkdirSync(artifactRoot, { recursive: true })
    writeFileSync(join(artifactRoot, 'history.json'), JSON.stringify(thread, null, 2) + '\n')
    writeFileSync(
      join(artifactRoot, 'events.jsonl'),
      readFileSync(join(e2eWorkspaceDir(), PROJECT, THREAD, 'events.jsonl')),
    )
    writeFileSync(
      join(artifactRoot, 'receipt.json'),
      JSON.stringify(
        {
          approved,
          rejected,
          starts: readFileSync(join(root, 'starts.txt'), 'utf8'),
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

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
import { parkPointer, saveAppScreenshot } from './helpers/screenshot.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
  writeSeedConfig,
} from './helpers/seed-config.ts'

const PROJECT = 'background-sandbox-cleanup'
const THREAD = 'background-cleanup-thread'
const FIRST_PROMPT = 'Start the bounded local preview.'
const NEXT_PROMPT = 'Confirm that the preview finished.'
let root = ''
let head = ''
let backgroundId: string | undefined

function gitStatus(): string {
  return execFileSync('git', ['status', '--porcelain=v1', '-uall'], {
    cwd: root,
    encoding: 'utf8',
  })
}

async function savedThread(): Promise<Awaited<ReturnType<typeof loadProjectThreads>>[number]> {
  const thread = (await loadProjectThreads(PROJECT)).find((thread) => thread.id === THREAD)
  assert.ok(thread)
  return thread
}

async function promptState(): Promise<{ startingCommit: string | null; dirty: boolean }> {
  return browser.execute(({ project, thread }) => window.api.git.promptState(project, thread), {
    project: PROJECT,
    thread: THREAD,
  })
}

describe('completed background task sandbox cleanup', function () {
  this.timeout(90_000)

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-background-cleanup-'))
    writeFileSync(join(root, '.gitignore'), 'verification/\n')
    writeFileSync(join(root, 'README.md'), 'Bounded preview verification\n')
    writeFileSync(
      join(root, 'server.cjs'),
      [
        "const fs = require('node:fs')",
        "fs.mkdirSync('verification', { recursive: true })",
        "fs.appendFileSync('verification/starts.txt', 'start')",
        "const server = require('node:http').createServer((q, r) => r.end('synthetic'))",
        "server.listen(0, '127.0.0.1', () => console.log('http://localhost:' + server.address().port))",
        'const stop = () => { clearInterval(release); clearTimeout(deadline); server.close() }',
        "const release = setInterval(() => { if (fs.existsSync('verification/release')) stop() }, 20)",
        'const deadline = setTimeout(stop, 60000)',
        '',
      ].join('\n'),
    )
    const git = (...args: string[]): string =>
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
        { cwd: root, encoding: 'utf8' },
      ).trim()
    git('init', '-b', 'main')
    git('add', '.')
    git('commit', '-m', 'Bounded background preview fixture')
    head = git('rev-parse', 'HEAD')
    resetUserData()
    seedEmptyProject(root, PROJECT, { subagentsEnabled: false, model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [{ id: PROJECT, name: 'Preview cleanup', path: root }],
      activeProjectId: PROJECT,
      activeThreadId: THREAD,
      [`threads:${PROJECT}`]: [
        {
          id: THREAD,
          title: 'Bounded preview cleanup',
          status: 'idle',
          worktreeChoice: 'shared',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForDisplayed({ timeout: 30_000 })
  })

  after(async () => {
    if (backgroundId) {
      await browser.execute(
        ({ id, project, thread }) => window.api.processManager.stopBackground(id, project, thread),
        { id: backgroundId, project: PROJECT, thread: THREAD },
      )
    }
    resetUserData()
    removeE2eTree(root)
  })

  it('preserves a live preview then leaves clean Git and a clean next prompt after it closes', async () => {
    const scenario = await installMockScenario({
      title: 'Bounded preview cleanup',
      turns: [
        {
          user: FIRST_PROMPT,
          responses: [
            {
              toolCalls: [
                {
                  name: 'run_background',
                  args: {
                    action: 'start',
                    command: 'node server.cjs',
                    allow_port_binding: true,
                    wake_on_completion: false,
                    timeout_ms: 60_000,
                  },
                },
              ],
            },
            { text: 'The bounded preview is ready.' },
          ],
        },
        { user: NEXT_PROMPT, responses: [{ text: 'The preview finished; the project is clean.' }] },
      ],
    })
    const before = { status: gitStatus(), prompt: await promptState() }
    assert.deepEqual(before, { status: '', prompt: { startingCommit: head, dirty: false } })
    await setComposerValue(FIRST_PROMPT)
    await submitComposer()
    let portPrompts = 0
    await browser.waitUntil(
      async () => {
        const dialog = $('#approval-dialog')
        if ((await dialog.isExisting()) && (await dialog.getProperty('open')) === true) {
          await expect(dialog.$('.approval-heading')).toHaveText(
            'Allow this project to bind a local port?',
          )
          await expect(dialog.$('.approval-remember-input')).not.toBeSelected()
          portPrompts += 1
          await dialog.$('.approval-approve').click()
        }
        return agentIsIdle()
      },
      { timeout: 30_000, interval: 100 },
    )
    assert.equal(portPrompts, 1)
    const live = await savedThread()
    const liveCalls = live.messages.flatMap((message) => message.toolCalls)
    assert.equal(liveCalls.length, 1)
    const call = liveCalls[0]
    assert.ok(call)
    assert.equal(call.commandPhase?.state, 'running')
    assert.equal(call.commandPhase.launched, true)
    backgroundId = call.commandPhase.backgroundTaskId
    assert.ok(backgroundId)
    const liveLogs = await browser.execute(
      ({ id, project, thread }) => window.api.backgroundTasks.logs(project, thread, id),
      { id: backgroundId, project: PROJECT, thread: THREAD },
    )
    assert.ok(liveLogs)
    assert.doesNotMatch(liveLogs.logs, /\[network-scope\]/)
    const during = { status: gitStatus(), prompt: await promptState(), call }
    const artifacts = join(process.cwd(), 'tests/e2e/artifacts/background-sandbox-cleanup')
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(
      join(artifacts, 'before-during.json'),
      JSON.stringify({ before, during }, null, 2),
    )
    assert.equal(readFileSync(join(root, 'verification/starts.txt'), 'utf8'), 'start')
    writeFileSync(join(root, 'verification/release'), 'finish\n')
    await browser.waitUntil(
      async () =>
        (await savedThread()).messages
          .flatMap((message) => message.toolCalls)
          .every((call) => call.commandPhase?.state === 'exited'),
      { timeout: 15_000, timeoutMsg: 'the bounded preview did not exit after its real release' },
    )
    const afterExit = { status: gitStatus(), prompt: await promptState() }
    writeFileSync(join(artifacts, 'after-exit.json'), JSON.stringify(afterExit, null, 2))
    await browser.waitUntil(async () => gitStatus() === '' && !(await promptState()).dirty, {
      timeout: 10_000,
      timeoutMsg: 'sandbox protection artifacts kept the finished project dirty',
    })
    const clean = { status: gitStatus(), prompt: await promptState() }
    assert.deepEqual(clean, before)
    await setComposerValue(NEXT_PROMPT)
    await submitComposer()
    await scenario.waitForComplete()
    await scenario.assertComplete()
    await browser.waitUntil(agentIsIdle, { timeout: 15_000 })
    const finished = await savedThread()
    const calls = finished.messages.flatMap((message) => message.toolCalls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.commandPhase?.state, 'exited')
    assert.equal(calls[0].commandPhase.exitCode, 0)
    const humanDirty = finished.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.dirty)
    assert.deepEqual(humanDirty, [false, false])
    await expect($('.follow-up-bubble-changes')).not.toExist()
    await expect($('.prompt-input')).toHaveAttribute('data-placeholder', 'Message…')
    writeFileSync(
      join(artifacts, 'receipt.json'),
      JSON.stringify({ before, during, afterExit, clean, humanDirty, finished }, null, 2),
    )
    writeFileSync(
      join(artifacts, 'events.jsonl'),
      readFileSync(join(e2eWorkspaceDir(), PROJECT, THREAD, 'events.jsonl')),
    )
    await parkPointer()
    await saveAppScreenshot('background-sandbox-cleanup.png')
  })
})

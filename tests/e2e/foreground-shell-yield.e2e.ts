import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { installMockScenario, type ScenarioHandle } from './helpers/mock-scenario.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { parkPointer, saveAppScreenshot } from './helpers/screenshot.ts'
import { fixtureHostPids } from './helpers/foreground-fixture-processes.ts'
import { waitForAgentIdle } from './helpers.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

// A checkpoint and two independently beating processes make replay and an
// abandoned writer observable. The spec releases it; its own cap is a fail-safe.
const FIXTURE = `const fs = require('node:fs')
if (process.argv[2] === 'child') {
  setInterval(() => fs.appendFileSync('child.txt', 'x'), 50)
  setTimeout(() => process.exit(2), 60000)
} else {
  const child = require('node:child_process').spawn(process.execPath, [__filename, 'child'], { stdio: 'ignore' })
  fs.writeFileSync('pids.json', JSON.stringify({ parent: process.pid, child: child.pid }))
  fs.appendFileSync('starts.txt', 'once\\n')
  console.log('checkpoint saved; bounded check is running')
  const cap = setTimeout(() => { child.kill('SIGKILL'); process.exit(2) }, 60000)
  const timer = setInterval(() => {
    fs.appendFileSync('parent.txt', 'x')
    if (!fs.existsSync('release.txt')) return
    clearInterval(timer)
    clearTimeout(cap)
    child.kill()
    fs.writeFileSync('finished.txt', 'checked\\n')
    console.log('bounded check finished')
    process.exitCode = Number(process.argv[2] || 0)
  }, 50)
}
`

let root = ''
let card = ''
let projectId = ''
let caseNumber = 0

function alive(pid: number): boolean {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status === 1 && !result.stdout.trim()) return false
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim() !== '' && !result.stdout.trim().startsWith('Z')
}

function beats(): number[] {
  return ['parent', 'child'].map((name) => statSync(join(root, `${name}.txt`)).size)
}

async function approvePending(): Promise<void> {
  const dialog = $('#approval-dialog')
  if ((await dialog.isExisting()) && (await dialog.getProperty('open')) === true)
    await dialog.$('.approval-approve').click()
}

async function expectPhase(phase: string, text: string | RegExp): Promise<void> {
  const label = $(`${card} > summary .tool-command-phase`)
  await browser.waitUntil(
    async () => {
      if (!(await label.isExisting())) return false
      const seen = String(await label.getProperty('textContent'))
      return (
        (typeof text === 'string' ? seen === text : text.test(seen)) &&
        (await label.getAttribute('data-phase')) === phase
      )
    },
    { timeout: 30_000, interval: 100, timeoutMsg: `expected command state ${phase}` },
  )
}

async function openCard(): Promise<void> {
  await browser.execute(() => {
    for (const rollup of document.querySelectorAll<HTMLDetailsElement>('details.tool-card-rollup'))
      rollup.open = true
  })
  await $(card).waitForExist({ timeout: 10_000 })
  await browser.execute((selector) => {
    const target = document.querySelector<HTMLDetailsElement>(selector)
    for (let parent = target?.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true
    }
    if (target && !target.open) target.querySelector<HTMLElement>(':scope > summary')?.click()
  }, card)
  await $(`${card} .tool-result`).waitForExist({ timeout: 10_000 })
}

async function settleReveal(): Promise<void> {
  await browser.waitUntil(
    async () => !((await $(card).getAttribute('class')) ?? '').includes('tool-card-revealed'),
    { timeout: 5_000, interval: 100 },
  )
}

async function start(
  ending: 'success' | 'failure' | 'deadline' | 'stop' | 'quit',
): Promise<ScenarioHandle> {
  const user = 'Run the bounded check and continue only when its result is ready.'
  const scenario = await installMockScenario({
    title: 'Bounded workspace check',
    turns: [
      {
        user,
        responses: [
          {
            toolCalls: [
              {
                name: 'run_shell',
                args: {
                  command: `node hold.cjs ${ending === 'failure' ? '3' : '0'}`,
                  timeout_ms: ending === 'deadline' ? 10_000 : 60_000,
                  yield_after_ms: 1_000,
                },
              },
            ],
          },
          { text: 'The check is still running. I will wait for its result before continuing.' },
        ],
      },
      ...(ending === 'stop' || ending === 'quit'
        ? []
        : [
            {
              user: {
                includes:
                  ending === 'deadline'
                    ? 'reached its deadline'
                    : `exited with code ${ending === 'failure' ? '3' : '0'}`,
              },
              responses:
                ending === 'success'
                  ? [
                      { toolCalls: [{ name: 'read_file', args: { path: 'finished.txt' } }] },
                      {
                        toolCalls: [
                          {
                            name: 'write_file',
                            args: {
                              path: 'dependent.txt',
                              content: 'Only after the completed check.\n',
                            },
                          },
                        ],
                      },
                      { text: 'The check passed. I continued from the saved checkpoint.' },
                    ]
                  : [
                      {
                        text:
                          ending === 'deadline'
                            ? 'The check reached its deadline. Its checkpoint and logs are retained.'
                            : 'The check failed with exit code 3. Its checkpoint and logs are retained.',
                      },
                    ],
            },
          ]),
    ],
  })
  await setComposerValue(user)
  await submitComposer()
  await browser.waitUntil(
    async () => {
      await approvePending()
      return existsSync(join(root, 'pids.json')) && existsSync(join(root, 'child.txt'))
    },
    { timeout: 30_000, interval: 100, timeoutMsg: 'the bounded command did not start' },
  )
  await scenario.waitForTurns(1)
  await waitForAgentIdle(30_000)
  const id = await browser.execute(() =>
    Array.from(document.querySelectorAll('.tool-command-phase'))
      .at(-1)
      ?.closest('details.tool-card')
      ?.getAttribute('data-tool-id'),
  )
  assert.ok(id)
  card = `details.tool-card[data-tool-id="${id}"]`
  await expectPhase('running', /^Background task \S+$/)
  await openCard()
  await expect($(`${card} .tool-result`)).toHaveText(expect.stringContaining('has not completed'))
  assert.equal(existsSync(join(root, 'dependent.txt')), false)
  assert.equal(readFileSync(join(root, 'starts.txt'), 'utf8'), 'once\n')
  return scenario
}

describe('bounded foreground command yielding', function () {
  this.timeout(120_000)

  beforeEach(async () => {
    resetUserData()
    // The prior turn is finished before this hook. Remove only this spec's
    // isolated stores so prior cases do not become unrelated orphan UI.
    const store = e2eWorkspaceDir()
    if (existsSync(store)) {
      for (const project of readdirSync(store)) {
        if (project.startsWith('e2e-foreground-shell-yield')) removeE2eTree(join(store, project))
      }
    }
    root = seedStableWorkspace({ files: { 'hold.cjs': FIXTURE } })
    projectId = `e2e-foreground-shell-yield-${String(++caseNumber)}`
    seedEmptyProject(root, projectId, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  afterEach(() => {
    for (const pid of fixtureHostPids(root)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // A completed, cancelled or timed-out fixture is already gone.
      }
    }
    resetUserData()
  })

  it('keeps the original process and defers dependent edits until its one completion wake', async () => {
    const scenario = await start('success')
    const pids = fixtureHostPids(root)
    assert.equal(pids.length, 2)
    assert.ok(pids.every(alive))
    await $(`${card} .tool-task-logs-button`).click()
    await expect($(`${card} .tool-task-logs-output pre`)).toHaveText(
      'checkpoint saved; bounded check is running',
    )
    await parkPointer()
    await saveAppScreenshot('foreground-shell-yield-running.png')
    const wakeCount = (await $$('.msg-machine-origin').getElements()).length
    writeFileSync(join(root, 'release.txt'), '')
    await browser.waitUntil(
      async () => {
        await approvePending()
        return existsSync(join(root, 'dependent.txt'))
      },
      { timeout: 30_000, interval: 100 },
    )
    await scenario.waitForComplete()
    await waitForAgentIdle(30_000)
    await $('.msg-machine-origin .msg-origin-command-link').click()
    await openCard()
    // Successful exits intentionally retire the phase badge. Check the saved
    // exit as well as the visible success state, rather than inventing a badge.
    const phase = await browser.execute(async (project) => {
      const threadId =
        document.querySelector<HTMLElement>('.chat-row.selected')?.dataset['threadId']
      if (!threadId) throw new Error('No selected thread')
      const messages = await window.api.threads.loadMessages(project, threadId)
      return messages
        .flatMap((message) => message.toolCalls)
        .find((call) => call.name === 'run_shell')?.commandPhase
    }, projectId)
    assert.ok(phase)
    assert.equal(phase.state, 'exited')
    assert.equal(phase.exitCode, 0)
    await expect($(`${card} .tool-command-phase`)).not.toExist()
    await expect($(`${card} .tool-status-icon`)).toHaveAttribute('aria-label', 'done')
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('The check passed. I continued from the saved checkpoint.'),
    )
    assert.equal((await $$('.msg-machine-origin').getElements()).length, wakeCount + 1)
    assert.equal(readFileSync(join(root, 'starts.txt'), 'utf8'), 'once\n')
    assert.equal(
      readFileSync(join(root, 'dependent.txt'), 'utf8'),
      'Only after the completed check.\n',
    )
    await browser.waitUntil(async () => pids.every((pid) => !alive(pid)), { timeout: 10_000 })
    await settleReveal()
    await parkPointer()
    await saveAppScreenshot('foreground-shell-yield-completed.png')
  })

  for (const ending of ['failure', 'deadline'] as const) {
    it(`retains the checkpoint and reports the ${ending} without replay`, async () => {
      const scenario = await start(ending)
      const pids = fixtureHostPids(root)
      if (ending === 'failure') writeFileSync(join(root, 'release.txt'), '')
      await scenario.waitForComplete(30_000)
      await waitForAgentIdle(30_000)
      await $('.msg-machine-origin .msg-origin-command-link').click()
      await openCard()
      await expectPhase(
        ending === 'deadline' ? 'timed_out' : 'exited',
        ending === 'deadline' ? 'Timed out' : 'Exit 3',
      )
      assert.equal(readFileSync(join(root, 'starts.txt'), 'utf8'), 'once\n')
      assert.equal(existsSync(join(root, 'dependent.txt')), false)
      await browser.waitUntil(async () => pids.every((pid) => !alive(pid)), { timeout: 10_000 })
      await settleReveal()
      await parkPointer()
      await saveAppScreenshot(
        ending === 'deadline'
          ? 'foreground-shell-yield-deadline.png'
          : 'foreground-shell-yield-failed.png',
      )
    })
  }

  it('cancels the owned process tree through the existing Background tasks control', async () => {
    const scenario = await start('stop')
    const pids = fixtureHostPids(root)
    await $('button[aria-label="Open terminal"]').click()
    const cancel = $('.supervised-task-row[data-state="running"] .supervised-task-cancel')
    await cancel.waitForDisplayed({ timeout: 10_000 })
    await cancel.click()
    await expectPhase('cancelled', 'Stopped')
    await browser.waitUntil(async () => pids.every((pid) => !alive(pid)), { timeout: 10_000 })
    const frozen = beats()
    await browser.pause(300)
    assert.deepEqual(beats(), frozen)
    assert.equal(existsSync(join(root, 'finished.txt')), false)
    assert.equal((await $$('.msg-machine-origin').getElements()).length, 0)
    await scenario.assertComplete()
    await $('button[aria-label="Open terminal"]').click()
    await openCard()
    await expect($(`${card} .tool-command-phase[data-phase="cancelled"]`)).toBeDisplayed()
    await parkPointer()
    await saveAppScreenshot('foreground-shell-yield-cancelled.png')
  })

  it('drains the adopted process tree when the isolated app quits', async () => {
    const scenario = await start('quit')
    const pids = fixtureHostPids(root)
    assert.equal(pids.length, 2)
    await scenario.assertComplete()
    const mainPid = await browser.execute(
      async () =>
        (await window.api.processManager.snapshot()).processes.find((row) => row.type === 'App')
          ?.pid ?? null,
    )
    assert.ok(mainPid !== null && mainPid > 1)
    process.kill(mainPid, 'SIGTERM')
    await browser.waitUntil(
      async () => {
        if (!alive(mainPid)) return true
        try {
          const confirm = $('#confirm-dialog')
          if (await confirm.isDisplayed()) await confirm.$('.confirm-dialog-confirm').click()
        } catch (error) {
          if (!/no such window|web view not found/.test(String(error))) throw error
        }
        return !alive(mainPid)
      },
      { timeout: 30_000, interval: 100, timeoutMsg: 'isolated Copse did not finish shutdown' },
    )
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => pids.every((pid) => !alive(pid)), { timeout: 10_000 })
    const frozen = beats()
    await browser.pause(300)
    assert.deepEqual(beats(), frozen)
    assert.equal(readFileSync(join(root, 'starts.txt'), 'utf8'), 'once\n')
    assert.equal(existsSync(join(root, 'finished.txt')), false)
    assert.equal(existsSync(join(root, 'dependent.txt')), false)
  })
})

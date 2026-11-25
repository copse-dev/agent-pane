import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { fixtureHostPids } from './helpers/foreground-fixture-processes.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { waitForAgentIdle } from './helpers.ts'
import type { MockScenario } from '../../packages/llm/src/mock-script.ts'

const RESTART_RESUME_NOTE = 'Copse restarted during this turn. Continuing where it stopped.'

let root = ''
let owned: number[] = []
function alive(pid: number): boolean {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status === 1 && !result.stdout.trim()) return false
  assert.equal(result.status, 0, result.stderr)
  const status = result.stdout.trim()
  return status !== '' && !status.startsWith('Z')
}
function beats(): number[] {
  return ['parent', 'child'].map((kind) => statSync(join(root, `${kind}.txt`)).size)
}

describe('quit during an owned foreground command', function () {
  this.timeout(120_000)
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-foreground-quit-'))
    writeFileSync(
      join(root, 'hold.cjs'),
      "const fs=require('node:fs');process.on('SIGTERM',()=>{});if(process.argv[2]==='child'){setInterval(()=>fs.appendFileSync('child.txt','x'),100);setTimeout(()=>process.exit(0),90000)}else{const c=require('node:child_process').spawn(process.execPath,[__filename,'child'],{stdio:'ignore'});fs.writeFileSync('pids.json',JSON.stringify({parent:process.pid,child:c.pid}));setInterval(()=>fs.appendFileSync('parent.txt','x'),100);setTimeout(()=>{c.kill('SIGKILL');process.exit(0)},90000)}\n",
    )
    execFileSync('git', ['init', '-b', 'main'], { cwd: root })
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@copse.invalid',
        'commit',
        '-m',
        'Synthetic owned process fixture',
      ],
      { cwd: root },
    )
    resetUserData()
    seedEmptyProject(root, 'e2e-foreground-shell-quit', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      // This spec covers the in-app path: quit cuts the turn off and the next
      // launch continues it. With the hand-off on, a background worker would
      // take the turn instead and the quit dialog would offer "Close".
      continueTurnsAfterQuit: false,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    for (const pid of fixtureHostPids(root)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    resetUserData()
    if (root) removeE2eTree(root)
  })

  it('drains the process group before quitting and continues the turn once on relaunch', async () => {
    const prompt = 'Record a checkpoint, then run the bounded foreground check.'
    const interruptedScenario: MockScenario = {
      title: 'Bounded check interrupted by quit',
      turns: [
        {
          user: prompt,
          responses: [
            {
              toolCalls: [
                {
                  name: 'write_file',
                  args: { path: 'checkpoint.txt', content: 'completed once\n' },
                },
              ],
            },
            {
              toolCalls: [
                { name: 'run_shell', args: { command: 'node hold.cjs', timeout_ms: 90_000 } },
                {
                  name: 'write_file',
                  args: { path: 'after-quit.txt', content: 'This queued edit must not run.\n' },
                },
              ],
            },
            { text: 'The check is done.' },
          ],
          allowAbort: true,
        },
      ],
    }
    // This scenario deliberately dies with the process; register it at the
    // existing fixture boundary rather than expecting post-restart completion.
    await browser.execute(async (scenario) => {
      const bridge = window.__copseE2e
      if (!bridge) throw new Error('Mock scenario bridge unavailable')
      const scope = document.querySelector<HTMLElement>('.chat-row.selected')?.dataset['threadId']
      await bridge.setMockScenario('foreground-shell-before-quit', scenario, scope)
    }, interruptedScenario)
    await setComposerValue(prompt)
    await submitComposer()
    await browser.waitUntil(
      async () => {
        const dialog = $('#approval-dialog')
        if ((await dialog.isExisting()) && (await dialog.getProperty('open')) === true)
          await dialog.$('.approval-approve').click()
        return (
          existsSync(join(root, 'pids.json')) &&
          existsSync(join(root, 'child.txt')) &&
          beats().every((n) => n > 1)
        )
      },
      { timeout: 30_000, interval: 100 },
    )
    owned = fixtureHostPids(root)
    assert.equal(owned.length, 2)
    assert.ok(owned.every(alive))
    assert.equal(existsSync(join(root, 'after-quit.txt')), false)
    // Process heartbeats establish running work, not the asynchronous Git
    // summary. Capture only after the composer reports all four fixture files.
    await expect($('.follow-up-bubble-changes .follow-up-stat-add')).toHaveText('+4')
    await expect($('.prompt-input')).toHaveAttribute('data-placeholder', 'Send follow-up')
    assert.ok(owned.every(alive), 'the readiness wait must preserve the running-process state')
    assert.equal(existsSync(join(root, 'after-quit.txt')), false)
    await saveAppScreenshot('foreground-shell-before-quit.png')
    const mainPid = await browser.execute(
      async () =>
        (await window.api.processManager.snapshot()).processes.find((row) => row.type === 'App')
          ?.pid ?? null,
    )
    assert.ok(mainPid !== null && mainPid > 1)
    process.kill(mainPid, 'SIGTERM')
    // Copse's signal handler approves quit without interaction. Some Electron
    // versions handle the signal as a native quit first and show confirmation;
    // answer it when offered, but never require it on the direct signal path.
    await browser.waitUntil(
      async () => {
        if (!alive(mainPid)) return true
        try {
          const confirm = $('#confirm-dialog')
          if (await confirm.isDisplayed()) {
            await expect(confirm.$('.confirm-dialog-confirm')).toHaveText('Close anyway')
            await confirm.$('.confirm-dialog-confirm').click()
          }
        } catch (error) {
          // The renderer can close before main finishes draining. Only the
          // actual main-process exit below satisfies the shutdown condition.
          if (!/no such window|web view not found/.test(String(error))) throw error
        }
        return !alive(mainPid)
      },
      {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: 'isolated Copse did not finish shutdown',
      },
    )
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => owned.every((pid) => !alive(pid)), {
      timeout: 10_000,
      timeoutMsg: 'an owned foreground process survived Copse quit',
    })
    const frozen = beats()
    await browser.pause(300)
    assert.deepEqual(beats(), frozen)
    assert.equal(readFileSync(join(root, 'checkpoint.txt'), 'utf8'), 'completed once\n')
    assert.equal(
      existsSync(join(root, 'after-quit.txt')),
      false,
      'quit must interrupt the owning turn before a queued edit can run',
    )
    // The cut-off turn continues by itself on relaunch, once, from the saved
    // history (`interrupted-turn-resume.ts`); the killed command is not rerun.
    // Its reply is the mock fallback (scenarios lived in the old process), which
    // the screenshot guard refuses, so this state has no screenshot.
    await expect($('.msg-user.msg-machine-origin')).toHaveText(RESTART_RESUME_NOTE, {
      containing: true,
    })
    await waitForAgentIdle(15_000)
    await expect($('[data-turn-recovery-card]')).not.toExist()
    assert.equal(readFileSync(join(root, 'checkpoint.txt'), 'utf8'), 'completed once\n')
    const retained = ['checkpoint.txt', 'pids.json', 'parent.txt', 'child.txt'].map((name) => ({
      name,
      contents: readFileSync(join(root, name), 'utf8'),
    }))
    const composerState = (): Promise<{ changes: string | null; placeholder: string | null }> =>
      browser.execute(() => ({
        changes: document.querySelector('.follow-up-bubble-changes')?.textContent ?? null,
        placeholder:
          document.querySelector('.prompt-input')?.getAttribute('data-placeholder') ?? null,
      }))
    const beforeReady = await composerState()
    // Follow-up generation and its subsequent changes refresh finish after
    // agent idle. Wait for the preserved four-file checkpoint's visible state.
    await expect($('.follow-up-bubble-changes .follow-up-stat-add')).toHaveText('+4')
    await expect($('.prompt-input')).toHaveAttribute('data-placeholder', 'Send follow-up')
    for (const file of retained) {
      assert.equal(readFileSync(join(root, file.name), 'utf8'), file.contents)
    }
    const afterReady = await composerState()
    const artifactDirectory = join(process.cwd(), '.tmp')
    mkdirSync(artifactDirectory, { recursive: true })
    writeFileSync(
      join(artifactDirectory, 'foreground-shell-quit-composer-control.json'),
      JSON.stringify(
        {
          before: beforeReady,
          after: afterReady,
          files: retained.map((file) => ({
            name: file.name,
            before: file.contents,
            after: readFileSync(join(root, file.name), 'utf8'),
          })),
        },
        null,
        2,
      ),
    )
    console.info(
      '[foreground-shell-quit] preserved-file composer readiness',
      JSON.stringify({
        before: beforeReady,
        after: afterReady,
        preservedFiles: retained.map((file) => file.name),
      }),
    )
    // No closing screenshot: the continued turn's reply is the mock fallback
    // (see above), which the screenshot guard refuses.
  })
})

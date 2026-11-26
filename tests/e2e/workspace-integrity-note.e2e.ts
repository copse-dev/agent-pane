import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { parkPointer, saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT = 'workspace-integrity-note'
const THREAD = 'workspace-integrity-thread'
const PROMPT = 'Track main upstream and set up the file watcher.'
let root = ''

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

// A contained run_shell that sets a program-starting git key alongside an
// inert one: the card shows the command's output followed by Copse's note,
// and only the program-starting key is undone.
describe('workspace integrity note on a contained command', function () {
  this.timeout(90_000)

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-integrity-note-'))
    writeFileSync(join(root, 'README.md'), 'Integrity note fixture\n')
    git('init', '-q', '-b', 'main')
    git('remote', 'add', 'origin', 'https://github.com/example/repo.git')
    resetUserData()
    seedEmptyProject(root, PROJECT, { subagentsEnabled: false, model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [{ id: PROJECT, name: 'Integrity note', path: root }],
      activeProjectId: PROJECT,
      activeThreadId: THREAD,
      [`threads:${PROJECT}`]: [
        {
          id: THREAD,
          title: 'Git watcher setup',
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

  after(() => {
    resetUserData()
    removeE2eTree(root)
  })

  it('appends the revert note to the command output and keeps the upstream', async () => {
    const scenario = await installMockScenario({
      title: 'Git watcher setup',
      turns: [
        {
          user: PROMPT,
          responses: [
            {
              toolCalls: [
                {
                  name: 'run_shell',
                  args: {
                    command:
                      'git config branch.main.remote origin && git config core.fsmonitor ./watch.sh && echo configured',
                  },
                },
              ],
            },
            { text: 'Copse undid the watcher setting. I will ask you before setting it.' },
          ],
        },
      ],
    })
    await setComposerValue(PROMPT)
    await submitComposer()
    await scenario.waitForComplete()
    await waitForAgentIdle(30_000)
    await scenario.assertComplete()
    // Contained without a prompt: no approval was needed to reach the note.
    await expect($('#approval-dialog[open]')).not.toExist()

    const id = await browser.execute(() =>
      Array.from(document.querySelectorAll('details.tool-card'))
        .at(-1)
        ?.getAttribute('data-tool-id'),
    )
    assert.ok(id)
    const card = `details.tool-card[data-tool-id="${id}"]`
    await browser.execute((selector) => {
      for (const rollup of document.querySelectorAll<HTMLDetailsElement>(
        'details.tool-card-rollup',
      ))
        rollup.open = true
      const target = document.querySelector<HTMLDetailsElement>(selector)
      for (let parent = target?.parentElement; parent; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true
      }
      if (target && !target.open) target.querySelector<HTMLElement>(':scope > summary')?.click()
    }, card)
    const result = $(`${card} .tool-result`)
    await result.waitForExist({ timeout: 10_000 })
    await expect(result).toHaveText(expect.stringContaining('configured'))
    await expect(result).toHaveText(
      expect.stringContaining('.git/config: modified (core.fsmonitor), reverted'),
    )
    await expect(result).toHaveText(expect.stringContaining('ask the user to make it'))

    const config = readFileSync(join(root, '.git/config'), 'utf8')
    assert.equal(config.includes('fsmonitor'), false)
    assert.equal(git('config', 'branch.main.remote'), 'origin')

    await result.scrollIntoView({ block: 'center' })
    await parkPointer()
    await saveAppScreenshot('workspace-integrity-note.png')
  })
})

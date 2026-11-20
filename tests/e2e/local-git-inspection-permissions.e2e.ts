import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { agentIsIdle } from './helpers.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

let root = ''
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

describe('local Git inspection permission prompts', function () {
  this.timeout(90_000)
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-local-git-inspection-'))
    git('init', '-b', 'main')
    writeFileSync(join(root, 'README.md'), '# Synthetic permission fixture\n')
    git('add', '.')
    git(
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@copse.invalid',
      'commit',
      '-m',
      'Synthetic local Git fixture',
    )
    git('remote', 'add', 'origin', 'https://example.invalid/fixture.git')
    resetUserData()
    seedEmptyProject(root, 'e2e-local-git-inspection', {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    resetUserData()
    if (root) removeE2eTree(root)
  })

  it('reads local Git metadata without approval and still asks before remote update', async () => {
    const prompt = 'Inspect this checkout locally, then ask before updating the remote.'
    const scenario = await installMockScenario({
      title: 'Inspect local Git metadata',
      turns: [
        {
          user: prompt,
          responses: [
            {
              toolCalls: [
                {
                  name: 'run_shell',
                  args: { command: 'git branch --show-current && git remote -v' },
                },
              ],
            },
            {
              toolCalls: [
                {
                  name: 'run_shell',
                  args: {
                    command:
                      "git cat-file commit HEAD | sed -n '/^tree /{s/^tree /Commit tree: /;p;}'",
                  },
                },
              ],
              expectToolResults: [
                { name: 'run_shell', includes: 'https://example.invalid/fixture.git' },
              ],
            },
            {
              toolCalls: [{ name: 'run_shell', args: { command: 'git remote update' } }],
              expectToolResults: [{ name: 'run_shell', includes: 'Commit tree:' }],
            },
            {
              text: 'Read the local branch, configured URLs and commit tree. The remote update was declined.',
            },
          ],
        },
      ],
    })
    await setComposerValue(prompt)
    await submitComposer()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog).toHaveText('git remote update', { containing: true })
    await expect(dialog).not.toHaveText('git remote -v', { containing: true })
    await expect(dialog).not.toHaveText('/^tree', { containing: true })
    await saveAppScreenshot('local-git-inspection-remote-update-approval.png')
    await dialog.$('.approval-reject').click()
    await scenario.waitForComplete()
    await scenario.assertComplete()
    await browser.waitUntil(agentIsIdle, { timeout: 15_000 })
    assert.equal(git('remote', 'get-url', 'origin'), 'https://example.invalid/fixture.git')
    await expect($('.messages-list')).toHaveText('The remote update was declined.', {
      containing: true,
    })
    await saveAppScreenshot('local-git-inspection-complete.png')
  })
})

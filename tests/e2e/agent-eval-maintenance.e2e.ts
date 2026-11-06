import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { waitForAgentIdle } from './helpers.ts'
import { acceptanceWakeTurn } from './helpers/acceptance-wake.ts'
import { acceptEvalProposals, selectEvalBranch } from './helpers/agent-eval-ui.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const PROJECT_ID = 'agent-eval-maintenance-project'

describe('agent eval maintenance interactions', function () {
  this.timeout(120_000)
  const roots: string[] = []

  after(() => {
    writeE2eEnv({ COPSE_PANEL_MOCK_BRANCH: undefined })
    resetUserData()
    for (const root of roots) removeE2eTree(root)
  })

  it('applies single and multiple proposals even when Changes is closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-eval-proposals-'))
    roots.push(root)
    resetUserData()
    seedEmptyProject(root, PROJECT_ID, { subagentsEnabled: false, model: 'claude-sonnet-4-6' })
    await browser.reloadSession()

    for (const paths of [['single.txt'], ['second.txt', 'third.txt']]) {
      const user = `Prepare ${paths.join(' and ')} for review.`
      const reply = `Proposed ${paths.join(', ')}.`
      const accepted = `Applied ${paths.join(', ')}.`
      const scenario = await installMockScenario({
        title: user,
        turns: [
          {
            user,
            responses: [
              {
                toolCalls: paths.map((path) => ({
                  name: 'write_file',
                  args: { path, content: `${path} accepted\n` },
                })),
              },
              { text: reply },
            ],
          },
          acceptanceWakeTurn(paths, accepted),
        ],
      })
      await setComposerValue(user)
      await submitComposer()
      await waitForAgentIdle()
      await expectAssistantReply(reply)
      for (const path of paths) assert.equal(existsSync(join(root, path)), false)

      await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })
      if (paths.length === 1) {
        await expect($('.git-changes-bulk-actions')).not.toBeDisplayed()
      }
      await $('.titlebar-btn[aria-label="Open changes"]').click()
      await expect($('#git-changes-host')).not.toBeDisplayed()
      assert.equal(await acceptEvalProposals(PROJECT_ID), true)
      await scenario.waitForComplete()
      await expectAssistantReply(accepted)
      await waitForAgentIdle()
      await scenario.assertComplete()
      for (const path of paths) {
        assert.equal(readFileSync(join(root, path), 'utf8'), `${path} accepted\n`)
      }
      assert.equal(await acceptEvalProposals(PROJECT_ID), false)
    }
    await assertNoErrorToasts('eval proposal acceptance')
    await saveAppScreenshot('agent-eval-proposals-applied.png')
  })

  it('selects an existing feature branch and submits its dirty checkout warning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-eval-branch-'))
    roots.push(root)
    const git = (args: string[]): string =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()
    git(['init', '-q', '-b', 'main'])
    writeFileSync(join(root, 'README.md'), '# Existing project\n')
    git(['add', 'README.md'])
    git([
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'Existing project',
    ])
    const branch = 'feature/existing-project'
    git(['switch', '-c', branch])
    writeFileSync(join(root, 'README.md'), '# Existing project\n\nUncommitted work.\n')
    resetUserData()
    seedEmptyProject(root, `${PROJECT_ID}-branch`, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    writeE2eEnv({ COPSE_PANEL_MOCK_BRANCH: '' })
    await browser.reloadSession()
    await selectEvalBranch(branch)
    await expect($('.branch-picker-trigger')).toHaveText(expect.stringContaining(branch))
    const user = 'Review this existing feature branch.'
    const scenario = await installMockScenario({
      title: user,
      turns: [{ user, responses: [{ text: 'Reviewed the selected feature branch.' }] }],
    })
    await setComposerValue(user)
    await submitComposer()
    await scenario.waitForComplete()
    await waitForAgentIdle()
    await scenario.assertComplete()
    assert.equal(git(['branch', '--show-current']), branch)
    assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /Uncommitted work/)
    await expect($('.composer-dirty-send-btn')).not.toBeDisplayed()
    await assertNoErrorToasts('eval branch selection')
    await saveAppScreenshot('agent-eval-existing-branch.png')
  })
})

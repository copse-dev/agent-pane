import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'

const BRANCH = 'copse/readable-push'
const REMOTE_SHA = '1234567890abcdef1234567890abcdef12345678'
const REPLY = 'The push was declined. No branch was published.'

async function showPushPrompt(args: { branch: string; expected_remote_sha?: string }): Promise<{
  body: string
  scenario: Awaited<ReturnType<typeof installMockScenario>>
}> {
  const scenario = await installMockScenario({
    title: 'Publish the branch',
    turns: [
      {
        user: 'Publish the branch.',
        responses: [{ toolCalls: [{ name: 'git_push', args }] }, { text: REPLY }],
      },
    ],
  })
  await setComposerValue('Publish the branch.')
  await submitComposer()
  const dialog = await $('#approval-dialog').getElement()
  await dialog.waitForDisplayed({ timeout: 30_000 })
  await expect(dialog.$('.approval-heading')).toHaveText('Push branch to origin?')
  await expect(dialog.$('.approval-approve')).toHaveText('Push branch')
  const body = await dialog.$('.approval-body').getText()
  assert.ok(body.includes(`Branch: ${BRANCH}`))
  assert.ok(body.includes('Remote: origin (same branch name)'))
  assert.doesNotMatch(body, /expected_remote_sha|"branch"/)
  return { body, scenario }
}

async function declinePush(): Promise<void> {
  await $('#approval-dialog .approval-reject').click()
  await waitForAgentIdle(30_000)
  await expectAssistantReply(REPLY)
}

describe('readable branch push approval', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-readable-push-approval', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    resetUserData()
  })

  it('names the branch and remote without a JSON dump', async () => {
    const { body, scenario } = await showPushPrompt({ branch: BRANCH })
    assert.ok(body.includes('No force push.'))
    await saveElementScreenshot('#approval-dialog', 'git-push-readable-approval.png')
    await declinePush()
    await scenario.assertComplete()
  })

  it('retains the full expected remote commit for a force-with-lease push', async () => {
    const { body, scenario } = await showPushPrompt({
      branch: BRANCH,
      expected_remote_sha: REMOTE_SHA,
    })
    assert.ok(body.includes('Force with lease:'))
    assert.ok(body.includes(REMOTE_SHA))
    assert.ok(body.includes('Never bare force.'))
    assert.ok(!body.includes('No force push.'))
    await saveElementScreenshot('#approval-dialog', 'git-push-lease-approval.png')
    await declinePush()
    await scenario.assertComplete()
  })
})

import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT = 'e2e-subthread-orchestration'
const REQUEST = 'Start two bounded subthreads and report when both were submitted.'
const FIRST = 'Report the first subthread result.'
const SECOND = 'Report the second subthread result.'

describe('parent thread orchestration', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), PROJECT, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      worktreeMode: 'always',
    })
    await browser.reloadSession()
  })
  after(() => {
    resetUserData()
  })

  it('one approval starts two isolated children through the normal queue, then can be revoked', async function () {
    this.timeout(120_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const first = await installMockScenario(
      {
        title: 'First child',
        turns: [{ user: FIRST, responses: [{ text: 'First child completed.' }] }],
      },
      null,
    )
    const second = await installMockScenario(
      {
        title: 'Second child',
        turns: [{ user: SECOND, responses: [{ text: 'Second child completed.' }] }],
      },
      null,
    )
    const parent = await installMockScenario({
      title: 'Orchestrate two children',
      turns: [
        {
          user: REQUEST,
          responses: [
            {
              toolCalls: [
                {
                  name: 'subthreads',
                  args: { action: 'start', key: 'first', title: 'First child', prompt: FIRST },
                },
              ],
            },
            {
              expectToolResults: [{ name: 'subthreads', includes: '"ok":true' }],
              toolCalls: [
                {
                  name: 'subthreads',
                  args: { action: 'start', key: 'second', title: 'Second child', prompt: SECOND },
                },
              ],
            },
            {
              expectToolResults: [{ name: 'subthreads', includes: '"ok":true' }],
              toolCalls: [{ name: 'subthreads', args: { action: 'list' } }],
            },
            {
              text: 'Both children were submitted.',
              expectToolResults: [{ name: 'subthreads', includes: 'Second child' }],
            },
          ],
        },
      ],
    })
    const parentId = await $('.chat-row.selected').getAttribute('data-thread-id')
    assert.ok(parentId)
    await setComposerValue(REQUEST)
    await submitComposer()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Allow subthread orchestration?')
    await expect(dialog.$('.approval-advice')).toHaveText(
      expect.stringContaining('Only subthreads created by this thread'),
    )
    await saveElementScreenshot('#approval-dialog', 'subthread-orchestration-approval.png')
    await dialog.$('.approval-approve').click()
    await expectAssistantReply('Both children were submitted.')
    await first.waitForComplete()
    await second.waitForComplete()
    await parent.assertComplete()
    await first.assertComplete()
    await second.assertComplete()
    await expect($('#approval-dialog')).not.toBeDisplayed()
    assert.equal(await $('.chat-row.selected').getAttribute('data-thread-id'), parentId)

    await browser.waitUntil(
      async () =>
        browser.execute(
          async ({ projectId, owner }) => {
            const threads = await window.api.threads.loadProject(projectId)
            const ownership = (await window.api.settings.getSnapshot()).threadSubthreadOwners
            const ids = (ownership ?? [])
              .filter((entry) => entry.projectId === projectId && entry.parentThreadId === owner)
              .map((entry) => entry.threadId)
            const children = threads.filter((thread) => ids.includes(thread.id))
            if (children.some((thread) => thread.followUpOf !== undefined)) return false
            if (children.length !== 2 || !children.every((thread) => thread.worktree?.path))
              return false
            const replies = await Promise.all(
              children.map(async (thread) =>
                (await window.api.threads.loadMessages(projectId, thread.id)).some(
                  (message) =>
                    message.role === 'assistant' && message.content.includes('child completed.'),
                ),
              ),
            )
            return (
              replies.every(Boolean) && children[0]?.worktree?.path !== children[1]?.worktree?.path
            )
          },
          { projectId: PROJECT, owner: parentId },
        ),
      {
        timeout: 20_000,
        timeoutMsg: 'Both isolated child threads must persist their actual replies',
      },
    )

    if (!(await $('#pane-files').isDisplayed()))
      await $('[aria-label="Toggle right panel"]').click()
    await $('[aria-label="Open thread context"]').click()
    const revoke = $('[data-action="revoke-orchestrate-access"]')
    await revoke.waitForDisplayed()
    await revoke.scrollIntoView({ block: 'center' })
    await expect($('[data-access="orchestrate"]')).toHaveText(
      expect.stringContaining('Orchestrate own subthreads'),
    )
    await saveElementScreenshot('#pane-files', 'subthread-orchestration-permission.png')
    await revoke.click()
    await expect($('[data-access="orchestrate"]')).not.toExist()
    const grants = await browser.execute(async () =>
      window.api.settings.get('threadSubthreadAccess'),
    )
    assert.ok(Array.isArray(grants) && !grants.includes(parentId))
  })
})

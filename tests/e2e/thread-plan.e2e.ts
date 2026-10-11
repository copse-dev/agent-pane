import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { installMockScenario, expectAssistantReply } from './helpers/mock-scenario.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'

const PROJECT = 'e2e-thread-plan'
const BODY =
  '# Goal\nMake sign-in recover after a session expires.\n\n# Constraints\nKeep existing sessions and the public API.\n\n# Scope\nSign-in form and session recovery tests.\n\n# Definition of done\n- Sign-in succeeds after session expiry  \n  without deleting existing sessions.\n- Existing sessions remain valid.\n- Focused regression tests pass.'

let firstBody = ''
let secondBody = ''

async function readPlan() {
  return browser.execute(async (projectId) => {
    const threadId = document.querySelector<HTMLElement>('.chat-row.selected')?.dataset.threadId
    if (!threadId) throw new Error('Missing selected thread')
    return window.api.plans.get(projectId, threadId)
  }, PROJECT)
}

async function selectPassage(text: string, feedbackVisible = true): Promise<void> {
  await browser.execute((passage) => {
    const editor = document.querySelector<HTMLElement>('#plan-body')
    if (!editor) throw new Error('Missing document editor')
    editor.focus()
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const start = node.textContent?.indexOf(passage) ?? -1
      if (start >= 0) {
        const range = document.createRange()
        range.setStart(node, start)
        range.setEnd(node, start + passage.length)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      node = walker.nextNode()
    }
    throw new Error(`Missing passage: ${passage}`)
  }, text)
  if (feedbackVisible) await expect($('.plan-selected-passage')).toHaveText(text)
  else
    await browser.waitUntil(
      async () => (await browser.execute(() => window.getSelection()?.toString())) === text,
    )
}

describe('optional thread plan', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.chat-row.selected').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    resetUserData()
  })

  it('reviews revisions and passage feedback', async () => {
    await $('[data-testid="open-plan"]').click()
    const dialog = await $('#thread-plan-dialog')
    await dialog.waitForDisplayed()
    await $('#plan-title').waitForEnabled()
    await browser.waitUntil(async () => !(await $('#plan-title').getProperty('readOnly')))
    await $('#plan-title').setValue('Recover expired sessions')
    await dialog.$('button=Markdown').click()
    await $('#plan-source').setValue(BODY)
    await dialog.$('button=Document').click()
    await expect($('#plan-body h1')).toHaveText('Goal')
    await browser.keys('Escape')
    await expect(dialog).toBeDisplayed()
    await expect($('.thread-plan-error')).toHaveText(
      'Save your revision or choose Discard edits and close.',
    )
    await expect(dialog.$('button=Discard edits and close')).toExist()
    await saveElementScreenshot('#thread-plan-dialog', 'thread-plan-unsaved.png')
    await selectPassage('Goal', false)
    await dialog.$('[aria-label="Bold"]').click()
    await expect($('#plan-body h1 strong')).toHaveText('Goal')
    await dialog.$('button=Start planning').click()
    await expect(dialog.$('[data-testid="plan-status"]')).toHaveText('draft · r1')
    firstBody = (await readPlan())?.body ?? ''
    await expect(firstBody).toContain('# **Goal**')
    await expect(firstBody).toContain('without deleting existing sessions.')
    const blocked = await browser.execute(async (projectId) => {
      const threadId = document.querySelector<HTMLElement>('.chat-row.selected')?.dataset.threadId
      if (!threadId) throw new Error('Missing selected thread')
      const errors: string[] = []
      try {
        await window.api.container.runThread({
          projectId,
          threadId,
          prompt: 'Implement the task',
          model: 'claude-sonnet-4-6',
          budgets: { wallClockMs: 60000, tokenCeiling: 1000 },
        })
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
      try {
        await window.api.review.run(projectId, threadId, '{}')
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
      return errors
    }, PROJECT)
    await expect(blocked[0]).toContain('cannot enforce the plan workflow')
    await expect(blocked[1]).toContain('Standalone review is unavailable during draft planning')

    await selectPassage('session expires')
    await dialog.$('[aria-label="Bold"]').click()
    await expect($('#plan-body p strong')).toHaveText('session expires')
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'z'])
    await expect($('#plan-body p strong')).not.toExist()
    await expect(dialog.$('button=Approve and implement')).toBeEnabled()
    await dialog.$('[aria-label="Redo"]').click()
    await expect($('#plan-body p strong')).toHaveText('session expires')
    await dialog.$('[aria-label="Undo"]').click()
    await selectPassage('Keep existing sessions and the public API.')
    await browser.keys('ArrowRight')
    await browser.keys(' Keep the current layout.')
    await expect(dialog.$('button=Approve and implement')).toBeDisabled()
    await dialog.$('button=Save revision').click()
    await expect(dialog.$('[data-testid="plan-status"]')).toHaveText('draft · r2')
    secondBody = (await readPlan())?.body ?? ''
    await selectPassage('Existing sessions remain valid.')
    await $('#plan-feedback').setValue('Include the expired-token regression case.')
    await dialog.$('button=Add passage feedback').click()
    await expect(dialog.$('.thread-plan-comment blockquote')).toHaveText(
      'Existing sessions remain valid.',
    )
    await expect(dialog.$('.thread-plan-comment p')).toHaveText(
      'Include the expired-token regression case.',
    )
    await saveElementScreenshot('#thread-plan-dialog', 'thread-plan-review.png')

    await $('#plan-revision').selectByAttribute('value', '1')
    await expect($('#plan-body')).toHaveAttribute('contenteditable', 'false')
    await dialog.$('button=Markdown').click()
    await expect($('#plan-source')).toHaveValue(firstBody)
    await expect($('#plan-source')).toHaveElementProperty('readOnly', true)
    await dialog.$('button=Document').click()
    await $('#plan-revision').selectByAttribute('value', '2')
    await expect($('#plan-body')).toHaveText(expect.stringContaining('Keep the current layout.'))
  })

  it('retains an unsent saved plan across new tasks, switches and an app restart', async function () {
    // Relaunching Electron includes native window teardown and boot.
    this.timeout(60_000)
    const saved = await readPlan()
    if (!saved) throw new Error('Missing saved draft')
    const threadId = saved.meta.threadId
    const rowSelector = `.chat-row[data-thread-id="${threadId}"]`
    await $('#thread-plan-dialog').$('button=Close').click()
    await expect($('.prompt-input')).toHaveText('')
    await expect($('.msg-user')).not.toExist()
    await $('.project-new-thread-btn').click()
    await expect($('.chat-row.selected')).not.toHaveAttribute('data-thread-id', threadId)
    await expect($(rowSelector)).toExist()
    await $(rowSelector).click()
    await browser.reloadSession()
    await $(rowSelector).waitForDisplayed({ timeout: 30_000 })
    await expect($('.prompt-input')).toHaveText('')
    await $('.project-new-thread-btn').click()
    await expect($('.chat-row.selected')).not.toHaveAttribute('data-thread-id', threadId)
    await $(rowSelector).click()
    await $('[data-testid="open-plan"]').click()
    await expect($('#thread-plan-dialog [data-testid="plan-status"]')).toHaveText('draft · r2')
    await expect((await readPlan())?.meta.planId).toBe(saved.meta.planId)
    await expect((await readPlan())?.body).toBe(saved.body)
    await expect($('.thread-plan-comment p')).toHaveText(
      'Include the expired-token regression case.',
    )
    await saveAppScreenshot('thread-plan-retained.png')
  })

  it('saves an agent revision and implements only after approval', async () => {
    const dialog = await $('#thread-plan-dialog')
    const revised = secondBody.replace(
      'Focused regression tests pass.',
      'Focused regression tests cover expired tokens.',
    )
    const refine = await installMockScenario({
      title: 'Review session recovery plan',
      turns: [
        {
          user: 'Review and refine draft plan revision 2. Ask focused questions where needed, address passage feedback, and save the next revision for my review.',
          responses: [
            {
              toolCalls: [
                {
                  name: 'update_thread_plan',
                  args: { expectedRevision: 2, title: 'Recover expired sessions', body: revised },
                },
              ],
            },
            {
              text: 'Revision 3 includes the expired-token regression case and is ready for review.',
              expectToolResults: [
                { name: 'update_thread_plan', includes: 'Saved plan revision 3' },
              ],
            },
          ],
        },
      ],
    })
    await dialog.$('button=Ask agent to refine').click()
    await dialog.waitForDisplayed({ reverse: true })
    await browser.waitUntil(
      async () =>
        (await $('.msg-user').isExisting()) || (await $('.composer-dirty-send-btn').isDisplayed()),
    )
    if (await $('.composer-dirty-send-btn').isDisplayed())
      await $('.composer-dirty-send-btn').click()
    await expectAssistantReply(
      'Revision 3 includes the expired-token regression case and is ready for review.',
    )
    await waitForAgentIdle(30_000)
    await refine.assertComplete()
    await $('[data-testid="open-plan"]').click()
    await expect(dialog.$('[data-testid="plan-status"]')).toHaveText('draft · r3')
    await expect($('#plan-body')).toHaveText(
      expect.stringContaining('Focused regression tests cover expired tokens.'),
    )

    // Read the identity through the normal product API; all mutations above use UI.
    const plan = await browser.execute(async (projectId) => {
      const threadId = document.querySelector<HTMLElement>('.chat-row.selected')?.dataset.threadId
      if (!threadId) throw new Error('Missing selected thread')
      return window.api.plans.get(projectId, threadId)
    }, PROJECT)
    if (!plan) throw new Error('Missing saved plan')
    const implementation = await installMockScenario({
      title: 'Implement session recovery plan',
      turns: [
        {
          user: 'Implement approved plan “Recover expired sessions”, revision 3. Report completion evidence against each definition-of-done criterion.',
          responses: [
            {
              toolCalls: [
                {
                  name: 'report_plan_completion',
                  args: {
                    planId: plan.meta.planId,
                    revision: 3,
                    contentHash: plan.contentHash,
                    results: [
                      {
                        criterionId: 'criterion-1',
                        status: 'met',
                        evidence: 'Session recovery regression test passed.',
                      },
                      {
                        criterionId: 'criterion-2',
                        status: 'partial',
                        evidence:
                          'Active sessions pass; refresh-token migration is still outstanding.',
                      },
                      {
                        criterionId: 'criterion-3',
                        status: 'unverified',
                        evidence: 'The full expired-token matrix has not been run.',
                      },
                    ],
                  },
                },
              ],
            },
            {
              text: 'The completion report records one met, one partial, and one unverified criterion.',
              expectToolResults: [
                { name: 'report_plan_completion', includes: 'Completion evidence saved' },
              ],
            },
          ],
        },
      ],
    })
    await dialog.$('button=Approve and implement').click()
    await dialog.waitForDisplayed({ reverse: true })
    await browser.waitUntil(
      async () =>
        (await $('.msg-user').isExisting()) || (await $('.composer-dirty-send-btn').isDisplayed()),
    )
    if (await $('.composer-dirty-send-btn').isDisplayed())
      await $('.composer-dirty-send-btn').click()
    await expectAssistantReply(
      'The completion report records one met, one partial, and one unverified criterion.',
    )
    await waitForAgentIdle(30_000)
    await implementation.assertComplete()
  })

  it('retains the approved revision and completion evidence after reload', async () => {
    await browser.refresh()
    await $('[data-testid="open-plan"]').waitForExist({ timeout: 30_000 })
    await $('.chat-row.selected').waitForExist({ timeout: 30_000 })
    await $('[data-testid="open-plan"]').click()
    await expect($('#thread-plan-dialog [data-testid="plan-status"]')).toHaveText('approved · r3')
    await expect($('#plan-body')).toHaveAttribute('contenteditable', 'false')
    await expect($('.thread-plan-result[data-status="met"]')).toHaveText(
      expect.stringContaining('Session recovery regression test passed.'),
    )
    await expect($('.thread-plan-result[data-status="met"] strong')).toHaveText(
      'Sign-in succeeds after session expiry without deleting existing sessions.',
    )
    await expect($('.thread-plan-result[data-status="partial"]')).toHaveText(
      expect.stringContaining('migration is still outstanding'),
    )
    await expect($('.thread-plan-result[data-status="unverified"]')).toHaveText(
      expect.stringContaining('has not been run'),
    )
    await saveElementScreenshot('#thread-plan-dialog', 'thread-plan-completion.png')
  })
})

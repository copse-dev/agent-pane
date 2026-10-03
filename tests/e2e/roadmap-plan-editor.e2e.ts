import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedRoadmapNotes } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { waitForAgentIdle } from './helpers.ts'

const PROJECT = 'e2e-roadmap-plan-editor'
const BRIEF =
  'Let people recover an expired session without losing their work.\n\n## Expected experience\n\nKeep the recovery inside the sign-in form. Explain what happened, preserve the draft, and return to the interrupted task.\n\n- Keep existing sessions valid.\n- Include a focused regression for expired tokens.\n\n## Open question\n\nShould recovery resume automatically or wait for confirmation?'
const PLAN =
  '# Goal\nRecover expired sessions without losing work.\n\n# Constraints\nKeep existing sessions and the public API.\n\n# Scope\nSign-in form and session recovery tests.\n\n# Definition of done\n- Recovery preserves the current draft.\n- Expired-token regression tests pass.'

async function currentPlan() {
  return browser.execute(async (projectId) => {
    const threadId = document.querySelector<HTMLElement>('.chat-row.selected')?.dataset.threadId
    if (!threadId) throw new Error('Missing selected task')
    return window.api.plans.get(projectId, threadId)
  }, PROJECT)
}

async function selectRoadmapItem(): Promise<void> {
  await $('.roadmap-row[data-id="session-recovery"]').click()
}

describe('roadmap document and linked planning prototype', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT, {
      roadmapPlansEnabled: true,
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
    })
    seedRoadmapNotes(PROJECT, [
      {
        id: 'session-recovery',
        title: 'Recover expired sessions',
        body: BRIEF,
        category: 'feature',
      },
      {
        id: 'keyboard',
        title: 'Keyboard navigation for the file picker',
        body: 'Let me pick a file without reaching for the mouse.',
        category: 'feature',
      },
      {
        id: 'loading',
        title: 'Keep loading states quiet',
        body: 'Review loading indicators in the sidebar.',
        category: 'bug',
      },
    ])
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Open roadmap"]').click()
    await $('.roadmap-row').waitForDisplayed()
  })
  after(() => {
    resetUserData()
  })

  it('keeps quick capture and opens saved briefs in a clean document view', async () => {
    await $('.roadmap-new-btn').click()
    await expect($('.roadmap-prompt-input')).toBeDisplayed()
    await $('.roadmap-prompt-input').setValue('A small idea can stay small.')
    await $('.roadmap-editor-modes').$('button=Document').click()
    await expect($('#roadmap-body')).toHaveText('A small idea can stay small.')
    await $('.roadmap-editor-modes').$('button=Quick edit').click()
    await expect($('.roadmap-prompt-input')).toHaveValue('A small idea can stay small.')
    await saveAppScreenshot('roadmap-quick-capture.png')
    await $('.roadmap-cancel-btn').click()
    await selectRoadmapItem()
    await expect($('#roadmap-body h2')).toHaveText('Expected experience')
    await expect($('.roadmap-details')).not.toHaveAttribute('open')
    await $('[aria-label="Expand roadmap over chat"]').click()
    await saveAppScreenshot('roadmap-document-editor.png')
    await $('.roadmap-editor-modes').$('button=Quick edit').click()
    await expect($('.roadmap-prompt-input')).toHaveValue(BRIEF)
    await $('.roadmap-prompt-input').setValue(
      `${BRIEF}\n\nPreserve keyboard focus during recovery.`,
    )
    await $('.roadmap-editor-modes').$('button=Document').click()
    await expect($('#roadmap-body')).toHaveText(
      expect.stringContaining('Preserve keyboard focus during recovery.'),
    )
    await $('.roadmap-save-btn').click()
    const saved = await browser.execute(
      async () =>
        (await window.api.roadmap.list()).find((item) => item.id === 'session-recovery')?.body,
    )
    await expect(saved).toBe(`${BRIEF}\n\nPreserve keyboard focus during recovery.`)
  })

  it('develops a real draft without starting implementation and reopens the same plan', async () => {
    await $('.roadmap-develop-btn').click()
    await $('#thread-plan-dialog').waitForDisplayed()
    await expect($('[data-testid="plan-status"]')).toHaveText('draft · r1')
    await expect($('#plan-body')).toHaveText(
      expect.stringContaining('Preserve keyboard focus during recovery.'),
    )
    const plan = await currentPlan()
    await expect(plan?.approval).toBeNull()
    await expect(plan?.completion).toBeNull()
    await expect($('.msg-assistant')).not.toExist()
    await $('#thread-plan-dialog').$('button=Close').click()
    // A roadmap draft is durable even if its prefilled composer is cleared.
    if (await $('[aria-label="Restore roadmap"]').isDisplayed())
      await $('[aria-label="Restore roadmap"]').click()
    await $('.prompt-input').click()
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'a'])
    await browser.keys('Backspace')
    await expect($('.prompt-input')).toHaveText('')
    await $('.project-new-thread-btn').click()
    await $('.roadmap-attempt').$('button=Open plan').waitForDisplayed()
    await $('.roadmap-attempt').$('button=Open plan').click()
    await expect($('[data-testid="plan-status"]')).toHaveText('draft · r1')
    await expect((await currentPlan())?.meta.planId).toBe(plan?.meta.planId)
    await $('#thread-plan-dialog').$('button=Markdown').click()
    await $('#plan-source').setValue(PLAN)
    await $('#thread-plan-dialog').$('button=Save revision').click()
    await expect($('[data-testid="plan-status"]')).toHaveText('draft · r2')
    await $('#thread-plan-dialog').$('button=Document').click()
    await saveElementScreenshot('#thread-plan-dialog', 'roadmap-linked-plan.png')
    await $('#thread-plan-dialog').$('button=Close').click()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    if (!(await $('.roadmap-new-btn').isDisplayed())) await $('[aria-label="Open roadmap"]').click()
    await $('.roadmap-row').waitForDisplayed({ timeout: 30_000 })
    await selectRoadmapItem()
    await $('.roadmap-attempt').$('button=Open plan').waitForDisplayed()
    await $('.roadmap-attempt').$('button=Open plan').click()
    await expect($('[data-testid="plan-status"]')).toHaveText('draft · r2')
    await expect((await currentPlan())?.meta.planId).toBe(plan?.meta.planId)
  })

  it('shows reported evidence and preserves previous attempts and their origin links', async () => {
    const plan = await currentPlan()
    if (!plan) throw new Error('Missing plan')
    await $('#thread-plan-dialog').$('button=Close').click()
    await browser.execute(() => {
      const transfer = new DataTransfer()
      transfer.items.add(
        new File(['SESSION-RECOVERY-FIXTURE'], 'recovery-case.txt', { type: 'text/plain' }),
      )
      const input = document.querySelector<HTMLInputElement>('.attach-file-input')
      if (!input) throw new Error('Missing attachment input')
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await $('.attachment-chip').waitForDisplayed()
    await $('.roadmap-attempt').$('button=Open plan').click()
    const implementation = await installMockScenario({
      title: 'Session recovery implementation',
      turns: [
        {
          user: { includes: 'SESSION-RECOVERY-FIXTURE' },
          responses: [
            {
              toolCalls: [
                {
                  name: 'report_plan_completion',
                  args: {
                    planId: plan.meta.planId,
                    revision: 2,
                    contentHash: plan.contentHash,
                    results: [
                      {
                        criterionId: 'criterion-1',
                        status: 'met',
                        evidence: 'Draft preservation regression passed.',
                      },
                      {
                        criterionId: 'criterion-2',
                        status: 'unverified',
                        evidence: 'Expired-token integration test has not run.',
                      },
                    ],
                  },
                },
              ],
            },
            { text: 'Draft preservation passed; the integration test still needs verification.' },
          ],
        },
      ],
    })
    await $('#thread-plan-dialog').$('button=Approve and implement').click()
    await browser.waitUntil(
      async () =>
        (await $('.msg-user').isExisting()) || (await $('.composer-dirty-send-btn').isDisplayed()),
    )
    if (await $('.composer-dirty-send-btn').isDisplayed())
      await $('.composer-dirty-send-btn').click()
    await expectAssistantReply(
      'Draft preservation passed; the integration test still needs verification.',
    )
    await waitForAgentIdle(30_000)
    await implementation.assertComplete()
    await expect($('.prompt-input')).toHaveText('')
    await expect($('.msg-user')).toHaveText(expect.stringContaining('Implement approved plan'))
    await expect($('.attachment-chip')).not.toExist()
    if (await $('[aria-label="Expand roadmap over chat"]').isDisplayed())
      await $('[aria-label="Expand roadmap over chat"]').click()
    await expect($('.roadmap-attempt-summary')).toHaveText('Approved r2 · 1 met · 1 unverified')
    await expect($('.roadmap-status-select')).toHaveValue('ready')
    await $('.roadmap-attempt-summary').scrollIntoView()
    await saveAppScreenshot('roadmap-plan-evidence.png')
    await $('.roadmap-start-btn').click()
    await $('.roadmap-previous-attempts summary').waitForDisplayed()
    await $('.roadmap-previous-attempts summary').click()
    await $('.roadmap-previous-attempts').$('button=View evidence').click()
    await expect($('.thread-plan-result[data-status="unverified"] p')).toHaveText(
      'Expired-token integration test has not run.',
    )
    await $('#thread-plan-dialog').$('button=Close').click()
    if (await $('[aria-label="Restore roadmap"]').isDisplayed())
      await $('[aria-label="Restore roadmap"]').click()
    await expect($('.thread-roadmap-origin')).toBeDisplayed()
    await $('.thread-roadmap-origin').click()
    await expect($('.roadmap-row.is-selected')).toHaveAttribute('data-id', 'session-recovery')
    await saveAppScreenshot('roadmap-linked-work-compact.png')
  })
})

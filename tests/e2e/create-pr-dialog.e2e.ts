import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'

/**
 * The "Create PR" follow-up chip and the dialog behind it.
 *
 * `mockFollowUps` seeds the chip without a model or a real `gh` (the same
 * fixture follow-up-suggestions.e2e.ts drives), and it makes `suggestPrBody`
 * return `mockPrBody()` so the description lands in the dialog deterministically.
 * The create itself goes through `createPrForThread` against the in-memory
 * GitHub backend (`COPSE_PANEL_MOCK_GH=1`), so confirming publishes nothing
 * outside this machine and is cheap enough to exercise end to end.
 */

const DIALOG = '#create-pr-dialog'
const TITLE_INPUT = `${DIALOG} .create-pr-dialog-title-input`
const BODY_INPUT = `${DIALOG} .create-pr-dialog-body-input`
const CREATE_BUTTON = `${DIALOG} .create-pr-dialog-create`

async function completeMockTurn(): Promise<void> {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await setComposerValue('roll up tool activity')
  await $('.submit-btn').click()

  await waitForAgentIdle(20_000)

  await $('.follow-up-bubble').waitForExist({ timeout: 30_000 })
}

/** Set the title field the way a user would: value plus the input event the button listens to. */
async function setTitle(value: string): Promise<void> {
  await browser.execute(
    (selector: string, next: string) => {
      const input = document.querySelector<HTMLInputElement>(selector)
      if (!input) throw new Error(`missing ${selector}`)
      input.value = next
      input.dispatchEvent(new Event('input', { bubbles: true }))
    },
    TITLE_INPUT,
    value,
  )
}

describe('create PR dialog', () => {
  before(async () => {
    resetUserData()
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    seedEmptyProject(process.cwd(), 'e2e-create-pr-dialog-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      mockFollowUps: true,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('opens from the chip, needs a title, and records the create as a card', async () => {
    await completeMockTurn()

    const chip = await $('.follow-up-bubble[data-id="create-pr"]')
    await expect(chip).toBeDisplayed()
    await expect(chip).toHaveText('Create PR')
    await chip.click()

    // Clicking offers a form; it must not publish on its own.
    const dialog = await $(DIALOG)
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect($(`${DIALOG} h3`)).toHaveText('Create pull request')
    await expect($(TITLE_INPUT)).toBeDisplayed()
    await expect($(TITLE_INPUT)).toHaveAttribute('placeholder', 'Summarise the change')
    await expect($(`${DIALOG} .create-pr-dialog-draft-input`)).toExist()
    await expect($(`${DIALOG} .create-pr-dialog-draft-input`)).not.toBeSelected()
    await expect($(`.tool-card[data-tool-id^="create-pr-"]`)).not.toExist()

    // The description is proposed while the dialog is open; under the mock
    // fixture that is `mockPrBody()`, which arrives without a model.
    const body = await $(BODY_INPUT)
    await browser.waitUntil(
      async () => (await body.getValue()).includes('Rolls tool activity up'),
      { timeout: 10_000, timeoutMsg: 'the proposed description did not land in the dialog' },
    )

    // Nothing writes a title for the user, so a blank one cannot be submitted —
    // whitespace included.
    await setTitle('   ')
    await expect($(CREATE_BUTTON)).toBeDisabled()
    await $(CREATE_BUTTON).click()
    await expect(dialog).toBeDisplayed()

    await setTitle('Roll up tool activity')
    await expect($(CREATE_BUTTON)).toBeEnabled()
    await expect($(CREATE_BUTTON)).toHaveText('Create pull request')

    await saveAppScreenshot('create-pr-dialog.png')

    // Confirming runs no model: the create goes straight to the mock backend
    // and lands in the transcript as the same `gh_pr_create` card the agent's
    // own call would leave.
    await $(CREATE_BUTTON).click()
    await expect(dialog).not.toBeDisplayed()
    const card = await $('.tool-card[data-tool-id^="create-pr-"]')
    await card.waitForExist({ timeout: 15_000 })
    await browser.waitUntil(async () => (await card.getAttribute('data-status')) !== 'running', {
      timeout: 15_000,
      timeoutMsg: 'the create card did not settle',
    })
    await expect(card).toHaveAttribute('data-status', 'done')
    await expect($('.follow-up-suggestions')).not.toBeDisplayed()
    await assertNoErrorToasts('create PR from the composer')
  })
})

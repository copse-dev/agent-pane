import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('markdown interrupted by real tool rounds', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-markdown-interruption', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => resetUserData())

  it('keeps a split table row and bold list label in one rendered reply', async function () {
    this.timeout(60_000)
    const prompt = 'Inspect the workspace and explain the result in a small table and list.'
    const scenario = await installMockScenario({
      title: 'Interrupted table and emphasis',
      turns: [
        {
          user: prompt,
          responses: [
            {
              text: 'Workspace check:\n\n| Item | Status |\n| --- | --- |\n| Source | Re',
              toolCalls: [{ name: 'list_dir', args: { path: '.' } }],
            },
            {
              text: 'ady |\n\n- **',
              expectToolResults: [{ name: 'list_dir', includes: 'src' }],
              toolCalls: [{ name: 'list_dir', args: { path: 'src' } }],
            },
            {
              text: 'Why:** The source directory is available.',
              expectToolResults: [{ name: 'list_dir', includes: 'renderer' }],
            },
          ],
        },
      ],
    })
    await setComposerValue(prompt)
    await submitComposer()
    await waitForAgentIdle()
    await scenario.assertComplete()
    await expect($$('.msg-assistant .message-text')).toBeElementsArrayOfSize(1)
    await expect($('.msg-assistant table tbody tr td:first-child')).toHaveText('Source')
    await expect($('.msg-assistant table tbody tr td:last-child')).toHaveText('Ready')
    await expect($('.msg-assistant li strong')).toHaveText('Why:')
    await expect($('.msg-assistant li')).toHaveText('Why: The source directory is available.')
    await saveAppScreenshot('markdown-tool-interruption-table-emphasis.png')
  })

  it('keeps an unterminated code fence together and renders HTML-like code inertly', async function () {
    this.timeout(60_000)
    const previousReplies = (await $$('.msg-assistant .message-text')).length
    const prompt = 'Show an incomplete HTML example after inspecting the workspace.'
    const scenario = await installMockScenario({
      title: 'Interrupted malformed fence',
      turns: [
        {
          user: prompt,
          responses: [
            {
              text: 'Incomplete example:\n\n```html\n',
              toolCalls: [{ name: 'list_dir', args: { path: '.' } }],
            },
            {
              text: '<img src=x onerror="document.body.dataset.interruptedMarkupExecuted=1">',
              expectToolResults: [{ name: 'list_dir', includes: 'src' }],
            },
          ],
        },
      ],
    })
    await setComposerValue(prompt)
    await submitComposer()
    await waitForAgentIdle()
    await scenario.assertComplete()
    await expect($$('.msg-assistant .message-text')).toBeElementsArrayOfSize(previousReplies + 1)
    await expect($('.msg-assistant pre code')).toHaveText(
      '<img src=x onerror="document.body.dataset.interruptedMarkupExecuted=1">',
    )
    await expect($('.msg-assistant .message-text img')).not.toExist()
    const executed = await browser.execute(() => document.body.dataset.interruptedMarkupExecuted)
    expect(executed ?? null).toBeNull()
    await saveAppScreenshot('markdown-tool-interruption-malformed-fence.png')
  })

  it('starts a separate reply after a completed bold span', async function () {
    this.timeout(60_000)
    const previousReplies = (await $$('.msg-assistant .message-text')).length
    const prompt =
      'Finish the first thought before inspecting the workspace, then give the next step.'
    const scenario = await installMockScenario({
      title: 'Completed emphasis boundary',
      turns: [
        {
          user: prompt,
          responses: [
            {
              text: '**Completed.**',
              toolCalls: [{ name: 'list_dir', args: { path: '.' } }],
            },
            {
              text: 'Next, inspect the build.',
              expectToolResults: [{ name: 'list_dir', includes: 'src' }],
            },
          ],
        },
      ],
    })
    await setComposerValue(prompt)
    await submitComposer()
    await waitForAgentIdle()
    await scenario.assertComplete()
    const replies = await $$('.msg-assistant .message-text')
    expect(replies.length).toBe(previousReplies + 2)
    await expect(replies[previousReplies]).toHaveText('Completed.')
    await expect(replies[previousReplies + 1]).toHaveText('Next, inspect the build.')
    await saveAppScreenshot('markdown-tool-interruption-completed-emphasis.png')
  })

  it('keeps a table row with optional outer pipes together across the tool', async function () {
    this.timeout(60_000)
    const previousReplies = (await $$('.msg-assistant .message-text')).length
    const prompt = 'Inspect the workspace and complete the table without outer pipes.'
    const scenario = await installMockScenario({
      title: 'Optional table outer pipes',
      turns: [
        {
          user: prompt,
          responses: [
            {
              text: 'Item | Status\n--- | ---\nSource',
              toolCalls: [{ name: 'list_dir', args: { path: '.' } }],
            },
            {
              text: 'Continued | value',
              expectToolResults: [{ name: 'list_dir', includes: 'src' }],
            },
          ],
        },
      ],
    })
    await setComposerValue(prompt)
    await submitComposer()
    await waitForAgentIdle()
    await scenario.assertComplete()
    const replies = await $$('.msg-assistant .message-text')
    expect(replies.length).toBe(previousReplies + 1)
    const lastReply = replies.at(-1)
    if (!lastReply) throw new Error('Expected the table reply')
    await expect(lastReply.$('table tbody tr td:first-child')).toHaveText('SourceContinued')
    await expect(lastReply.$('table tbody tr td:last-child')).toHaveText('value')
    await saveAppScreenshot('markdown-tool-interruption-optional-pipes.png')
  })
})

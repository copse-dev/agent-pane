import { $, $$, browser, expect } from '@wdio/globals'
import { parkPointer, saveAppScreenshot } from '../e2e/helpers/screenshot.ts'
import { buildDemoFixturePage } from './helpers/demo-fixture-page.ts'

/** The transcript's rows in order: role, origin, and the visible reply text. */
async function readRows(): Promise<{ kind: string; text: string }[]> {
  return browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>('.messages-list > .msg')].map((row) => ({
      kind: row.classList.contains('msg-machine-origin')
        ? 'machine'
        : row.classList.contains('msg-user')
          ? 'user'
          : 'assistant',
      text: (
        row.querySelector('.message-body > .message-text')?.textContent ??
        row.querySelector('.msg-origin-label')?.textContent ??
        ''
      ).trim(),
    })),
  )
}

describe('transcript turn boundaries in the real renderer', () => {
  let page = ''
  before(async () => {
    page = await buildDemoFixturePage('scripted-turn-fixture')
  })

  it('puts a mid-run continuation answer below its machine prompt', async () => {
    await submitScriptedTurn(page, 'continuation', 'Finish the release checklist.')
    await browser.waitUntil(
      async () => (await readRows()).some((row) => row.text === 'Second answer.'),
      { timeoutMsg: 'expected the continuation answer to render' },
    )

    const rows = await readRows()
    expect(rows.map((row) => row.kind)).toEqual(['user', 'assistant', 'machine', 'assistant'])
    expect(rows[1]?.text).toBe('First answer.')
    expect(rows[2]?.text).toMatch(/^Before this turn can finish, reconcile the task plan/)
    expect(rows[3]?.text).toBe('Second answer.')
    await expect($('.msg-machine-origin')).toHaveAttribute(
      'data-operation-id',
      'post-turn-continuation',
    )
    await expect($('.msg-machine-origin .msg-origin-label')).toHaveText(
      'Machine · automatic continuation',
    )

    await parkPointer()
    await saveAppScreenshot('transcript-continuation-below-machine-prompt.png')
  })

  it('keeps the start of a sentence a tool call interrupted when the step is rewritten', async () => {
    await submitScriptedTurn(page, 'resumed-sentence', 'Read the plan twice.')
    await browser.waitUntil(
      async () =>
        (await readRows()).some((row) => row.text.replace(/\s+/g, ' ').includes('other file')),
      { timeoutMsg: 'expected the resumed sentence to render' },
    )

    const replies = (await readRows()).filter((row) => row.kind === 'assistant')
    expect(replies).toHaveLength(1)
    expect(replies[0]?.text.replace(/\s+/g, ' ')).toBe('Let me check the other file')
    // Both reads stay in that one bubble, rolled up under the sentence.
    await expect($('.msg-assistant .tool-card-rollup')).toHaveAttribute('data-tool-count', '2')
    await expect($('.messages-list')).not.toHaveText(expect.stringContaining('<tool_call>'))

    await parkPointer()
    await saveAppScreenshot('transcript-resumed-sentence-text-replace.png')
  })
})

async function submitScriptedTurn(page: string, turn: string, prompt: string): Promise<void> {
  await browser.url(`${page}?turn=${turn}`)
  await $('.prompt-input').waitForExist()
  await browser.execute(async () => {
    await document.fonts.ready
  })
  await browser.execute((text) => {
    const composer = document.querySelector<HTMLElement>('.prompt-input')
    if (!composer) throw new Error('Missing composer')
    composer.textContent = text
    composer.dispatchEvent(new Event('input', { bubbles: true }))
  }, prompt)
  await $('.submit-btn').click()
  await browser.waitUntil(
    async () =>
      (await $$('.messages-list .is-streaming').length) === 0 && (await $$('.msg-user').length) > 0,
    { timeoutMsg: 'expected the scripted turn to finish' },
  )
}

import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// The concise thread view in each state a thread can be in. Each scenario is a
// seeded transcript (src/shared/demo-concise-states.ts); each test asserts what
// the view paints and keeps — and what it must not hide — and leaves a capture.

interface Row {
  kind: 'user' | 'assistant' | 'footer' | 'recovery' | 'activity' | 'other'
  visible: boolean
  height: number
  cards: number
  text: string
}

/** The transcript's direct children, in order, with what is actually painted. */
async function rows(): Promise<Row[]> {
  return browser.execute(() =>
    [...document.querySelectorAll('.messages-list > *')].map((node): Row => {
      const visible = node instanceof HTMLElement && node.checkVisibility()
      const kind = node.classList.contains('msg-user')
        ? 'user'
        : node.classList.contains('msg-assistant')
          ? 'assistant'
          : node.classList.contains('concise-turn-footer')
            ? 'footer'
            : node.classList.contains('turn-recovery-card')
              ? 'recovery'
              : node.classList.contains('agent-activity')
                ? 'activity'
                : 'other'
      return {
        kind,
        visible,
        height: Math.round(node.getBoundingClientRect().height),
        cards: [...node.querySelectorAll('.tool-card')].filter(
          (card) => card instanceof HTMLElement && card.checkVisibility(),
        ).length,
        text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
      }
    }),
  )
}

const painted = (all: Row[], kind: Row['kind']): Row[] =>
  all.filter((row) => row.kind === kind && row.visible)

/** Open a scenario and wait for its transcript to paint and settle. */
async function open(id: string): Promise<void> {
  await browser.url(`/?scenario=concise-state-${id}`)
  await $('.messages-list .msg-user').waitForExist()
  await browser.pause(300)
}

describe('concise thread view states', () => {
  it('says a stopped turn was stopped, without an empty band, and opens it in full', async () => {
    await open('stopped')
    const footer = $('.concise-turn-footer')
    await footer.waitForDisplayed()

    const closed = await rows()
    // The only bubble is process with no text: it must take no room.
    expect(painted(closed, 'assistant')).toHaveLength(0)
    expect((await footer.getText()).replace(/\s+/g, ' ')).toBe(
      'Interrupted by you. Show steps 2 tool calls',
    )
    await saveAppScreenshot('concise-state-stopped.png')

    await footer.$('button').click()
    await expect(footer.$('button')).toHaveAttribute('aria-expanded', 'true')
    const opened = await rows()
    expect(painted(opened, 'assistant')[0]?.cards).toBeGreaterThan(0)
    expect(painted(opened, 'assistant')[0]?.text).toContain('Interrupted by you.')
    await saveAppScreenshot('concise-state-stopped-expanded.png')
  })

  it('tells a turn cut off by a new message apart from one stopped outright', async () => {
    await open('interrupted-by-message')
    await $('.concise-turn-footer').waitForDisplayed()

    const all = await rows()
    const footers = painted(all, 'footer').map((row) => row.text)
    expect(footers).toEqual([
      'Interrupted when you sent a new message.Show steps1 tool call',
      'Show steps1 tool call+4−2',
    ])
    // The cut-off turn paints nothing of its own; the follow-up's summary is the answer.
    expect(painted(all, 'assistant').map((row) => row.text)).toEqual([
      expect.stringContaining('Save is pinned with a grid footer'),
    ])
    await saveAppScreenshot('concise-state-interrupted-by-message.png')
  })

  it('is on for a profile that never chose, and offers Show steps', async () => {
    await open('default-on')
    await $('.concise-turn-footer').waitForDisplayed()

    const all = await rows()
    expect(painted(all, 'assistant').map((row) => row.text)).toEqual([
      expect.stringContaining('Save now stays pinned at every width.'),
    ])
    expect(painted(all, 'assistant')[0]?.cards).toBe(0)
    expect(painted(all, 'footer')[0]?.text).toBe('Show steps2 tool calls+4−2')
    await saveAppScreenshot('concise-state-default-on.png')
  })

  it('keeps a failed turn’s text and recovery action visible', async () => {
    await open('failed')
    await $('.turn-recovery-card').waitForDisplayed()

    const all = await rows()
    expect(painted(all, 'assistant')[0]?.text).toContain('then the provider stopped responding')
    expect(painted(all, 'assistant')[0]?.cards).toBe(0)
    expect(painted(all, 'recovery')).toHaveLength(1)
    // The footer follows the recovery action, so Retry stays the failed message's neighbour.
    expect(all.map((row) => row.kind).filter((kind) => kind !== 'activity')).toEqual([
      'user',
      'assistant',
      'recovery',
      'footer',
    ])
    await saveAppScreenshot('concise-state-failed.png')
  })

  it('keeps the permission prompt on top of a running turn that is waiting on it', async () => {
    await open('approval')
    await $('#approval-dialog').waitForDisplayed()

    await expect($('#approval-dialog .approval-heading')).toHaveText('Run outside sandbox?')
    const all = await rows()
    expect(painted(all, 'assistant')).toHaveLength(0)
    expect(painted(all, 'footer')).toHaveLength(0)
    await expect($('.agent-activity-label')).toHaveText('Running pnpm install…')
    await saveAppScreenshot('concise-state-approval.png')
  })

  it('keeps the question dialog on top of a running turn that is waiting for an answer', async () => {
    await open('question')
    await $('#ask-user-dialog').waitForDisplayed()

    await expect($('#ask-user-dialog .ask-user-title')).toHaveText('The agent has a question')
    expect(await $('#ask-user-dialog').getText()).toContain(
      'Which migration order should the schema bump use?',
    )
    expect(painted(await rows(), 'assistant')).toHaveLength(0)
    await saveAppScreenshot('concise-state-question.png')
  })

  it('hides subagent timelines behind the footer and shows them when opened', async () => {
    await open('subagent')
    const footer = $('.concise-turn-footer')
    await footer.waitForDisplayed()

    const closed = await rows()
    expect(painted(closed, 'assistant').map((row) => row.cards)).toEqual([0])
    expect(await $$('.tool-card-subagent').filter((card) => card.isDisplayed())).toHaveLength(0)
    await saveAppScreenshot('concise-state-subagent.png')

    await footer.$('button').click()
    await expect($('.tool-card-subagent')).toBeDisplayed()
    await saveAppScreenshot('concise-state-subagent-expanded.png')
  })

  it('names the subagent’s work in the activity row while it runs', async () => {
    await open('subagent-running')
    await $('.agent-activity').waitForDisplayed()

    await expect($('.agent-activity-label')).toHaveText('Exploring files…')
    expect(painted(await rows(), 'assistant')).toHaveLength(0)
    expect(painted(await rows(), 'footer')).toHaveLength(0)
    await saveAppScreenshot('concise-state-subagent-running.png')
  })

  it('keeps long output and patches out of the transcript, and bounded when opened', async () => {
    await open('long-output')
    const footer = $('.concise-turn-footer')
    await footer.waitForDisplayed()

    const closed = await rows()
    expect(painted(closed, 'assistant').map((row) => row.cards)).toEqual([0])
    expect(painted(closed, 'footer')[0]?.text).toBe('Show steps3 tool calls+5−3')
    await saveAppScreenshot('concise-state-long-output.png')

    await footer.$('button').click()
    await $('.tool-card').waitForDisplayed()
    const geometry = await browser.execute(() => {
      const list = document.querySelector<HTMLElement>('.messages-list')!
      return {
        pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        listOverflowX: list.scrollWidth > list.clientWidth,
        // 400 lines of output must not be laid out at full height in the transcript.
        tallestCard: Math.max(
          ...[...document.querySelectorAll<HTMLElement>('.tool-card')].map(
            (card) => card.getBoundingClientRect().height,
          ),
        ),
      }
    })
    expect(geometry.pageOverflowX).toBe(false)
    expect(geometry.listOverflowX).toBe(false)
    expect(geometry.tallestCard).toBeLessThan(2_000)
    await saveAppScreenshot('concise-state-long-output-expanded.png')
  })

  it('hides an ACP terminal reference in the concise turn and shows it when opened', async () => {
    await open('terminal')
    const footer = $('.concise-turn-footer')
    await footer.waitForDisplayed()

    const visibleTerminals = (): Promise<number> =>
      browser.execute(
        () =>
          [...document.querySelectorAll('.acp-terminal-reference')].filter(
            (node) => node instanceof HTMLElement && node.checkVisibility(),
          ).length,
      )
    expect(await visibleTerminals()).toBe(0)
    await saveAppScreenshot('concise-state-terminal.png')

    await footer.$('button').click()
    await browser.waitUntil(async () => (await visibleTerminals()) > 0)
    await saveAppScreenshot('concise-state-terminal-expanded.png')
  })

  it('leaves the prompt’s attachments and image untouched', async () => {
    await open('attachments')
    await $('.concise-turn-footer').waitForDisplayed()

    const prompt = (await rows()).find((row) => row.kind === 'user')
    expect(prompt?.text).toContain('settings.css')
    expect(prompt?.text).toContain('Pasted text')
    await expect($('.msg-user img')).toBeDisplayed()
    expect(painted(await rows(), 'assistant').map((row) => row.text)).toEqual([
      expect.stringContaining('The footer now matches your screenshot.'),
    ])
    await saveAppScreenshot('concise-state-attachments.png')
  })

  it('renders an old thread’s unattributed turn in full and the new turn concisely', async () => {
    await open('resumed')
    await $('.concise-turn-footer').waitForDisplayed()

    const all = await rows()
    const kinds = all.filter((row) => row.visible).map((row) => `${row.kind}:${String(row.cards)}`)
    // The legacy turn has no model on record, so it keeps its card and gets no footer;
    // the new turn is concise and does.
    expect(kinds).toEqual([
      'user:0',
      'assistant:1',
      'assistant:0',
      'user:0',
      'assistant:0',
      'footer:0',
    ])
    await saveAppScreenshot('concise-state-resumed.png')
  })

  it('judges each turn by the model that ran it and keeps the switch visible', async () => {
    await open('model-switch')
    await $('.concise-turn-footer').waitForDisplayed()

    const all = await rows()
    const summary = all
      .filter((row) => row.visible)
      .map((row) => `${row.kind}:${String(row.cards)}`)
    expect(summary).toEqual([
      'user:0',
      'assistant:0', // Opus: concise
      'footer:0',
      'user:0',
      'assistant:1', // Haiku, below the gate: full, with its card
      'assistant:0',
      'user:0',
      'assistant:0', // Opus again: concise
      'footer:0',
    ])
    // Each segment's model label sits on a bubble that is painted, so the user
    // can see where the model changed even though the work bubbles are hidden.
    const labels = await browser.execute(() =>
      [...document.querySelectorAll('.messages-list .msg-assistant')]
        .filter((node) => node instanceof HTMLElement && node.checkVisibility())
        .map((node) => node.querySelector('.message-model')?.textContent?.trim() ?? ''),
    )
    expect(labels).toEqual(['Claude Opus 5.5', 'Claude Haiku 4.5', '', 'Claude Opus 5.5'])
    await saveAppScreenshot('concise-state-model-switch.png')
  })
})

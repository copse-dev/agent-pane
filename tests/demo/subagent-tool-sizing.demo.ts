import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import { setComposerValue } from '../e2e/helpers/composer.ts'
import {
  parkPointer,
  saveElementScreenshot,
  waitForSettledLayout,
} from '../e2e/helpers/screenshot.ts'
import { buildDemoFixturePage } from './helpers/demo-fixture-page.ts'

const PARENT = '.tool-card-subagent[data-tool-id="sizing-parent"]'
const INNER = `${PARENT} .subagent-timeline .subagent-inner-tool[data-tool-id="sizing-shell"]`
const HEADER = `${INNER} > .tool-group-item-header`

interface TranscriptOutcome {
  thread: string | undefined
  parent: string | undefined
  session: string | undefined
  child: string | undefined
  childResult: string | null | undefined
  parentResult: string | null | undefined
  replyId: string | undefined
  replyRole: string | undefined
  replyContent: string | undefined
}

async function assertRunningRow(stage: string): Promise<{ headerWidth: number }> {
  await expect($(PARENT)).toHaveAttribute('data-status', 'running')
  await expect($(PARENT)).toHaveAttribute('open')
  await expect($(INNER)).toHaveAttribute('data-status', 'running')
  await expect($(INNER)).not.toHaveAttribute('open')
  await expect($('.submit-btn.with-stop')).toBeDisplayed()
  await expect($(`${PARENT} .subagent-timeline`)).toBeDisplayed()
  await expect($(`${PARENT} .subagent-message-assistant.is-streaming`)).toBeDisplayed()
  await expect($(`${HEADER} > .tool-command-phase`)).not.toExist()
  await expect(
    $$(`${HEADER} > .tool-activity-icon-slot > .reasoning-activity-icon`),
  ).toBeElementsArrayOfSize(1)
  await expect($(`${HEADER} > .tool-activity-icon-slot`)).toBeDisplayed()
  await expect($(`${HEADER} > .tool-activity-icon-slot > .reasoning-activity-icon`)).toBeDisplayed()
  await expect($(`${HEADER} > .tool-status-icon`)).not.toBeDisplayed()

  const metrics = await browser.execute((selector) => {
    const header = document.querySelector<HTMLElement>(selector)
    const label = header?.querySelector<HTMLElement>(':scope > .tool-name')
    const slot = header?.querySelector<HTMLElement>(':scope > .tool-activity-icon-slot')
    const svg = slot?.querySelector<SVGElement>(':scope > .reasoning-activity-icon')
    if (!header || !label || !slot || !svg) throw new Error('Missing live subagent header')
    const headerRect = header.getBoundingClientRect()
    const slotRect = slot.getBoundingClientRect()
    const svgRect = svg.getBoundingClientRect()
    // The real inner header declares font-size: var(--font-size-sm). Reading
    // its resolved font size measures that token without a surrogate DOM row.
    const expectedSize = Number.parseFloat(getComputedStyle(header).fontSize)
    return {
      held: window.subagentToolSizingFixture.held,
      released: window.subagentToolSizingFixture.released,
      expectedSize,
      slotWidth: slotRect.width,
      slotHeight: slotRect.height,
      svgWidth: svgRect.width,
      svgHeight: svgRect.height,
      slotShrink: getComputedStyle(slot).flexShrink,
      slotPosition: getComputedStyle(slot).position,
      slotOrder: getComputedStyle(slot).order,
      headerWidth: headerRect.width,
      headerInViewport:
        headerRect.left >= 0 &&
        headerRect.top >= 0 &&
        headerRect.right <= innerWidth &&
        headerRect.bottom <= innerHeight,
      labelWidth: label.getBoundingClientRect().width,
      labelClientWidth: label.clientWidth,
      labelScrollWidth: label.scrollWidth,
      labelOverflow: getComputedStyle(label).textOverflow,
      labelText: label.textContent,
    }
  }, HEADER)
  console.info('subagent-tool-sizing', JSON.stringify({ stage, ...metrics }))
  assert.equal(metrics.held, true, 'Child result must remain causally held')
  assert.equal(metrics.released, false)
  assert.ok(Number.isFinite(metrics.expectedSize) && metrics.expectedSize > 0)
  for (const [dimension, value] of [
    ['slot width', metrics.slotWidth],
    ['slot height', metrics.slotHeight],
    ['SVG width', metrics.svgWidth],
    ['SVG height', metrics.svgHeight],
  ] as const) {
    assert.ok(
      Math.abs(value - metrics.expectedSize) <= 0.1,
      `${stage}: ${dimension} ${String(value)} differs from token ${String(metrics.expectedSize)}`,
    )
  }
  assert.equal(metrics.slotShrink, '0')
  assert.equal(metrics.slotPosition, 'static')
  assert.equal(metrics.slotOrder, '1')
  assert.equal(metrics.headerInViewport, true)
  assert.ok(metrics.headerWidth > 0 && metrics.labelWidth > 0)
  assert.equal(metrics.labelOverflow, 'ellipsis')
  assert.ok(metrics.labelText.startsWith('pnpm run test:demo -- --spec'))
  if (stage.startsWith('narrow')) {
    assert.ok(
      metrics.labelScrollWidth > metrics.labelClientWidth,
      'The narrow child label must exercise actual CSS ellipsis',
    )
  }
  return { headerWidth: metrics.headerWidth }
}

describe('live subagent trailing icon sizing', () => {
  let fixturePage = ''
  before(async () => {
    fixturePage = await buildDemoFixturePage('subagent-tool-sizing-fixture')
  })

  it('keeps the real child wrapper and SVG at the size token in narrow and wide panels', async () => {
    await browser.url(fixturePage)
    await $('.prompt-input').waitForExist()
    await browser.execute(async () => {
      await document.fonts.ready
    })
    // Use the reader's layout control, not a content-width token override.
    if (!(await $('#pane-files').isDisplayed())) {
      await $('[aria-label="Toggle right panel"]').click()
    }
    await expect($('#pane-files')).toBeDisplayed()
    await setComposerValue('Check the live subagent tool layout.')
    const failures: unknown[] = []
    try {
      await $('.submit-btn').click()
      await browser.waitUntil(() => browser.execute(() => window.subagentToolSizingFixture.held), {
        timeoutMsg: 'Expected the checkpoint before the actual child tool result',
      })
      await expect($(`${PARENT} > summary.tool-card-header`)).toBeDisplayed()
      // The normal running-card policy may already have revealed this card.
      // Choose user-open in one task so that reveal cannot interleave with a
      // separate closed check and invert the intended click into user-closed.
      const disclosure = await browser.execute((selector) => {
        const card = document.querySelector<HTMLDetailsElement>(selector)
        const summary = card?.querySelector<HTMLElement>(':scope > summary.tool-card-header')
        if (!card || !summary) throw new Error('Missing live subagent disclosure')
        const wasOpen = card.open
        if (wasOpen) summary.click()
        summary.click()
        return { wasOpen, open: card.open, status: card.dataset['status'] }
      }, PARENT)
      console.info('subagent-tool-sizing disclosure', JSON.stringify(disclosure))
      assert.equal(disclosure.open, true)
      assert.equal(disclosure.status, 'running')
      await expect($(HEADER)).toBeDisplayed()
      await $(HEADER).scrollIntoView({ block: 'center', inline: 'nearest' })
      await waitForSettledLayout(HEADER)
      await parkPointer()
      const narrow = await assertRunningRow('narrow')
      await saveElementScreenshot(PARENT, 'subagent-tool-sizing-narrow.png', {
        beforeCapture: async () => {
          await assertRunningRow('narrow-capture')
        },
      })

      await $('[aria-label="Toggle right panel"]').click()
      await expect($('#pane-files')).not.toBeDisplayed()
      await $(HEADER).scrollIntoView({ block: 'center', inline: 'nearest' })
      await waitForSettledLayout(HEADER)
      await parkPointer()
      const wide = await assertRunningRow('wide')
      assert.ok(wide.headerWidth > narrow.headerWidth, 'The panel must really widen the child row')
      await saveElementScreenshot(PARENT, 'subagent-tool-sizing-wide.png', {
        beforeCapture: async () => {
          await assertRunningRow('wide-capture')
        },
      })

      await $('[aria-label="Toggle right panel"]').click()
      await expect($('#pane-files')).toBeDisplayed()
      await $(HEADER).scrollIntoView({ block: 'center', inline: 'nearest' })
      await waitForSettledLayout(HEADER)
      await parkPointer()
      const restored = await assertRunningRow('narrow-restored')
      assert.ok(Math.abs(restored.headerWidth - narrow.headerWidth) <= 1)
    } catch (error) {
      failures.push(error)
    } finally {
      try {
        await browser.execute(() => {
          window.subagentToolSizingFixture.release()
        })
        await expect($(INNER)).toHaveAttribute('data-status', 'done')
        await expect($(PARENT)).toHaveAttribute('data-status', 'done')
        await expect($('.submit-btn.with-stop')).not.toExist()
        await expect($(INNER)).not.toHaveAttribute('open')
        await expect(
          $(`${HEADER} > .tool-activity-icon-slot > .reasoning-activity-icon`),
        ).not.toExist()
        await expect($(`${HEADER} > .tool-status-icon`)).toBeDisplayed()
        const settled = await browser.execute((selector) => {
          const slot = document.querySelector(`${selector} > .tool-activity-icon-slot`)
          if (!slot) throw new Error('Missing settled activity slot')
          return { empty: slot.childElementCount === 0, display: getComputedStyle(slot).display }
        }, HEADER)
        assert.deepEqual(settled, { empty: true, display: 'none' })
        // Read the actual completed transcript through the ordinary in-memory
        // persistence API, proving both child session and parent settled normally.
        const readOutcome = async (): Promise<TranscriptOutcome> =>
          browser.execute(async () => {
            const threads = await window.api.threads.loadProject('subagent-sizing-project')
            const thread = threads.find((candidate) =>
              candidate.messages.some((message) =>
                message.toolCalls.some((call) => call.id === 'sizing-parent'),
              ),
            )
            const parent = thread?.messages
              .flatMap((message) => message.toolCalls)
              .find((call) => call.id === 'sizing-parent')
            const child = parent?.subagent?.messages
              .flatMap((message) => message.toolCalls)
              .find((call) => call.id === 'sizing-shell')
            const reply = thread?.messages.at(-1)
            return {
              thread: thread?.status,
              parent: parent?.status,
              session: parent?.subagent?.status,
              child: child?.status,
              childResult: child?.result,
              parentResult: parent?.result,
              replyId: reply?.id,
              replyRole: reply?.role,
              replyContent: reply?.content,
            }
          })
        await browser.waitUntil(
          async () => {
            const outcome = await readOutcome()
            return (
              outcome.thread === 'idle' &&
              outcome.parent === 'done' &&
              outcome.session === 'done' &&
              outcome.child === 'done' &&
              outcome.replyId !== undefined &&
              outcome.replyRole === 'assistant' &&
              outcome.replyContent === 'The subagent completed the layout check.'
            )
          },
          { timeoutMsg: 'Expected the actual persisted child, session and parent to finish' },
        )
        const { replyId, ...outcome } = await readOutcome()
        assert.deepEqual(outcome, {
          thread: 'idle',
          parent: 'done',
          session: 'done',
          child: 'done',
          childResult: 'Focused sizing check completed.',
          parentResult: 'The focused sizing check completed.',
          replyRole: 'assistant',
          replyContent: 'The subagent completed the layout check.',
        })
        assert.ok(replyId, 'The actual completed reply must have a message id')
        // The earlier tool-only parent bubble also has an empty direct text
        // element. Bind to the actual final reply, never the first text match or
        // a nested child's prose.
        const escapedReplyId = await browser.execute((id) => CSS.escape(id), replyId)
        await expect(
          $(`.msg-assistant[data-message-id="${escapedReplyId}"] > .message-body > .message-text`),
        ).toHaveText('The subagent completed the layout check.')
      } catch (error) {
        // Keep an earlier sizing/capture error if release or completion fails.
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      // WDIO's Mocha adapter drops AggregateError.errors from its report.
      // Log each original object so its assertion reason and stack survive.
      for (const [index, failure] of failures.entries()) {
        console.error('subagent-tool-sizing failure', index + 1, failure)
      }
      throw new AggregateError(failures, 'Live subagent sizing and completion both failed')
    }
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  prepareChatMessageScreenshot,
  saveAppScreenshot,
  savePreparedElementScreenshot,
} from './helpers/screenshot.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { rememberCanvasArtefact } from '../../src/main/services/canvas-store.ts'

const PROJECT_ID = 'e2e-inline-visualization-project'
const THREAD_ID = 'e2e-inline-visualization-thread'
const REFERENCE =
  '\u{e200}visualize\u{e202}{"path":"/workspace/tool-rollup-approaches.html","mode":"wide","title":"Tool rollup approaches"}\u{e201}'

const INLINE_PROTOTYPE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; background: #f5f2eb; color: #18211e; }
    button { font: inherit; }
    .shell { min-height: 100vh; padding: 20px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
    .brand { display: flex; align-items: center; gap: 9px; font-size: 12px; font-weight: 750; letter-spacing: .04em; }
    .mark { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 7px; background: #153b36; color: #a9ffca; }
    .live { display: flex; align-items: center; gap: 6px; color: #61706a; font-size: 11px; }
    .live::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #36c977; box-shadow: 0 0 0 3px #d9f1e2; }
    .intro { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 16px; }
    .eyebrow { margin: 0 0 5px; color: #8a5e72; font-size: 10px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; max-width: 540px; font: 500 clamp(23px, 4vw, 34px)/1.06 Georgia, serif; letter-spacing: -.025em; }
    .choices { display: flex; gap: 6px; }
    .choice { min-width: 34px; height: 30px; border: 1px solid #cbc7be; border-radius: 8px; background: #fffdf8; color: #5d6662; cursor: pointer; }
    .choice:hover, .choice:focus-visible { border-color: #93667b; outline: none; }
    .choice[aria-pressed='true'] { border-color: #153b36; background: #153b36; color: #fff; }
    .board { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(190px, .75fr); gap: 12px; }
    .panel { border: 1px solid #d8d3c8; border-radius: 13px; background: #fffdf8; box-shadow: 0 10px 26px rgba(28, 44, 38, .06); }
    .timeline { padding: 14px; }
    .row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid #ebe7de; }
    .row:last-child { border-bottom: 0; }
    .icon { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; background: #e7f0eb; color: #285f51; font-size: 12px; font-weight: 800; }
    .row strong { display: block; font-size: 12px; }
    .row small { display: block; margin-top: 2px; color: #7a827e; font-size: 10px; }
    .time { color: #8a928e; font-size: 10px; }
    .recommendation { display: flex; flex-direction: column; justify-content: space-between; padding: 16px; background: #153b36; color: #f8fff9; }
    .recommendation .label { color: #9fe4b9; font-size: 10px; font-weight: 750; letter-spacing: .11em; text-transform: uppercase; }
    .recommendation h2 { margin: 12px 0 8px; font: 500 24px/1.05 Georgia, serif; }
    .recommendation p { margin: 0; color: #c7d8d1; font-size: 11px; line-height: 1.45; }
    .selection { margin-top: 18px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,.16); color: #fff; font-size: 11px; }
    .selection strong { color: #ffb5d4; }
    @media (max-width: 520px) {
      .shell { padding: 14px; }
      .intro { align-items: start; flex-direction: column; }
      .board { grid-template-columns: 1fr; }
      .recommendation { min-height: 160px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="topbar">
      <div class="brand"><span class="mark">R</span> Rollup studio</div>
      <div class="live">Interactive prototype</div>
    </div>
    <div class="intro">
      <div><p class="eyebrow">Conversation design</p><h1>Choose how work folds into the thread</h1></div>
      <div class="choices" aria-label="Rollup approach">
        <button class="choice" data-choice="A" aria-pressed="false">A</button>
        <button class="choice" data-choice="B" aria-pressed="false">B</button>
        <button class="choice" data-choice="C" aria-pressed="true">C</button>
      </div>
    </div>
    <section class="board">
      <div class="panel timeline">
        <div class="row"><span class="icon">1</span><span><strong>Read the renderer</strong><small>Source and styles stay in chronological order</small></span><span class="time">0:08</span></div>
        <div class="row"><span class="icon">2</span><span><strong>Build focused change</strong><small>Related calls fold into one quiet step</small></span><span class="time">0:24</span></div>
        <div class="row"><span class="icon">3</span><span><strong>Validate visually</strong><small>The result remains beside the explanation</small></span><span class="time">0:41</span></div>
      </div>
      <aside class="panel recommendation">
        <div><span class="label">Recommended</span><h2>Approach C</h2><p>Compact at rest, chronological when expanded, and easy to scan.</p></div>
        <div class="selection">Selected: <strong id="selection">Approach C</strong></div>
      </aside>
    </section>
  </main>
  <script>
    const choices = [...document.querySelectorAll('[data-choice]')];
    choices.forEach((choice) => choice.addEventListener('click', () => {
      choices.forEach((item) => item.setAttribute('aria-pressed', String(item === choice)));
      document.querySelector('#selection').textContent = 'Approach ' + choice.dataset.choice;
    }));
  </script>
</body>
</html>`

async function drawAnnotation(selector: string): Promise<void> {
  await browser.execute((surfaceSelector) => {
    const surface = document.querySelector(surfaceSelector)
    if (!surface) throw new Error(`missing annotation surface: ${surfaceSelector}`)
    const pointer = (type: string, x: number, y: number): PointerEvent =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: 'mouse',
        pressure: 0.5,
      })
    const bounds = surface.getBoundingClientRect()
    const x = (fraction: number): number => bounds.left + bounds.width * fraction
    const y = (fraction: number): number => bounds.top + bounds.height * fraction
    surface.dispatchEvent(pointer('pointerdown', x(0.15), y(0.35)))
    window.dispatchEvent(pointer('pointermove', x(0.5), y(0.55)))
    window.dispatchEvent(pointer('pointerup', x(0.75), y(0.7)))
  }, selector)
}

describe('ACP inline visualization reference', () => {
  before(async () => {
    const now = Date.now()
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Inline visualization',
          status: 'idle',
          messages: [
            {
              id: 'inline-vis-user',
              role: 'user',
              content: 'Show me the tool rollup options.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: 'inline-vis-assistant',
              role: 'assistant',
              content: `${REFERENCE}\nApproach C best balances compression with the conversation's chronology.`,
              toolCalls: [],
              canvasArtefacts: [{ title: 'Tool rollup approaches' }],
              createdAt: now + 1,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now + 1,
        },
      ],
    })
    const preview = readFileSync(
      join(process.cwd(), 'tests/e2e/fixtures/inline-rollup-prototype.png'),
    )
    await rememberCanvasArtefact(PROJECT_ID, THREAD_ID, {
      title: 'Tool rollup approaches',
      mimeType: 'text/html',
      body: INLINE_PROTOTYPE_HTML,
      threadId: THREAD_ID,
      preview: `data:image/png;base64,${preview.toString('base64')}`,
    })
    await browser.reloadSession()
    await $('[data-message-id="inline-vis-assistant"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('hides the provider control frame and keeps the answer readable', async function () {
    this.timeout(90_000)
    const answer = $('[data-message-id="inline-vis-assistant"] .message-text')
    await expect(answer).toHaveText(
      "Approach C best balances compression with the conversation's chronology.",
    )
    expect(await $('.tool-card').isExisting()).toEqual(false)
    const card = $('.message-canvas-previews .canvas-preview-card')
    await card.waitForExist({ timeout: 20_000 })
    await expect(card.$('.canvas-preview-title')).toHaveText('Tool rollup approaches')
    await browser.waitUntil(
      async () => (await card.getAttribute('data-canvas-state')) === 'interactive',
      { timeout: 20_000, timeoutMsg: 'expected the inline canvas guest to become interactive' },
    )
    await expect(card.$('.canvas-inline-status')).toHaveText('Interactive')
    await expect(card.$('.canvas-preview-open')).toHaveText('Open canvas')
    expect(await card.$('.canvas-inline-webview').getAttribute('partition')).toContain(THREAD_ID)
    expect(
      await browser.execute(() => {
        const webview = document.querySelector('.canvas-inline-webview')
        return webview ? getComputedStyle(webview).display : null
      }),
    ).toEqual('flex')
    expect(await $('.messages-list').getText()).not.toContain('visualize')
    expect(await $('.messages-list').getText()).not.toContain(
      '/workspace/tool-rollup-approaches.html',
    )
    expect(await $('#pane-files').getAttribute('hidden')).not.toEqual(null)

    const selected = await browser.execute(async () => {
      const webview = document.querySelector('.canvas-inline-webview') as {
        executeJavaScript?: (source: string) => Promise<unknown>
      } | null
      await webview?.executeJavaScript?.(`document.querySelector('[data-choice="A"]')?.click()`)
      return await webview?.executeJavaScript?.(
        `document.querySelector('#selection')?.textContent ?? null`,
      )
    })
    expect(selected).toEqual('Approach A')

    await browser.execute(async () => {
      const webview = document.querySelector('.canvas-inline-webview') as {
        executeJavaScript?: (source: string) => Promise<unknown>
      } | null
      await webview?.executeJavaScript?.(`document.querySelector('[data-choice="C"]')?.click()`)
    })

    await prepareChatMessageScreenshot()
    const annotate = $('.message-canvas-previews .canvas-preview-annotate')
    await expect(annotate).toHaveText('Annotate')
    await annotate.click()
    await expect(annotate).toHaveAttribute('aria-pressed', 'true')
    await $('.message-canvas-previews [data-tool="rect"]').click()
    await drawAnnotation('.message-canvas-previews .annotation-layer-svg')
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document.querySelector('.message-canvas-previews .annotation-layer-svg')
              ?.childElementCount ?? 0,
        )) === 1,
      { timeout: 5_000, timeoutMsg: 'expected an inline annotation mark' },
    )
    await expect($('.message-canvas-previews .annotation-send')).toBeEnabled()
    const previews = $('.message-canvas-previews')
    await previews.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'inline-canvas-annotation.png'))
    await $('.message-canvas-previews [aria-label="Clear"]').click()
    await $('.message-canvas-previews [aria-label="Done"]').click()
    await expect($('.message-canvas-previews .canvas-preview-annotate')).toHaveAttribute(
      'aria-pressed',
      'false',
    )

    // ChromeDriver screenshots omit the out-of-process guest surface on macOS.
    // Reveal the matching captured frame underneath for the visual reference;
    // the live guest and its interaction were asserted immediately above.
    await browser.execute(() => {
      const webview = document.querySelector<HTMLElement>('.canvas-inline-webview')
      const preview = document.querySelector<HTMLElement>(
        '.canvas-inline-stage .canvas-preview-image',
      )
      if (webview) webview.style.opacity = '0'
      if (preview) preview.style.visibility = 'visible'
    })

    await savePreparedElementScreenshot('.messages-list', 'acp-inline-visualization-reference.png')

    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('.canvas-preview-open')?.click()
    })
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document.querySelector('.browser-tabs-tab.is-active .browser-tabs-tab-label')
              ?.textContent ?? null,
        )) === 'Tool rollup approaches',
      { timeout: 20_000, timeoutMsg: 'expected Open to restore the saved canvas artefact' },
    )
    await $('.browser-tab-panel.is-active webview').waitForExist({ timeout: 20_000 })
    await browser.waitUntil(
      async () =>
        (await browser.execute(async () => {
          const webview = document.querySelector('.browser-tab-panel.is-active webview') as {
            executeJavaScript?: (source: string) => Promise<unknown>
          } | null
          return await webview?.executeJavaScript?.(
            `document.querySelector('h1')?.textContent ?? null`,
          )
        })) === 'Choose how work folds into the thread',
      { timeout: 20_000, timeoutMsg: 'expected the Browser canvas guest to finish loading' },
    )

    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const button = document.querySelector<HTMLElement>(
            '.browser-tab-panel.is-active .browser-annotate-btn',
          )
          return button !== null && button.offsetParent !== null
        }),
      { timeout: 10_000, timeoutMsg: 'expected the Browser annotation control to become visible' },
    )
    await browser.execute(() => {
      document
        .querySelector<HTMLButtonElement>('.browser-tab-panel.is-active .browser-annotate-btn')
        ?.click()
    })
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document
              .querySelector('.browser-tab-panel.is-active .browser-annotate-btn')
              ?.getAttribute('aria-pressed') ?? null,
        )) === 'true',
      { timeout: 5_000, timeoutMsg: 'expected Browser annotation mode to activate' },
    )
    await $('.browser-tab-panel.is-active [data-tool="arrow"]').click()
    await drawAnnotation('.browser-tab-panel.is-active .annotation-layer-svg')
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document.querySelector('.browser-tab-panel.is-active .annotation-layer-svg')
              ?.childElementCount ?? 0,
        )) === 1,
      { timeout: 5_000, timeoutMsg: 'expected a Browser pane annotation mark' },
    )
    await saveAppScreenshot('browser-canvas-annotation.png')

    await browser.execute(() => {
      document
        .querySelector<HTMLButtonElement>('.browser-tab-panel.is-active .annotation-send')
        ?.click()
    })
    await $('.attachment-chips .image-chip').waitForDisplayed({ timeout: 20_000 })
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document
              .querySelector('.browser-tab-panel.is-active .browser-annotate-btn')
              ?.getAttribute('aria-pressed') ?? null,
        )) === 'false',
      { timeout: 5_000, timeoutMsg: 'expected Browser annotation mode to deactivate after Send' },
    )
    const sentState = await browser.execute(() => {
      const root = document.querySelector<HTMLElement>(
        '.browser-tab-panel.is-active .annotation-layer',
      )
      const surface = root?.querySelector('.annotation-layer-svg')
      return { hidden: root?.hidden ?? false, marks: surface?.childElementCount ?? -1 }
    })
    expect(sentState).toEqual({ hidden: true, marks: 0 })
    await expect($('.attachment-chips .image-chip img')).toHaveAttribute(
      'src',
      expect.stringContaining('data:image/png;base64,'),
    )
    await assertNoErrorToasts('canvas annotation')
  })
})

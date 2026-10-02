import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ToolCall } from '../../src/shared/types/index.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json'
import { browser, $ } from '@wdio/globals'
import { drawingStory, textAlignmentStory } from '../fixtures/explainer-drawing.ts'
import { loadProjectThreads } from '../../src/main/services/thread-store.ts'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { submitComposer } from './helpers/composer.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { getCopseUserDataDir, waitForAgentIdle, waitForPromptReady } from './helpers.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { E2E_SCREENSHOT_DIR, prepareE2eScreenshot } from './helpers/screenshot.ts'

async function turn(prompt: string, name: string, args: Record<string, unknown>): Promise<void> {
  const scenario = await prepareMockToolTurn(
    prompt,
    { name, args },
    'The requested check is complete.',
  )
  await submitComposer()
  await scenario.waitForComplete(60_000)
  await waitForAgentIdle(60_000)
  await scenario.assertComplete()
}
async function lastCall(): Promise<ToolCall | undefined> {
  const config = safeJsonParse(
    await readFile(join(getCopseUserDataDir(), 'config.json'), 'utf8'),
    decodeWithSchema(
      z.object({ activeProjectId: z.string(), activeThreadId: z.string().optional() }),
    ),
  )
  assert.ok(config)
  const threads = await loadProjectThreads(config.activeProjectId)
  const thread = threads.find((t) => t.id === config.activeThreadId) ?? threads.at(-1)
  return thread?.messages.flatMap((m) => m.toolCalls).at(-1)
}
async function guest(code: string, index = 0): Promise<unknown> {
  return browser.execute(
    async (script, item) => {
      const view = document.querySelectorAll('.canvas-inline-artefact webview').item(item)
      const execute = view ? Reflect.get(view, 'executeJavaScript') : undefined
      return typeof execute === 'function' ? execute.call(view, script) : null
    },
    code,
    index,
  )
}
async function capture(index: number, name: string, playerName: string): Promise<void> {
  await prepareE2eScreenshot()
  const png = await browser.execute(async (item) => {
    const card = document.querySelectorAll('.canvas-inline-artefact').item(item)
    card?.scrollIntoView({ block: 'center' })
    const view = card?.querySelector('webview')
    const getId = view ? Reflect.get(view, 'getWebContentsId') : undefined
    if (typeof getId !== 'function') throw new Error('Expected live drawing guest')
    const screenshot = await window.api.browser.captureScreenshot(getId.call(view))
    const image = card.querySelector('img')
    if (!image || !view) throw new Error('Expected card preview')
    image.src = screenshot.dataUrl
    await image.decode()
    image.style.objectFit = 'contain'
    image.style.visibility = 'visible'
    view.style.opacity = '0'
    return screenshot.dataUrl
  }, index)
  await writeFile(
    join(E2E_SCREENSHOT_DIR, `${playerName}.png`),
    Buffer.from(png.split(',')[1] ?? '', 'base64'),
  )
  await $('#app').saveScreenshot(join(E2E_SCREENSHOT_DIR, `${name}.png`))
  await browser.execute((item) => {
    const card = document.querySelectorAll('.canvas-inline-artefact').item(item)
    const view = card?.querySelector<HTMLElement>('webview')
    const image = card?.querySelector('img')
    if (view) view.style.opacity = ''
    if (image) image.style.visibility = ''
  }, index)
}

describe('original drawings in the thread player', function () {
  this.timeout(180_000)
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-explainer-drawing', {
      model: 'claude-sonnet-4-6',
      mcpUiCanvasEnabled: true,
      theme: 'dark',
      autoPortraitRightPanel: false,
      rightPanelPosition: 'side',
    })
    await browser.reloadSession()
    await browser.execute(async () => {
      await window.api.plugins.setSetting('copse.mcp-ui-canvas', 'animatedExplainers', true)
    })
    await waitForPromptReady()
  })
  after(() => resetUserData())

  it('rejects broken, frozen and nondeterministic drawings without publishing', async function () {
    this.timeout(180_000)
    for (const { code, message } of [
      { code: 'const = ;', message: /Unexpected|Syntax|token/i },
      { code: 'while(true){}', message: /too long|timed out/i },
      { code: 'helpers.rect(100,100,100,100,"#ffffff");', message: /did not change/i },
      { code: 'helpers.rect(frame.index*80,100,100,100,"#ffffff");', message: /did not change/i },
      { code: 'helpers.rect(Math.random()*600,100,100,100,"#ffffff");', message: /deterministic/i },
      {
        code: 'helpers.textBox("Unreadable label",20,20,50,30);',
        message: /textBox cannot fit.*Enlarge the box/i,
      },
      {
        code: 'helpers.textBox("Label",20,20,50,30,{padding:30});',
        message: /textBox needs valid bounds/i,
      },
    ]) {
      await turn('Check this animation draft.', 'mcp__copse-canvas__preview_explainer', {
        ...drawingStory,
        drawing: { ...drawingStory.drawing, code },
      })
      const call = await lastCall()
      assert.equal(call?.status, 'error')
      assert.match(call?.result ?? '', message)
      assert.equal(await browser.$$('.canvas-inline-artefact').length, 0)
    }
  })

  it('reviews transitions, publishes by ID, resizes, revises and reopens the original drawings', async function () {
    this.timeout(180_000)
    const isolationProbe = `
if(typeof document!=='undefined'||typeof require!=='undefined'||typeof process!=='undefined')throw new Error('Drawing escaped its worker');
let blocked=false;try{const x=new XMLHttpRequest();x.open('GET','data:text/plain,blocked',false);x.send();}catch{blocked=true;}
if(!blocked)throw new Error('Drawing network policy is missing');
`
    for (const index of [0, 1]) {
      const input = {
        ...drawingStory,
        drawing: {
          ...drawingStory.drawing,
          styleName: index ? 'Night exhibition' : drawingStory.drawing.styleName,
          background: index ? '#24213b' : drawingStory.drawing.background,
          code: isolationProbe + drawingStory.drawing.code,
        },
      }
      await turn(
        index
          ? 'Make the explanation look like a night exhibition.'
          : 'Explain how this water supply is divided.',
        'mcp__copse-canvas__preview_explainer',
        input,
      )
      const preview = await lastCall()
      assert.equal(preview?.status, 'done', preview?.result)
      assert.equal(preview?.images?.length, 4)
      assert.match(preview?.result ?? '', /mid-transition/)
      const previewId = preview?.result?.match(/Preview ID: ([a-f0-9-]+)/)?.[1]
      assert.ok(previewId)
      await turn('Show the reviewed explanation.', 'mcp__copse-canvas__render_explainer', {
        previewId,
      })
      await browser.waitUntil(
        async () => {
          try {
            return (await guest('Boolean(window.explainerReady)', index)) === true
          } catch {
            return false
          }
        },
        { timeout: 30_000 },
      )
      assert.equal(
        await guest(
          'window.explainerReady.then(()=>story.version).catch(error=>String(error))',
          index,
        ),
        3,
      )
      await browser.execute(
        (item) =>
          document
            .querySelectorAll('.canvas-inline-artefact')
            .item(item)
            ?.scrollIntoView({ block: 'center' }),
        index,
      )
      assert.equal(await guest('document.querySelectorAll("#transcript li").length', index), 4)
      await guest('window.renderFrame(0)', index)
      const first = await guest('document.querySelector("#scene").toDataURL()', index)
      await guest('document.querySelector("#play").click()', index)
      await browser
        .waitUntil(
          async () => Number(await guest('document.querySelector("#seek").value', index)) > 8,
          { timeout: 20_000 },
        )
        .catch(async () => {
          throw new Error(
            'Playback stopped: ' +
              String(
                await guest(
                  'JSON.stringify({index:story.drawing.styleName,position:document.querySelector("#seek").value,play:document.querySelector("#play").textContent,hidden:document.hidden,error:document.querySelector("#scene").dataset.error})',
                  index,
                ),
              ),
          )
        })
      await guest('document.querySelector("#play").click()', index)
      assert.equal(
        (await guest('document.querySelector("#scene").toDataURL()', index)) === first,
        false,
      )
      assert.equal(
        await guest(
          '(async()=>{await renderFrame(18);const a=document.querySelector("#scene").toDataURL();await renderFrame(3);await renderFrame(18);return a===document.querySelector("#scene").toDataURL()})()',
          index,
        ),
        true,
      )
      await guest('window.renderFrame(story.duration)', index)
      assert.equal(await guest('document.querySelector("#play").textContent', index), 'Replay')
      await (index === 0
        ? capture(index, 'explainer-drawing-1', 'explainer-drawing-1-player')
        : capture(index, 'explainer-drawing-2', 'explainer-drawing-2-player'))
      if (index === 1) {
        await browser.execute(() => {
          const card = document.querySelectorAll<HTMLElement>('.canvas-inline-artefact').item(1)
          card.style.width = '320px'
        })
        await browser.waitUntil(async () => (await guest('innerWidth <= 322', index)) === true, {
          timeout: 10_000,
        })
        assert.equal(
          await guest(
            'document.documentElement.scrollWidth <= innerWidth && getComputedStyle(document.querySelector("#caption")).display !== "none" && document.querySelector("nav").getBoundingClientRect().right <= innerWidth',
            index,
          ),
          true,
        )
        assert.equal(
          await guest('document.querySelector("#caption").textContent', index),
          drawingStory.beats[3]?.caption,
        )
        await capture(index, 'explainer-drawing-narrow', 'explainer-drawing-narrow-player')
      }
      await assertNoErrorToasts('original drawing')
    }
    await browser.reloadSession()
    await waitForPromptReady()
    await browser.waitUntil(
      async () => (await browser.$$('.canvas-inline-artefact').length) === 2,
      { timeout: 30_000 },
    )
    for (const index of [0, 1]) {
      await browser.execute(
        (item) =>
          document
            .querySelectorAll('.canvas-inline-artefact')
            .item(item)
            ?.scrollIntoView({ block: 'center' }),
        index,
      )
      await browser.waitUntil(
        async () => {
          try {
            return (
              (await guest('window.explainerReady.then(()=>story.drawing.styleName)', index)) ===
              (index ? 'Night exhibition' : drawingStory.drawing.styleName)
            )
          } catch {
            return false
          }
        },
        { timeout: 30_000 },
      )
      await guest('window.renderFrame(story.duration)', index)
    }
  })

  it('centres real glyphs, wraps without clipping and keeps transformed labels attached', async () => {
    await turn('Check text alignment.', 'mcp__copse-canvas__preview_explainer', textAlignmentStory)
    const preview = await lastCall()
    assert.equal(preview?.status, 'done', preview?.result)
    assert.equal(preview?.images?.length, 3)
    const previewId = preview?.result?.match(/Preview ID: ([a-f0-9-]+)/)?.[1]
    assert.ok(previewId)
    await turn('Publish the checked layout.', 'mcp__copse-canvas__render_explainer', { previewId })
    assert.equal((await lastCall())?.status, 'done')
    const index = 2
    await browser.waitUntil(
      async () => {
        try {
          return (await guest('Boolean(window.explainerReady)', index)) === true
        } catch {
          return false
        }
      },
      { timeout: 30_000 },
    )
    await guest('window.explainerReady', index)
    assert.equal(
      await guest(
        `(async()=>{
      await renderFrame(2);const first=document.querySelector('#scene').toDataURL();
      await renderFrame(6);const moved=document.querySelector('#scene').toDataURL();
      await renderFrame(2);return first!==moved && first===document.querySelector('#scene').toDataURL();
    })()`,
        index,
      ),
      true,
    )
    await capture(index, 'explainer-text-alignment', 'explainer-text-alignment-player')
    await assertNoErrorToasts('text alignment')
  })
})

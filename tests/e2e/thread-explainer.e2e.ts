import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import assert from 'node:assert/strict'
import { browser, $ } from '@wdio/globals'
import { submitComposer } from './helpers/composer.ts'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle, waitForPromptReady } from './helpers.ts'
import {
  prepareE2eScreenshot,
  E2E_SCREENSHOT_DIR,
  waitForSettledLayout,
} from './helpers/screenshot.ts'

const story = {
  project: 'Copse',
  title: 'Three searches, one answer',
  pattern: 'parallel',
  style: 'auto',
  duration: 24,
  audience: 'both',
  labels: ['Text matches', 'Related concepts', 'File evidence'],
  beats: [
    {
      title: 'Start with the question',
      caption:
        'A question may span several parts of a project. One search can miss useful evidence.',
    },
    {
      title: 'Give each search a job',
      caption:
        'Use exact text matches, related concepts and file inspection to investigate different clues.',
    },
    {
      title: 'Bring the evidence together',
      caption: 'Compare the findings with the source files before explaining how the code works.',
    },
  ],
  source:
    'Conceptual search example from the supplied brief; availability depends on enabled tools.',
}

async function guest(script: string, index = 0): Promise<unknown> {
  return browser.execute(
    async (code, item) => {
      const view = document.querySelectorAll('.canvas-inline-artefact webview').item(item)
      const execute = view ? Reflect.get(view, 'executeJavaScript') : undefined
      if (typeof execute !== 'function') return null
      return execute.call(view, code)
    },
    script,
    index,
  )
}

async function waitForPlayer(index = 0): Promise<void> {
  await browser.waitUntil(
    async () => {
      try {
        return (await guest('Boolean(document.getElementById("play"))', index)) === true
      } catch {
        return false
      }
    },
    { timeout: 30_000, timeoutMsg: 'Expected a live explainer inside the assistant message' },
  )
}

async function makeExplainer(prompt: string, style: string): Promise<void> {
  const scenario = await prepareMockToolTurn(
    prompt,
    {
      name: 'mcp__copse-canvas__render_explainer',
      args: { ...story, style },
    },
    'Here is the explanation. You can ask me to simplify it or change the style.',
  )
  await submitComposer()
  await scenario.waitForComplete(45_000)
  await waitForAgentIdle(45_000)
  await scenario.assertComplete()
}

describe('thread explainer', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-thread-explainer', {
      model: 'claude-sonnet-4-6',
      mcpUiCanvasEnabled: true,
      theme: 'dark',
      autoPortraitRightPanel: false,
      rightPanelPosition: 'side',
    })
    await browser.reloadSession()
  })
  after(() => {
    resetUserData()
  })

  it('embeds a playable card, preserves revisions and survives reload', async function () {
    this.timeout(150_000)
    await waitForPromptReady()
    await makeExplainer(
      'Explain how different searches can find the code behind a question',
      'auto',
    )
    await waitForPlayer()
    assert.equal(await guest('document.getElementById("style").textContent'), 'Isometric mailroom')
    assert.equal(await guest('document.querySelectorAll("#transcript li").length'), 3)
    assert.equal(await browser.$$('.canvas-inline-artefact').length, 1)
    assert.equal(
      await browser.$$('.browser-tab-panel.is-active .browser-webview-host').length,
      0,
      'must not open the Browser pane',
    )
    const firstFrame = await guest('document.getElementById("scene").toDataURL()')
    await guest('document.getElementById("play").click()')
    await browser.waitUntil(
      async () => Number(await guest('document.getElementById("seek").value')) > 1,
      { timeout: 10_000 },
    )
    await guest('document.getElementById("play").click()')
    assert.notEqual(
      await guest('document.getElementById("scene").toDataURL()'),
      firstFrame,
      'animation must draw changing frames',
    )
    assert.equal(await guest('document.getElementById("play").textContent'), 'Play')
    assert.equal(
      await guest(
        '(()=>{const b=document.getElementById("play").getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight})()',
      ),
      true,
      'playback controls must fit the inline viewport',
    )

    await makeExplainer('Try this in paper, keeping the explanation the same', 'paper')
    await waitForPlayer(1)
    assert.equal(await browser.$$('.canvas-inline-artefact').length, 2)
    assert.equal(
      await guest('document.getElementById("style").textContent', 0),
      'Isometric mailroom',
    )
    assert.equal(await guest('document.getElementById("style").textContent', 1), 'Paper desk')
    await prepareE2eScreenshot()
    await browser.execute(() =>
      document
        .querySelectorAll('.canvas-inline-artefact')
        .item(1)
        ?.scrollIntoView({ block: 'center' }),
    )
    await waitForPlayer(1)
    await guest(
      'document.getElementById("seek").value=10;document.getElementById("seek").dispatchEvent(new Event("input"))',
      1,
    )
    await waitForSettledLayout('#app')
    assert.equal(
      await guest(
        '(()=>{const c=document.getElementById("scene").getBoundingClientRect(), b=document.getElementById("play").getBoundingClientRect();return c.width<=innerWidth+1&&b.bottom<=innerHeight})()',
        1,
      ),
      true,
    )
    await assertNoErrorToasts('before reload')
    // ChromeDriver does not reliably composite macOS out-of-process guests.
    // Capture the live guest through Copse's normal screenshot API, then use
    // that exact frame in the existing preview layer for the app screenshot.
    const frame = await browser.execute(async () => {
      const card = document.querySelectorAll('.canvas-inline-artefact').item(1)
      const view = card?.querySelector('webview')
      const getId = view ? Reflect.get(view, 'getWebContentsId') : undefined
      if (typeof getId !== 'function') throw new Error('Expected a live guest')
      const id = getId.call(view)
      const screenshot = await window.api.browser.captureScreenshot(id)
      const preview = card.querySelector('img')
      if (!preview || !view) throw new Error('Expected preview and guest')
      preview.src = screenshot.dataUrl
      await preview.decode()
      preview.style.objectFit = 'contain'
      preview.style.visibility = 'visible'
      view.style.opacity = '0'
      return screenshot.dataUrl
    })
    await writeFile(
      join(E2E_SCREENSHOT_DIR, 'thread-explainer-player.png'),
      Buffer.from(frame.split(',')[1] ?? '', 'base64'),
    )
    await $('#app').saveScreenshot(join(E2E_SCREENSHOT_DIR, 'thread-explainer-inline.png'))

    await assertNoErrorToasts('captured preview')
    await browser.reloadSession()
    await waitForPromptReady()
    await waitForPlayer(1)
    assert.equal(await browser.$$('.canvas-inline-artefact').length, 2)
    assert.equal(
      await guest('document.getElementById("style").textContent', 0),
      'Isometric mailroom',
    )
    assert.equal(await guest('document.getElementById("style").textContent', 1), 'Paper desk')
    await guest(
      'document.getElementById("seek").value=24;document.getElementById("seek").dispatchEvent(new Event("input"))',
      1,
    )
    assert.equal(await guest('document.getElementById("play").textContent', 1), 'Replay')
    await guest('document.getElementById("play").click()', 1)
    assert.equal(await guest('document.getElementById("play").textContent', 1), 'Pause')
  })
})

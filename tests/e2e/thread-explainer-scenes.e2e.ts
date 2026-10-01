import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { browser, $ } from '@wdio/globals'
import { reviewSceneStory, worktreeSceneStory } from '../fixtures/explainer-scenes.ts'
import { loadProjectThreads } from '../../src/main/services/thread-store.ts'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { submitComposer } from './helpers/composer.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { getCopseUserDataDir, waitForAgentIdle, waitForPromptReady } from './helpers.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { E2E_SCREENSHOT_DIR, prepareE2eScreenshot } from './helpers/screenshot.ts'

async function turn(prompt: string, name: string, args: Record<string, unknown>): Promise<void> {
  const scenario = await prepareMockToolTurn(prompt, { name, args }, 'The explanation is ready.')
  await submitComposer()
  await scenario.waitForComplete(60_000)
  await waitForAgentIdle(60_000)
  await scenario.assertComplete()
}
async function guest(code: string, index: number): Promise<unknown> {
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
async function previewId(): Promise<string> {
  const raw: unknown = JSON.parse(
    await readFile(join(getCopseUserDataDir(), 'config.json'), 'utf8'),
  )
  const config = z
    .object({ activeProjectId: z.string(), activeThreadId: z.string().optional() })
    .parse(raw)
  const threads = await loadProjectThreads(config.activeProjectId)
  const thread = threads.find((t) => t.id === config.activeThreadId) ?? threads.at(-1)
  const call = thread?.messages
    .flatMap((m) => m.toolCalls)
    .filter((t) => t.name.endsWith('preview_explainer'))
    .at(-1)
  assert.equal(call?.status, 'done')
  assert.ok((call?.images?.length ?? 0) >= 4, 'actual scene frames must reach the model')
  const id = call?.result?.match(/Preview ID: ([a-f0-9-]+)/)?.[1]
  assert.ok(id)
  return id
}

describe('composed explainer scenes', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-explainer-scenes', {
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
  })
  after(() => resetUserData())
  it('previews real frames, publishes the reviewed story and preserves causal state', async function () {
    this.timeout(180_000)
    await waitForPromptReady()
    for (const [index, story] of [reviewSceneStory, worktreeSceneStory].entries()) {
      await turn(`Preview ${story.title}`, 'mcp__copse-canvas__preview_explainer', story)
      assert.equal(
        await browser.$$('.canvas-inline-artefact').length,
        index,
        'preview must not publish a card',
      )
      await browser.pause(500)
      const id = await previewId()
      await turn(`Show ${story.title}`, 'mcp__copse-canvas__render_explainer', {
        ...story,
        previewId: id,
      })
      await browser.waitUntil(
        async () => {
          try {
            return (await guest('Boolean(document.getElementById("play"))', index)) === true
          } catch {
            return false
          }
        },
        { timeout: 30_000 },
      )
      assert.equal(
        await guest('document.querySelectorAll("#transcript li").length', index),
        story.scenes.length,
      )
      const first = await guest('document.getElementById("scene").toDataURL()', index)
      await guest('document.getElementById("play").click()', index)
      await browser.waitUntil(
        async () => Number(await guest('document.getElementById("seek").value', index)) > 2,
        { timeout: 10_000 },
      )
      await guest('document.getElementById("play").click()', index)
      assert.notEqual(await guest('document.getElementById("scene").toDataURL()', index), first)
      await guest(
        'document.getElementById("seek").value=document.getElementById("seek").max;document.getElementById("seek").dispatchEvent(new Event("input"))',
        index,
      )
      const state = await guest(
        'JSON.stringify(SceneExplainer.stateAt(story,story.duration).objects.map(o=>({id:o.id,content:o.content,visible:o.visible,conflict:o.conflict})))',
        index,
      )
      assert.equal(typeof state, 'string')
      if (index === 0) {
        assert.match(String(state), /"content":"Welcome"/)
        assert.match(String(state), /"id":"bad"[^}]*"visible":false/)
      } else {
        assert.match(String(state), /theme: grey/)
        assert.match(String(state), /theme: blue/)
        assert.match(String(state), /theme: coral/)
        assert.match(String(state), /"conflict":true/)
      }
      await prepareE2eScreenshot()
      await browser.execute(
        (item) =>
          document
            .querySelectorAll('.canvas-inline-artefact')
            .item(item)
            ?.scrollIntoView({ block: 'center' }),
        index,
      )
      const frame = await browser.execute(async (item) => {
        const card = document.querySelectorAll('.canvas-inline-artefact').item(item)
        const view = card?.querySelector('webview')
        const getId = view ? Reflect.get(view, 'getWebContentsId') : undefined
        if (typeof getId !== 'function') throw new Error('Expected live guest')
        const capture = await window.api.browser.captureScreenshot(getId.call(view))
        const image = card.querySelector('img')
        if (!image || !view) throw new Error('Missing preview')
        image.src = capture.dataUrl
        await image.decode()
        image.style.objectFit = 'contain'
        image.style.visibility = 'visible'
        view.style.opacity = '0'
        return capture.dataUrl
      }, index)
      await writeFile(
        join(E2E_SCREENSHOT_DIR, `explainer-scenes-${index + 1}-player.png`),
        Buffer.from(frame.split(',')[1] ?? '', 'base64'),
      )
      await $('#app').saveScreenshot(join(E2E_SCREENSHOT_DIR, `explainer-scenes-${index + 1}.png`))
      await assertNoErrorToasts('composed explainer')
    }
    await browser.reloadSession()
    await waitForPromptReady()
    await browser.waitUntil(
      async () => (await browser.$$('.canvas-inline-artefact').length) === 2,
      { timeout: 30_000 },
    )
  })
})

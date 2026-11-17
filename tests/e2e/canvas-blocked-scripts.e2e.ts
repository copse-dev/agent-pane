import { submitComposer } from './helpers/composer.ts'
import { expectAssistantReply, prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedStableWorkspace, writeSeedConfig } from './helpers/seed-config.ts'
import { waitForAgentIdle, waitForPromptReady } from './helpers.ts'
import { saveAppViewportScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-canvas-blocked-scripts'
const CANVAS_TOOL = 'mcp__copse-canvas__render_html_artefact'
const CHART_JS = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
const NOTICE =
  'The canvas blocked these because it only runs scripts and styles written inline in the page:'

// The CDN script never loads: the canvas CSP refuses it before any request is
// made. The inline script still runs and says so on the page itself.
const PROTOTYPE = `<!doctype html>
<title>Sales Chart</title>
<script src="${CHART_JS}"></script>
<style>
  body { font: 16px system-ui, sans-serif; margin: 32px; }
</style>
<h1>Quarterly sales</h1>
<p id="chart-status">Loading the chart</p>
<canvas id="sales" width="480" height="240"></canvas>
<script>
  document.getElementById('chart-status').textContent =
    typeof Chart === 'undefined' ? 'Chart.js did not load.' : 'Chart.js loaded.'
</script>
`

/** What the active canvas guest says about its chart library. */
async function guestChartStatus(): Promise<string | null> {
  return browser.execute(async () => {
    const webview = document.querySelector<Electron.WebviewTag>(
      '.browser-tab-panel.is-active webview',
    )
    const text: unknown = await webview
      ?.executeJavaScript('document.getElementById("chart-status")?.textContent ?? null')
      .catch(() => null)
    return typeof text === 'string' ? text : null
  })
}

/**
 * Open the canvas tool card through its real summary handlers, so a transcript
 * rebuild (the capture's resize triggers one) keeps it open, and bring its
 * result into view. Resolves with the result text once it is showing.
 */
async function revealToolResult(): Promise<string> {
  let text = ''
  await browser.waitUntil(
    async () => {
      text = await browser.execute(() => {
        const card = document.querySelector<HTMLDetailsElement>('.tool-card[data-tool-id]')
        if (!card) return ''
        const rollup = card.closest<HTMLDetailsElement>('details.tool-card-rollup')
        const rollupSummary = rollup?.querySelector<HTMLElement>(':scope > summary')
        if (rollup && rollupSummary && rollup.dataset['userToggled'] !== '1') {
          if (rollup.open) rollupSummary.click()
          rollupSummary.click()
          return ''
        }
        if (!card.open) {
          card.querySelector<HTMLElement>(':scope > summary')?.click()
          return ''
        }
        const result = card.querySelector<HTMLElement>('.tool-result pre')
        if (!result) return ''
        result.scrollIntoView({ block: 'center', inline: 'nearest' })
        // The result box scrolls on its own; the notice is its last lines.
        for (let box: HTMLElement | null = result; box && box !== card; box = box.parentElement) {
          box.scrollTop = box.scrollHeight
        }
        return result.textContent
      })
      return text.includes(NOTICE)
    },
    { timeout: 20_000, timeoutMsg: 'expected the canvas tool result to show the notice' },
  )
  return text
}

describe('canvas blocked scripts', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    resetUserData()
    // A fresh profile: no `pluginDisabled` list, so the host seeds its own
    // defaults and canvas is on only because it ships on.
    const root = seedStableWorkspace()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: root, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders a prototype by default and names the CDN script the canvas blocked', async function () {
    this.timeout(90_000)
    await waitForPromptReady()

    const reply = 'The sales chart prototype is open in the canvas.'
    const scenario = await prepareMockToolTurn(
      'Prototype a quarterly sales chart with Chart.js.',
      { name: CANVAS_TOOL, args: { title: 'Sales Chart', html: PROTOTYPE } },
      reply,
    )
    await submitComposer()
    await expectAssistantReply(reply)
    await waitForAgentIdle(30_000)
    await scenario.assertComplete()

    // The bundled canvas tool exists and renders with no opt-in.
    await $('.browser-tab-panel.is-active webview').waitForExist({ timeout: 20_000 })
    await browser.waitUntil(async () => (await guestChartStatus()) === 'Chart.js did not load.', {
      timeout: 20_000,
      timeoutMsg: 'expected the prototype to render, with its CDN script blocked',
    })

    const result = await revealToolResult()
    expect(result).toContain(`${NOTICE}\n- script: ${CHART_JS}\n`)
    expect(result).toContain('Inline that code in <script> and <style> elements')

    await saveAppViewportScreenshot('canvas-blocked-script-notice.png', async () => {
      await revealToolResult()
    })
  })
})

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { prepareMockTurn, expectAssistantReply } from './helpers/mock-scenario.ts'
import { submitComposer } from './helpers/composer.ts'
import {
  removeAllProjectStoresOnRelaunch,
  resetUserData,
  seedEmptyProject,
} from './helpers/seed-config.ts'
import { saveAppScreenshot, saveAppViewportScreenshot } from './helpers/screenshot.ts'
import { frameInTranscript } from './helpers/sticky-prompt.ts'
import { waitForTranscriptScrollSettled } from './helpers/scroll-to-bottom.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { waitForAgentIdle } from './helpers.ts'
import type { MockResponse } from '../../packages/llm/src/mock-script.ts'

const PAGE = `<!doctype html><html><head><title>Harbor release</title><style>
body{margin:0;background:#f0f5f5;color:#163c40;font:12px system-ui}main{max-width:580px;margin:4px auto;padding:8px;background:white;border:1px solid #c2d4d3;border-radius:16px}h1{margin:0 0 4px;font-size:18px}form{display:grid;grid-template-columns:1fr 1fr;gap:6px}label{display:block;font-weight:600}input,textarea,select{display:block;box-sizing:border-box;width:100%;margin-top:4px;padding:5px;border:1px solid #96afae;border-radius:8px;font:inherit}textarea{height:40px}button{margin:16px 3px 0 0;padding:5px 6px;border:0;border-radius:8px;background:#17666b;color:white;font:inherit}p{line-height:1.4;margin:8px 0}.stale{position:absolute;opacity:0;pointer-events:none}
</style></head><body><div class="stale"><input id="stale" data-copse-ref="e1" value="Hidden draft"></div><main>
<h1>Harbor release</h1><form>
<label for="title">Title<input id="title" value="Manual title"></label>
<label for="notes">Notes<textarea id="notes">Keep the user note</textarea></label>
<label for="priority">Priority<select id="priority"><option value="low">Low</option><option value="high">High</option></select></label>
<div><button type="submit">Save release</button><button type="button" id="reload">Reload</button></div>
</form><p id="status">Unsaved user draft</p><p id="events">Input events: 0; change events: 0</p></main><script>
const title=document.querySelector('#title'),notes=document.querySelector('#notes'),priority=document.querySelector('#priority');
const saved=localStorage.getItem('release');
if(saved){const value=JSON.parse(saved);title.value=value.title;notes.value=value.notes;priority.value=value.priority;document.querySelector('#status').textContent=value.status;document.querySelector('#events').textContent=value.events;}
let inputs=0,changes=0;
document.querySelector('form').addEventListener('input',()=>{inputs++;});
document.querySelector('form').addEventListener('change',()=>{changes++;});
document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();const status='Saved once: '+title.value+' / '+notes.value+' / '+priority.value+' / '+(document.querySelector('#stale').value==='Hidden draft'?'Hidden draft preserved':'Hidden draft changed');const events='Input events: '+inputs+'; change events: '+changes;document.querySelector('#status').textContent=status;document.querySelector('#events').textContent=events;localStorage.setItem('release',JSON.stringify({title:title.value,notes:notes.value,priority:priority.value,status,events}));});
document.querySelector('#reload').addEventListener('click',()=>location.reload());
</script></body></html>`

// Only the uncertainty case has an own-input mutation. The visible probe is
// read by the genuine agent browser snapshot, not by a separate preview guest.
const UNCONFIRMED_PAGE = PAGE.replace(
  '<textarea id="notes">Keep the user note</textarea>',
  '<input id="notes" value="Keep the user note">',
)
  .replace(
    '<body>',
    '<body><div id="capture-state" aria-hidden="true" style="position:fixed;top:0;right:0;width:24px;height:24px;background:#d31f61;pointer-events:none"></div>',
  )
  .replace('<p id="status">', '<p id="probe"></p><p id="status">')
  .replace(
    'let inputs=0,changes=0;',
    `let inputs=0,changes=0,priorityEvents=0;
const updateProbe=()=>{document.querySelector('#probe').textContent='Title: '+title.value+'; Notes type: '+notes.type+'; Notes value: '+notes.value+'; Priority: '+priority.value+'; Priority events: '+priorityEvents+'; Saved: '+(localStorage.getItem('release')?'yes':'no')+'; Input events: '+inputs+'; change events: '+changes;const complete=title.value==='Ready for release'&&notes.type==='checkbox'&&notes.value==='Keep the user note; checks passed'&&priority.value==='low'&&priorityEvents===0&&!localStorage.getItem('release')&&inputs===2&&changes===1;document.querySelector('#capture-state').style.background=complete?'#25c571':'#d31f61';};
notes.addEventListener('input',()=>{const value=notes.value;notes.type='checkbox';notes.value=value;updateProbe();});
for(const event of ['input','change'])priority.addEventListener(event,()=>{priorityEvents++;updateProbe();});
updateProbe();`,
  )
  .replace('inputs++;', 'inputs++;updateProbe();')
  .replace('changes++;', 'changes++;updateProbe();')

interface PreviewWebview extends HTMLElement {
  executeJavaScript(code: string): Promise<unknown>
}

let root = ''
let projectId = ''
let caseNumber = 0
const fields = [
  { ref: 'e1', text: 'Ready for release' },
  { ref: 'e2', text: 'Keep the user note; checks passed' },
  { ref: 'e3', text: 'high' },
]

describe('native browser form entry', () => {
  beforeEach(async function () {
    root = mkdtempSync(join(tmpdir(), 'copse-form-entry-'))
    // The old single-field path picks the first matching ref. Leave the
    // invisible draft unnumbered in its legacy control; grouped entry must
    // also handle stale snapshot refs retained by a hidden dialog.
    writeFileSync(
      join(root, 'index.html'),
      this.currentTest?.title === 'keeps the existing three-call form workflow working'
        ? PAGE.replace(' data-copse-ref="e1"', '')
        : this.currentTest?.title ===
            'shows an uncertain current field and leaves later fields untouched after its handler changes type'
          ? UNCONFIRMED_PAGE
          : PAGE,
    )
    resetUserData()
    removeAllProjectStoresOnRelaunch()
    projectId = `browser-form-entry-${String(++caseNumber)}`
    seedEmptyProject(root, projectId, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      windowBounds: { width: 1440, height: 1000 },
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  afterEach(async () => {
    await waitForAgentIdle(15_000)
    resetUserData()
    removeE2eTree(root)
  })

  async function enterAndSave(grouped: boolean): Promise<void> {
    const typing: MockResponse[] = grouped
      ? [{ toolCalls: [{ name: 'browser_type', args: { fields } }] }]
      : fields.map(({ ref, text }) => ({
          toolCalls: [{ name: 'browser_type', args: { ref, text } }],
        }))
    const scenario = await prepareMockTurn(
      'Update the release draft, save it once and verify it survives reload.',
      [
        { toolCalls: [{ name: 'browser_preview', args: {} }] },
        { toolCalls: [{ name: 'browser_snapshot', args: {} }] },
        ...typing,
        {
          toolCalls: [{ name: 'browser_snapshot', args: {} }],
          expectToolResults: [
            {
              name: 'browser_type',
              includes: grouped ? 'Entered 3 fields' : 'Typed into [ref=e3]',
            },
          ],
        },
        {
          toolCalls: [{ name: 'browser_click', args: { ref: 'e4' } }],
          expectToolResults: [
            { name: 'browser_snapshot', includes: 'Keep the user note; checks passed' },
          ],
        },
        { toolCalls: [{ name: 'browser_snapshot', args: {} }] },
        {
          toolCalls: [{ name: 'browser_click', args: { ref: 'e5' } }],
          expectToolResults: [{ name: 'browser_snapshot', includes: 'Hidden draft preserved' }],
        },
        { toolCalls: [{ name: 'browser_snapshot', args: {} }] },
        {
          toolCalls: [{ name: 'browser_screenshot', args: {} }],
          expectToolResults: [
            { name: 'browser_snapshot', includes: 'Input events: 3; change events: 3' },
          ],
        },
        {
          text: 'The release draft was saved once and verified after reload.',
          expectToolResults: [
            { name: 'browser_screenshot', includes: 'The screenshot is attached' },
          ],
        },
      ],
    )
    await submitComposer()
    await expectAssistantReply('The release draft was saved once and verified after reload.')
    await waitForAgentIdle(15_000)
    await scenario.assertComplete()
    // Tool results are checked at the model boundary above; the native tool
    // cards independently establish the actual number of registered calls.
    const typed = await browser.execute(
      () =>
        [...document.querySelectorAll('.messages-list [data-tool-id] > summary .tool-name')].filter(
          (node) => node.textContent.trim() === 'Typed text',
        ).length,
    )
    assert.equal(typed, grouped ? 1 : 3)
    await expect($('#approval-dialog[open]')).not.toExist()
    if (!grouped) return
    const image = $('.tool-result-preview-image.image-expandable')
    await image.waitForDisplayed({ timeout: 15_000 })
    const capturedPage = await image.getAttribute('src')
    assert.ok(capturedPage)
    assert.ok(capturedPage.startsWith('data:image/png;base64,'))
    mkdirSync(join(process.cwd(), '.tmp'), { recursive: true })
    writeFileSync(
      join(process.cwd(), '.tmp/browser-form-captured-page.png'),
      Buffer.from(capturedPage.slice('data:image/png;base64,'.length), 'base64'),
    )
    await image.click()
    await $('dialog.attachment-preview-dialog[open]').waitForDisplayed({ timeout: 5_000 })
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const img = document.querySelector<HTMLImageElement>('.image-expand-image')
          return Boolean(img?.complete && img.naturalWidth > 0)
        }),
      { timeout: 10_000 },
    )
    await browser.execute(() => {
      const address = document.querySelector<HTMLInputElement>(
        '.browser-tab-panel.is-active .browser-url-input',
      )
      if (address) address.value = 'http://localhost:4321/'
    })
    await saveAppScreenshot('browser-form-fields-entered.png')
    await $('.attachment-preview-close').click()
  }

  it('keeps the existing three-call form workflow working', async () => {
    await enterAndSave(false)
  })

  it('fills the same form in one call, preserves a hidden draft and saves only on explicit click', async () => {
    await enterAndSave(true)
  })

  it('shows an uncertain current field and leaves later fields untouched after its handler changes type', async () => {
    const reply =
      'Form entry stopped at Notes. Title is confirmed; inspect the form before retrying without replaying it.'
    const state =
      'Title: Ready for release; Notes type: checkbox; Notes value: Keep the user note; checks passed; Priority: low; Priority events: 0; Saved: no; Input events: 2; change events: 1'
    const scenario = await prepareMockTurn(
      'Enter the release draft fields together. If the page changes a field, stop and inspect without submitting or replaying input.',
      [
        { toolCalls: [{ name: 'browser_preview', args: {} }] },
        { toolCalls: [{ name: 'browser_snapshot', args: {} }] },
        { toolCalls: [{ name: 'browser_type', args: { fields } }] },
        {
          toolCalls: [{ name: 'browser_snapshot', args: {} }],
          expectToolResults: [{ name: 'browser_type', includes: 'e2 may already have changed' }],
        },
        {
          toolCalls: [{ name: 'browser_screenshot', args: {} }],
          expectToolResults: [{ name: 'browser_snapshot', includes: state }],
        },
        {
          text: reply,
          expectToolResults: [
            { name: 'browser_screenshot', includes: 'The screenshot is attached' },
          ],
        },
      ],
    )
    await submitComposer()
    await expectAssistantReply(reply)
    await waitForAgentIdle(15_000)
    await scenario.assertComplete()
    const calls = await browser.execute(async (project) => {
      const thread = document.querySelector<HTMLElement>('.chat-row.selected')?.dataset['threadId']
      if (!thread) throw new Error('No selected form thread')
      const messages = await window.api.threads.loadMessages(project, thread)
      return messages.flatMap((message) =>
        message.toolCalls.map(({ id, name, status, result }) => ({ id, name, status, result })),
      )
    }, projectId)
    assert.deepEqual(
      calls.map((call) => call.name),
      [
        'browser_preview',
        'browser_snapshot',
        'browser_type',
        'browser_snapshot',
        'browser_screenshot',
      ],
    )
    const typed = calls.find((call) => call.name === 'browser_type')
    assert.ok(typed)
    assert.equal(typed.status, 'error')
    assert.match(typed.result ?? '', /stopped after 1 confirmed fields of 3.*Entered: e1/)
    assert.match(typed.result ?? '', /e2 may already have changed.*do not replay confirmed input/)
    assert.ok(
      calls.filter((call) => call.name !== 'browser_type').every((call) => call.status === 'done'),
    )
    assert.ok(
      calls
        .filter((call) => call.name === 'browser_snapshot')
        .at(-1)
        ?.result?.includes(state),
    )
    const card = `.tool-card[data-tool-id="${typed.id}"]`
    await $(card).waitForDisplayed({ timeout: 15_000 })
    await expect($(`${card} .tool-status-icon`)).toHaveAttribute('aria-label', 'error')
    if (!(await $(card).getProperty('open'))) await $(`${card} > summary`).click()
    await expect($(`${card} .tool-result`)).toHaveText(
      expect.stringContaining('e2 may already have changed'),
    )
    await expect($('#approval-dialog[open]')).not.toExist()
    const imageSelector = '.tool-result-preview-image.image-expandable'
    const image = $(imageSelector)
    await image.waitForDisplayed({ timeout: 15_000 })
    const capturedPage = await image.getAttribute('src')
    assert.ok(capturedPage)
    assert.ok(capturedPage.startsWith('data:image/png;base64,'))
    mkdirSync(join(process.cwd(), '.tmp'), { recursive: true })
    writeFileSync(
      join(process.cwd(), '.tmp/browser-form-unconfirmed-captured-page.png'),
      Buffer.from(capturedPage.slice('data:image/png;base64,'.length), 'base64'),
    )
    // A correct DOM snapshot does not establish which compositor frame was
    // returned. The marker turns green only for the complete post-edit state;
    // a cached pre-edit or partly edited frame retains the red marker.
    const capturedPixel = await browser.execute(async (dataUrl) => {
      const decoded = new Image()
      decoded.src = dataUrl
      await decoded.decode()
      const canvas = document.createElement('canvas')
      canvas.width = decoded.naturalWidth
      canvas.height = decoded.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Cannot inspect the returned screenshot PNG')
      context.drawImage(decoded, 0, 0)
      return [...context.getImageData(canvas.width - 8, 8, 1, 1).data]
    }, capturedPage)
    assert.deepEqual(
      capturedPixel,
      [37, 197, 113, 255],
      'the actual returned native PNG must contain the complete current page state',
    )
    const address = $('.browser-tab-panel.is-active .browser-url-input')
    const actualAddress = await address.getValue()
    assert.match(actualAddress, /^http:\/\/localhost:\d+\/$/)
    try {
      await saveAppViewportScreenshot('browser-form-entry-unconfirmed.png', async () => {
        const framed = await frameInTranscript([card, imageSelector])
        assert.ok(framed.fits, JSON.stringify(framed))
        await expect($(`${card} .tool-result`)).toBeDisplayed()
        await browser.waitUntil(
          () =>
            browser.execute(() => {
              const img = document.querySelector<HTMLImageElement>(
                '.tool-result-preview-image.image-expandable',
              )
              return Boolean(img?.complete && img.naturalWidth > 0)
            }),
          {
            timeout: 15_000,
            timeoutMsg: 'actual agent screenshot preview must decode before capture',
          },
        )
        // This separate guest check establishes capture geometry only. All
        // agent-edit assertions above come from actual tool responses.
        await browser.waitUntil(
          () =>
            browser.execute(async () => {
              const guest = document.querySelector<PreviewWebview>(
                '.browser-tab-panel.is-active webview',
              )
              if (!guest) return false
              const width = await guest.executeJavaScript(
                'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(window.innerWidth))))',
              )
              return (
                typeof width === 'number' &&
                Math.abs(width - guest.getBoundingClientRect().width) <= 1
              )
            }),
          { timeout: 10_000, timeoutMsg: 'visible preview viewport must match its framed bounds' },
        )
        await browser.execute(() => {
          const input = document.querySelector<HTMLInputElement>(
            '.browser-tab-panel.is-active .browser-url-input',
          )
          if (!input) throw new Error('Preview address is missing')
          input.value = 'http://localhost:4321/'
        })
        await waitForTranscriptScrollSettled()
      })
    } finally {
      await browser.execute((value) => {
        const input = document.querySelector<HTMLInputElement>(
          '.browser-tab-panel.is-active .browser-url-input',
        )
        if (input) input.value = value
      }, actualAddress)
    }
  })
})

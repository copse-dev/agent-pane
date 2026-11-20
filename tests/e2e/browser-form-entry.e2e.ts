import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { prepareMockTurn, expectAssistantReply } from './helpers/mock-scenario.ts'
import { submitComposer } from './helpers/composer.ts'
import { e2eWorkspaceDir, resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
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

let root = ''
let caseNumber = 0
const fields = [
  { ref: 'e1', text: 'Ready for release' },
  { ref: 'e2', text: 'Keep the user note; checks passed' },
  { ref: 'e3', text: 'high' },
]

describe('native browser form entry', () => {
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-form-entry-'))
    // The old single-field path picks the first matching ref. Leave the
    // invisible draft unnumbered in its legacy control; grouped entry must
    // also handle stale snapshot refs retained by a hidden dialog.
    writeFileSync(
      join(root, 'index.html'),
      caseNumber === 0 ? PAGE.replace(' data-copse-ref="e1"', '') : PAGE,
    )
    resetUserData()
    removeE2eTree(e2eWorkspaceDir())
    seedEmptyProject(root, `browser-form-entry-${String(++caseNumber)}`, {
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
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-monaco-fstring-project'
const SAMPLE_FILE = 'fstring-sample.py'
const SCREENSHOT = 'monaco-python-fstring-highlight.png'

// A multi-line f-string followed by ordinary code. Monaco 0.56's stock Monarch
// python grammar drops the string state at the opening line's EOL, then the
// closing `"""` opens a fresh docstring state — so everything below renders as
// one endless string. python-monarch-fstring-fix.ts patches the grammar in
// monaco-global.ts; this spec proves the patched grammar is the one that
// actually reaches the screen (the explicit setMonarchTokensProvider call must
// win over monaco's lazy per-language factory).
const SAMPLE_LINES = [
  'name = "monaco"',
  'greeting = f"""hello',
  '{name} spans lines',
  'still inside the string',
  '"""',
  '',
  'def after_the_string(x):',
  '    return x + 1',
  '',
]
const DEF_LINE_INDEX = 6
const STRING_BODY_LINE_INDEX = 3

async function waitForWorkspace(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const name = await $('.workspace-name')
      return (await name.isExisting()) && (await name.getText()) !== 'No folder'
    },
    { timeout: 30_000, timeoutMsg: 'expected workspace to be restored' },
  )
}

describe('Monaco python multi-line f-string highlighting', () => {
  let workspaceRoot = ''

  before(async function () {
    this.timeout(120_000)
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-monaco-fstring-'))
    writeFileSync(join(workspaceRoot, SAMPLE_FILE), SAMPLE_LINES.join('\n'), 'utf8')
    mkdirSync(join(process.cwd(), 'tests/e2e/screenshots'), { recursive: true })
    resetUserData()
    seedE2eViewport()
    seedEmptyProject(workspaceRoot, PROJECT_ID)
    await browser.reloadSession()
    await waitForWorkspace()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('keeps code after the f-string tokenized as code, not string', async () => {
    const panelBtn = await $('.titlebar-btn[aria-label="Toggle right panel"]')
    if (!(await $('#pane-files').isDisplayed())) await panelBtn.click()
    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })

    const sampleRow = await $(`.tree-row[title="${SAMPLE_FILE}"]`)
    await sampleRow.waitForDisplayed({ timeout: 30_000 })
    await sampleRow.click()

    const editor = await $('#file-viewer .monaco-editor')
    await editor.waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(
      async () => await browser.execute(() => window.__copseMonaco !== undefined),
      { timeout: 30_000, timeoutMsg: 'expected the monaco bundle to expose __copseMonaco' },
    )

    // The registered tokenizer — not a replica — must carry the f-string fix:
    // the line after the string closes tokenizes as code (`def` is a keyword),
    // while the f-string body itself stays string-colored.
    const tokenTypes = await browser.execute((source: string) => {
      const monaco = window.__copseMonaco
      if (!monaco) throw new Error('window.__copseMonaco is not set')
      return monaco.editor.tokenize(source, 'python').map((line) => line.map((t) => t.type))
    }, SAMPLE_LINES.join('\n'))
    expect(tokenTypes[DEF_LINE_INDEX].some((type) => type.startsWith('keyword'))).toBe(true)
    expect(tokenTypes[DEF_LINE_INDEX].every((type) => type.startsWith('string'))).toBe(false)
    expect(tokenTypes[STRING_BODY_LINE_INDEX].every((type) => type.startsWith('string'))).toBe(true)

    // And the rendered DOM agrees: the `def` line paints more than one token
    // color (with the unpatched grammar the whole line is one string-colored
    // span run).
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const lines = Array.from(
            document.querySelectorAll('#file-viewer .monaco-editor .view-line'),
          )
          const defLine = lines.find((line) => line.textContent?.includes('def after_the_string'))
          if (!defLine) return false
          const classes = new Set(
            Array.from(defLine.querySelectorAll('span[class*="mtk"]')).map((s) => s.className),
          )
          return classes.size >= 2
        }),
      {
        timeout: 15_000,
        timeoutMsg: 'expected the def line to render with differentiated token classes',
      },
    )

    await saveAppScreenshot(SCREENSHOT)
  })
})

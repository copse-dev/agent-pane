import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import type { MockScriptStep } from '@copse/llm/mock-script.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle, waitForPromptReady } from './helpers.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// The assistant reply is streamed char-by-char by the mock LLM (mock-provider.ts,
// ~10ms/char) straight into the app's real StreamingMarkdownRenderer — the same
// path a live model drives. A leading paragraph settles first, then the table's
// header row terminates and its `|---` separator streams in cell by cell. That
// separator-arrival window is exactly where the v0.5.0 tokenizer regression hid
// the header and rendered a dashes-only table before converging to a correct one.
const TABLE_MARKDOWN = [
  'Here is the project layout:',
  '',
  '| Path | Role |',
  '|------|------|',
  '| `src/` | Application source |',
  '| `tests/e2e/` | WebdriverIO specs |',
  '',
  'That is the structure.',
].join('\n')

const SCRIPT = [
  {
    when: 'project layout',
    text: TABLE_MARKDOWN,
  },
] satisfies MockScriptStep[]

/** A per-mutation snapshot of the streaming message's table state. */
interface TableFrame {
  /** The message is still in its incremental streaming pass. */
  streaming: boolean
  /** A <table> exists in the streaming message. */
  hasTable: boolean
  /** Trimmed text of every <thead> <th> across tables in the message. */
  headerCells: string[]
  /**
   * Count of table cells (th/td) whose whole text is a GFM separator artifact
   * (`---`, `:--:`, …). A settled cell never contains one; the regression
   * rendered the separator row's dashes AS the header cells.
   */
  separatorArtifactCells: number
  /** A raw `.stream-pending` span leaked table pipe syntax as plain text. */
  rawPendingPipeSpan: boolean
}

async function installMockScript(): Promise<void> {
  const status = await browser.execute(async (script) => {
    const bridge = (
      window as unknown as {
        __copseE2e?: { setMockScript: (s: unknown) => Promise<{ steps: number; cursor: number }> }
      }
    ).__copseE2e
    if (!bridge?.setMockScript) throw new Error('__copseE2e.setMockScript unavailable')
    return bridge.setMockScript(script)
  }, SCRIPT)
  if (status.steps !== SCRIPT.length) {
    throw new Error(`mock script registration failed: ${JSON.stringify(status)}`)
  }
}

/**
 * Install a MutationObserver that records the streaming table state on every DOM
 * mutation, so the whole streaming history — not just the converged final render
 * — is available to assert against. Must run before the reply starts streaming.
 */
async function startFrameRecorder(): Promise<void> {
  await browser.execute(() => {
    const SEPARATOR_CELL = /^:?-{2,}:?$/
    const w = window as unknown as { __tableFrames?: unknown[] }
    const frames: unknown[] = []
    w.__tableFrames = frames

    const snapshot = (): void => {
      // The active streaming message is the last assistant bubble still tagged
      // is-streaming; fall back to the last one for the committed final frame.
      const streamingEl =
        document.querySelector('.msg-assistant .message-text.is-streaming') ??
        document.querySelector('.msg-assistant:last-of-type .message-text')
      if (!streamingEl) return
      const cells = [...streamingEl.querySelectorAll('th, td')]
      frames.push({
        streaming: streamingEl.classList.contains('is-streaming'),
        hasTable: !!streamingEl.querySelector('table'),
        headerCells: [...streamingEl.querySelectorAll('thead th')].map((c) =>
          (c.textContent ?? '').trim(),
        ),
        separatorArtifactCells: cells.filter((c) =>
          SEPARATOR_CELL.test((c.textContent ?? '').trim()),
        ).length,
        rawPendingPipeSpan: [...streamingEl.querySelectorAll('span.stream-pending')].some((s) =>
          (s.textContent ?? '').includes('|'),
        ),
      })
      if (frames.length > 5000) frames.shift()
    }

    const list = document.querySelector('.messages-list')
    if (!list) throw new Error('no messages list to observe')
    const observer = new MutationObserver(snapshot)
    observer.observe(list, { childList: true, subtree: true, characterData: true })
    snapshot()
  })
}

async function readFrames(): Promise<TableFrame[]> {
  return browser.execute(() => {
    const w = window as unknown as { __tableFrames?: TableFrame[] }
    return w.__tableFrames ?? []
  }) as Promise<TableFrame[]>
}

describe('markdown streaming table (real renderer)', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-streaming-table-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
  })

  after(async () => {
    await browser.execute(async () => {
      await (
        window as unknown as { __copseE2e?: { clearMockScript: () => Promise<void> } }
      ).__copseE2e?.clearMockScript?.()
    })
    resetUserData()
  })

  it('streams a GFM table through the real parser without ever showing a dashes-only header', async () => {
    await waitForPromptReady(30_000)
    await installMockScript()
    await startFrameRecorder()

    await $('.prompt-input').setValue('Show me the project layout as a table')
    await $('.submit-btn').click()
    await waitForAgentIdle(30_000)

    const frames = await readFrames()

    // Coverage guard: unless we actually observed a table mid-stream, the
    // invariants below are vacuous (the mock never streamed, or the table
    // committed in one frame). This is what makes the test able to catch the
    // regression rather than pass trivially.
    const streamingTableFrames = frames.filter((f) => f.streaming && f.hasTable)
    expect(streamingTableFrames.length).toBeGreaterThan(0)

    // The regression's signature: a table cell whose entire text is a separator
    // artifact. In the fixed parser the header and its still-streaming `|---`
    // separator stay one block, so the dashes are never promoted into a cell.
    for (const frame of frames) {
      expect(frame.separatorArtifactCells).toBe(0)
    }

    // Once the full header row has settled — both cells present in one frame,
    // so we are past the header still being typed character by character — its
    // cells must not vanish while the separator streams in. The regression
    // dropped the settled header to an invisible ambiguous block.
    const headerLockIdx = frames.findIndex(
      (f) => f.headerCells.includes('Path') && f.headerCells.includes('Role'),
    )
    expect(headerLockIdx).toBeGreaterThanOrEqual(0)
    for (const frame of frames.slice(headerLockIdx)) {
      if (frame.hasTable) {
        expect(frame.headerCells).toContain('Path')
        expect(frame.headerCells).toContain('Role')
      }
    }

    // Table pipe syntax is never leaked as a raw pending text span.
    for (const frame of frames) {
      expect(frame.rawPendingPipeSpan).toBe(false)
    }

    // Committed final render: a real, converged table produced by the parser.
    const final = await browser.execute(() => {
      const el = document.querySelector('.msg-assistant:last-of-type .message-text')
      if (!el) return { error: 'no assistant message' }
      const table = el.querySelector('table')
      const bodyRows = [...(table?.querySelectorAll('tbody tr') ?? [])]
      return {
        stillStreaming: el.classList.contains('is-streaming'),
        headerTexts: [...(table?.querySelectorAll('thead th') ?? [])].map((c) =>
          (c.textContent ?? '').trim(),
        ),
        firstColumnCodeText: table?.querySelector('tbody tr td code')?.textContent ?? '',
        // Join per cell — a row's textContent concatenates adjacent cells with no
        // separator (`src/Application source`), which reads as a lost space.
        bodyRowText: bodyRows.map((r) =>
          [...r.querySelectorAll('td')].map((td) => (td.textContent ?? '').trim()).join(' '),
        ),
        hasFormingTable: !!el.querySelector('.stream-table-forming'),
        hasPendingRow: !!el.querySelector('tr.stream-pending-row'),
        hasRawPendingSpan: !!el.querySelector('span.stream-pending'),
      }
    })

    expect(final).not.toHaveProperty('error')
    expect(final.stillStreaming).toBe(false)
    expect(final.headerTexts).toEqual(['Path', 'Role'])
    expect(final.firstColumnCodeText).toBe('src/')
    expect(final.bodyRowText).toEqual(['src/ Application source', 'tests/e2e/ WebdriverIO specs'])
    expect(final.hasFormingTable).toBe(false)
    expect(final.hasPendingRow).toBe(false)
    expect(final.hasRawPendingSpan).toBe(false)

    await saveAppScreenshot('markdown-streaming-table-pending-row.png')
  })
})

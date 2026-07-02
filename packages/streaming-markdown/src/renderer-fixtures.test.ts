import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from './renderer.ts'

// Parsing-correctness ports of the markdown e2e fixtures. The e2e specs
// (tests/e2e/markdown-{list-indent,ordered-list-spacing,bold-glob}.e2e.ts) mix
// two concerns: markdown STRUCTURE (which tag tree the renderer produces) and
// CSS LAYOUT (pixel gaps/indents/wrapping). Layout needs a real browser and
// stays in e2e; the structure half — the part that actually regressed and the
// reason these fixtures exist — is pure `renderMarkdown` output and belongs
// here, where it runs in milliseconds with no Electron. We parse the rendered
// HTML into a detached element and assert the same tag relationships the e2e
// `browser.execute` blocks checked (minus the geometry).

function render(md: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = renderMarkdown(md)
  return root
}

function bySubstring<T extends Element>(els: Iterable<T>, text: string): T | undefined {
  return [...els].find((e) => e.textContent.includes(text))
}

describe('renderMarkdown fixture structure: multi-section list (markdown-list-indent)', () => {
  // tests/e2e/helpers/seed-config.ts -> seedMarkdownListFixture
  const content = [
    '### ⚠️ Known Failures',
    '',
    '**Unit tests (2 failures):**',
    '- `terminal-service` — 2 subtests fail with posix spawnp failed',
    '',
    '**E2E tests (all 10 fail):**',
    '- Every e2e test fails with listen EPERM: operation not permitted 0.0.0.0',
    '',
    '### 📦 Architecture Highlights',
    '- Electron app — AI coding assistant with tool-executing agents',
    '- No backend — Direct LLM provider calls (Anthropic, OpenAI, LM Studio)',
    '- Mock LLM — `COPSE-PANEL-MOCK-LLM=1` enables full e2e testing without API keys',
    '- MCP host — Per-server enable toggles in Settings',
    '- Persistence — `electron-store` for projects, threads, settings',
  ].join('\n')

  it('never nests a list inside a paragraph', () => {
    const root = render(content)
    // e2e: layout.listsInsideParagraphs === 0
    assert.equal(root.querySelectorAll('p ul, p ol').length, 0)
  })

  it('renders each heading/subheading as a sibling immediately followed by its <ul>', () => {
    const root = render(content)
    // e2e: architectureHeadingIsFollowedByUl === true
    const archHeading = bySubstring(root.querySelectorAll('h3'), 'Architecture Highlights')
    assert.ok(archHeading, 'expected an Architecture Highlights heading')
    // Annotate as nullable so the optional access is honest under the DOM lib
    // (where nextElementSibling is `Element | null`).
    const archSibling: Element | null = archHeading.nextElementSibling
    assert.ok(archSibling, 'Architecture Highlights heading should be followed by a sibling')
    assert.equal(archSibling.tagName, 'UL')
    assert.equal(archSibling.querySelectorAll('li').length, 5)

    // e2e: knownFailuresHeadingIsFollowedByUl === true — the bold "Unit tests"
    // subheading is its own paragraph, with the list as the next sibling.
    const unitTests = bySubstring(root.querySelectorAll('p strong'), 'Unit tests')
    assert.ok(unitTests, 'expected a bold "Unit tests" subheading paragraph')
    assert.equal(unitTests.closest('p')?.nextElementSibling?.tagName, 'UL')
  })

  it('renders bold markers as <strong>, leaving no literal asterisks', () => {
    const root = render(content)
    assert.ok(!root.textContent.includes('**'), 'no literal ** should survive')
  })
})

describe('renderMarkdown fixture structure: git summary ordered list (markdown-ordered-list-spacing)', () => {
  // tests/e2e/helpers/seed-config.ts -> seedGitSummaryMarkdownFixture
  const content = [
    "Here's a summary of the three changed files:",
    '',
    '1. `src/main/project-sandbox/sandbox-fs-client.ts`',
    '',
    'Introduces a **sandboxed filesystem client** that routes reads and writes through a worker thread when the project sandbox is active.',
    '',
    '2. `src/main/project-sandbox/sandbox-fs-worker.ts`',
    '',
    'Worker thread that handles file operations under seatbelt constraints and reports results back to the main process.',
    '',
    '3. `src/main/project-sandbox/spawn.ts`',
    '',
    'Adds sandbox spawn helpers and wires ASRT seatbelt initialization for macOS project commands.',
  ].join('\n')

  it('collapses a loose numbered list into a single <ol> of three items', () => {
    const root = render(content)
    // e2e: olCount === 1, liCount === 3
    assert.equal(root.querySelectorAll('ol').length, 1)
    assert.equal(root.querySelectorAll('ol > li').length, 3)
  })

  it('wraps loose list items in paragraphs and never emits literal "1." text', () => {
    const root = render(content)
    // Intro stays a standalone paragraph; loose list items each get their own <p> blocks.
    const intro = root.querySelector('p')
    assert.ok(intro, 'expected intro paragraph')
    assert.ok(intro.textContent.includes('summary'))
    assert.equal(root.querySelectorAll('ol > li > p').length, 6)
    assert.ok(!/^\d+\./.test(root.textContent.trim()))
  })

  it('folds the path code and bold prose into the list item, not a trailing paragraph', () => {
    const root = render(content)
    // e2e: firstItemHasCode === true, firstItemHasBold === true
    const firstItem = root.querySelector('ol > li')
    assert.ok(firstItem, 'expected a first list item')
    assert.ok(firstItem.querySelector('code'), 'first item should contain the path <code>')
    assert.ok(firstItem.querySelector('strong'), 'first item should contain bold prose')
  })
})

describe('renderMarkdown fixture structure: bold after glob table (markdown-bold-glob)', () => {
  // tests/e2e/helpers/seed-config.ts -> seedMarkdownBoldGlobFixture
  const content = [
    '## Tests',
    '',
    '| Path | Role |',
    '| --- | --- |',
    '| **`src/**/*.test.ts`** | Unit tests (bundled by esbuild into `dist-test/`) |',
    '| **`tests/e2e/`** | WebdriverIO e2e tests (tool display, markdown rendering, etc.) |',
    '| **`tests/fixtures/`** | E2E test fixtures |',
    '',
    '## Key Supporting Files',
    '',
    '- **`README.md`** — Project overview, commands, layout',
    '- **`AGENTS.md`** — Detailed agent instructions: running headless, mock LLM, permission policy',
    '- **`vendor/`** — Bundled `codesearch` binary (downloaded on `npm install`)',
    '',
    '## Architecture Notes',
    '',
    '- **No backend** — main process talks directly to LLM providers',
    '- **Persistence** via `electron-store` (JSON config under `~/Library/Application Support/copse-panel/` on macOS)',
    '- **LLM fallback**: `MockLLMProvider` when no API keys are set',
    '- **Shell permissions**: `src/main/services/permission-policy.ts` — macOS-only sandbox; other platforms use static analysis',
    '- **MCP host**: connects to MCP servers via `.cursor/mcp.json` or `~/.cursor/mcp.json`',
  ].join('\n')

  it('renders a glob path inside a bold table cell without breaking on the **/* tokens', () => {
    const root = render(content)
    // e2e: globCellText === 'src/**/*.test.ts'. The `**` here is the literal glob
    // surviving intact inside <strong><code>, so a whole-tree "no **" check would
    // be a false positive — correctness is asserted per-item below instead.
    const globCell = root.querySelector('td strong code')
    assert.equal(globCell?.textContent, 'src/**/*.test.ts')
  })

  it('renders bold list labels after the glob table as <strong>', () => {
    const root = render(content)
    // e2e: mcpStrongText === 'MCP host', hasLiteralMcpStars === false,
    // hasMalformedStrong === false — the regression was the bold label after the
    // glob table rendering as a literal `**MCP host**` / malformed </strong>.
    const mcpItem = bySubstring(root.querySelectorAll('li'), 'MCP host')
    assert.ok(mcpItem)
    assert.equal(mcpItem.querySelector('strong')?.textContent, 'MCP host')
    assert.ok(!mcpItem.textContent.includes('**'), 'no literal ** in the MCP item')
    assert.ok(
      !root.innerHTML.includes('</strong>MCP host**'),
      'no malformed strong around the MCP label',
    )
  })

  it('keeps the supporting-files and architecture lists structurally intact', () => {
    const root = render(content)
    // e2e: supportingListItemCount === 3, architectureListLabels === 5
    const supporting = bySubstring(root.querySelectorAll('h2'), 'Key Supporting Files')
    assert.equal(supporting?.nextElementSibling?.querySelectorAll('li').length, 3)

    const architecture = bySubstring(root.querySelectorAll('h2'), 'Architecture Notes')
    assert.equal(architecture?.nextElementSibling?.querySelectorAll('li strong').length, 5)
  })
})

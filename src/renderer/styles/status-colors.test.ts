// Contract tests for status colour (issue #3065).
//
// docs/ui-taste.md binds product colour to semantic tokens: `--success`,
// `--warning`, `--danger`, `--error`, `--info`, `--important`, and the accent for
// interaction emphasis only. Component stylesheets had drifted onto raw hex
// values for exactly the things those tokens exist for — git status letters,
// PR CI dots, Monaco diff washes, tool diff stats — which gave the app four
// different greens for "added" and none of them derived for the light theme.
// happy-dom cannot see colour, so the rules are pinned at the stylesheet level.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const GLOBAL = resolve(process.cwd(), 'src/renderer/styles/global')

/** Component stylesheets, comments stripped (they quote hex values and selectors). */
function stylesheets(): { file: string; css: string }[] {
  return readdirSync(GLOBAL)
    .filter((name) => name.endsWith('.css'))
    .map((file) => ({
      file,
      css: readFileSync(resolve(GLOBAL, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
    }))
}

/** Flat `selector { … }` rule bodies whose selector list contains `selector`. */
function bodyOf(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm')
  return rule.exec(css)?.[1] ?? null
}

/**
 * Raw hex colours still allowed per component file, held shrink-only. Each entry
 * is a deliberate exception, not a backlog:
 *  - markdown.css: the light syntax-highlighting palette, measured to AA by
 *    light-contrast.test.ts, which has no token equivalent.
 *  - ui.css / conversation.css: white glyph text on a filled danger button and on
 *    the accent scroll-to-bottom disc, until a `--text-on-danger` tier exists.
 *  - video-expand.css: the black letterbox behind a video.
 *  - settings.css: two `#000` stops in a `mask-image` gradient, where only the
 *    alpha channel is read, so no hue is being chosen.
 */
const ALLOWED_RAW_HEX: Record<string, number> = {
  'markdown.css': 8,
  'ui.css': 2,
  'conversation.css': 1,
  'video-expand.css': 1,
  'settings.css': 2,
}

describe('status colours come from tokens (#3065)', () => {
  it('keeps raw hex colours out of component stylesheets', () => {
    for (const { file, css } of stylesheets()) {
      // `var(--warning, #d29922)` is a fallback for a token, not a competing hue.
      const declarations = css.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, 'var()')
      const found = declarations.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
      const allowed = ALLOWED_RAW_HEX[file] ?? 0
      assert.ok(
        found.length <= allowed,
        `${file} paints ${String(found.length)} raw hex colour(s) (${found.join(', ')}); ` +
          `use --success / --warning / --danger / --info / --error or the text tokens instead`,
      )
      if (found.length < allowed) {
        assert.fail(
          `${file} now has ${String(found.length)} raw hex colour(s); lower ALLOWED_RAW_HEX to match`,
        )
      }
    }
  })

  it('paints git status, CI, and diff-stat state with the semantic tokens', () => {
    const layout = stylesheets().find((sheet) => sheet.file === 'layout.css')?.css ?? ''
    const expectations: [string, RegExp][] = [
      ['.git-change-status-modified', /color:\s*var\(--warning\)/],
      ['.git-change-status-untracked', /color:\s*var\(--success\)/],
      ['.git-change-status-deleted', /color:\s*var\(--danger\)/],
      ['.git-change-status-renamed', /color:\s*var\(--info\)/],
      ['.pr-list-ci-success', /background:\s*var\(--success\)/],
      ['.pr-list-ci-failure', /background:\s*var\(--danger\)/],
      ['.pr-list-ci-pending', /background:\s*var\(--warning\)/],
      ['.pr-badge-automerge', /color:\s*var\(--info\)/],
    ]
    for (const [selector, declaration] of expectations) {
      const body = bodyOf(layout, selector)
      assert.ok(body, `missing rule for ${selector}`)
      assert.match(body, declaration, `${selector} must take its state from a token`)
    }
    assert.doesNotMatch(
      bodyOf(layout, '.pr-badge-automerge') ?? '',
      /--accent/,
      'auto-merge is a state, not interaction emphasis; the accent is not a status colour',
    )
    for (const [file, selector, declaration] of [
      ['tool-cards.css', '.tool-stat-add', /color:\s*var\(--success\)/],
      ['tool-cards.css', '.tool-stat-del', /color:\s*var\(--danger\)/],
      ['composer-extras.css', '.follow-up-stat-add', /color:\s*var\(--success\)/],
      ['composer-extras.css', '.follow-up-stat-del', /color:\s*var\(--danger\)/],
    ] as const) {
      const css = stylesheets().find((sheet) => sheet.file === file)?.css ?? ''
      const body = bodyOf(css, selector)
      assert.ok(body, `missing rule for ${selector} in ${file}`)
      assert.match(body, declaration, `${selector} must share the app's one green / one red`)
    }
  })

  it('keeps status fills off yes/no buttons', () => {
    // Accept / Reject on the diff bar are kit buttons (classes set in
    // git-changes-pane.ts); the stylesheet must not paint them in status hues.
    const diff = stylesheets().find((sheet) => sheet.file === 'diff.css')?.css ?? ''
    for (const selector of ['.diff-accept-btn', '.diff-reject-btn']) {
      const body = bodyOf(diff, selector)
      if (body === null) continue
      assert.doesNotMatch(
        body,
        /background:\s*var\(--(success|error|danger)\)/,
        `${selector} must not be a status-coloured fill (docs/ui-taste.md, approval prompts)`,
      )
    }
  })

  it('tints the MCP row status badge, not the server name', () => {
    const mcp = stylesheets().find((sheet) => sheet.file === 'mcp.css')?.css ?? ''
    for (const state of ['connected', 'error', 'untrusted']) {
      assert.equal(
        bodyOf(mcp, `.mcp-server-row.mcp-state-${state} .mcp-server-summary`),
        null,
        `.mcp-state-${state} must colour .ui-inline-status inside the summary, not the whole title`,
      )
      assert.ok(
        bodyOf(mcp, `.mcp-server-row.mcp-state-${state} .mcp-server-summary .ui-inline-status`),
        `missing status-badge tint for .mcp-state-${state}`,
      )
    }
  })
})

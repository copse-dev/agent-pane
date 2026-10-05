// Contract tests for status colour (issue #3065).
//
// docs/ui-taste.md binds product colour to semantic tokens: `--success`,
// `--warning`, `--danger`, `--error`, `--info`, `--important`, the change-mark
// tier (`--change-*`, `--diff-*`), and the accent for interaction emphasis only.
// light-contrast.test.ts pins which token each change mark and CI dot takes;
// this file keeps new raw hex out of component stylesheets and status fills off
// yes/no buttons. happy-dom cannot see colour, so both rules are pinned at the
// stylesheet level.
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

/** Flat rule bodies whose selector list contains `selector`, including qualified forms. */
function bodiesOf(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const selectorToken = new RegExp(`${escaped}(?![-_a-zA-Z0-9])`)
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1]?.split(',').some((part) => selectorToken.test(part)))
    .flatMap((match) => (match[2] === undefined ? [] : [match[2]]))
}

const STATUS_TOKEN =
  /var\(--(?:success|warning|danger|error|info|important|(?:change|diff)-[a-z0-9-]+)\b/i

/**
 * Every custom-property declaration in the sheet. CSS variables inherit, so a
 * button background can resolve through an alias declared on any ancestor. A
 * stylesheet contract cannot prove the complete DOM/cascade cheaply; treating
 * every declaration of a referenced alias as reachable is deliberately
 * conservative and keeps an indirect status fill from slipping through.
 */
function customProperties(css: string): ReadonlyMap<string, readonly string[]> {
  const properties = new Map<string, string[]>()
  for (const match of css.matchAll(/(?:^|[;{])\s*(--[-_a-z0-9]+)\s*:\s*([^;{}]*)/gi)) {
    const [, name, value] = match
    if (name === undefined || value === undefined) continue
    const values = properties.get(name) ?? []
    values.push(value)
    properties.set(name, values)
  }
  return properties
}

function valueUsesStatusToken(
  value: string,
  properties: ReadonlyMap<string, readonly string[]>,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (STATUS_TOKEN.test(value)) return true
  for (const match of value.matchAll(/var\((--[-_a-z0-9]+)/gi)) {
    const name = match[1]
    if (name === undefined || seen.has(name)) continue
    const nextSeen = new Set(seen)
    nextSeen.add(name)
    if (
      (properties.get(name) ?? []).some((next) => valueUsesStatusToken(next, properties, nextSeen))
    ) {
      return true
    }
  }
  return false
}

function assertNoStatusFill(css: string, selector: string): void {
  const bodies = bodiesOf(css, selector)
  const properties = customProperties(css)
  for (const body of bodies) {
    for (const match of body.matchAll(
      /(?:^|;)\s*background(?:-(?:color|image))?\s*:\s*([^;{}]*)/gi,
    )) {
      const value = match[1]
      assert.equal(
        value === undefined ? false : valueUsesStatusToken(value, properties),
        false,
        `${selector} must not be a status-coloured fill (docs/ui-taste.md, approval prompts)`,
      )
    }
  }
}

/**
 * Raw hex colours still allowed per component file, held shrink-only. Each entry
 * is a deliberate exception, not a backlog:
 *  - markdown.css: the light syntax-highlighting palette, measured to AA by
 *    light-contrast.test.ts, which has no token equivalent.
 *  - video-expand.css: the black letterbox behind a video.
 *  - settings.css: two `#000` stops in a `mask-image` gradient, where only the
 *    alpha channel is read, so no hue is being chosen. The existing ChatGPT
 *    sign-in button also preserves its provider brand: black/white with a
 *    #202020 hover. The selector-level test below pins that exception.
 */
const ALLOWED_RAW_HEX: Readonly<Record<string, readonly string[]>> = {
  'markdown.css': [
    '#007000',
    '#0000ff',
    '#a31515',
    '#07734b',
    '#795e26',
    '#1f6b80',
    '#0451a5',
    '#1f1f1f',
  ],
  'video-expand.css': ['#000'],
  'settings.css': ['#000', '#000', '#000', '#202020', '#fff', '#fff', '#fff'],
}

function assertApprovedRawHex(file: string, css: string): void {
  // `var(--warning, #d29922)` is a token fallback, not a competing component hue.
  const declarations = css.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, 'var()')
  const found = (declarations.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])
    .map((colour) => colour.toLowerCase())
    .sort()
  const allowed = [...(ALLOWED_RAW_HEX[file] ?? [])].sort()
  assert.deepEqual(
    found,
    allowed,
    `${file} must keep its reviewed raw hex palette; use semantic or text tokens for new hues`,
  )
}

describe('status colours come from tokens (#3065)', () => {
  it('keeps raw hex colours out of component stylesheets', () => {
    for (const { file, css } of stylesheets()) {
      assertApprovedRawHex(file, css)
    }
  })

  it('pins reviewed exception colours rather than only their count', () => {
    const markdown = stylesheets().find((sheet) => sheet.file === 'markdown.css')?.css ?? ''
    assert.throws(() => {
      assertApprovedRawHex('markdown.css', markdown.replace('#007000', '#ff0000'))
    }, /reviewed raw hex palette/)
  })

  it('keeps the provider palette confined to the existing ChatGPT sign-in button', () => {
    const settings = stylesheets().find((sheet) => sheet.file === 'settings.css')?.css ?? ''
    function assertProviderSelectors(css: string): void {
      const selectors = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((match) => /#[0-9a-fA-F]{3,8}\b/.test(match[2] ?? ''))
        .filter((match) => match[1]?.includes('.chatgpt-sign-in'))
        .map((match) => match[1]?.trim())
      assert.deepEqual(selectors, ['.chatgpt-sign-in', '.chatgpt-sign-in:hover:not(:disabled)'])
    }
    assertProviderSelectors(settings)
    const base = bodiesOf(settings, '.chatgpt-sign-in').join('\n')
    assert.deepEqual((base.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).sort(), [
      '#000',
      '#202020',
      '#fff',
      '#fff',
      '#fff',
    ])
    for (const selector of ['.chatgpt-sign-in', '.chatgpt-sign-in:hover:not(:disabled)']) {
      assert.throws(() => {
        assertProviderSelectors(settings.replace(`${selector} {`, `${selector}, .unrelated {`))
      })
    }
    assert.throws(() => {
      assertApprovedRawHex('settings.css', settings.replace('#202020', '#202021'))
    }, /reviewed raw hex palette/)
    assert.throws(() => {
      assertApprovedRawHex('settings.css', `${settings}\n.unrelated { color: #fff; }`)
    }, /reviewed raw hex palette/)
  })

  it('keeps status fills off yes/no buttons', () => {
    // Accept / Reject on the diff bar are kit buttons (classes set in
    // git-changes-pane.ts); the stylesheet must not paint them in status hues.
    const diff = stylesheets().find((sheet) => sheet.file === 'diff.css')?.css ?? ''
    for (const selector of ['.diff-accept-btn', '.diff-reject-btn']) {
      assertNoStatusFill(diff, selector)
    }
  })

  it('checks qualified and pseudo-class button selectors', () => {
    const css = `
      .ui-btn-primary.diff-accept-btn:hover:not(:disabled),
      button.diff-reject-btn.is-active { background: var(--success); }
    `
    assert.throws(() => {
      assertNoStatusFill(css, '.diff-accept-btn')
    }, /must not be/)
    assert.throws(() => {
      assertNoStatusFill(css, '.diff-reject-btn')
    }, /must not be/)
  })

  it('rejects every semantic status hue in background declarations', () => {
    for (const token of [
      'success',
      'warning',
      'danger',
      'error',
      'info',
      'important',
      'change-added',
      'change-deleted',
      'change-modified',
      'change-renamed',
      'diff-delete',
      'diff-insert',
    ]) {
      const property = token === 'success' ? 'background-color' : 'background'
      const value =
        token === 'info' ? `linear-gradient(var(--${token}), var(--bg-base))` : `var(--${token})`
      const css = `.diff-accept-btn { ${property}: ${value}; }`
      assert.throws(
        () => {
          assertNoStatusFill(css, '.diff-accept-btn')
        },
        /must not be/,
        `expected --${token} to be rejected`,
      )
    }
  })

  it('rejects semantic status gradients in background-image declarations', () => {
    const css = `
      .diff-accept-btn {
        background-image: linear-gradient(var(--success), transparent);
      }
    `
    assert.throws(() => {
      assertNoStatusFill(css, '.diff-accept-btn')
    }, /must not be/)
  })

  it('follows local custom properties used by button backgrounds', () => {
    const css = `
      .diff-accept-btn {
        --accept-fill: var(--success);
        --button-fill: var(--accept-fill);
        background: var(--button-fill);
      }
    `
    assert.throws(() => {
      assertNoStatusFill(css, '.diff-accept-btn')
    }, /must not be/)
  })

  it('follows inherited custom properties used by button backgrounds', () => {
    const css = `
      .diff-approval-bar {
        --accept-fill: var(--success);
      }
      .diff-accept-btn {
        --button-fill: var(--accept-fill);
        background: var(--button-fill);
      }
    `
    assert.throws(() => {
      assertNoStatusFill(css, '.diff-accept-btn')
    }, /must not be/)
  })
})

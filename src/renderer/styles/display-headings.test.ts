// Contract tests for the heading tiers in docs/ui-taste.md → "Shared foundations".
//
// `brand.css` binds `h1`–`h3` to the display face (Averia Serif Libre) at weight
// 400. Averia ships a single weight, so any rule that asks one of those headings
// for 600/700 gets Chromium's synthetic bold, which smears the serifs. And since
// the element is what picks the face, a heading that should read as a utility
// label or nested card title is an `h4`+, not an `h3` restyled small.
//
// Neither mistake shows up in happy-dom (no fonts, no cascade), and a screenshot
// only shows it once it has shipped, so pin both at the stylesheet level:
//
//   1. No rule that styles an `h1`–`h3` asks for a bold weight while leaving it in
//      the display face. "Styles an h1–h3" means the rule's subject names the
//      element, or names a class the renderer puts on an `h1`–`h3`.
//   2. Settings' masthead rule reaches only the section's own `<h3>`: a
//      descendant `.settings-section h3` (0,1,1) also caught card titles mounted
//      deeper in the section and outranked their own class rules (0,1,0).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const ROOT = process.cwd()
const STYLES = resolve(ROOT, 'src/renderer/styles')
const RENDERER = resolve(ROOT, 'src/renderer')

function walk(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) return walk(path, keep)
    return keep(entry.name) ? [path] : []
  })
}

/** Classes the renderer source puts on an `h1`–`h3`. */
function displayHeadingClasses(): Set<string> {
  const found = new Set<string>()
  const patterns = [
    // el('h3', { class: 'foo bar' }, …)
    /\bel\(\s*'h[1-3]'\s*,\s*\{[^}]*?\bclass:\s*'([^']+)'/g,
    // <h3 class="foo">
    /<h[1-3]\b[^>]*?\bclass="([^"]+)"/g,
    // const x = document.createElement('h3') \n x.className = 'foo'
    /createElement\('h[1-3]'\)\s*\n\s*\w+\.className\s*=\s*'([^']+)'/g,
  ]
  const sources = walk(RENDERER, (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  for (const file of sources) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        for (const name of (match[1] ?? '').split(/\s+/)) if (name) found.add(name)
      }
    }
  }
  return found
}

type Rule = { file: string; line: number; selector: string; body: string }

/** Flat `selector { … }` rules, descending into `@media`/`@supports` wrappers. */
function rules(): Rule[] {
  const found: Rule[] = []
  for (const path of walk(STYLES, (name) => name.endsWith('.css'))) {
    const file = relative(ROOT, path)
    const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (comment) =>
      comment.replace(/[^\n]/g, ' '),
    )
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ')
      if (!selector || selector.startsWith('@')) continue
      found.push({
        file,
        line: css.slice(0, match.index).split('\n').length,
        selector,
        body: match[2] ?? '',
      })
    }
  }
  return found
}

/** Split on `separator` outside parens, so `:is(h1, h2)` stays one branch. */
function split(input: string, separator: RegExp): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const char of input.trim()) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (separator.test(char) && depth === 0) {
      if (current) out.push(current)
      current = ''
    } else current += char
  }
  if (current) out.push(current)
  return out
}

/** The subject compound of each comma branch (the part after the last combinator). */
function subjects(selector: string): string[] {
  return split(selector, /,/).map(
    (branch) => split(branch.replace(/\s*([>+~])\s*/g, ' '), /\s/).at(-1) ?? '',
  )
}

function declaration(body: string, property: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(body)
  return match?.[1]?.trim() ?? null
}

describe('display headings (docs/ui-taste.md → Shared foundations)', () => {
  const headingClasses = displayHeadingClasses()
  const all = rules()

  it('finds the h1–h3 classes it guards', () => {
    // A regex that silently matched nothing would pass everything below.
    for (const name of ['welcome-heading', 'keyboard-shortcuts-title']) {
      assert.ok(headingClasses.has(name), `expected .${name} to be found on an h1–h3`)
    }
  })

  it('never asks an h1–h3 in the display face for a synthetic bold', () => {
    const offenders: string[] = []
    for (const rule of all) {
      const weight = declaration(rule.body, 'font-weight')
      if (weight === null || /^(400|normal|inherit)$/.test(weight)) continue
      // A rule that moves the heading out of the display face owns its weight.
      const family = declaration(rule.body, 'font-family')
      if (family !== null && !family.includes('--font-display')) continue
      const targetsDisplayHeading = subjects(rule.selector).some(
        (subject) =>
          /(?:^|[(,\s])h[1-3](?![\w-])/.test(subject) ||
          (subject.match(/\.[A-Za-z0-9_-]+/g) ?? []).some((name) =>
            headingClasses.has(name.slice(1)),
          ),
      )
      if (targetsDisplayHeading) {
        offenders.push(
          `${rule.file}:${String(rule.line)} ${rule.selector} { font-weight: ${weight} }`,
        )
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'h1–h3 are the display tier in Averia, which ships only 400 — set 400, or make the ' +
        'element an h4+ if it is a utility heading (docs/ui-taste.md)',
    )
  })

  it("scopes Settings' masthead rule to the section's own h3", () => {
    const settings = all.filter((rule) => rule.file.endsWith('settings.css'))
    const branches = settings.flatMap((rule) => split(rule.selector, /,/).map((b) => b.trim()))
    assert.ok(
      branches.includes('.settings-section > h3'),
      'settings.css must style the section masthead as `.settings-section > h3`',
    )
    assert.ok(
      !branches.some((branch) => /\.settings-section(?:\.[\w-]+)* h3\b/.test(branch)),
      'a descendant `.settings-section h3` also restyles nested card titles and outranks their ' +
        'own class rules; use the child combinator',
    )
  })
})

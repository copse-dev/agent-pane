// Every `var(--name)` without a fallback must name a custom property something
// actually defines.
//
// A reference to an undefined custom property does not fail loudly. The
// declaration becomes invalid at computed-value time and the property falls
// back to its initial value: `background` turns transparent, `border-radius`
// turns 0, `transition` stops animating. Nothing warns — not the build, not
// happy-dom, not the console — so a mistyped or never-created token
// (`--bg-secondary`, `--radius-md`, `--transition-fast`) silently strips a
// button's fill or a chip's corners until somebody notices in a screenshot
// (#3065). A `color-mix()` that mentions one is dropped as a whole.
//
// "Defined" means one of:
//   - declared (`--name: …`) in any renderer stylesheet — tokens.css, themes.css,
//     or a component-local knob in a global/*.css rule;
//   - set at runtime from renderer code with `style.setProperty('--name', …)`.
//     The list is read from the source rather than maintained by hand, so a new
//     runtime setter needs no edit here.
//
// A reference with a fallback (`var(--knob, 8px)`) is a deliberate override
// point and is not checked. A nested `var(--a, var(--b))` still checks `--b`:
// if `--a` is always defined, `--b` is dead text; if it is not, `--b` is what
// renders.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const RENDERER = resolve(process.cwd(), 'src/renderer')

function walk(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) return walk(path, keep)
    return keep(entry.name) ? [path] : []
  })
}

type Source = { file: string; text: string }

// CSS comments are blanked rather than removed so reported line numbers stay
// true. TS is read raw: a glob string such as '**/*.ts' would open a "comment"
// there and hide real code.
const blankComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))

function read(files: string[], clean: (text: string) => string): Source[] {
  return files.map((file) => ({
    file: relative(process.cwd(), file),
    text: clean(readFileSync(file, 'utf8')),
  }))
}

const stylesheets = read(
  walk(RENDERER, (name) => name.endsWith('.css')),
  blankComments,
)
const scripts = read(
  walk(RENDERER, (name) => name.endsWith('.ts') && !name.endsWith('.test.ts')),
  (text) => text,
)

const DECLARATION = /(?<![\w-])(--[\w-]+)\s*:/g
const RUNTIME_SETTER = /\.setProperty\(\s*['"`](--[\w-]+)['"`]/g
// `var(--name)` with nothing but whitespace before the closing paren.
const UNGUARDED_REFERENCE = /var\(\s*(--[\w-]+)\s*\)/g

type Hit = { name: string; index: number }

/** The first capture group of every match, with where it matched. */
function hits(text: string, pattern: RegExp): Hit[] {
  return [...text.matchAll(pattern)].flatMap((match) => {
    const name = match[1]
    return name === undefined ? [] : [{ name, index: match.index }]
  })
}

function defined(): Set<string> {
  return new Set([
    ...stylesheets.flatMap(({ text }) => hits(text, DECLARATION)).map((hit) => hit.name),
    ...scripts.flatMap(({ text }) => hits(text, RUNTIME_SETTER)).map((hit) => hit.name),
  ])
}

type Reference = { at: string; name: string }

function unguardedReferences(sources: Source[]): Reference[] {
  return sources.flatMap(({ file, text }) =>
    hits(text, UNGUARDED_REFERENCE).map(({ name, index }) => ({
      at: `${file}:${String(text.slice(0, index).split('\n').length)}`,
      name,
    })),
  )
}

function undefinedReferences(sources: Source[]): string[] {
  const names = defined()
  return unguardedReferences(sources)
    .filter((ref) => !names.has(ref.name))
    .map((ref) => `${ref.at} var(${ref.name})`)
}

describe('renderer custom properties', () => {
  it('finds the stylesheets, tokens and runtime setters it checks against', () => {
    // Guards the guard: a broken walk or regex would make every check below
    // pass vacuously.
    assert.ok(stylesheets.some(({ file }) => file.endsWith('styles/tokens.css')))
    assert.ok(unguardedReferences(stylesheets).length > 500)
    const names = defined()
    for (const name of ['--bg-base', '--bg-elevated', '--radius', '--tint-amount']) {
      assert.ok(names.has(name), `${name} should be defined`)
    }
    // Set only from TS (pane-resizer.ts), never declared in CSS.
    assert.ok(names.has('--projects-width'), 'runtime setters should count as definitions')
  })

  it('never references an undefined custom property without a fallback in CSS (#3065)', () => {
    assert.deepEqual(
      undefinedReferences(stylesheets),
      [],
      'these resolve to the initial value (transparent, 0, none); use a token from tokens.css',
    )
  })

  it('never references an undefined custom property from renderer inline styles', () => {
    assert.deepEqual(
      undefinedReferences(scripts),
      [],
      'these resolve to the initial value; use a token from tokens.css',
    )
  })
})

// Loads the official CommonMark conformance examples from the `commonmark-spec`
// devDependency (its `spec.txt`) so we do not vendor a copy of the spec data in
// this repo. The extraction logic mirrors `commonmark-spec`'s own `index.js`
// (the embedded ` ```……``` example fences), kept inline so the test does not
// have to bundle the package's CommonJS entry (which reads `spec.txt` relative
// to its own `__dirname`).
//
// Source: https://www.npmjs.com/package/commonmark-spec
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

export interface SpecExample {
  markdown: string
  html: string
  example: number
  section: string
}

const EXAMPLE_RE = /^`{32} example\n([\s\S]*?)^\.\n([\s\S]*?)^`{32}$|^#{1,6} *(.*)$/gm

// Resolve `commonmark-spec` from the repo root at runtime. Building the require
// dynamically (rather than using the bundler's `require`) keeps esbuild from
// trying to inline the package, while still honoring node_modules hoisting. The
// base file need not exist — it only anchors resolution.
const requireFromRoot = createRequire(resolve(process.cwd(), 'noop.js'))

/** Version of the installed `commonmark-spec` package (the pinned spec version). */
export function commonMarkSpecVersion(): string {
  return (requireFromRoot('commonmark-spec/package.json') as { version: string }).version
}

/** Parse every embedded conformance example from the spec text. */
export function loadCommonMarkSpec(): SpecExample[] {
  const text = readFileSync(requireFromRoot.resolve('commonmark-spec/spec.txt'), 'utf8')
    .replace(/\r\n?/g, '\n')
    .replace(/^<!-- END TESTS -->(.|[\n])*/m, '')
  const examples: SpecExample[] = []
  let section = ''
  let number = 0
  text.replace(
    EXAMPLE_RE,
    (_match, markdown: string, html: string, heading: string | undefined) => {
      if (heading !== undefined) {
        section = heading
      } else {
        number++
        // spec.txt renders tabs as a visible `→` glyph; the spec's own test
        // extractor (spec_tests.py) substitutes real tabs back in.
        examples.push({
          markdown: markdown.replace(/→/g, '\t'),
          html: html.replace(/→/g, '\t'),
          example: number,
          section,
        })
      }
      return ''
    },
  )
  return examples
}

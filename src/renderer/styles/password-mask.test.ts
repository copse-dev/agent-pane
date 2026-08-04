import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE_CSS = resolve(process.cwd(), 'src/renderer/styles/global/base.css')

describe('password masking', () => {
  it('uses filled discs rather than font-dependent period glyphs', () => {
    const css = readFileSync(BASE_CSS, 'utf8')
    assert.match(css, /input\[type='password'\]\s*\{[^}]*-webkit-text-security:\s*disc/s)
  })
})

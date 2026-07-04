import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { highlightFenceCode } from './highlight.ts'
import { fenceInfoLanguage, parseFenceSlice } from './block-patterns.ts'
import { renderMarkdown } from './renderer.ts'

describe('fenced-code content fidelity (#598)', () => {
  it('preserves the first line indentation (no leading trim)', () => {
    // Unknown lang → escaped plain text, so we can assert the content exactly.
    assert.equal(highlightFenceCode('    indented', 'weirdlang'), '    indented')
  })

  it('preserves interior and leading/trailing blank lines', () => {
    assert.equal(highlightFenceCode('\na\n\nb\n', 'weirdlang'), '\na\n\nb\n')
  })

  it('keeps a blank-only fence body instead of collapsing it to empty', () => {
    assert.equal(highlightFenceCode('\n\n', 'weirdlang'), '\n\n')
    assert.equal(highlightFenceCode('\n\n', ''), '\n\n')
  })

  it('returns empty only for a truly empty body', () => {
    assert.equal(highlightFenceCode('', 'ts'), '')
  })
})

describe('parseFenceSlice content fidelity (#598)', () => {
  it('keeps blank lines and indentation between the fences', () => {
    const { code } = parseFenceSlice('```\n\n    a\n\n```')
    assert.equal(code, '\n    a\n')
  })

  it('strips only the opening fence indentation from content lines', () => {
    // Fence opener indented 2 spaces → up to 2 leading spaces removed per line.
    const { code } = parseFenceSlice('  ```\n      six\n  two\n  ```')
    assert.equal(code, '    six\ntwo')
  })
})

describe('fence info-string language (#598, spec #24)', () => {
  it('decodes backslash escapes in the info string', () => {
    assert.equal(fenceInfoLanguage('foo\\+bar'), 'foo+bar')
  })

  it('takes only the first word as the language', () => {
    assert.equal(fenceInfoLanguage('ruby startline=3 $%@#$'), 'ruby')
  })

  it('decodes HTML entities in the info string', () => {
    assert.equal(fenceInfoLanguage('f&ouml;o'), 'föo')
  })

  it('renders the decoded language class through the full renderer', () => {
    const html = renderMarkdown('```foo\\+bar\ncode\n```')
    assert.match(html, /class="hljs lang-foo\+bar"/)
  })
})

describe('fenced code renders blank lines through the full renderer (#598)', () => {
  it('keeps an interior blank line in the <pre><code>', () => {
    const html = renderMarkdown('```\nline1\n\nline3\n```')
    assert.match(html, /line1\n\nline3/)
  })
})

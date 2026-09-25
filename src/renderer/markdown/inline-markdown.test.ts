import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setInlineMarkdown } from './inline-markdown.ts'

function render(source: string): HTMLElement {
  const host = document.createElement('p')
  setInlineMarkdown(host, source)
  return host
}

describe('setInlineMarkdown', () => {
  it('renders backtick spans as inline code without their delimiters', () => {
    const host = render('Sign in with `claude /login` or set `ANTHROPIC_API_KEY`.')
    assert.deepEqual(
      [...host.querySelectorAll('code')].map((code) => code.textContent),
      ['claude /login', 'ANTHROPIC_API_KEY'],
    )
    assert.equal(host.textContent, 'Sign in with claude /login or set ANTHROPIC_API_KEY.')
    assert.equal(host.querySelector('p'), null, 'the host receives phrasing content only')
  })

  it('keeps raw HTML placeholders literal', () => {
    const host = render('Serves http://localhost:<port> via `run_background`.')
    assert.match(host.textContent, /localhost:<port>/)
    assert.equal(host.querySelector('port'), null)
  })

  it('falls back to the source text for anything beyond the phrasing subset', () => {
    assert.equal(render('- one\n- two').textContent, '- one\n- two')
    assert.equal(render('First.\n\nSecond `x`.').textContent, 'First.\n\nSecond `x`.')
  })
})

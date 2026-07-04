import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMermaidFallback } from './mermaid-fallback.ts'

describe('renderMermaidFallback', () => {
  it('replaces the container with a titled, collapsible source view', () => {
    const container = document.createElement('div')
    container.className = 'mermaid-diagram mermaid-diagram--pending mermaid-diagram--folded'
    container.setAttribute('role', 'button')
    container.setAttribute('tabindex', '0')
    container.setAttribute('aria-label', 'Expand diagram')
    container.innerHTML = '<pre class="mermaid">graph TD; A-->B</pre>'

    renderMermaidFallback(container, 'graph TD; A-->B')

    // Pending/folded state and interaction affordances are cleared.
    assert.equal(container.classList.contains('mermaid-diagram--pending'), false)
    assert.equal(container.classList.contains('mermaid-diagram--folded'), false)
    assert.equal(container.dataset['mermaidUi'], 'true')
    assert.equal(container.getAttribute('role'), null)
    assert.equal(container.getAttribute('tabindex'), null)
    assert.equal(container.getAttribute('aria-label'), null)

    // Fallback structure: title, hint, and a <details> holding the raw source.
    assert.equal(
      container.querySelector('.mermaid-fallback-title')?.textContent,
      'Diagram could not be rendered',
    )
    assert.ok(container.querySelector('.mermaid-fallback-hint'))
    const pre = container.querySelector('details.mermaid-fallback-source pre')
    assert.equal(pre?.textContent, 'graph TD; A-->B')
    assert.equal(container.querySelector('summary')?.textContent, 'View diagram source')
    // The original <pre class="mermaid"> is gone.
    assert.equal(container.querySelector('pre.mermaid'), null)
  })
})

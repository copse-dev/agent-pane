// Uses jsdom because DOMPurify needs a spec-complete DOM (see setup file).
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { renderMarkdown } from './renderer.ts'

describe('sanitizeRenderedMarkdown', () => {
  it('strips script tags', () => {
    const html = sanitizeRenderedMarkdown('<p>hi</p><script>alert(1)</script>')
    assert.doesNotMatch(html, /<script/i)
    assert.match(html, /<p>hi<\/p>/)
  })

  it('strips event-handler attributes and unknown tags', () => {
    const html = sanitizeRenderedMarkdown('<img src=x onerror=alert(1)><p onclick="evil()">x</p>')
    // A non-artifact `<img>` (wrong/absent class) is dropped entirely, so the
    // `onerror` payload can never reach `innerHTML`.
    assert.doesNotMatch(html, /<img/i)
    assert.doesNotMatch(html, /onerror/i)
    assert.doesNotMatch(html, /onclick/i)
    assert.match(html, /<p>x<\/p>/)
  })

  it('drops arbitrary LLM <img> even when it claims the artifact class', () => {
    // An attacker who guesses the gate class still cannot smuggle a `src`
    // (and therefore no `onerror`/scheme payload) past the sanitizer.
    const html = sanitizeRenderedMarkdown(
      '<img class="remote-artifact-image" src="x" onerror="alert(1)">' +
        '<img class="evil" src="x" onerror="alert(1)">',
    )
    assert.doesNotMatch(html, /onerror/i)
    assert.doesNotMatch(html, /src=/i)
    // The wrong-class image is removed entirely.
    assert.doesNotMatch(html, /class="evil"/i)
  })

  it('preserves a renderer-produced remote-artifact image with its data-* attributes', () => {
    const html = sanitizeRenderedMarkdown(
      '<img class="remote-artifact-image" ' +
        'data-remote-artifact-path="artifacts/diagram.png" ' +
        'data-remote-artifact-agent-id="bc-123" ' +
        'alt="Remote agent artifact" loading="lazy">',
    )
    assert.match(html, /<img[^>]*class="remote-artifact-image"/i)
    assert.match(html, /data-remote-artifact-path="artifacts\/diagram\.png"/)
    assert.match(html, /data-remote-artifact-agent-id="bc-123"/)
    assert.match(html, /alt="Remote agent artifact"/)
    assert.match(html, /loading="lazy"/)
    // No event handlers and no src survive sanitization (hydration sets src later).
    assert.doesNotMatch(html, /onerror/i)
    assert.doesNotMatch(html, /\bon\w+=/i)
    assert.doesNotMatch(html, /src=/i)
  })

  it('drops javascript: hrefs while keeping the link text', () => {
    const html = sanitizeRenderedMarkdown('<a href="javascript:alert(1)">click</a>')
    assert.doesNotMatch(html, /javascript:/i)
    assert.match(html, /click/)
  })

  it('preserves the renderer link shape (target, rel, data-browser-link)', () => {
    const html = sanitizeRenderedMarkdown(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer" data-browser-link="true">x</a>',
    )
    assert.match(html, /href="https:\/\/example\.com"/)
    assert.match(html, /target="_blank"/)
    assert.match(html, /rel="noopener noreferrer"/)
    assert.match(html, /data-browser-link="true"/)
  })

  it('preserves workspace markdown link attributes', () => {
    const html = sanitizeRenderedMarkdown(
      '<a href="/docs/foo.md" class="workspace-markdown-link" data-workspace-link="true">x</a>',
    )
    assert.match(html, /data-workspace-link="true"/)
    assert.match(html, /href="\/docs\/foo\.md"/)
  })

  it('preserves mermaid scaffolding and highlight.js spans', () => {
    const html = sanitizeRenderedMarkdown(
      '<div class="mermaid-diagram mermaid-diagram--pending"><pre class="mermaid">A--&gt;B</pre></div>' +
        '<pre><code class="hljs lang-ts"><span class="hljs-keyword">const</span></code></pre>',
    )
    assert.match(html, /class="mermaid-diagram mermaid-diagram--pending"/)
    assert.match(html, /<pre class="mermaid">/)
    assert.match(html, /class="hljs-keyword"/)
  })

  it('normalizes double-encoded nbsp entities leaked before innerHTML', () => {
    const html = sanitizeRenderedMarkdown('<p>Proposed &amp;nbsp;&amp;nbsp;|&amp;nbsp;</p>')
    const div = document.createElement('div')
    div.innerHTML = html
    assert.doesNotMatch(div.textContent, /&nbsp;/)
    assert.match(div.textContent, /\u00A0/)
  })

  it('is a no-op for the structures renderMarkdown already produces', () => {
    const source = [
      '## Heading',
      '',
      '- one',
      '- two',
      '',
      'Text with **bold**, _italic_, `code`, and [a link](https://example.com).',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n')
    assert.equal(sanitizeRenderedMarkdown(renderMarkdown(source)), renderMarkdown(source))
  })

  it('neutralizes a payload even if it reached the rendered HTML directly', () => {
    // Simulates the renderer mis-assembling markup: the sanitizer is the backstop.
    const html = sanitizeRenderedMarkdown('<p>ok</p><iframe src="javascript:alert(1)"></iframe>')
    assert.doesNotMatch(html, /<iframe/i)
    assert.match(html, /<p>ok<\/p>/)
  })
})

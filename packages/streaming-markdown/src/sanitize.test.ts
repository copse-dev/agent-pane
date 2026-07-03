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

// Defense-in-depth coverage for the DOMPurify Dependabot advisories. Those
// advisories are fixed upstream in dompurify 3.4.11 (they affect <=3.4.10), and
// the app pulls that patched release; these tests are not a substitute for the
// bump. What they add is that each of those bypasses targets a *risky* DOMPurify
// configuration this sink deliberately does not use: a strict tag/attr allowlist
// (never a FORBID_TAGS denylist), string output (never RETURN_DOM), and no
// custom-element handling. These assertions pin that posture so a refactor of
// `sanitize.ts` toward any of those modes fails loudly here instead of silently
// re-opening the advisory class.
describe('sanitizeRenderedMarkdown — DOMPurify advisory posture', () => {
  it('drops custom elements (CUSTOM_ELEMENT_HANDLING prototype-pollution class)', () => {
    // The allowlist admits only standard tags, so a custom element and any
    // handler it carries are removed regardless of DOMPurify's custom-element
    // fallback behaviour.
    const html = sanitizeRenderedMarkdown('<x-widget onclick="alert(1)">hi</x-widget>')
    assert.doesNotMatch(html, /<x-widget/i)
    assert.doesNotMatch(html, /onclick/i)
    assert.match(html, /hi/)
  })

  it('strips SVG/foreignObject re-contextualization vectors (mutation-XSS class)', () => {
    const html = sanitizeRenderedMarkdown(
      '<svg><foreignObject><a href="javascript:alert(1)">x</a></foreignObject></svg>' +
        '<svg><style><img src=x onerror=alert(1)></style></svg>',
    )
    assert.doesNotMatch(html, /<svg/i)
    assert.doesNotMatch(html, /foreignObject/i)
    assert.doesNotMatch(html, /javascript:/i)
    assert.doesNotMatch(html, /onerror/i)
  })

  it('strips MathML mglyph/mtext smuggling (mutation-XSS class)', () => {
    const html = sanitizeRenderedMarkdown(
      '<math><mtext><mglyph><style><img src=x onerror=alert(1)></style></mglyph></mtext></math>',
    )
    assert.doesNotMatch(html, /<math/i)
    assert.doesNotMatch(html, /mglyph/i)
    assert.doesNotMatch(html, /onerror/i)
  })

  it('an unlisted tag is dropped by the allowlist, not merely denylisted (FORBID_TAGS-bypass class)', () => {
    // A denylist can be dodged; an allowlist admits only what it names. `form`,
    // `object`, and `template` are not in ALLOWED_TAGS, so they cannot survive
    // even when nested to confuse a denylist walker.
    const html = sanitizeRenderedMarkdown(
      '<form><template><object data="javascript:alert(1)"></object></template></form>',
    )
    assert.doesNotMatch(html, /<form/i)
    assert.doesNotMatch(html, /<template/i)
    assert.doesNotMatch(html, /<object/i)
    assert.doesNotMatch(html, /javascript:/i)
  })
})

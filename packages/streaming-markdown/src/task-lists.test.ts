import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { renderStreamingMarkdown } from './streaming.ts'

describe('GFM task lists (#614)', () => {
  it('renders an unchecked item with a disabled checkbox', () => {
    assert.equal(
      renderMarkdown('- [ ] Ship feature'),
      '<ul class="contains-task-list"><li class="task-list-item">' +
        '<input type="checkbox" disabled> Ship feature</li></ul>',
    )
  })

  it('renders a checked item ([x] and [X])', () => {
    assert.equal(
      renderMarkdown('- [x] Done'),
      '<ul class="contains-task-list"><li class="task-list-item">' +
        '<input type="checkbox" disabled checked> Done</li></ul>',
    )
    assert.match(renderMarkdown('- [X] Done'), /<input type="checkbox" disabled checked>/)
  })

  it('keeps inline markdown in the item body', () => {
    const html = renderMarkdown('- [x] Ship `pkg` and **bold**')
    assert.match(
      html,
      /<input type="checkbox" disabled checked> Ship <code>pkg<\/code> and <strong>bold<\/strong>/,
    )
  })

  it('mixes task and plain items in one list', () => {
    const html = renderMarkdown('- [ ] todo\n- plain item')
    assert.match(html, /^<ul class="contains-task-list">/)
    assert.match(html, /<li class="task-list-item"><input type="checkbox" disabled> todo<\/li>/)
    assert.match(html, /<li>plain item<\/li>/)
  })

  it('does not flag a plain list as a task list', () => {
    assert.equal(renderMarkdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>')
  })

  it('handles nested task lists via existing <ul> recursion', () => {
    const html = renderMarkdown('- [ ] parent\n  - [x] child')
    assert.match(html, /parent/)
    // The nested list is itself a task list containing the checked child.
    assert.match(
      html,
      /<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled checked> child<\/li><\/ul>/,
    )
  })

  it('leaves non-checkbox brackets literal', () => {
    // No space after the bracket, or a multi-char body, is not a task marker.
    assert.match(renderMarkdown('- [ok] label'), /<li>\[ok\] label<\/li>/)
    assert.match(renderMarkdown('- [] empty'), /<li>\[\] empty<\/li>/)
  })

  it('supports an empty checkbox with no trailing text', () => {
    assert.equal(
      renderMarkdown('- [x]'),
      '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled checked></li></ul>',
    )
  })
})

describe('task-list sanitizer surface (#614)', () => {
  it('preserves the renderer-produced checkbox', () => {
    const html = sanitizeRenderedMarkdown(renderMarkdown('- [x] done'))
    assert.match(html, /<input[^>]*type="checkbox"[^>]*>/)
    assert.match(html, /disabled/)
    assert.match(html, /checked/)
  })

  it('drops any non-checkbox <input> and forces the checkbox read-only', () => {
    const html = sanitizeRenderedMarkdown(
      '<input type="text" value="x"><input type="image" src="y" onerror="alert(1)">' +
        '<input type="checkbox">',
    )
    assert.doesNotMatch(html, /type="text"/i)
    assert.doesNotMatch(html, /type="image"/i)
    assert.doesNotMatch(html, /onerror/i)
    assert.doesNotMatch(html, /src=/i)
    // The bare checkbox survives but is forced disabled (read-only).
    assert.match(html, /<input[^>]*type="checkbox"[^>]*>/)
    assert.match(html, /disabled/)
  })
})

describe('task lists while streaming (#614)', () => {
  it('does not mis-parse [ ] as a broken link mid-stream, and commits a checkbox', () => {
    // Feed the item in prefixes; no partial render should produce an <a> for [ ].
    const full = '- [ ] streaming task\n'
    for (let cut = 1; cut <= full.length; cut++) {
      const html = renderStreamingMarkdown(full.slice(0, cut))
      assert.doesNotMatch(
        html,
        /<a\b/,
        `unexpected link at prefix ${JSON.stringify(full.slice(0, cut))}`,
      )
    }
    // The streaming path sanitizes, so `disabled` serializes as `disabled=""`.
    assert.match(
      renderStreamingMarkdown(full),
      /<input type="checkbox" disabled(?:="")?> streaming task/,
    )
  })
})

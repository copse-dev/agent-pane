import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderSnapshot, type PageSnapshot } from './snapshot-format.ts'

describe('renderSnapshot', () => {
  it('renders a header and indented accessibility outline with refs', () => {
    const snapshot: PageSnapshot = {
      title: 'Example',
      url: 'http://localhost:3000/',
      nodes: [
        { role: 'heading', name: 'Welcome', depth: 0 },
        { role: 'link', name: 'Docs', depth: 1, ref: 'e1' },
        { role: 'textbox', name: 'Search', depth: 1, ref: 'e2', value: 'hello' },
      ],
    }
    const out = renderSnapshot(snapshot)
    assert.match(out, /page: "Example"/)
    assert.match(out, /url: http:\/\/localhost:3000\//)
    assert.match(out, /- heading "Welcome"/)
    assert.match(out, /\s{2}- link "Docs" \[ref=e1\]/)
    assert.match(out, /- textbox "Search" = "hello" \[ref=e2\]/)
  })

  it('handles empty pages', () => {
    const out = renderSnapshot({ title: '', url: 'http://localhost/', nodes: [] })
    assert.match(out, /\(no visible accessible content\)/)
  })

  it('marks truncated snapshots', () => {
    const out = renderSnapshot({
      title: 'Big',
      url: 'http://localhost/',
      nodes: [{ role: 'text', name: 'x', depth: 0 }],
      truncated: true,
    })
    assert.match(out, /snapshot truncated/)
  })
})

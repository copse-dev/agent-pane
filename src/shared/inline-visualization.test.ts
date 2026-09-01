import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createInlineVisualizationStreamFilter,
  stripInlineVisualizationReferences,
  type InlineVisualizationReference,
} from './inline-visualization.ts'

const frame = (payload: string, operator = 'visualize'): string =>
  `\u{e200}${operator}\u{e202}${payload}\u{e201}`

describe('inline visualization content references', () => {
  it('strips the frame and decodes the supported reference', () => {
    const references: InlineVisualizationReference[] = []
    const filter = createInlineVisualizationStreamFilter((reference) => references.push(reference))

    const visible =
      filter.push(
        `Before\n${frame('{"path":"/workspace/chart.html","mode":"wide","title":"Chart"}')}\nAfter`,
      ) + filter.finish()

    assert.equal(visible, 'Before\n\nAfter')
    assert.deepEqual(references, [{ path: '/workspace/chart.html', mode: 'wide', title: 'Chart' }])
  })

  it('recognizes a frame split across arbitrary stream chunks', () => {
    const references: InlineVisualizationReference[] = []
    const filter = createInlineVisualizationStreamFilter((reference) => references.push(reference))
    const source = `Lead ${frame('{"path":"/workspace/chart.html"}')} tail`
    let visible = ''

    for (const char of source) visible += filter.push(char)
    visible += filter.finish()

    assert.equal(visible, 'Lead  tail')
    assert.deepEqual(references, [{ path: '/workspace/chart.html' }])
  })

  it('strips unknown, malformed, and incomplete control frames', () => {
    const text = [
      'Start',
      frame('{"path":"/workspace/chart.html"}', 'future-op'),
      frame('{not json}'),
      '\u{e200}visualize\u{e202}{"path":"/workspace/incomplete.html"}',
    ].join('\n')

    assert.equal(stripInlineVisualizationReferences(text), 'Start\n\n\n')
  })

  it('leaves ordinary text unchanged', () => {
    assert.equal(stripInlineVisualizationReferences('A normal answer.'), 'A normal answer.')
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeMermaidHtmlEntities,
  prepareMermaidSource,
  stabilizeMermaidSource,
} from './mermaid-source.ts'

describe('mermaid source preparation', () => {
  it('decodes HTML entities from embedded diagram text', () => {
    assert.equal(decodeMermaidHtmlEntities('A --&gt; B &amp; C'), 'A --> B & C')
  })

  it('quotes square-bracket labels that contain parentheses', () => {
    const input = 'flowchart TB\n  Renderer[Renderer (20+ modules)]'
    assert.equal(
      stabilizeMermaidSource(input),
      'flowchart TB\n  Renderer["Renderer (20+ modules)"]',
    )
  })

  it('quotes labels with slashes, plus, or colon', () => {
    assert.match(
      stabilizeMermaidSource('  md[markdown/mermaid rendering]'),
      /md\["markdown\/mermaid rendering"\]/,
    )
    assert.match(
      stabilizeMermaidSource('  views[Views + Controllers]'),
      /views\["Views \+ Controllers"\]/,
    )
    assert.match(
      stabilizeMermaidSource('  loop[Agent loop: run-agent]'),
      /loop\["Agent loop: run-agent"\]/,
    )
  })

  it('quotes subgraph titles with parentheses', () => {
    const input = '  subgraph main[Main Process (electron)]'
    assert.equal(stabilizeMermaidSource(input), '  subgraph main["Main Process (electron)"]')
  })

  it('leaves stadium shapes unchanged', () => {
    const input = 'flowchart LR\n  A[(database)]'
    assert.equal(stabilizeMermaidSource(input), input)
  })

  it('prepareMermaidSource decodes then stabilizes', () => {
    const raw = '  Node[Label (note)] &amp; x --&gt; y'
    assert.match(prepareMermaidSource(raw), /Node\["Label \(note\)"\] & x --> y/)
  })
})

// Property test: incremental streaming must converge to the same display as a
// fresh complete render, using CommonMark baseline examples as fuzz inputs.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadBaselinePassingExamples } from '../tests/commonmark/baseline-examples.ts'
import { renderMarkdown } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import {
  renderStreamingMarkdown,
  splitForStreaming,
  StreamingMarkdownRenderer,
} from './streaming.ts'

/** Visible streaming HTML: committed blocks + any forming table + live tail. */
function extractStreamingDisplay(host: HTMLElement): string {
  const parts: string[] = []
  const complete = host.querySelector('.stream-complete')
  if (complete) parts.push(complete.innerHTML)
  const forming = host.querySelector('.stream-forming')
  if (forming instanceof HTMLElement && !forming.hidden) parts.push(forming.innerHTML)
  const pending = host.querySelector('.stream-pending')
  if (pending instanceof HTMLElement && !pending.hidden && pending.innerHTML !== '') {
    parts.push(pending.innerHTML)
  }
  return parts.join('')
}

function streamingDisplayAfterUpdates(markdown: string, cuts: number[]): string {
  const host = document.createElement('div')
  const renderer = new StreamingMarkdownRenderer(host)
  for (const cut of cuts) {
    renderer.update(markdown.slice(0, cut))
  }
  return extractStreamingDisplay(host)
}

/**
 * Cut indices exercised for each example. Short inputs try every prefix length;
 * longer ones still hit every newline and a strided sample so runtime stays bounded.
 */
function streamingCutIndices(text: string): number[] {
  const len = text.length
  if (len <= 256 || process.env['STREAMING_FUZZ_ALL'] === '1') {
    return Array.from({ length: len + 1 }, (_, i) => i)
  }
  const cuts = new Set<number>([0, len])
  for (let i = 0; i < len; i++) {
    if (text[i] === '\n' || i < 32 || i >= len - 32) cuts.add(i)
  }
  const stride = Math.max(1, Math.ceil(len / 128))
  for (let i = 0; i <= len; i += stride) cuts.add(i)
  return [...cuts].sort((a, b) => a - b)
}

const baselineExamples = loadBaselinePassingExamples()

describe('streaming markdown convergence (CommonMark baseline fuzz)', () => {
  it('incremental cuts converge to a fresh complete StreamingMarkdownRenderer render', () => {
    for (const ex of baselineExamples) {
      const markdown = ex.markdown
      const fresh = streamingDisplayAfterUpdates(markdown, [markdown.length])
      for (const cut of streamingCutIndices(markdown)) {
        const viaHistory = streamingDisplayAfterUpdates(markdown, [cut, markdown.length])
        assert.equal(
          viaHistory,
          fresh,
          `example #${String(ex.example)} (${ex.section}) cut=${String(cut)}`,
        )
      }
    }
  })

  it('matches at-rest render when the tokenizer commits the full input', () => {
    for (const ex of baselineExamples) {
      const markdown = ex.markdown
      if (splitForStreaming(markdown).pending !== '') continue
      const fresh = streamingDisplayAfterUpdates(markdown, [markdown.length])
      const atRest = sanitizeRenderedMarkdown(renderMarkdown(markdown))
      assert.equal(fresh, atRest, `example #${String(ex.example)} (${ex.section}) at-rest`)
    }
  })

  it('renderStreamingMarkdown matches the incremental renderer when fully committed', () => {
    for (const ex of baselineExamples) {
      const markdown = ex.markdown
      if (splitForStreaming(markdown).pending !== '') continue
      const domFresh = streamingDisplayAfterUpdates(markdown, [markdown.length])
      const stringFresh = renderStreamingMarkdown(markdown)
      assert.equal(
        domFresh,
        stringFresh,
        `example #${String(ex.example)} (${ex.section}) string API`,
      )
    }
  })
})

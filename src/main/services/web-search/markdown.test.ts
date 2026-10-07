import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { COMMAND_OUTPUT_TRUNCATED_MARKER } from '../exec/subprocess-output-cap.ts'
import { FETCH_URL_OUTPUT_MAX_BYTES, fetchUrlMarkdown } from './markdown.ts'

describe('fetchUrlMarkdown output cap', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function serve(html: string): void {
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }))
  }

  function page(paragraphs: number): string {
    const body = Array.from(
      { length: paragraphs },
      (_, i) => `<p>Paragraph ${String(i)} explains the API in some detail for readers.</p>`,
    ).join('')
    return `<html><head><title>Docs</title></head><body><article><h1>Docs</h1>${body}</article></body></html>`
  }

  it('returns a page under the cap in full', async () => {
    serve(page(20))
    const markdown = await fetchUrlMarkdown('https://duckduckgo.com/docs')
    assert.ok(markdown.includes('Paragraph 19 explains'))
    assert.ok(!markdown.includes(COMMAND_OUTPUT_TRUNCATED_MARKER))
  })

  it('caps converted Markdown that exceeds the cap, keeping head and tail', async () => {
    serve(page(8000))
    const markdown = await fetchUrlMarkdown('https://duckduckgo.com/docs')
    assert.ok(Buffer.byteLength(markdown, 'utf8') <= FETCH_URL_OUTPUT_MAX_BYTES)
    assert.ok(markdown.includes('Paragraph 0 explains'))
    assert.ok(markdown.includes('Paragraph 7999 explains'))
    assert.ok(markdown.includes(COMMAND_OUTPUT_TRUNCATED_MARKER))
    assert.match(markdown, /\[dropped \d+ bytes \(~\d+ lines\) from the middle\.\]/)
  })
})

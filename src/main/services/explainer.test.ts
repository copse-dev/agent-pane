import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFile } from 'node:fs/promises'
import { JSDOM, VirtualConsole } from 'jsdom'
import { buildExplainerHtml, prepareExplainer } from './explainer.ts'

const story = {
  project: 'Copse',
  title: 'Review the changes',
  pattern: 'review',
  labels: ['First edit', 'Second edit', 'Third edit'],
  beats: [
    { title: 'Inspect', caption: 'Three proposed edits need a decision.' },
    { title: 'Choose', caption: 'Keep two helpful edits and reject the third.' },
    { title: 'Continue', caption: 'The rejected edit returns to its original state.' },
  ],
  source: 'Conceptual example, based on the supplied brief.',
}

describe('thread explainer', () => {
  it('chooses concrete styles and readable timings without a provider call', () => {
    for (const [pattern, style] of Object.entries({
      review: 'paper',
      parallel: 'mailroom',
      context: 'travel',
      routing: 'folded',
      sequence: 'comic',
    })) {
      const prepared = prepareExplainer({ ...story, pattern, duration: 12 })
      assert.equal(prepared.style, style)
      assert.ok(prepared.duration >= 12)
      assert.ok(
        Math.abs(prepared.beatDurations.reduce((a, b) => a + b, 0) - prepared.duration) < 0.001,
      )
    }
    assert.equal(prepareExplainer({ ...story, style: 'felt' }).style, 'felt')
  })

  it('rejects malformed/oversized stories and drops undeclared fields', () => {
    for (const value of [
      { ...story, beats: [] },
      { ...story, duration: -1 },
      { ...story, style: 'constructor' },
      { ...story, title: 'x'.repeat(76) },
    ]) {
      assert.throws(() => prepareExplainer(value))
    }
    assert.equal(Object.hasOwn(prepareExplainer({ ...story, apiKey: 'secret' }), 'apiKey'), false)
  })

  it('keeps narration inert even with script terminators and replacement tokens', () => {
    const caption = '</script><script>window.compromised=true</script> $& $`'
    const html = buildExplainerHtml(
      '<script type="application/json">__COPSE_EXPLAINER_STORY__</script>',
      {
        ...story,
        beats: story.beats.map((beat) => ({ ...beat, caption })),
      },
    )
    assert.equal((html.match(/<script/g) ?? []).length, 1)
    assert.match(html, /\\u003c\/script>/)
    assert.match(html, /\$&/)
  })

  it('runs all nine styles and five mechanisms without script errors', async () => {
    for (const style of [
      'paper',
      'mailroom',
      'comic',
      'felt',
      'travel',
      'kinetic',
      'workshop',
      'folded',
      'signal',
    ]) {
      for (const pattern of ['review', 'parallel', 'context', 'routing', 'sequence']) {
        const errors: string[] = []
        const virtualConsole = new VirtualConsole()
        virtualConsole.on('jsdomError', (error) => errors.push(error.message))
        const template = await readFile('assets/explainers/player.html', 'utf8')
        const html = buildExplainerHtml(template, { ...story, style, pattern })
        const dom = new JSDOM(html, {
          runScripts: 'dangerously',
          virtualConsole,
          beforeParse(window): void {
            Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
              value: (): object =>
                new Proxy(
                  {},
                  {
                    get(_target, key): unknown {
                      if (key === 'measureText')
                        return (value: string): { width: number } => ({ width: value.length * 12 })
                      return (...args: unknown[]): void => {
                        for (const value of args)
                          if (typeof value === 'number') assert.ok(Number.isFinite(value))
                      }
                    },
                    set(): boolean {
                      return true
                    },
                  },
                ),
            })
          },
        })
        const seek = dom.window.document.querySelector('input')
        assert.ok(seek)
        for (const time of [0, 6, 12, 18, 24]) {
          seek.value = String(time)
          seek.dispatchEvent(new dom.window.Event('input'))
        }
        assert.deepEqual(errors, [], `${style}/${pattern}`)
        assert.equal(dom.window.document.querySelectorAll('#transcript li').length, 3)
        assert.match(dom.window.document.querySelector('#time')?.textContent ?? '', /0:24/)
        dom.window.close()
      }
    }
  })
})

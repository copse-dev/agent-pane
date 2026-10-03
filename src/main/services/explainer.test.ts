import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFile } from 'node:fs/promises'
import { JSDOM, VirtualConsole } from 'jsdom'
import { z } from 'zod'
import { reviewSceneStory, worktreeSceneStory } from '../../../tests/fixtures/explainer-scenes.ts'
import { drawingStory } from '../../../tests/fixtures/explainer-drawing.ts'
import {
  createExplainerPreviews,
  buildExplainerHtml,
  prepareExplainer,
  explainerPublishInput,
} from './explainer.ts'

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
    const caption =
      '</script><script>window.compromised=true</script> $& $` __COPSE_EXPLAINER_DRAWING_RUNTIME__'
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
    assert.match(html, /__COPSE_EXPLAINER_DRAWING_RUNTIME__/)
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

const stateSchema = z.object({
  objects: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      visible: z.boolean(),
      conflict: z.boolean().optional(),
      choices: z.array(z.string()).optional(),
    }),
  ),
})

it('validates scene references, lifetime and simultaneous dependencies', () => {
  assert.equal(prepareExplainer(reviewSceneStory).version, 2)
  assert.equal(prepareExplainer(worktreeSceneStory).beats.length, 6)
  const scene = (actions: unknown[]): { title: string; caption: string; actions: unknown[] } => ({
    title: 'Check',
    caption: 'Check the changed state.',
    actions,
  })
  for (const actions of [
    [{ type: 'edit', target: 'missing', content: 'x' }],
    [{ type: 'apply', from: 'bad', to: 'file' }],
    [{ type: 'copy', from: 'file', to: 'file' }],
    [{ type: 'copy', from: 'file', to: 'good' }],
    [
      { type: 'copy', from: 'file', to: 'bad' },
      { type: 'edit', target: 'file', content: 'Changed' },
    ],
    [{ type: 'merge', from: ['file', 'file'], to: 'bad' }],
    [{ type: 'discard', target: 'good', to: 'file' }],
  ])
    assert.throws(() =>
      prepareExplainer({
        ...reviewSceneStory,
        scenes: Array.from({ length: 4 }, () => scene(actions)),
      }),
    )
  assert.throws(() =>
    prepareExplainer({
      ...reviewSceneStory,
      objects: [...reviewSceneStory.objects, reviewSceneStory.objects[0]],
    }),
  )
  assert.throws(() => prepareExplainer({ ...reviewSceneStory, scenes: undefined }))
  assert.throws(() =>
    prepareExplainer({
      ...reviewSceneStory,
      scenes: reviewSceneStory.scenes.map((v) => ({ ...v, caption: 'x'.repeat(141) })),
    }),
  )
})

it('requires an exact preview and bounds retained previews', () => {
  const previews = createExplainerPreviews()
  const token = previews.record('original')
  previews.assertReviewed(token, 'original')
  assert.throws(() => {
    previews.assertReviewed(undefined, 'original')
  })
  assert.throws(() => {
    previews.assertReviewed(token, 'changed')
  })
  for (let i = 0; i < 24; i++) previews.record(String(i))
  assert.throws(() => {
    previews.assertReviewed(token, 'original')
  })
})

it('prepares original drawings without requiring preset objects or plots', () => {
  const prepared = prepareExplainer(drawingStory)
  assert.equal(prepared.version, 3)
  assert.equal(prepared.drawing?.styleName, 'Reservoir cutaway')
  assert.equal(prepared.beats.length, 4)
  assert.equal(prepared.objects, undefined)
  for (const value of [
    { ...drawingStory, beats: undefined },
    { ...drawingStory, objects: reviewSceneStory.objects },
    { ...drawingStory, drawing: { ...drawingStory.drawing, code: 'x'.repeat(24_001) } },
    {
      ...drawingStory,
      drawing: { ...drawingStory.drawing, background: 'url(https://example.com)' },
    },
    { ...drawingStory, beats: drawingStory.beats.map((b) => ({ ...b, caption: 'x'.repeat(141) })) },
    { ...story, beats: drawingStory.beats },
  ])
    assert.throws(() => prepareExplainer(value))
})

it('keeps generated drawing code inert until the worker receives it', () => {
  const code = '</script><script>window.compromised=true</script>'
  const html = buildExplainerHtml(
    '<script type="application/json">__COPSE_EXPLAINER_STORY__</script>',
    {
      ...drawingStory,
      drawing: { ...drawingStory.drawing, code },
    },
  )
  assert.equal((html.match(/<script/g) ?? []).length, 1)
  assert.match(html, /\\u003c\/script>/)
})

it('publishes the retained preview without requiring the code again', () => {
  const parsed = z
    .object(explainerPublishInput)
    .parse({ previewId: 'd28ecf32-93dd-44bb-a01c-9b5fbd73dd20' })
  assert.deepEqual(Object.keys(parsed), ['previewId'])
  const previews = createExplainerPreviews()
  const story = prepareExplainer(drawingStory)
  const id = previews.record('reviewed HTML', story)
  assert.deepEqual(previews.get(id), { html: 'reviewed HTML', story })
  assert.throws(() => previews.get(undefined))
  for (let i = 0; i < 24; i++) previews.record(String(i), story)
  assert.throws(() => previews.get(id))
})

it('preserves causal state across styles, replays and backwards seeks', async () => {
  const template = await readFile('assets/explainers/player.html', 'utf8')
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
    for (const input of [reviewSceneStory, worktreeSceneStory]) {
      const story = prepareExplainer({ ...input, style })
      const errors: string[] = []
      const virtualConsole = new VirtualConsole()
      virtualConsole.on('jsdomError', (error) => errors.push(error.message))
      const dom = new JSDOM(buildExplainerHtml(template, { ...input, style }), {
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
                      return (s: string): { width: number } => ({ width: s.length * 10 })
                    return (...args: unknown[]): void => {
                      for (const a of args) if (typeof a === 'number') assert.ok(Number.isFinite(a))
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
      const state = (time: number): z.output<typeof stateSchema> => {
        const value: unknown = dom.window.eval(
          `SceneExplainer.stateAt(JSON.parse(document.getElementById('story').textContent), ${String(time)})`,
        )
        return stateSchema.parse(value)
      }
      const seek = dom.window.document.querySelector('input')
      assert.ok(seek)
      const times = [
        0,
        story.duration * 0.35,
        story.duration,
        story.duration * 0.7,
        0,
        story.duration,
      ]
      for (const t of times) {
        seek.value = String(t)
        seek.dispatchEvent(new dom.window.Event('input'))
      }
      const final = state(story.duration)
      if (input === reviewSceneStory) {
        assert.equal(final.objects.find((o) => o.id === 'file')?.content, 'Welcome')
        assert.equal(final.objects.find((o) => o.id === 'bad')?.visible, false)
        assert.equal(state(0).objects.find((o) => o.id === 'file')?.content, 'Hello')
      } else {
        assert.equal(final.objects.find((o) => o.id === 'base')?.content, 'theme: grey')
        assert.equal(final.objects.find((o) => o.id === 'a')?.content, 'theme: blue')
        assert.equal(final.objects.find((o) => o.id === 'b')?.content, 'theme: coral')
        assert.equal(final.objects.find((o) => o.id === 'result')?.conflict, true)
        assert.deepEqual(final.objects.find((o) => o.id === 'result')?.choices, [
          'theme: blue',
          'theme: coral',
        ])
      }
      assert.deepEqual(errors, [], `${style}/${story.title}`)
      assert.equal(
        dom.window.document.querySelectorAll('#transcript li').length,
        input.scenes.length,
      )
      dom.window.close()
    }
  }
})

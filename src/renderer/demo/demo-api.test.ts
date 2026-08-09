import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@shared/types'
import type { DemoTrace } from '@shared/demo-traces.ts'
import { DEMO_SCENARIOS, type DemoScenario } from '@shared/demo-scenarios.ts'
import { createDemoApi } from './demo-api.ts'

const tracedScenario = DEMO_SCENARIOS.find((entry) => entry.trace !== undefined)

/** The renderer sends a JSON `AgentRunPayload`, not a bare string. */
function payload(text: string): string {
  return JSON.stringify({ content: text })
}

/** Emitted chunks for one run, once the run has gone quiet. */
async function runAndCollect(
  api: ReturnType<typeof createDemoApi>,
  text: string,
): Promise<StreamChunk[]> {
  const seen: StreamChunk[] = []
  const stop = api.agent.onChunk((_threadId, chunk) => seen.push(chunk))
  await api.agent.run('p', 't', payload(text))
  await new Promise((resolve) => setTimeout(resolve, 50))
  stop()
  return seen
}

/** A trace whose turn writes two new files, as a "build me a site" turn does. */
const EDIT_TRACE: DemoTrace = {
  id: 'edit',
  label: 'Writes two files',
  prompt: 'build me a cupcake site',
  steps: [
    {
      chunk: {
        type: 'tool_call',
        toolCall: {
          id: 'tc-1',
          name: 'write_file',
          args: { path: 'site/index.html', content: '<h1>Cupcakes</h1>\n' },
        },
      },
    },
    {
      chunk: {
        type: 'tool_call',
        toolCall: {
          id: 'tc-2',
          name: 'write_file',
          args: { path: 'site/styles.css', content: 'h1 {\n  color: pink;\n}\n' },
        },
      },
    },
    { chunk: { type: 'done', stopReason: 'end_turn' } },
  ],
}

/** The same file written and then amended, so the second diff has a base. */
const REWRITE_TRACE: DemoTrace = {
  id: 'rewrite',
  label: 'Writes then amends one file',
  prompt: 'rename the heading',
  steps: [
    {
      chunk: {
        type: 'tool_call',
        toolCall: {
          id: 'tc-1',
          name: 'write_file',
          args: { path: 'site/index.html', content: '<h1>Cupcakes</h1>\n' },
        },
      },
    },
    {
      chunk: {
        type: 'tool_call',
        toolCall: {
          id: 'tc-2',
          name: 'str_replace',
          args: { path: 'site/index.html', old_string: 'Cupcakes', new_string: 'Bakery' },
        },
      },
    },
    { chunk: { type: 'done', stopReason: 'end_turn' } },
  ],
}

function scenarioFor(id: string, trace: DemoTrace): DemoScenario {
  return {
    id,
    label: trace.label,
    project: { id: `demo-${id}-project`, path: '/demo/copse', name: 'copse-demo' },
    settings: {},
    threads: [],
    trace,
  }
}

const editScenario = scenarioFor('edit', EDIT_TRACE)
const rewriteScenario = scenarioFor('rewrite', REWRITE_TRACE)

describe('createDemoApi decisions surface', () => {
  it('exposes list/export stubs so ApiClient stays complete for the browser demo', async () => {
    const scenario = DEMO_SCENARIOS[0]
    assert.ok(scenario, 'expected at least one demo scenario')
    const api = createDemoApi(scenario)
    assert.deepEqual(await api.decisions.list(), [])
    assert.deepEqual(await api.decisions.export(), { path: '', count: 0 })
  })
})

describe('createDemoApi trace replay', () => {
  it('replays the recorded turn when its own prompt is sent', async () => {
    assert.ok(tracedScenario?.trace, 'expected a scenario carrying a trace')
    const api = createDemoApi(tracedScenario, { trace: { instant: true } })
    const seen = await runAndCollect(api, tracedScenario.trace.prompt)

    const recorded = new Set(tracedScenario.trace.steps.map((step) => step.chunk.type))
    for (const type of recorded) {
      assert.ok(
        seen.some((chunk) => chunk.type === type),
        `expected a '${type}' chunk from the replay`,
      )
    }
    assert.equal(seen.at(-1)?.type, 'done')
  })

  it('answers an off-script prompt with the stub instead of the recorded answer', async () => {
    assert.ok(tracedScenario?.trace, 'expected a scenario carrying a trace')
    const api = createDemoApi(tracedScenario, { trace: { instant: true } })
    const seen = await runAndCollect(api, 'something nobody recorded')

    const text = seen
      .filter((chunk) => chunk.type === 'text')
      .map((chunk) => chunk.text)
      .join('')
    assert.match(text, /^Demo response to:/)
    assert.doesNotMatch(text, /build output/)
  })

  it('pushes a replayed file edit down the real proposed-diff path', async () => {
    const api = createDemoApi(editScenario, { trace: { instant: true } })
    const shown: unknown[][] = []
    const queued: unknown[][] = []
    api.diff.onShowDiff((...args) => shown.push(args))
    api.diff.onQueued((...args) => queued.push(args))

    await runAndCollect(api, EDIT_TRACE.prompt)

    assert.deepEqual(shown, [
      ['demo-edit-project', 't', 'site/index.html', '', '<h1>Cupcakes</h1>\n', 'html'],
      ['demo-edit-project', 't', 'site/styles.css', '', 'h1 {\n  color: pink;\n}\n', 'css'],
    ])
    // The queue is cumulative: the pane drops a selection whose path has left it.
    assert.deepEqual(queued.at(-1)?.[2], [
      { path: 'site/index.html', language: 'html' },
      { path: 'site/styles.css', language: 'css' },
    ])
  })

  it('diffs a second edit against what the same turn already wrote', async () => {
    const api = createDemoApi(rewriteScenario, { trace: { instant: true } })
    const shown: unknown[][] = []
    api.diff.onShowDiff((...args) => shown.push(args))

    await runAndCollect(api, REWRITE_TRACE.prompt)

    // `str_replace` has no content of its own to show; without the turn's own
    // write as the base it would diff against an empty buffer and read as a
    // whole-file rewrite.
    assert.deepEqual(shown.at(-1)?.slice(3), ['<h1>Cupcakes</h1>\n', '<h1>Bakery</h1>\n', 'html'])
  })

  it('leaves the panel alone for a turn that only reads', async () => {
    assert.ok(tracedScenario?.trace, 'expected a scenario carrying a trace')
    const api = createDemoApi(tracedScenario, { trace: { instant: true } })
    let shown = 0
    api.diff.onShowDiff(() => (shown += 1))

    await runAndCollect(api, tracedScenario.trace.prompt)

    assert.equal(shown, 0)
  })

  it('lets the composer send at all — the checkout and branch stubs must resolve', async () => {
    assert.ok(tracedScenario)
    const api = createDemoApi(tracedScenario)
    // Both are called on the way to `agent.run`; rejecting either replaces the
    // answer with a retry error, and both silently dropped their leading
    // (projectId, threadId) arguments before this scenario ever sent anything.
    assert.equal((await api.git.branchStatus('p', 't')).currentBranch, 'main')
    assert.equal(
      (await api.agent.prepareCheckout('p', 't', 'hello', 'automatic')).checkoutMode,
      'shared',
    )
  })
})

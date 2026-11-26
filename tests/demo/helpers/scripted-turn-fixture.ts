import type { DemoScenario } from '@shared/demo-scenarios.ts'
import type { DemoTrace } from '@shared/demo-traces.ts'
import { OPEN_TODOS_PRE_REVIEW_NUDGE } from '@shared/todos/todo-logic.ts'
import { createDemoApi } from '../../../src/renderer/demo/demo-api.ts'
import { selectDemoScenario } from '../../../src/renderer/demo/scenarios.ts'
import { useAnnouncementCatalog } from '../../../src/renderer/announcement-catalog.ts'

// Replays one scripted turn through the demo API's ordinary chunk path, so the
// renderer's real transcript reducer folds it exactly as it would a live run.
// `?turn=` picks the chunk sequence; the spec submits the matching prompt.
// Each sequence is the one the main process emits for the state under test.

const READ_PLAN = (id: string): DemoTrace['steps'] => [
  {
    chunk: { type: 'tool_call', toolCall: { id, name: 'read_file', args: { path: 'PLAN.md' } } },
  },
  { chunk: { type: 'tool_result', toolCallId: id, result: '1. Ship it', isError: false } },
]

const TURNS: Record<string, { trace: DemoTrace; model?: string }> = {
  // The pre-review todo gate starts a machine turn inside the run, with no
  // `done` since the first answer (post-turn-orchestration.ts).
  continuation: {
    trace: {
      id: 'scripted-continuation',
      label: 'Continuation prompt inside a run',
      prompt: 'Finish the release checklist.',
      steps: [
        { chunk: { type: 'text', text: 'First answer.' } },
        {
          chunk: {
            type: 'machine_turn_start',
            content: OPEN_TODOS_PRE_REVIEW_NUDGE,
            origin: { kind: 'machine', operationId: 'post-turn-continuation' },
          },
        },
        { chunk: { type: 'text', text: 'Second answer.' } },
        { chunk: { type: 'done', stopReason: 'end_turn' } },
      ],
    },
  },
  // A step resumes the sentence a tool call interrupted, then the loop strips
  // the tool markup it recovered from that step's text only (`text_replace`).
  'resumed-sentence': {
    trace: {
      id: 'scripted-resumed-sentence',
      label: 'Step text rewrite after a resumed sentence',
      prompt: 'Read the plan twice.',
      steps: [
        { chunk: { type: 'text', text: 'Let me check the' } },
        ...READ_PLAN('read-1'),
        {
          chunk: {
            type: 'text',
            text: ' other file <tool_call>{"name":"read_file"}</tool_call>',
          },
        },
        { chunk: { type: 'text_replace', text: ' other file' } },
        ...READ_PLAN('read-2'),
        { chunk: { type: 'done', stopReason: 'end_turn' } },
      ],
    },
  },
  // A Claude Managed Agents stream that closes before `session.status_idle`:
  // the launch notice, the half-received reply, then the classified error
  // notice (`agentErrorNoticeText`, on a block of its own after that reply) and
  // the `done` that agent-service.ts sends for the thrown error.
  'managed-agent-stream-ended': {
    model: 'remote-agent:anthropic',
    trace: {
      id: 'scripted-managed-agent-stream-ended',
      label: 'Claude Agent stream ends mid-turn',
      prompt: 'Update the changelog on the remote sandbox.',
      steps: [
        {
          chunk: {
            type: 'text',
            text: '_Running on Claude Agent — work happens on a remote sandbox and lands on a branch / PR, not in this local workspace._\n\n',
          },
        },
        { chunk: { type: 'text', text: 'I am updating the changelog' } },
        {
          chunk: {
            type: 'text',
            text: '\n\n> [!CAUTION]\n> Claude Agent stream ended before the turn finished. The remote session may still be running.',
          },
        },
        { chunk: { type: 'done' } },
      ],
    },
  },
}

const turnName = new URLSearchParams(location.search).get('turn') ?? ''
const turn = Object.hasOwn(TURNS, turnName) ? TURNS[turnName] : undefined
if (!turn) throw new Error(`Unknown scripted turn: ${turnName}`)
const base = selectDemoScenario('?scenario=chat-reading-layout')
const [thread] = base.threads
if (!thread) throw new Error('Reading-layout thread missing')
const scenario: DemoScenario = {
  ...base,
  settings: { ...base.settings, ...(turn.model ? { model: turn.model } : {}) },
  threads: [
    {
      ...thread,
      title: turn.trace.label,
      messages: [],
      ...(turn.model ? { model: turn.model } : {}),
    },
  ],
  trace: turn.trace,
}
// This entry point is bundled only by the specs into a standalone test page.
useAnnouncementCatalog([])
window.api = createDemoApi(scenario, { trace: { instant: true } })
document.documentElement.dataset['demoScenario'] = scenario.id
void import('../../../src/renderer/main.ts').then(async (main) => {
  await main.rendererReady
})

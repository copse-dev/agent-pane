import type { DemoScenario } from '@shared/demo-scenarios.ts'
import type { DemoTrace } from '@shared/demo-traces.ts'
import { useAnnouncementCatalog } from '../../../src/renderer/announcement-catalog.ts'
import { createDemoApi } from '../../../src/renderer/demo/demo-api.ts'

// Synthetic protocol fixture, not a recorded agent run or a live backend. The
// unchanged renderer receives the same subagent chunks as run-subagent.ts emits.
// Nothing is seeded running: the spec submits the normal composer first.
const prompt = 'Check the live subagent tool layout.'
const summary = 'The focused sizing check completed.'
const trace: DemoTrace = {
  id: 'subagent-tool-sizing',
  label: 'Live subagent tool sizing fixture',
  prompt,
  steps: [
    {
      chunk: {
        type: 'tool_call',
        toolCall: {
          id: 'sizing-parent',
          name: 'task',
          args: { subagent_type: 'layout-checker', prompt },
        },
      },
    },
    {
      chunk: {
        type: 'subagent_start',
        parentToolCallId: 'sizing-parent',
        session: {
          id: 'sizing-session',
          kind: 'custom',
          agentName: 'layout-checker',
          status: 'running',
          prompt,
          summary: null,
          messages: [],
        },
      },
    },
    {
      chunk: {
        type: 'subagent_text',
        parentToolCallId: 'sizing-parent',
        messageId: 'sizing-child-message',
        text: 'Checking the focused renderer layout.',
      },
    },
    {
      chunk: {
        type: 'subagent_tool_call',
        parentToolCallId: 'sizing-parent',
        messageId: 'sizing-child-message',
        toolCall: {
          id: 'sizing-shell',
          name: 'run_shell',
          args: {
            command:
              'pnpm run test:demo -- --spec tests/demo/subagent-tool-sizing-with-a-deliberately-long-command-label.demo.ts',
          },
        },
      },
    },
    {
      // playTrace awaits this positive delay BEFORE it emits the result. All
      // other step delays are zero, so the first sleep is this exact boundary.
      delayMs: 1,
      chunk: {
        type: 'subagent_tool_result',
        parentToolCallId: 'sizing-parent',
        toolCallId: 'sizing-shell',
        result: 'Focused sizing check completed.',
        isError: false,
      },
    },
    { chunk: { type: 'subagent_done', parentToolCallId: 'sizing-parent', summary } },
    {
      chunk: {
        type: 'tool_result',
        toolCallId: 'sizing-parent',
        result: summary,
        isError: false,
      },
    },
    { chunk: { type: 'text', text: 'The subagent completed the layout check.' } },
    { chunk: { type: 'done', stopReason: 'end_turn' } },
  ],
}

const scenario: DemoScenario = {
  id: 'subagent-tool-sizing',
  label: 'Live subagent tool sizing fixture',
  project: { id: 'subagent-sizing-project', name: 'Copse', path: '/workspace' },
  threads: [],
  settings: { onboardingCompleted: true, theme: 'dark', uiTintStrength: 'off' },
  trace,
}

declare global {
  interface Window {
    subagentToolSizingFixture: {
      held: boolean
      released: boolean
      release: () => void
    }
  }
}

let releaseGate = (): void => {}
const gate = new Promise<void>((resolve) => {
  releaseGate = resolve
})
const checkpoint = {
  held: false,
  released: false,
  release: (): void => {
    checkpoint.released = true
    releaseGate()
  },
}
window.subagentToolSizingFixture = checkpoint
useAnnouncementCatalog([])
window.api = createDemoApi(scenario, {
  trace: {
    stepPauseMs: 0,
    // Child shell phases are not forwarded by the current subagent wire path.
    // Do not manufacture a commandPhase badge in this fixture.
    sleep: async (ms) => {
      if (!checkpoint.released) {
        checkpoint.held = true
        await gate
        checkpoint.held = false
      }
      await new Promise<void>((resolve) => setTimeout(resolve, ms))
    },
  },
})
document.documentElement.dataset['demoScenario'] = scenario.id
void import('../../../src/renderer/main.ts').then(async (main) => {
  await main.rendererReady
})

import type { DemoScenario } from './demo-scenarios.ts'

const CREATED_AT = Date.UTC(2026, 9, 11, 9)
const MODEL = 'claude-opus-5-5'
const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/greeting.ts',
  '-hello',
  '+hello, world',
  '*** Add File: src/farewell.ts',
  '+goodbye',
  '*** End Patch',
].join('\n')

// Authored ACP UI fixtures: wrapped identities and no meaningful ACP kind.
export const BRIDGED_TOOL_SCENARIOS: readonly DemoScenario[] = [
  {
    id: 'bridged-tools',
    label: 'Patch file links and command output',
    project: { id: 'demo-bridge-project', name: 'Bridge tools', path: '/demo/bridge' },
    settings: { onboardingCompleted: true, theme: 'dark', uiTintStrength: 'off', model: MODEL },
    threads: [
      {
        id: 'demo-bridge-thread',
        title: 'Update greetings',
        status: 'idle',
        model: MODEL,
        messages: [
          {
            id: 'bridge-user',
            role: 'user',
            content: 'Update the greetings.',
            toolCalls: [],
            createdAt: CREATED_AT,
          },
          {
            id: 'bridge-patch',
            role: 'assistant',
            content: 'Updated both greetings.',
            createdAt: CREATED_AT,
            toolCalls: [
              {
                id: 'bridge-patch-call',
                name: 'copse.apply_patch',
                args: { input: PATCH },
                status: 'done',
                result: 'Patched two files.',
              },
            ],
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ],
    trace: {
      id: 'bridge-shell-trace',
      label: 'Run greeting tests',
      prompt: 'Run the greeting tests.',
      steps: [
        {
          chunk: {
            type: 'tool_call',
            toolCall: {
              id: 'bridge-shell',
              name: 'Run greeting tests',
              programmaticName: 'mcp__copse__run_shell',
              args: { command: 'pnpm test greetings' },
            },
          },
        },
        {
          chunk: {
            type: 'tool_result',
            toolCallId: 'bridge-shell',
            result: '2 greeting tests passed.',
            isError: false,
          },
        },
        { chunk: { type: 'text', text: 'Both greeting tests passed.' } },
        { chunk: { type: 'done', stopReason: 'end_turn' } },
      ],
    },
  },
  {
    id: 'bridged-tools-concise',
    label: 'Running command in concise view',
    project: { id: 'demo-bridge-concise-project', name: 'Bridge tools', path: '/demo/bridge' },
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
      model: MODEL,
      conciseThreadsEnabled: true,
    },
    threads: [
      {
        id: 'demo-bridge-concise-thread',
        title: 'Test greetings',
        status: 'running',
        model: MODEL,
        messages: [
          {
            id: 'bridge-concise-user',
            role: 'user',
            content: 'Run the greeting tests.',
            toolCalls: [],
            createdAt: CREATED_AT,
          },
          {
            id: 'bridge-concise-shell',
            role: 'assistant',
            content: '',
            model: MODEL,
            createdAt: CREATED_AT,
            toolCalls: [
              {
                id: 'bridge-running-shell',
                name: 'copse-run_shell: Test greetings',
                args: { command: 'pnpm test greetings' },
                status: 'running',
                result: null,
              },
            ],
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ],
  },
]

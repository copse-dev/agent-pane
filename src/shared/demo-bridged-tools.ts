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
    id: 'bridged-thread-proposals',
    label: 'Two proposed follow-up threads',
    project: { id: 'demo-proposals-project', name: 'Follow-up work', path: '/demo/proposals' },
    settings: { onboardingCompleted: true, theme: 'dark', uiTintStrength: 'off', model: MODEL },
    threads: [
      {
        id: 'demo-proposals-thread',
        title: 'Settings follow-up',
        status: 'idle',
        model: MODEL,
        messages: [
          {
            id: 'proposals-user',
            role: 'user',
            content: 'Propose separate threads for these two settings fixes.',
            toolCalls: [],
            createdAt: CREATED_AT,
          },
          {
            id: 'proposals-assistant',
            role: 'assistant',
            content: 'Here are the two proposed threads.',
            createdAt: CREATED_AT,
            toolCalls: [
              {
                id: 'proposal-read-1',
                name: 'read_file',
                args: { path: 'settings.ts' },
                status: 'done',
                result: 'Read settings.',
              },
              {
                id: 'proposal-read-2',
                name: 'read_file',
                args: { path: 'agents.ts' },
                status: 'done',
                result: 'Read agents.',
              },
              ...[
                {
                  title: 'Fix Codex readiness detection',
                  summary: 'Show the correct sign-in status and verify refresh behavior.',
                },
                {
                  title: 'Finish the combined Models & agents list',
                  summary:
                    'Bring coding agents, API keys and model servers into one settings list.',
                },
              ].map((proposal, index) => ({
                id: `wrapped-proposal-${String(index)}`,
                name: 'mcp.copse.propose_thread',
                title: 'mcp.copse.propose_thread',
                kind: 'execute',
                args: {
                  server: 'copse',
                  tool: 'propose_thread',
                  arguments: { ...proposal, prompt: `${proposal.title}. Add focused tests.` },
                },
                status: 'done' as const,
                result: 'Offered to the user.',
              })),
            ],
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ],
  },
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

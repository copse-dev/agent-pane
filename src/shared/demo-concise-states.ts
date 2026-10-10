import type { Project, Thread } from './types/index.ts'
import type { DemoScenario } from './demo-scenarios.ts'
import { ACP_CANCELLED_TOOL_CALL_RESULT } from './tools/tool-interruption.ts'

/**
 * Fixtures for the concise thread view in each state a thread can be in: the
 * visual specs in `tests/demo/concise-thread-states.demo.ts` open one per state.
 * They are authored states, not recordings of turns that happened.
 */

// A stand-in browser capture for the concise-thread scenarios: the screenshot a
// tool returned is the "work output" that view keeps on screen.
export const CONCISE_SCREENSHOT = `data:image/svg+xml;base64,${btoa(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">',
    '<rect width="480" height="270" fill="#f4f1ea"/>',
    '<rect width="480" height="36" fill="#2f3a2f"/>',
    '<text x="16" y="23" font-family="sans-serif" font-size="14" fill="#fff">Settings</text>',
    '<rect x="16" y="56" width="200" height="14" rx="3" fill="#c9c2b3"/>',
    '<rect x="16" y="84" width="448" height="44" rx="6" fill="#fff" stroke="#d8d2c4"/>',
    '<rect x="16" y="140" width="448" height="44" rx="6" fill="#fff" stroke="#d8d2c4"/>',
    '<rect x="384" y="210" width="80" height="32" rx="6" fill="#4f7a4f"/>',
    '<text x="405" y="231" font-family="sans-serif" font-size="13" fill="#fff">Save</text>',
    '</svg>',
  ].join(''),
)}`

const TIME = Date.UTC(2026, 6, 17, 9, 0, 0)
/** Above the concise gate; the same transcript renders in full for `MODEST`. */
const CAPABLE = 'claude-opus-5-5'
const MODEST = 'claude-haiku-4-5'

type Message = Thread['messages'][number]
type ToolCall = Message['toolCalls'][number]

const PROJECT: Project = {
  id: 'demo-concise-states-project',
  name: 'copse-demo',
  path: '/demo/copse',
}

let clock = 0
const user = (id: string, content: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: 'user',
  content,
  toolCalls: [],
  createdAt: TIME + ++clock * 1_000,
  ...extra,
})
const assistant = (
  id: string,
  content: string,
  toolCalls: ToolCall[] = [],
  extra: Partial<Message> = {},
): Message => ({
  id,
  role: 'assistant',
  model: CAPABLE,
  content,
  toolCalls,
  createdAt: TIME + ++clock * 1_000,
  ...extra,
})

const read = (id: string, path = 'src/renderer/views/settings-dialog.ts'): ToolCall => ({
  id,
  name: 'read_file',
  args: { path },
  status: 'done',
  result: 'export function mountSettings() { … }',
})
const edit = (id: string): ToolCall => ({
  id,
  name: 'str_replace',
  args: { path: 'src/renderer/styles/settings.css' },
  status: 'done',
  result: 'Replaced 1 occurrence.',
  editStats: { additions: 4, deletions: 2 },
})
const shell = (
  id: string,
  command: string,
  status: ToolCall['status'] = 'done',
  result: string | null = 'ℹ pass 12',
): ToolCall => ({ id, name: 'run_shell', args: { command }, status, result })

const outcome = (
  status: 'completed' | 'failed' | 'cancelled',
  extra: Partial<NonNullable<Message['turnOutcome']>> = {},
): NonNullable<Message['turnOutcome']> => ({
  status,
  stopReason: status === 'failed' ? 'error' : status === 'cancelled' ? 'cancelled' : 'end_turn',
  source: status === 'cancelled' ? 'user' : 'provider',
  executor: 'local',
  provider: 'anthropic',
  model: CAPABLE,
  endedAt: TIME + 60_000,
  ...extra,
})

function scenario(
  id: string,
  label: string,
  messages: Message[],
  { status = 'idle', ...extra }: Partial<DemoScenario> & { status?: Thread['status'] } = {},
): DemoScenario {
  return {
    id: `concise-state-${id}`,
    label,
    project: PROJECT,
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
      model: CAPABLE,
      conciseThreadsEnabled: true,
    },
    threads: [
      {
        id: `demo-concise-state-${id}`,
        title: 'Concise thread view',
        status,
        model: CAPABLE,
        messages,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: TIME,
        updatedAt: TIME,
      },
    ],
    ...extra,
  }
}

/** A long command transcript: more lines than any card should paint at once. */
const LONG_OUTPUT = Array.from(
  { length: 400 },
  (_, i) =>
    `ℹ test ${String(i + 1).padStart(3, '0')} › settings form keeps Save pinned (${String(i % 9)}ms)`,
).join('\n')

const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/renderer/styles/settings.css',
  '@@',
  '-.settings-footer { position: absolute; bottom: 0; }',
  '+.settings-footer { display: grid; align-items: end; }',
  '*** End Patch',
].join('\n')

const THREAD_ID = (id: string): string => `demo-concise-state-${id}`

export const CONCISE_STATE_SCENARIOS: readonly DemoScenario[] = [
  scenario('stopped', 'A turn the user stopped partway', [
    user('stopped-user', 'Fix the settings form so Save stays aligned on narrow windows.'),
    assistant(
      'stopped-work',
      '',
      [
        read('stopped-read'),
        shell(
          'stopped-test',
          'pnpm test -- settings-forms',
          'error',
          ACP_CANCELLED_TOOL_CALL_RESULT,
        ),
      ],
      { turnOutcome: outcome('cancelled', { userAbort: 'stop' }) },
    ),
  ]),
  scenario('interrupted-by-message', 'A turn cut off by a new message, then answered', [
    user('cut-user', 'Fix the settings form so Save stays aligned on narrow windows.'),
    assistant(
      'cut-work',
      '',
      [shell('cut-test', 'pnpm test -- settings-forms', 'error', ACP_CANCELLED_TOOL_CALL_RESULT)],
      { turnOutcome: outcome('cancelled', { userAbort: 'send_now' }) },
    ),
    user('cut-next', 'Actually, leave the tests alone and only change the CSS.'),
    assistant('cut-edit', 'Editing the stylesheet.', [edit('cut-edit-call')]),
    assistant('cut-done', 'Save is pinned with a grid footer; no test files were touched.', [], {
      turnOutcome: outcome('completed'),
    }),
  ]),
  // No `conciseThreadsEnabled` stored at all: a profile that never touched the setting.
  scenario(
    'default-on',
    'A capable model’s turn on a profile with no stored setting',
    [
      user('default-user', 'Fix the settings form so Save stays aligned on narrow windows.'),
      assistant('default-work', 'Reading the form.', [read('default-read'), edit('default-edit')]),
      assistant('default-done', 'Save now stays pinned at every width.', [], {
        turnOutcome: outcome('completed'),
      }),
    ],
    {
      settings: { onboardingCompleted: true, theme: 'dark', uiTintStrength: 'off', model: CAPABLE },
    },
  ),
  scenario('failed', 'A turn that failed partway', [
    user('failed-user', 'Fix the settings form so Save stays aligned on narrow windows.'),
    assistant(
      'failed-work',
      'I read the form and found the footer, then the provider stopped responding.',
      [read('failed-read'), edit('failed-edit')],
      {
        turnOutcome: outcome('failed', {
          error: { message: 'The model provider is overloaded (529). Try again in a moment.' },
        }),
      },
    ),
  ]),
  scenario(
    'approval',
    'A running turn waiting for permission',
    [
      user('approval-user', 'Install the dependencies and run the settings tests.'),
      assistant('approval-work', 'Installing first.', [
        read('approval-read', 'package.json'),
        shell('approval-install', 'pnpm install', 'running', null),
      ]),
    ],
    {
      status: 'running',
      approvalRequests: [
        {
          id: 'concise-state-approval-request',
          threadId: THREAD_ID('approval'),
          title: 'Run outside sandbox?',
          body: 'pnpm install',
          bodyAdvice:
            'The project sandbox would block this command:\n• Installs or updates packages, which downloads and runs code from the internet',
          bodyFooter: 'Allow running it once outside the sandbox?',
          type: 'shell',
        },
      ],
    },
  ),
  scenario(
    'question',
    'A running turn waiting for an answer',
    [
      user('question-user', 'Bump the schema.'),
      assistant('question-work', 'Reading the migrations.', [
        read('question-read', 'db/migrations/0042.sql'),
        {
          id: 'question-ask',
          name: 'ask_user',
          args: { questions: [{ question: 'Which migration order should the schema bump use?' }] },
          status: 'running',
          result: null,
        },
      ]),
    ],
    {
      status: 'running',
      askUserRequests: [
        {
          id: 'concise-state-question-request',
          threadId: THREAD_ID('question'),
          questions: [
            {
              question: 'Which migration order should the schema bump use?',
              options: ['Columns first', 'Backfill first'],
            },
          ],
        },
      ],
    },
  ),
  scenario('subagent', 'A finished turn that used subagents', [
    user('subagent-user', 'Find where the footer is laid out and review the auth changes.'),
    assistant('subagent-work', 'Delegating the search.', [
      {
        id: 'subagent-explore',
        name: 'explore',
        args: { query: 'Find the settings footer' },
        status: 'done',
        result: 'The footer lives in settings.css.',
        subagent: {
          id: 'subagent-explore-session',
          kind: 'explore',
          status: 'done',
          prompt: 'Find the settings footer',
          summary: 'The footer lives in settings.css.',
          messages: [
            {
              id: 'subagent-explore-1',
              role: 'assistant',
              content: 'Reading **settings.css**.',
              toolCalls: [read('subagent-inner-read', 'src/renderer/styles/settings.css')],
            },
          ],
        },
      },
    ]),
    assistant(
      'subagent-done',
      'The footer is an absolutely positioned row in `settings.css`.',
      [],
      {
        turnOutcome: outcome('completed'),
      },
    ),
  ]),
  scenario(
    'subagent-running',
    'A running turn with a subagent at work',
    [
      user('subagent-live-user', 'Find where the footer is laid out.'),
      assistant('subagent-live-work', 'Delegating the search.', [
        {
          id: 'subagent-live-explore',
          name: 'explore',
          args: { query: 'Find the settings footer' },
          status: 'running',
          result: null,
          subagent: {
            id: 'subagent-live-session',
            kind: 'explore',
            status: 'running',
            prompt: 'Find the settings footer',
            summary: null,
            messages: [],
          },
        },
      ]),
    ],
    { status: 'running' },
  ),
  scenario('long-output', 'A finished turn with long output, an edit and a patch', [
    user('long-user', 'Move the footer to a grid and run the whole settings suite.'),
    assistant('long-work', 'Applying the change, then running every test.', [
      edit('long-edit'),
      {
        id: 'long-patch',
        name: 'apply_patch',
        args: { input: PATCH },
        status: 'done',
        result: 'Applied.',
        editStats: { additions: 1, deletions: 1 },
      },
      shell('long-suite', 'pnpm test -- settings', 'done', LONG_OUTPUT),
    ]),
    assistant('long-done', 'All 400 settings tests pass with the grid footer.', [], {
      turnOutcome: outcome('completed'),
    }),
  ]),
  scenario('terminal', 'A finished turn from an agent that ran a terminal', [
    user('terminal-user', 'Run the settings tests.'),
    assistant('terminal-work', 'Running them in a terminal.', [
      {
        id: 'terminal-call',
        name: 'run_shell',
        title: 'pnpm test -- settings',
        kind: 'execute',
        args: { command: 'pnpm test -- settings' },
        status: 'done',
        result: 'ℹ pass 12',
        content: [{ type: 'terminal', terminalId: 'demo-terminal-1' }],
      },
    ]),
    assistant('terminal-done', 'The settings tests pass.', [], {
      turnOutcome: outcome('completed'),
    }),
  ]),
  scenario('attachments', 'A prompt with attachments, answered concisely', [
    user('attach-user', 'Match the footer in this screenshot, using the notes and the spec.', {
      images: [CONCISE_SCREENSHOT],
      attachments: [
        { kind: 'file', label: 'settings.css' },
        {
          kind: 'paste',
          label: 'Pasted text · 42 lines',
          content: 'footer {\n  position: absolute;\n}',
        },
      ],
    }),
    assistant('attach-work', 'Comparing the footer with the screenshot.', [
      read('attach-read', 'src/renderer/styles/settings.css'),
      edit('attach-edit'),
    ]),
    assistant('attach-done', 'The footer now matches your screenshot.', [], {
      turnOutcome: outcome('completed'),
    }),
  ]),
  scenario('resumed', 'An old thread resumed with a capable model', [
    user('old-user', 'What does the settings footer do?'),
    {
      id: 'old-work',
      role: 'assistant',
      content: 'Let me look at the footer first.',
      toolCalls: [read('old-read')],
      createdAt: TIME + ++clock * 1_000,
    },
    {
      id: 'old-done',
      role: 'assistant',
      content: 'It pins Save to the bottom of the dialog.',
      toolCalls: [],
      createdAt: TIME + ++clock * 1_000,
    },
    user('new-user', 'Make it a grid so it stays aligned.'),
    assistant('new-work', 'Rewriting the footer.', [edit('new-edit')]),
    assistant('new-done', 'The footer is a grid now.', [], { turnOutcome: outcome('completed') }),
  ]),
  scenario('model-switch', 'A thread that switches models between turns', [
    user('switch-user-1', 'Find the footer rule.'),
    assistant('switch-work-1', 'Searching the styles.', [read('switch-read-1')]),
    assistant('switch-done-1', 'It is in `settings.css`.', [], {
      turnOutcome: outcome('completed'),
    }),
    user('switch-user-2', 'Now change it.'),
    assistant('switch-work-2', 'Editing the rule.', [edit('switch-edit-2')], { model: MODEST }),
    assistant('switch-done-2', 'Changed to a grid.', [], {
      model: MODEST,
      turnOutcome: outcome('completed', { model: MODEST }),
    }),
    user('switch-user-3', 'Run the tests.'),
    assistant('switch-work-3', 'Running them.', [
      shell('switch-test-3', 'pnpm test -- settings-forms'),
    ]),
    assistant('switch-done-3', 'All settings tests pass.', [], {
      turnOutcome: outcome('completed'),
    }),
  ]),
]

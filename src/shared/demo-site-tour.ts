import type { Project, Thread } from './types/index.ts'
import type { McpServerStatus } from './types/mcp.ts'
import type { ToolPermissionCatalog } from './types/tool-permissions.ts'
import type { DemoScenario } from './demo-scenarios.ts'

/**
 * Fixtures behind the copse.dev feature tour and spotlight cards.
 *
 * Every scenario opens the same project the hero walkthrough builds — Crumb &
 * Bloom, a cupcake studio's coming-soon site — so the site's screenshots read as
 * one person's workspace rather than a set of test fixtures. They are authored
 * states for screenshots, not recordings of turns that happened: nothing here
 * claims an agent read or changed these files.
 */

const SITE_TOUR_TIME = Date.UTC(2026, 8, 14, 10, 30, 0)
const SITE_TOUR_MODEL = 'claude-opus-5-5'

const CRUMB_AND_BLOOM: Project = {
  id: 'demo-crumb-and-bloom',
  name: 'Crumb & Bloom',
  path: '/demo/crumb-and-bloom',
}

const SITE_TOUR_SETTINGS = {
  onboardingCompleted: true,
  theme: 'dark',
  uiTintStrength: 'off',
  model: SITE_TOUR_MODEL,
} as const

/** Earlier threads in the same project, so the sidebar reads as real history. */
function earlierThreads(minutesAgo: number): Thread[] {
  return [
    {
      id: 'demo-site-tour-coming-soon',
      title: 'Crumb & Bloom coming soon',
      status: 'idle',
      gitBranch: 'main',
      model: SITE_TOUR_MODEL,
      messages: [
        {
          id: 'demo-site-tour-coming-soon-user',
          role: 'user',
          content:
            'Build a polished coming-soon site for Crumb & Bloom, a playful premium cupcake studio.',
          toolCalls: [],
          createdAt: SITE_TOUR_TIME - (minutesAgo + 240) * 60_000,
        },
        {
          id: 'demo-site-tour-coming-soon-assistant',
          role: 'assistant',
          content: 'Built the coming-soon page in `index.html`, `styles.css`, and `script.js`.',
          toolCalls: [],
          createdAt: SITE_TOUR_TIME - (minutesAgo + 236) * 60_000,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: SITE_TOUR_TIME - (minutesAgo + 240) * 60_000,
      updatedAt: SITE_TOUR_TIME - (minutesAgo + 236) * 60_000,
    },
    {
      id: 'demo-site-tour-menu-photos',
      title: 'Compress the menu photos',
      status: 'idle',
      gitBranch: 'main',
      model: SITE_TOUR_MODEL,
      messages: [
        {
          id: 'demo-site-tour-menu-photos-user',
          role: 'user',
          content: 'The menu photos are slow on mobile. Can you compress them?',
          toolCalls: [],
          createdAt: SITE_TOUR_TIME - (minutesAgo + 90) * 60_000,
        },
        {
          id: 'demo-site-tour-menu-photos-assistant',
          role: 'assistant',
          content: 'Converted the six menu photos to WebP and added `loading="lazy"`.',
          toolCalls: [],
          createdAt: SITE_TOUR_TIME - (minutesAgo + 86) * 60_000,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: SITE_TOUR_TIME - (minutesAgo + 90) * 60_000,
      updatedAt: SITE_TOUR_TIME - (minutesAgo + 86) * 60_000,
    },
  ]
}

function siteTourScenario(
  id: string,
  label: string,
  thread: Thread,
  extra: Partial<DemoScenario> = {},
): DemoScenario {
  return {
    id,
    label,
    project: CRUMB_AND_BLOOM,
    settings: SITE_TOUR_SETTINGS,
    threads: [thread, ...earlierThreads(30)],
    ...extra,
  }
}

const SITE_TOUR_GITHUB_MCP: McpServerStatus = {
  name: 'github',
  transport: 'http',
  state: 'connected',
  toolCount: 5,
  tools: [
    'search_issues',
    'get_pull_request',
    'create_issue',
    'add_issue_comment',
    'merge_pull_request',
  ],
  source: '/demo/crumb-and-bloom/.mcp.json',
  origin: 'project',
  originDetail: '.mcp.json',
  userEnabled: true,
  configDisabled: false,
}

const SITE_TOUR_TOOL_PERMISSIONS: ToolPermissionCatalog = {
  groups: [
    {
      id: 'copse',
      name: 'Copse tools',
      kind: 'copse',
      tools: [
        {
          id: 'copse:read-file',
          executionName: 'read_file',
          name: 'Read file',
          description: 'Read a file in the active project.',
          policy: 'allow',
          defaultPolicy: 'allow',
          overridden: false,
        },
        {
          id: 'copse:run-shell',
          executionName: 'run_shell',
          name: 'Run shell command',
          description: 'Run a command in the project sandbox.',
          policy: 'ask',
          defaultPolicy: 'ask',
          overridden: false,
        },
      ],
    },
    {
      id: 'mcp:project:github',
      name: 'github',
      kind: 'mcp',
      origin: 'project',
      originDetail: '/demo/crumb-and-bloom/.mcp.json',
      status: 'connected',
      tools: [
        {
          id: 'mcp:project:github:search-issues',
          executionName: 'mcp__github__search_issues',
          name: 'Search issues',
          description: 'Search issues and pull requests in a repository.',
          policy: 'allow',
          defaultPolicy: 'ask',
          overridden: true,
        },
        {
          id: 'mcp:project:github:get-pull-request',
          executionName: 'mcp__github__get_pull_request',
          name: 'Get pull request',
          description: 'Read a pull request, its diff, and its review comments.',
          policy: 'allow',
          defaultPolicy: 'ask',
          overridden: true,
        },
        {
          id: 'mcp:project:github:create-issue',
          executionName: 'mcp__github__create_issue',
          name: 'Create issue',
          description: 'Open a new issue in a repository.',
          policy: 'ask',
          defaultPolicy: 'ask',
          overridden: false,
        },
        {
          id: 'mcp:project:github:add-issue-comment',
          executionName: 'mcp__github__add_issue_comment',
          name: 'Add issue comment',
          description: 'Comment on an issue or pull request.',
          policy: 'ask',
          defaultPolicy: 'ask',
          overridden: false,
        },
        {
          id: 'mcp:project:github:merge-pull-request',
          executionName: 'mcp__github__merge_pull_request',
          name: 'Merge pull request',
          description: 'Merge a pull request into its base branch.',
          policy: 'block',
          defaultPolicy: 'ask',
          overridden: true,
        },
      ],
    },
  ],
}

const SEASONAL_PR_BODY = [
  'Adds a seasonal flavours section below the hero.',
  '',
  '- Reads the current menu from `flavours.json`, so the bakery can swap flavours without touching markup',
  '- Pauses the flavour ticker for visitors who prefer reduced motion',
  '- Keeps the section to a single column on narrow screens',
].join('\n')

const SIGNUP_THREAD: Thread = {
  id: 'demo-site-tour-signup',
  title: 'Send signups to the newsletter',
  status: 'idle',
  gitBranch: 'main',
  model: SITE_TOUR_MODEL,
  messages: [
    {
      id: 'demo-site-tour-signup-user-1',
      role: 'user',
      content: 'Where does the email signup get handled?',
      toolCalls: [],
      createdAt: SITE_TOUR_TIME - 4 * 60_000,
    },
    {
      id: 'demo-site-tour-signup-assistant-1',
      role: 'assistant',
      content:
        'In `script.js`: the form’s submit handler checks the address, then shows the confirmation note under the form. Nothing is sent anywhere yet, so the address only lives in the page.',
      toolCalls: [],
      createdAt: SITE_TOUR_TIME - 3 * 60_000,
    },
    {
      id: 'demo-site-tour-signup-user-2',
      role: 'user',
      content: 'Send new signups to the newsletter list instead of only showing the note.',
      toolCalls: [],
      createdAt: SITE_TOUR_TIME - 2 * 60_000,
    },
    {
      id: 'demo-site-tour-signup-assistant-2',
      role: 'assistant',
      content:
        'The submit handler now posts the address to the newsletter endpoint and only shows the confirmation note once the request succeeds. A failed request keeps what the visitor typed and offers to try again.',
      toolCalls: [],
      createdAt: SITE_TOUR_TIME - 60_000,
    },
  ],
  usage: { inputTokens: 0, outputTokens: 0 },
  createdAt: SITE_TOUR_TIME - 4 * 60_000,
  updatedAt: SITE_TOUR_TIME - 60_000,
}

export const SITE_TOUR_SCENARIOS: readonly DemoScenario[] = [
  siteTourScenario('site-fork-resend', 'Copse.dev tour: fork and resend a prompt', SIGNUP_THREAD, {
    // The site the thread is about, open in the Browser pane beside it.
    staticSite: 'sites/cupcakes',
    settings: {
      ...SITE_TOUR_SETTINGS,
      layout: { projectsPaneWidth: 240, filesPaneWidth: 560 },
    },
  }),
  siteTourScenario('site-subagent', 'Copse.dev tour: an expanded subagent', {
    id: 'demo-site-tour-accessibility',
    title: 'Accessibility audit',
    status: 'idle',
    gitBranch: 'main',
    model: SITE_TOUR_MODEL,
    messages: [
      {
        id: 'demo-site-tour-accessibility-user',
        role: 'user',
        content: 'Check the coming-soon page for accessibility problems before we launch.',
        toolCalls: [],
        createdAt: SITE_TOUR_TIME - 3 * 60_000,
      },
      {
        id: 'demo-site-tour-accessibility-assistant',
        role: 'assistant',
        content: 'I asked an explore agent to audit the markup and styles.',
        toolCalls: [
          {
            id: 'demo-site-tour-accessibility-explore',
            name: 'explore',
            args: { query: 'Audit index.html and styles.css for accessibility gaps' },
            status: 'done',
            result:
              'Two gaps: the flavour ticker ignores reduced motion, and the signup field has no visible label.',
            subagent: {
              id: 'demo-site-tour-accessibility-session',
              kind: 'explore',
              status: 'done',
              prompt: 'Audit index.html and styles.css for accessibility gaps',
              summary:
                'Two gaps: the flavour ticker ignores reduced motion, and the signup field has no visible label.',
              model: SITE_TOUR_MODEL,
              messages: [
                {
                  id: 'demo-site-tour-accessibility-explore-1',
                  role: 'assistant',
                  content: 'Reading the page structure and the stylesheet.',
                  toolCalls: [
                    {
                      id: 'demo-site-tour-accessibility-read-html',
                      name: 'read_file',
                      args: { path: 'index.html' },
                      status: 'done',
                      result: '<!doctype html>\n',
                    },
                    {
                      id: 'demo-site-tour-accessibility-read-css',
                      name: 'read_file',
                      args: { path: 'styles.css' },
                      status: 'done',
                      result: ':root {\n',
                    },
                  ],
                },
                {
                  id: 'demo-site-tour-accessibility-explore-2',
                  role: 'assistant',
                  content: 'Checking whether the ticker animation respects **reduced motion**.',
                  toolCalls: [
                    {
                      id: 'demo-site-tour-accessibility-grep',
                      name: 'grep_search',
                      args: { pattern: 'prefers-reduced-motion' },
                      status: 'done',
                      result: 'No matches.',
                    },
                  ],
                },
                {
                  id: 'demo-site-tour-accessibility-explore-3',
                  role: 'assistant',
                  content:
                    'Two gaps: the flavour ticker ignores reduced motion, and the signup field has no visible label.',
                  toolCalls: [],
                },
              ],
            },
          },
        ],
        createdAt: SITE_TOUR_TIME - 2 * 60_000,
      },
      {
        id: 'demo-site-tour-accessibility-findings',
        role: 'assistant',
        content: [
          'Two things to fix before launch:',
          '',
          '- The flavour ticker keeps scrolling for visitors who prefer reduced motion.',
          '- The signup field relies on its placeholder, so it has no visible label.',
          '',
          'Want me to fix both?',
        ].join('\n'),
        toolCalls: [],
        createdAt: SITE_TOUR_TIME - 60_000,
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: SITE_TOUR_TIME - 3 * 60_000,
    updatedAt: SITE_TOUR_TIME - 60_000,
  }),
  siteTourScenario('site-archive-attachment', 'Copse.dev tour: attach a zip archive', {
    // Empty: the spec drops the archive into this thread's composer.
    id: 'demo-site-tour-brand-kit',
    title: 'Swap in the new brand kit',
    status: 'idle',
    gitBranch: 'main',
    model: SITE_TOUR_MODEL,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: SITE_TOUR_TIME,
    updatedAt: SITE_TOUR_TIME,
  }),
  // Settings opens over the same conversation the fork shot uses.
  siteTourScenario('site-providers', 'Copse.dev tour: provider settings', SIGNUP_THREAD),
  siteTourScenario(
    'site-create-pr',
    'Copse.dev tour: create a pull request',
    {
      id: 'demo-site-tour-seasonal',
      title: 'Add seasonal flavours',
      status: 'idle',
      gitBranch: 'seasonal-flavours',
      model: SITE_TOUR_MODEL,
      messages: [
        {
          id: 'demo-site-tour-seasonal-user',
          role: 'user',
          content:
            'Add a seasonal flavours section under the hero that reads from flavours.json, and make sure the ticker respects reduced motion.',
          toolCalls: [],
          createdAt: SITE_TOUR_TIME - 3 * 60_000,
        },
        {
          id: 'demo-site-tour-seasonal-assistant',
          role: 'assistant',
          content:
            'Added the seasonal flavours section and committed it on `seasonal-flavours`. The ticker now pauses for visitors who prefer reduced motion.',
          toolCalls: [],
          createdAt: SITE_TOUR_TIME - 60_000,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: SITE_TOUR_TIME - 3 * 60_000,
      updatedAt: SITE_TOUR_TIME - 60_000,
    },
    {
      changeStats: { additions: 86, deletions: 12 },
      followUps: [
        { id: 'create-pr', label: 'Create PR', action: 'create-pr' },
        { id: 'review', label: 'Review changes', action: 'review' },
      ],
      prBody: SEASONAL_PR_BODY,
    },
  ),
  siteTourScenario(
    'site-mcp-permissions',
    'Copse.dev tour: per-tool MCP permissions',
    {
      id: 'demo-site-tour-triage',
      title: 'Triage launch issues',
      status: 'idle',
      gitBranch: 'main',
      model: SITE_TOUR_MODEL,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: SITE_TOUR_TIME,
      updatedAt: SITE_TOUR_TIME,
    },
    {
      mcpServers: [SITE_TOUR_GITHUB_MCP],
      toolPermissions: SITE_TOUR_TOOL_PERMISSIONS,
    },
  ),
]

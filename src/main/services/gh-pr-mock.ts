import type {
  GhCliStatus,
  GhPrChecksState,
  GhPrDetails,
  GhPrFileDiff,
  GhPrSummary,
} from '@shared/types/git.ts'

export const MOCK_GH_PR_OWNER = 'copse-dev'
export const MOCK_GH_PR_REPO = 'copse-panel'
export const MOCK_GH_PR_NUMBER = 42
export const MOCK_GH_PR_URL = `https://github.com/${MOCK_GH_PR_OWNER}/${MOCK_GH_PR_REPO}/pull/${MOCK_GH_PR_NUMBER}`

const MOCK_LINKED_PR: GhPrSummary = {
  owner: MOCK_GH_PR_OWNER,
  repo: MOCK_GH_PR_REPO,
  number: MOCK_GH_PR_NUMBER,
  title: 'Add GitHub PR panel tab',
  url: MOCK_GH_PR_URL,
  state: 'OPEN',
  headRefName: 'feature/pr-panel',
  authorLogin: 'mock-user',
}

const MOCK_OTHER_PR: GhPrSummary = {
  owner: MOCK_GH_PR_OWNER,
  repo: MOCK_GH_PR_REPO,
  number: 17,
  title: 'Polish footer branch status',
  url: `https://github.com/${MOCK_GH_PR_OWNER}/${MOCK_GH_PR_REPO}/pull/17`,
  state: 'OPEN',
  headRefName: 'fix/footer-pr-link',
  authorLogin: 'mock-user',
}

export const MOCK_GH_WORKSPACE_PR_NUMBER = 88

// An open PR in the current workspace repo authored by someone else, so the
// "in this repo" section surfaces PRs beyond just the signed-in user's own.
const MOCK_WORKSPACE_PR: GhPrSummary = {
  owner: MOCK_GH_PR_OWNER,
  repo: MOCK_GH_PR_REPO,
  number: MOCK_GH_WORKSPACE_PR_NUMBER,
  title: 'Tidy up workspace status polling',
  url: `https://github.com/${MOCK_GH_PR_OWNER}/${MOCK_GH_PR_REPO}/pull/${MOCK_GH_WORKSPACE_PR_NUMBER}`,
  state: 'OPEN',
  headRefName: 'chore/workspace-status',
  authorLogin: 'octo-dev',
}

const MOCK_PR_DETAILS: GhPrDetails = {
  ...MOCK_LINKED_PR,
  body: [
    '<!-- Copse PR template: hidden guidance for reviewers -->',
    '## Summary',
    '',
    'Adds a **PRs** tab to the right panel so chat-linked pull requests open in-app.',
    '',
    '- Linked PRs from chat appear under *From chat*',
    '- Uses the existing Changes diff viewer',
  ].join('\n'),
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  additions: 12,
  deletions: 3,
  changedFiles: 4,
  files: [
    { path: 'src/renderer/views/pr-pane.ts', status: 'added', additions: 420, deletions: 0 },
    { path: 'src/main/services/gh-pr-service.ts', status: 'modified', additions: 80, deletions: 4 },
    { path: 'src/shared/types/git.ts', status: 'modified', additions: 3, deletions: 1 },
    { path: 'src/renderer/views/old-panel.ts', status: 'removed', additions: 0, deletions: 150 },
  ],
}

const MOCK_FILE_DIFFS: Record<string, GhPrFileDiff> = {
  'src/renderer/views/pr-pane.ts': {
    path: 'src/renderer/views/pr-pane.ts',
    before: '',
    after: [
      'export function mountPrPane() {',
      '  // PR list + viewer for chat-linked pull requests',
      '}',
      '',
    ].join('\n'),
    language: 'typescript',
  },
  'src/main/services/gh-pr-service.ts': {
    path: 'src/main/services/gh-pr-service.ts',
    before: 'export async function getGhCliStatus() {\n  return null\n}\n',
    after: [
      'export async function getGhCliStatus() {',
      '  if (isMockGhEnabled()) return mockGhCliStatus()',
      '  // ...',
      '}',
      '',
    ].join('\n'),
    language: 'typescript',
  },
}

export function isMockGhEnabled(): boolean {
  return process.env['COPSE_PANEL_MOCK_GH'] === '1'
}

export function mockGhCliStatus(): GhCliStatus {
  if (process.env['COPSE_PANEL_MOCK_GH_STATUS'] === 'unavailable') {
    return {
      installed: false,
      authenticated: false,
      username: null,
      message: 'GitHub CLI (gh) is not installed or not on PATH.',
    }
  }
  if (process.env['COPSE_PANEL_MOCK_GH_STATUS'] === 'unauthenticated') {
    return {
      installed: true,
      authenticated: false,
      username: null,
      message: 'Run `gh auth login` to connect your GitHub account.',
    }
  }
  return {
    installed: true,
    authenticated: true,
    username: 'mock-user',
    message: null,
  }
}

export function mockListMyOpenPrs(): GhPrSummary[] {
  return [MOCK_LINKED_PR, MOCK_OTHER_PR]
}

export function mockListWorkspaceOpenPrs(): GhPrSummary[] {
  // The repo-scoped listing carries CI rollup, so its summaries arrive with
  // checks already resolved (search-based "your PRs" does not).
  return [
    { ...MOCK_LINKED_PR, checks: 'success' },
    { ...MOCK_WORKSPACE_PR, checks: 'failure' },
  ]
}

export function mockGetGhPrChecksState(ref: {
  owner: string
  repo: string
  number: number
}): GhPrChecksState {
  if (ref.owner !== MOCK_GH_PR_OWNER || ref.repo !== MOCK_GH_PR_REPO) return 'no_checks'
  switch (ref.number) {
    case MOCK_GH_PR_NUMBER:
      return 'success'
    case MOCK_GH_WORKSPACE_PR_NUMBER:
      return 'failure'
    case MOCK_OTHER_PR.number:
      return 'pending'
    default:
      return 'no_checks'
  }
}

export function mockGetGhPrDetails(ref: {
  owner: string
  repo: string
  number: number
}): GhPrDetails | null {
  if (
    ref.owner === MOCK_GH_PR_OWNER &&
    ref.repo === MOCK_GH_PR_REPO &&
    ref.number === MOCK_GH_PR_NUMBER
  ) {
    return MOCK_PR_DETAILS
  }
  if (
    ref.owner === MOCK_GH_PR_OWNER &&
    ref.repo === MOCK_GH_PR_REPO &&
    ref.number === MOCK_OTHER_PR.number
  ) {
    return {
      ...MOCK_OTHER_PR,
      body: 'Minor footer polish for branch/PR display.',
      baseRefName: 'main',
      additions: 4,
      deletions: 1,
      changedFiles: 1,
      files: [
        {
          path: 'src/renderer/views/footer-branch-status.ts',
          status: 'modified',
          additions: 4,
          deletions: 1,
        },
      ],
    }
  }
  if (
    ref.owner === MOCK_GH_PR_OWNER &&
    ref.repo === MOCK_GH_PR_REPO &&
    ref.number === MOCK_WORKSPACE_PR.number
  ) {
    return {
      ...MOCK_WORKSPACE_PR,
      body: 'Refreshes PR badges when the active workspace changes.',
      baseRefName: 'main',
      additions: 9,
      deletions: 6,
      changedFiles: 1,
      files: [
        {
          path: 'src/main/services/pr-context-service.ts',
          status: 'modified',
          additions: 9,
          deletions: 6,
        },
      ],
    }
  }
  return null
}

export function mockGetGhPrFileDiff(
  ref: { owner: string; repo: string; number: number },
  path: string,
): GhPrFileDiff | null {
  if (ref.owner !== MOCK_GH_PR_OWNER || ref.repo !== MOCK_GH_PR_REPO) return null
  if (ref.number !== MOCK_GH_PR_NUMBER) {
    if (
      ref.number === MOCK_OTHER_PR.number &&
      path === 'src/renderer/views/footer-branch-status.ts'
    ) {
      return {
        path,
        before: 'export function mountFooter() {}\n',
        after: 'export function mountFooter() {\n  // show PR link when gh is ready\n}\n',
        language: 'typescript',
      }
    }
    if (
      ref.number === MOCK_WORKSPACE_PR.number &&
      path === 'src/main/services/pr-context-service.ts'
    ) {
      return {
        path,
        before: 'export function getPrWorkspaceContext() {}\n',
        after: 'export function getPrWorkspaceContext() {\n  // re-poll on workspace_changed\n}\n',
        language: 'typescript',
      }
    }
    return null
  }
  return MOCK_FILE_DIFFS[path] ?? null
}

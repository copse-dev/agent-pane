import { installSanitizerBackend } from '../../../src/renderer/markdown/sanitizer-backend.ts'
import { createStore } from '@shared/store/store.ts'
import type { GhPrDetails } from '@shared/types/git.ts'
import { createFakeApi } from '../../../src/renderer/fake-api.test-support.ts'
import { mountReviewPane } from '../../../src/renderer/views/review-pane.ts'
import { mountRightPanelLayout } from '../../../src/renderer/views/right-panel-layout.ts'
import { mountPanelModeControls } from '../../../src/renderer/views/panel-mode-controls.ts'
import { loadMonaco } from '../../../src/renderer/monaco/setup.ts'

const pr: GhPrDetails = {
  owner: 'acme',
  repo: 'widgets',
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
  title: 'Keep search results in order',
  state: 'OPEN',
  body: 'Preserve the newest query when an earlier search finishes late.',
  headRefName: 'fix/search-order',
  baseRefName: 'main',
  additions: 2,
  deletions: 1,
  files: [{ path: 'src/search.ts', status: 'modified', additions: 2, deletions: 1 }],
  activity: {
    comments: [
      {
        id: 'comment-1',
        author: 'alex',
        body: 'The request guard looks good.',
        createdAt: '2026-11-08T12:00:00Z',
        url: 'https://github.com/acme/widgets/pull/42#issuecomment-1',
      },
    ],
    checks: [{ name: 'Unit tests', state: 'SUCCESS', url: null }],
    headSha: 'abc123',
    commentsTruncated: false,
    checksTruncated: false,
  },
}
const store = createStore({
  projects: [{ id: 'widgets', name: 'Widgets', path: '/widgets' }],
  workspaceRoot: '/widgets',
  activeProjectId: 'widgets',
  activeThreadId: 'search',
  filesPaneOpen: true,
  rightPanelMode: 'changes',
  threads: [
    {
      id: 'search',
      title: 'Keep search results in order',
      gitBranch: 'fix/search-order',
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
      prRefs: [pr],
    },
  ],
  stagedDiffs: [{ path: 'src/search.ts', language: 'typescript' }],
  activeDiff: {
    path: 'src/search.ts',
    before: 'return results\n',
    after: 'if (request !== latestRequest) return\nreturn results\n',
    language: 'typescript',
  },
})
const api = createFakeApi()
window.api = api
window.addEventListener('unhandledrejection', (event) => {
  const error = document.createElement('pre')
  error.id = 'fixture-error'
  error.textContent =
    event.reason instanceof Error
      ? (event.reason.stack ?? event.reason.message)
      : String(event.reason)
  document.body.append(error)
})
const diff = {
  path: 'src/search.ts',
  before: 'return results\n',
  after: 'if (request !== latestRequest) return\nreturn results\n',
  language: 'typescript',
}
api.git.isAvailable = async (): ReturnType<typeof api.git.isAvailable> => true
api.git.status = async (): ReturnType<typeof api.git.status> => ({
  staged: [],
  unstaged: [{ path: 'src/search.ts', status: 'modified' }],
})
api.git.fileDiff = async (): ReturnType<typeof api.git.fileDiff> => diff
api.git.committedChanges = async (): ReturnType<typeof api.git.committedChanges> => null
api.git.sessionBackup = async (): ReturnType<typeof api.git.sessionBackup> => null
api.diff.content = async (): ReturnType<typeof api.diff.content> => diff
api.gh.status = async (): ReturnType<typeof api.gh.status> => ({
  installed: true,
  authenticated: !location.search.includes('offline'),
  username: 'alex',
  message: null,
})
api.gh.listWorkspaceOpenPrs = async (): ReturnType<typeof api.gh.listWorkspaceOpenPrs> => [pr]
api.gh.prDetails = async (): ReturnType<typeof api.gh.prDetails> => pr
api.gh.prFileDiff = async (): ReturnType<typeof api.gh.prFileDiff> => diff
api.gh.prChecks = async (): ReturnType<typeof api.gh.prChecks> => 'success'
const app = document.getElementById('app')
if (!app) throw new Error('Missing fixture root')
document.documentElement.dataset['theme'] = 'dark'
app.innerHTML = `<div id="titlebar"></div><div id="body" style="display:flex;flex:1;min-height:0"><div id="pane-files" class="pane-files" style="width:760px;height:100%"><div class="pane-files-body"><div id="right-sidebar" class="right-sidebar"><div id="git-changes-host" class="git-changes-host"></div><div id="pr-list-host" class="git-changes-host pr-list-host"></div></div><div id="resizer-tree" class="pane-resizer"></div><div id="git-diff-viewer-host" class="git-diff-viewer-host"></div><div id="pr-viewer-host" class="git-diff-viewer-host pr-viewer-host"></div></div></div></div>`
const titlebar = document.getElementById('titlebar')
const pane = document.getElementById('pane-files')
if (!pane || !titlebar) throw new Error('Missing pane')
titlebar.append(mountPanelModeControls(store, api).element)
mountRightPanelLayout(store)
void Promise.all([loadMonaco(), installSanitizerBackend()]).then(([monaco]) =>
  mountReviewPane(pane, store, api, monaco),
)

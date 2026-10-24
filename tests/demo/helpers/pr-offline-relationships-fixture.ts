import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { ThreadPrRelationshipIndex } from '@shared/git/thread-pr-relations.ts'
import { createFakeApi } from '../../../src/renderer/fake-api.test-support.ts'
import { mountPrPane } from '../../../src/renderer/views/pr-pane.ts'
import type { GitDiffMonaco } from '../../../src/renderer/monaco/git-diff-viewer.ts'

const pr = {
  owner: 'acme',
  repo: 'widgets',
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
}
function thread(id: string, title: string): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}
const store = createStore({
  activeProjectId: 'widgets',
  activeThreadId: 'reviewer',
  filesPaneOpen: true,
  rightPanelMode: 'prs',
  threads: [
    { ...thread('reviewer', 'Review widget'), prRefs: [pr] },
    thread('producer', 'Implement widget'),
  ],
})
const api = createFakeApi()
api.gh.status = async (): ReturnType<typeof api.gh.status> => ({
  installed: location.search.includes('unauthenticated'),
  authenticated: false,
  username: null,
  message: null,
})
api.gh.prThreadRelationships = async (ref): ReturnType<typeof api.gh.prThreadRelationships> =>
  new ThreadPrRelationshipIndex(store.getState().threads).forPr(ref)
api.gh.threadPrRelationships = async (id): ReturnType<typeof api.gh.threadPrRelationships> =>
  new ThreadPrRelationshipIndex(store.getState().threads).forThread(id)
const unreachable = (): never => {
  throw new Error('Offline fixture must not construct a diff editor')
}
const monaco: GitDiffMonaco = {
  KeyCode: { KeyL: 0 },
  Uri: { parse: (value) => ({ toString: () => value }) },
  editor: { createDiffEditor: unreachable, createModel: unreachable },
}
const app = document.getElementById('app')
if (!app) throw new Error('Missing fixture root')
document.documentElement.dataset['theme'] = 'dark'
const record = document.createElement('button')
record.id = 'record-production'
record.textContent = 'Record PR creation'
record.onclick = (): void => {
  store.setState({
    threads: store.getState().threads.map((item) =>
      item.id === 'producer'
        ? {
            ...item,
            prProductions: [{ pr, eventId: 'native-create', source: 'pr-create', createdAt: 2 }],
          }
        : item,
    ),
  })
  store.emit('threads_changed')
}
const pane = document.createElement('div')
pane.id = 'pane-files'
pane.style.cssText = 'display:flex;width:660px;height:617px;flex-shrink:0;background:var(--bg-base)'
const list = document.createElement('div')
list.style.cssText = 'width:220px;flex-shrink:0;border-right:1px solid var(--border)'
const viewer = document.createElement('div')
viewer.id = 'pr-viewer-host'
viewer.style.cssText = 'flex:1;min-width:0'
pane.append(list, viewer)
app.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start'
app.append(record, pane)
mountPrPane(list, viewer, store, api, monaco)

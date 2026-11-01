import { z } from 'zod'
import { createStore } from '@shared/store/store.ts'
import { RemoteChatClient, RemoteActions } from './client.ts'
import { mountChatSurface } from '../views/chat-surface.ts'
import { request } from './transport.ts'
import { installHighlighterBackend } from '../markdown/highlighter-backend.ts'
import { qsRequired } from '../dom/helpers.ts'
import { mountConfirmDialog, showConfirmDialog } from '../views/confirm-dialog.ts'

const metadataSchema = z.object({
  access: z.enum(['read', 'control']),
  sessionId: z.uuid(),
  runId: z.uuid().nullable(),
})

export async function startRemoteChat(): Promise<void> {
  const params = new URLSearchParams(location.search)
  const projectId = params.get('project')
  const threadId = params.get('thread')
  const conversation = document.getElementById('conversation')
  const input = document.getElementById('input-bar')
  const status = qsRequired(document, '#connection')
  const title = qsRequired(document, '#thread-title')
  if (!conversation || !input || !projectId || !threadId) return
  const theme = window.matchMedia('(prefers-color-scheme: dark)')
  const applyTheme = (): void => {
    document.documentElement.dataset['theme'] = theme.matches ? 'dark' : 'light'
  }
  applyTheme()
  theme.addEventListener('change', applyTheme)
  const store = createStore({
    activeProjectId: projectId,
    activeThreadId: threadId,
    conciseThreadsEnabled: false,
  })
  let connected = false
  const client = new RemoteChatClient(request)
  let appliedSnapshot: string | null = null
  let metadata: z.infer<typeof metadataSchema> | null = null
  mountConfirmDialog()
  const actions = new RemoteActions(request, () =>
    showConfirmDialog({
      message: 'Send this action again?',
      detail:
        'The earlier delivery is uncertain. Check this chat on your Mac before sending again to avoid a duplicate.',
      confirmLabel: 'Send again',
    }),
  )
  async function action(
    payload: { action: 'message'; text: string } | { action: 'stop'; runId: string },
  ): Promise<void> {
    if (!connected || !metadata || metadata.access !== 'control')
      throw new Error('Reconnect to your Mac to send.')
    await actions.run(
      { ...payload, projectId: projectId ?? '', threadId: threadId ?? '' },
      metadata.sessionId,
    )
  }
  mountChatSurface(conversation, input, store, window.api, {
    transport: {
      connected: () => connected,
      send: async (_project, _thread, text) => action({ action: 'message', text }),
      stop: async () => {
        if (!metadata?.runId) throw new Error('The run has already changed.')
        await action({ action: 'stop', runId: metadata.runId })
      },
    },
  })
  await installHighlighterBackend().catch(() => {})
  let refreshing = false
  async function refresh(): Promise<void> {
    if (refreshing) return
    refreshing = true
    try {
      const [state, rawMetadata] = await Promise.all([
        client.snapshot(),
        request(
          '/api/thread/' +
            encodeURIComponent(projectId ?? '') +
            '/' +
            encodeURIComponent(threadId ?? ''),
        ),
      ])
      metadata = metadataSchema.parse(rawMetadata)
      const view = state.views.find((item) => item.projectId === projectId)
      const thread = view?.threads.find((item) => item.id === threadId)
      if (!thread) throw new Error('Open this project on your Mac to share its live chat.')
      const wasConnected = connected
      connected = metadata.access === 'control'
      const snapshotKey = `${state.sessionId}:${String(state.revision)}`
      if (snapshotKey !== appliedSnapshot) {
        const hydrated = await client.hydrate(projectId ?? '', thread)
        store.setState({
          threads: view?.threads.map((item) => (item.id === threadId ? hydrated : item)) ?? [],
        })
        appliedSnapshot = snapshotKey
        store.emit('threads_changed')
      } else if (wasConnected !== connected) {
        store.emit('threads_changed')
      }
      title.textContent = thread.title || 'Chat'
      status.textContent = connected ? 'Connected to your Mac' : 'Enable control on your Mac'
      status.dataset['connected'] = String(connected)
    } catch (cause) {
      connected = false
      store.emit('threads_changed')
      status.dataset['connected'] = 'false'
      status.textContent =
        cause instanceof Error ? cause.message : 'Reconnecting… Your draft is kept.'
    } finally {
      refreshing = false
    }
  }
  await refresh()
  window.setInterval(() => {
    void refresh()
  }, 1500)
}

import { z } from 'zod'
import { createStore } from '@shared/store/store.ts'
import { remoteStateSchema } from '../../shared/remote-interface.ts'
import { mountChatSurface } from '../views/chat-surface.ts'
import { request } from './electron.ts'
import { installHighlighterBackend } from '../markdown/highlighter-backend.ts'
import { qsRequired } from '../dom/helpers.ts'

const metadataSchema = z.object({
  access: z.enum(['read', 'control']),
  sessionId: z.uuid(),
  runId: z.uuid().nullable(),
})
const actionResultSchema = z.object({ ok: z.boolean().optional(), error: z.string().optional() })

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
  let metadata: z.infer<typeof metadataSchema> | null = null
  const pending = new Map<string, { requestId: string; sessionId: string; issuedAt: number }>()
  async function action(
    payload: { action: 'message'; text: string } | { action: 'stop'; runId: string },
  ): Promise<void> {
    if (!connected || !metadata || metadata.access !== 'control')
      throw new Error('Reconnect to your Mac to send.')
    const key = JSON.stringify(payload)
    let envelope = pending.get(key)
    if (!envelope || envelope.sessionId !== metadata.sessionId) {
      envelope = {
        requestId: crypto.randomUUID(),
        sessionId: metadata.sessionId,
        issuedAt: Date.now(),
      }
      pending.set(key, envelope)
    }
    // Keep the envelope after uncertain delivery: retries cannot start duplicate runs.
    const result = actionResultSchema.parse(
      await request('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...envelope, projectId, threadId, ...payload }),
      }),
    )
    if (result.error) throw new Error(result.error)
    pending.delete(key)
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
      const [rawState, rawMetadata] = await Promise.all([
        request('/api/remote/state'),
        request(
          '/api/thread/' +
            encodeURIComponent(projectId ?? '') +
            '/' +
            encodeURIComponent(threadId ?? ''),
        ),
      ])
      const state = remoteStateSchema.parse(rawState)
      metadata = metadataSchema.parse(rawMetadata)
      const view = state.views.find((item) => item.projectId === projectId)
      const thread = view?.threads.find((item) => item.id === threadId)
      if (!thread) throw new Error('Open this project on your Mac to share its live chat.')
      connected = metadata.access === 'control'
      store.setState({ threads: view?.threads ?? [] })
      store.emit('threads_changed')
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

import { createStore, type AppStore } from '@shared/store/store.ts'
import {
  transcriptMeta,
  transcriptMetaPatch,
  type TranscriptMeta,
} from '@shared/store/transcript-state.ts'
import {
  createTranscriptReducer,
  type TranscriptReducer,
} from '@shared/store/transcript-reducer.ts'
import {
  getThreadById,
  setMessageCommandSummary,
  setMessageRunSummary,
  setMessageToolSummary,
  setThreadStatus,
} from '@shared/store/thread-helpers.ts'
import type {
  Message,
  StreamChunk,
  Thread,
  TranscriptAnnotation,
  TranscriptStamp,
  TranscriptSnapshot,
} from '@shared/types'

/**
 * Main is the writer of a dispatched turn's transcript.
 *
 * Until this existed the window reduced `agent:chunk`s into messages and was the
 * only caller of `appendMessage`, so closing it mid-turn lost the rest of the
 * turn while the agent kept running (mobile-web-experience.md L1). Now the
 * dispatcher hands each turn's chunks here first. A headless store seeded from
 * disk runs the same reducer the window runs (`transcript-reducer.ts`); its
 * finalized messages and the turn's closing status are written from here, and
 * every chunk is forwarded with a {@link TranscriptStamp} naming the ids of the
 * messages it created, so the window draws the same messages and writes none.
 *
 * This is the first step toward a window that only ever attaches to a runtime
 * it does not own (client-server-split.md). It does not fence writers across
 * processes: the dispatcher's per-thread slot is the only exclusion, which holds
 * while one process runs turns (cross-device-harness-offload.md O1).
 */
export interface TurnTranscriptWriterDependencies {
  /** Deliver a chunk to the window. A missing stamp means the window writes it. */
  forward: (threadId: string, chunk: StreamChunk, stamp?: TranscriptStamp) => void
  snapshot?: (snapshot: TranscriptSnapshot) => void
  loadThread: (projectId: string, threadId: string) => Promise<Thread | null>
  appendMessage: (projectId: string, threadId: string, message: Message) => Promise<void>
  updateMeta: (
    projectId: string,
    threadId: string,
    patch: Partial<Omit<Thread, 'messages'>>,
  ) => Promise<void>
  /** The model a bubble records when neither the turn nor the thread names one. */
  defaultModel: () => string | undefined
  createId: () => string
  onError?: (error: unknown) => void
}

/** One turn's transcript, from dispatch to its terminal chunk. */
export interface TurnTranscript {
  emit(chunk: StreamChunk): void
  /** The turn released its slot. Writes anything still unwritten, then detaches. */
  end(): void
}

interface Session {
  projectId: string
  threadId: string
  store: AppStore
  reducer: TranscriptReducer
  /** Null once seeded; chunks wait here until then so order is kept. */
  pending: StreamChunk[] | null
  /** Seeding found no thread: forward unstamped and leave writing to the window. */
  passthrough: boolean
  /** Ids the chunk being applied created, in order. */
  created: string[]
  /** Messages this turn changed, with the JSON last written for each. */
  touched: Set<string>
  written: Map<string, string>
  /** Writes this session has issued and not yet seen settle. */
  writes: Set<Promise<void>>
  done: boolean
  ended: boolean
  unsubscribe: () => void
  /** Resolves once the session has ended and every write it issued settled. */
  drained: Promise<void>
  markDrained: () => void
  seeded: Promise<void>
  markSeeded: () => void
  initialMeta: TranscriptMeta | null
}

export class TurnTranscriptWriter {
  private readonly deps: TurnTranscriptWriterDependencies
  private readonly sessions = new Map<string, Session>()
  private revision = 0
  private readonly userAborts = new Map<string, 'send_now' | 'stop'>()
  /**
   * Per thread, the last session's drain. Writes are issued only once a
   * session's seed read returns, so a later read of the same thread — the next
   * turn's seed, an annotation — waits for this rather than racing ahead of
   * them on the store's queue.
   */
  private readonly drains = new Map<string, Promise<void>>()

  constructor(deps: TurnTranscriptWriterDependencies) {
    this.deps = deps
  }

  /** Resolves once everything main has written for the thread has landed. */
  settled(threadId: string): Promise<void> {
    return this.drains.get(threadId) ?? Promise.resolve()
  }

  /**
   * Remember how the user stopped a thread's run, so the outcome main writes
   * says Stop or send-now just as the window's copy does.
   */
  noteUserAbort(threadId: string, reason: 'send_now' | 'stop'): void {
    this.userAborts.set(threadId, reason)
  }

  /** Snapshot and subsequent chunks use the same ordered IPC sender. */
  async attach(projectId: string, threadIds: readonly string[]): Promise<void> {
    for (const threadId of threadIds) {
      // A turn may start or finish during a disk read. Retry until the read
      // and the active session agree, then send without another await.
      for (;;) {
        const before = this.sessions.get(threadId)
        if (before?.pending) {
          await before.seeded
          continue
        }
        if (before && before.projectId === projectId) {
          this.sendSnapshot(before)
          break
        }
        const drain = this.settled(threadId)
        await drain
        const revision = this.revision
        const thread = await this.deps.loadThread(projectId, threadId)
        if (
          revision !== this.revision ||
          this.sessions.get(threadId) !== before ||
          this.drains.has(threadId)
        )
          continue
        if (thread)
          this.deps.snapshot?.({
            projectId,
            thread,
            checkpoint: { stream: null, pendingTurn: null },
          })
        break
      }
    }
  }

  private sendSnapshot(session: Session): void {
    const thread = getThreadById(session.store, session.threadId)
    if (thread)
      this.deps.snapshot?.(
        structuredClone({
          projectId: session.projectId,
          thread,
          checkpoint: session.reducer.checkpoint(session.threadId),
        }),
      )
  }

  begin(projectId: string, threadId: string): TurnTranscript {
    this.revision += 1
    const store = createStore()
    const session: Session = {
      projectId,
      threadId,
      store,
      reducer: createTranscriptReducer(store, {
        createMessageId: () => {
          const id = this.deps.createId()
          session.created.push(id)
          return id
        },
        defaultModel: this.deps.defaultModel,
        userAbort: (id) => this.userAborts.get(id) ?? 'stop',
      }),
      pending: [],
      passthrough: false,
      created: [],
      touched: new Set(),
      written: new Map(),
      writes: new Set(),
      done: false,
      ended: false,
      unsubscribe: () => undefined,
      drained: Promise.resolve(),
      markDrained: () => undefined,
      seeded: Promise.resolve(),
      markSeeded: () => undefined,
      initialMeta: null,
    }
    session.drained = new Promise<void>((resolve) => {
      session.markDrained = resolve
    })
    session.seeded = new Promise<void>((resolve) => {
      session.markSeeded = resolve
    })
    session.unsubscribe = this.watch(session)
    const previous = this.settled(threadId)
    this.sessions.set(threadId, session)
    this.drains.set(threadId, session.drained)
    this.userAborts.delete(threadId)

    void previous
      .then(() => this.deps.loadThread(projectId, threadId))
      .then((thread) => {
        if (thread) {
          store.setState({ threads: [{ ...thread, status: 'running' }], activeThreadId: threadId })
          session.initialMeta = structuredClone(transcriptMeta(thread))
          // Attachment tells the renderer this status is runtime-owned. Write
          // it on the store queue before output so a held turn is recoverable.
          this.track(
            session,
            this.deps
              .updateMeta(projectId, threadId, { status: 'running' })
              .catch((error: unknown) => {
                this.deps.onError?.(error)
              }),
          )
        } else session.passthrough = true
      })
      .catch((error: unknown) => {
        session.passthrough = true
        this.deps.onError?.(error)
      })
      .finally(() => {
        const queued = session.pending ?? []
        session.pending = null
        this.sendSnapshot(session)
        for (const chunk of queued) this.process(session, chunk)
        if (session.ended) this.finish(session)
        session.markSeeded()
      })

    return {
      emit: (chunk): void => {
        if (session.pending) session.pending.push(chunk)
        else this.process(session, chunk)
      },
      end: (): void => {
        session.ended = true
        if (!session.pending) this.finish(session)
      },
    }
  }

  /**
   * Merge a window-derived label into a message and persist it. During the turn
   * the live copy is patched (and written by the same path as everything else);
   * afterwards the stored message is read back and rewritten.
   */
  async annotate(
    projectId: string,
    threadId: string,
    messageId: string,
    annotation: TranscriptAnnotation,
  ): Promise<void> {
    const session = this.sessions.get(threadId)
    if (
      session &&
      session.projectId === projectId &&
      !session.passthrough &&
      !session.pending &&
      getThreadById(session.store, threadId)?.messages.some((m) => m.id === messageId)
    ) {
      session.touched.add(messageId)
      applyAnnotation(session.store, messageId, annotation)
      return
    }
    await this.settled(threadId)
    const thread = await this.deps.loadThread(projectId, threadId)
    const message = thread?.messages.find((candidate) => candidate.id === messageId)
    if (!message) return
    await this.deps.appendMessage(projectId, threadId, { ...message, ...annotation })
  }

  private process(session: Session, chunk: StreamChunk): void {
    if (session.passthrough || session.done) {
      this.deps.forward(session.threadId, chunk)
      return
    }
    session.created = []
    try {
      session.reducer.apply(session.threadId, chunk)
    } catch (error) {
      // A chunk the reducer cannot place must not take the turn down with it.
      this.deps.onError?.(error)
    }
    const stamp: TranscriptStamp = { messageIds: session.created }
    session.created = []
    this.deps.forward(session.threadId, this.forWindow(session.threadId, chunk), stamp)
    if (chunk.type === 'done') this.complete(session)
  }

  /** The chunk as the window should see it: a user Stop carries main's label. */
  private forWindow(threadId: string, chunk: StreamChunk): StreamChunk {
    if (chunk.type !== 'turn_outcome' || chunk.outcome.userAbort !== undefined) return chunk
    if (chunk.outcome.status !== 'cancelled' || chunk.outcome.source !== 'user') return chunk
    return {
      ...chunk,
      outcome: { ...chunk.outcome, userAbort: this.userAborts.get(threadId) ?? 'stop' },
    }
  }

  /** Subscribe the persistence triggers the window's autosave used to own. */
  private watch(session: Session): () => void {
    const { store, threadId } = session
    const owned = (messageId: string): Message | undefined =>
      getThreadById(store, threadId)?.messages.find((m) => m.id === messageId)
    const touch = (messageId: string): void => {
      session.touched.add(messageId)
    }
    const unsubscribes = [
      store.on('message_added', (_tid, messageId) => {
        touch(messageId)
        // A machine turn's prompt is complete when added; an assistant bubble
        // waits for `message_done`.
        if (owned(messageId)?.role === 'user') this.persist(session, messageId)
      }),
      store.on('message_token', touch),
      store.on('message_reasoning', touch),
      store.on('message_acp_content', touch),
      store.on('message_canvas_artefacts_changed', touch),
      store.on('message_visual_evidence_changed', touch),
      store.on('tool_call_started', touch),
      store.on('hook_card_added', (_tid, messageId) => {
        touch(messageId)
      }),
      store.on('review_changed', (_tid, messageId) => {
        touch(messageId)
      }),
      store.on('message_done', (messageId) => {
        touch(messageId)
        this.persist(session, messageId)
      }),
      store.on('tool_call_updated', (messageId, toolCallId) => {
        touch(messageId)
        const message = owned(messageId)
        if (!message) return
        // The v1 spine has no running tool status: a settled call (or a label,
        // which arrives with an empty id) re-finalizes its message.
        if (toolCallId) {
          const toolCall = message.toolCalls.find((candidate) => candidate.id === toolCallId)
          if (!toolCall || toolCall.status === 'running') return
        }
        this.persist(session, messageId)
      }),
      store.on('review_report_changed', (_tid, messageId) => {
        if (messageId === null) return
        touch(messageId)
        const message = owned(messageId)
        // A `running` card is transient; the settled report replaces it.
        if (!message || message.reviewReport?.status === 'running') return
        if (message.toolCalls.some((toolCall) => toolCall.status === 'running')) return
        this.persist(session, messageId)
      }),
    ]
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }

  private persist(session: Session, messageId: string): void {
    const message = getThreadById(session.store, session.threadId)?.messages.find(
      (candidate) => candidate.id === messageId,
    )
    if (!message) return
    const json = JSON.stringify(message)
    if (session.written.get(messageId) === json) return
    session.written.set(messageId, json)
    // A snapshot, not the live object: the reducer keeps mutating the message
    // while the write waits on the store's queue.
    const snapshot: Message = structuredClone(message)
    this.track(
      session,
      this.deps
        .appendMessage(session.projectId, session.threadId, snapshot)
        .catch((error: unknown) => {
          if (session.written.get(messageId) === json) session.written.delete(messageId)
          this.deps.onError?.(error)
        }),
    )
  }

  private track(session: Session, write: Promise<void>): void {
    session.writes.add(write)
    void write.finally(() => session.writes.delete(write))
  }

  /** Write every message the turn changed and has not written in its final form. */
  private flushTouched(session: Session): void {
    for (const messageId of session.touched) this.persist(session, messageId)
  }

  private complete(session: Session): void {
    session.done = true
    this.flushTouched(session)
    this.persistMeta(session)
  }

  private persistMeta(session: Session): void {
    const thread = getThreadById(session.store, session.threadId)
    if (thread) {
      // The run-owned fields of the closing metadata. The window's autosave
      // still owns everything else (drafts, queue, title).
      this.track(
        session,
        this.deps
          .updateMeta(session.projectId, session.threadId, {
            ...(session.initialMeta
              ? transcriptMetaPatch(session.initialMeta, transcriptMeta(thread))
              : transcriptMeta(thread)),
            status: thread.status,
          })
          .catch((error: unknown) => {
            this.deps.onError?.(error)
          }),
      )
    }
  }

  private finish(session: Session): void {
    this.revision += 1
    // A turn that failed before `done` still keeps what it produced.
    if (!session.done && !session.passthrough) {
      this.flushTouched(session)
      setThreadStatus(session.store, session.threadId, 'idle')
      this.persistMeta(session)
    }
    session.unsubscribe()
    if (this.sessions.get(session.threadId) === session) this.sessions.delete(session.threadId)
    this.userAborts.delete(session.threadId)
    void Promise.allSettled([...session.writes]).then(() => {
      session.markDrained()
      if (this.drains.get(session.threadId) === session.drained) {
        this.drains.delete(session.threadId)
      }
    })
  }
}

function applyAnnotation(
  store: AppStore,
  messageId: string,
  annotation: TranscriptAnnotation,
): void {
  if (annotation.commandSummary !== undefined) {
    setMessageCommandSummary(store, messageId, annotation.commandSummary)
  }
  if (annotation.toolSummary !== undefined) {
    setMessageToolSummary(store, messageId, annotation.toolSummary)
  }
  if (annotation.runSummary !== undefined) {
    setMessageRunSummary(store, messageId, annotation.runSummary)
  }
}

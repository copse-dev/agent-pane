import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { setThreadDraftPrompt } from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountInputBar } from './input-bar.ts'
import { mountProjectsPane } from './projects-pane.ts'
import type { ArchiveAttachmentRef } from '@shared/archive/archive-media.ts'
import type { PreparedThreadCheckout, ThreadCheckoutPreview } from '@shared/types/worktree.ts'
import type { SkillSummary } from '@shared/types/skills.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.defineProperties(globalThis, {
  ResizeObserver: { configurable: true, value: TestResizeObserver },
  requestAnimationFrame: {
    configurable: true,
    value: (callback: FrameRequestCallback): number =>
      window.setTimeout(() => {
        callback(Date.now())
      }, 0),
  },
  cancelAnimationFrame: {
    configurable: true,
    value: (id: number): void => {
      window.clearTimeout(id)
    },
  },
  MutationObserver: { configurable: true, value: window.MutationObserver },
})

function thread(branch?: string): Thread {
  const value: Thread = {
    id: 'thread-1',
    title: 'Test thread',
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
  if (branch) value.gitBranch = branch
  return value
}

function createApi(options: {
  currentBranch: string
  onAbort?: () => Promise<void>
  onRun?: () => Promise<void>
  onCheckoutBranch?: (branch: string) => Promise<void>
  onPrepareCheckout?: () => Promise<PreparedThreadCheckout>
  onPreviewCheckout?: () => Promise<ThreadCheckoutPreview>
  listSkills?: () => Promise<SkillSummary[]>
  availableProviders?: () => Promise<
    Awaited<ReturnType<ApiClient['settings']['availableProviders']>>
  >
  openRouterModels?: () => Promise<Awaited<ReturnType<ApiClient['openRouter']['models']>>>
  lmStudioModelInfo?: () => Promise<Awaited<ReturnType<ApiClient['lmStudio']['modelInfo']>>>
  onDescribeImages?: ApiClient['agent']['describeImages']
  estimateContext?: ApiClient['agent']['estimateContext']
  promptState?: { startingCommit: string | null; dirty: boolean }
  onExportArchive?: (projectId: string, threadId: string) => void
  onAttachArchive?: (projectId: string, threadId: string, name: string, bytes?: Uint8Array) => void
}): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      agent: {
        ...base['agent'],
        abort: options.onAbort ?? (async (): Promise<void> => {}),
        run: options.onRun ?? (async (): Promise<void> => {}),
        describeImages: options.onDescribeImages ?? base['agent'].describeImages,
        estimateContext: options.estimateContext ?? base['agent'].estimateContext,
        clearHistory: async (_projectId: string, _threadId: string): Promise<void> => {},
        prepareCheckout:
          options.onPrepareCheckout ??
          (async (): Promise<PreparedThreadCheckout> => ({
            checkoutMode: 'shared',
            choice: 'automatic',
            branch: options.currentBranch,
          })),
        previewCheckout:
          options.onPreviewCheckout ??
          (async (): Promise<ThreadCheckoutPreview> => ({ checkoutMode: 'shared' })),
        suggestFollowUps: async () => [],
        refreshModelContext: async (): Promise<void> => {},
        onRefreshContextEstimate: () => () => {},
      },
      fs: {
        ...base['fs'],
        onChanged: () => () => {},
      },
      security: {
        ...base['security'],
        getGuardedYolo: async (threadId: string) => ({
          threadId,
          phase: 'off',
          containment: 'unsandboxed',
          expiresAt: null,
        }),
        enableGuardedYolo: async (threadId: string) => ({
          threadId,
          phase: 'off',
          containment: 'unsandboxed',
          expiresAt: null,
        }),
        disableGuardedYolo: async (threadId: string) => ({
          threadId,
          phase: 'off',
          containment: 'unsandboxed',
          expiresAt: null,
        }),
        onGuardedYoloChanged: () => () => {},
      },
      git: {
        ...base['git'],
        branchStatus: async () => ({ currentBranch: options.currentBranch, pr: null }),
        promptState: async () => options.promptState ?? { startingCommit: null, dirty: false },
        checkoutBranch: async (
          _projectId: string,
          _threadId: string,
          branch: string,
        ): Promise<void> => {
          await options.onCheckoutBranch?.(branch)
        },
        listBranches: async () => [{ name: options.currentBranch, lastCommitDate: '2024-01-01' }],
        getDefaultBranch: async () => 'main',
      },
      lmStudio: {
        ...base['lmStudio'],
        models: async () => [],
        modelInfo:
          options.lmStudioModelInfo ??
          (async (): Promise<Array<{ id: string; supportsImages?: boolean }>> => []),
      },
      openRouter: {
        ...base['openRouter'],
        models: options.openRouterModels ?? (async (): Promise<[]> => []),
      },
      settings: {
        ...base['settings'],
        availableProviders:
          options.availableProviders ??
          (async (): Promise<{ anthropic: true; openai: true }> => ({
            anthropic: true,
            openai: true,
          })),
        extraProviders: async () => [],
        get: async () => undefined,
        set: async (): Promise<void> => {},
      },
      packs: {
        ...base['packs'],
        // Memories / Roadmap are gated on first-party packs after migration off
        // their retired settings; the panel controls read `packs:list` on mount.
        // Default OFF (empty list) keeps those panes hidden.
        list: async () => ({ packs: [] }),
        setEnabled: async () => ({ packs: [] }),
        setSetting: async () => ({ packs: [] }),
      },
      skills: {
        ...base['skills'],
        list: options.listSkills ?? (async (): Promise<SkillSummary[]> => []),
      },
      index: {
        ...base['index'],
        status: async () => ({
          fileIndex: { phase: 'idle' },
          semantic: { phase: 'idle' },
        }),
        onStatusChanged: () => () => {},
      },
      threads: {
        ...base['threads'],
        listOrphans: async () => [],
        // A zip magic number is enough: nothing here unpacks it, and the bytes
        // are only ever asserted on as the payload handed to `archive:attach`.
        exportArchive: async (
          projectId: string,
          threadId: string,
        ): Promise<Uint8Array<ArrayBuffer>> => {
          options.onExportArchive?.(projectId, threadId)
          return new Uint8Array([80, 75, 3, 4])
        },
      },
      archive: {
        // Mirrors storeArchiveAttachment: the stored path is under whichever
        // thread was active at attach time.
        attach: async (
          projectId: string,
          threadId: string,
          archive: { name: string; bytes?: Uint8Array },
        ): Promise<ArchiveAttachmentRef> => {
          options.onAttachArchive?.(projectId, threadId, archive.name, archive.bytes)
          return {
            path: `/store/${threadId}/blobs/media/uuid-${archive.name}`,
            name: archive.name,
            sizeBytes: 8,
          }
        },
      },
    } satisfies ApiClient
  })()
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await settle()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('input bar first-message checkout', () => {
  it('shows the shared default and lets the user opt into an isolated worktree', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(host, store, createApi({ currentBranch: 'main' }))
    await settle()

    const choice = host.querySelector<HTMLButtonElement>('.footer-checkout-btn')
    assert.ok(choice)
    assert.equal(choice.textContent, 'Shared checkout')
    choice.click()
    const isolated = host.querySelector<HTMLButtonElement>('[data-checkout-choice="worktree"]')
    assert.ok(isolated)
    assert.equal(isolated.hidden, false)
    isolated.click()
    assert.equal(choice.textContent, 'Isolated worktree')
  })

  it('honors composer_checkout_preferred on a blank thread', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(host, store, createApi({ currentBranch: 'main' }))
    await settle()

    const choice = host.querySelector<HTMLButtonElement>('.footer-checkout-btn')
    assert.ok(choice)
    // Preview may show Isolated when automatic prefers worktree; force shared.
    store.emit('composer_checkout_preferred', 'shared')
    assert.equal(choice.textContent, 'Shared checkout')
    store.emit('composer_checkout_preferred', 'worktree')
    assert.equal(choice.textContent, 'Isolated worktree')
  })

  it('previews an automatic project opt-in only when Git supports it', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo', worktreeMode: 'always' }],
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(
      host,
      store,
      createApi({
        currentBranch: 'main',
        onPreviewCheckout: async () => ({ checkoutMode: 'worktree' }),
      }),
    )
    await settle()

    const choice = host.querySelector<HTMLButtonElement>('.footer-checkout-btn')
    assert.ok(choice)
    assert.equal(choice.textContent, 'Isolated worktree')
  })

  it('keeps the prompt and sends nothing when checkout preparation fails', async () => {
    let runs = 0
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(
      host,
      store,
      createApi({
        currentBranch: 'main',
        onPrepareCheckout: async () => {
          throw new Error(
            "Error invoking remote method 'agent:prepareCheckout': Error: worktree allocation failed",
          )
        },
        onRun: async () => {
          runs += 1
        },
      }),
    )
    const composer = host.querySelector<HTMLElement>('.prompt-input')
    const submit = host.querySelector<HTMLButtonElement>('.submit-btn')
    assert.ok(composer)
    assert.ok(submit)
    composer.textContent = 'Keep this prompt'
    submit.click()
    await flush()

    assert.equal(composer.textContent, 'Keep this prompt')
    assert.equal(runs, 0)
    assert.equal(store.getState().threads[0]?.messages.length, 0)
    const error = host.querySelector<HTMLElement>('.composer-checkout-error')
    assert.ok(error)
    assert.equal(error.hidden, false)
    assert.match(error.textContent, /worktree allocation failed/)
    assert.doesNotMatch(error.textContent, /invoking remote method/)
    assert.match(error.textContent, /Retry/)
  })

  it('persists checkout state before recording and dispatching the first prompt', async () => {
    const order: string[] = []
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(
      host,
      store,
      createApi({
        currentBranch: 'main',
        onPrepareCheckout: async () => {
          order.push('prepare')
          return {
            checkoutMode: 'worktree',
            choice: 'worktree',
            branch: 'copse/first-message',
            worktree: {
              path: '/worktrees/thread-1',
              branch: 'copse/first-message',
              baseBranch: 'main',
              baseCommit: 'a'.repeat(40),
              createdAt: 2,
              seededFromDirtyProject: false,
            },
          }
        },
        onRun: async () => {
          order.push('run')
        },
      }),
    )
    const choice = host.querySelector<HTMLButtonElement>('.footer-checkout-btn')
    const isolated = host.querySelector<HTMLButtonElement>('[data-checkout-choice="worktree"]')
    const composer = host.querySelector<HTMLElement>('.prompt-input')
    const submit = host.querySelector<HTMLButtonElement>('.submit-btn')
    assert.ok(choice)
    assert.ok(isolated)
    assert.ok(composer)
    assert.ok(submit)
    choice.click()
    isolated.click()
    composer.textContent = 'Start in isolation'
    submit.click()
    await flush()

    assert.deepEqual(order, ['prepare', 'run'])
    const prepared = store.getState().threads[0]
    assert.ok(prepared)
    assert.equal(prepared.worktreeChoice, 'worktree')
    assert.equal(prepared.gitBranch, 'copse/first-message')
    assert.equal(prepared.messages[0]?.content, 'Start in isolation')
    assert.equal(composer.textContent, '')
  })
})

describe('input bar prompt git-state capture', () => {
  it('stamps the sent message with the fetched startingCommit and dirty flag', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [{ ...thread('main'), messages: [], worktreeChoice: 'automatic' }],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(
      host,
      store,
      createApi({
        currentBranch: 'main',
        promptState: { startingCommit: 'a'.repeat(40), dirty: true },
      }),
    )
    await settle()

    const composer = host.querySelector<HTMLElement>('.prompt-input')
    const submit = host.querySelector<HTMLButtonElement>('.submit-btn')
    assert.ok(composer)
    assert.ok(submit)
    composer.textContent = 'What changed?'
    submit.click()
    await flush()

    const message = store.getState().threads[0]?.messages[0]
    assert.ok(message)
    assert.equal(message.startingCommit, 'a'.repeat(40))
    assert.equal(message.dirty, true)
  })

  it('omits startingCommit and leaves dirty false outside a git repository', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [{ ...thread('main'), messages: [], worktreeChoice: 'automatic' }],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(
      host,
      store,
      createApi({
        currentBranch: 'main',
        promptState: { startingCommit: null, dirty: false },
      }),
    )
    await settle()

    const composer = host.querySelector<HTMLElement>('.prompt-input')
    const submit = host.querySelector<HTMLButtonElement>('.submit-btn')
    assert.ok(composer)
    assert.ok(submit)
    composer.textContent = 'Hello'
    submit.click()
    await flush()

    const message = store.getState().threads[0]?.messages[0]
    assert.ok(message)
    assert.equal('startingCommit' in message, false)
    assert.equal(message.dirty, false)
  })
})

describe('draft prompt preservation', () => {
  it('keeps a drafted blank thread, restores its composer, and opens a fresh blank', async () => {
    const draftText = 'still typing a draft prompt…'
    const blankThread: Thread = {
      id: 'thread-blank',
      title: 'New Thread',
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 2,
      updatedAt: 2,
    }
    const usedThread: Thread = {
      id: 'thread-used',
      title: 'Used thread',
      status: 'idle',
      messages: [
        {
          id: 'message-used',
          role: 'user',
          content: 'hello from used thread',
          toolCalls: [],
          createdAt: 1,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
    }
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      expandedProjectId: 'project-1',
      activeThreadId: blankThread.id,
      threads: [blankThread, usedThread],
    })
    const api = createApi({ currentBranch: 'main' })
    const projectsHost = document.createElement('div')
    const inputHost = document.createElement('div')
    document.body.append(projectsHost, inputHost)
    mountProjectsPane(projectsHost, store, api)
    mountInputBar(inputHost, store, api)
    await settle()

    const composer = inputHost.querySelector<HTMLElement>('.prompt-input')
    assert.ok(composer)
    assert.equal(
      projectsHost.querySelector('.chat-row.selected .chat-title')?.textContent,
      'New Thread',
    )

    composer.textContent = draftText
    composer.dispatchEvent(new Event('input', { bubbles: true }))

    const clickThread = (title: string): void => {
      const row = [...projectsHost.querySelectorAll<HTMLElement>('.chat-row')].find(
        (candidate) => candidate.querySelector('.chat-title')?.textContent === title,
      )
      assert.ok(row, `expected sidebar row ${title}`)
      row.click()
    }

    clickThread('Used thread')
    assert.equal(store.getState().activeThreadId, usedThread.id)
    assert.equal(
      store.getState().threads.find((thread) => thread.id === blankThread.id)?.draftPrompt,
      draftText,
    )
    assert.equal(composer.textContent, '')
    assert.equal(
      store.getState().threads.find((thread) => thread.id === usedThread.id)?.messages[0]?.content,
      'hello from used thread',
    )

    clickThread('New Thread')
    assert.equal(store.getState().activeThreadId, blankThread.id)
    assert.equal(composer.textContent, draftText)

    const newThreadButton = projectsHost.querySelector<HTMLButtonElement>('.project-new-thread-btn')
    assert.ok(newThreadButton)
    newThreadButton.click()

    assert.equal(store.getState().threads.length, 3)
    assert.notEqual(store.getState().activeThreadId, blankThread.id)
    assert.equal(composer.textContent, '')
    assert.equal(
      store.getState().threads.filter((thread) => thread.title === 'New Thread').length,
      2,
    )

    // All three fit inside one sidebar page, so they are all listed and no
    // "Show more" appears (the window only pages past SIDEBAR_THREADS_PAGE_SIZE).
    assert.equal(projectsHost.querySelectorAll('.chats-list .chat-row').length, 3)
    assert.equal(projectsHost.querySelector('.chats-show-more'), null)
  })
})

describe('externally cleared draft', () => {
  it('empties the composer when an automation consumes the active thread draft', async () => {
    // A cron automation creates its thread with the scheduled prompt as the
    // draft, then clears that draft once it dispatches the run. The user is
    // already looking at the thread, so no thread switch happens — without a
    // `thread_draft_changed` subscription the sent prompt stays in the composer
    // and the next Enter sends it a second time.
    const scheduled: Thread = {
      id: 'thread-automation',
      title: 'CI review',
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      draftPrompt: 'Review CI and report any failures.',
      createdAt: 1,
      updatedAt: 1,
    }
    const existing: Thread = {
      id: 'thread-existing',
      title: 'Existing',
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
    }
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: existing.id,
      threads: [existing],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(host, store, createApi({ currentBranch: 'main' }))
    await settle()

    // Selecting the automation's thread loads its draft into the composer, the
    // same way clicking the sidebar row does.
    store.setState({ threads: [scheduled, existing], activeThreadId: scheduled.id })
    store.emit('threads_changed')
    await settle()

    const composer = host.querySelector<HTMLElement>('.prompt-input')
    assert.ok(composer)
    assert.equal(composer.textContent, 'Review CI and report any failures.')

    setThreadDraftPrompt(store, scheduled.id, '')
    await settle()

    assert.equal(composer.textContent, '')
  })

  it('leaves the composer alone when the draft change is its own autosave', async () => {
    const blank: Thread = {
      id: 'thread-blank',
      title: 'New Thread',
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
    }
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: blank.id,
      threads: [blank],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(host, store, createApi({ currentBranch: 'main' }))
    await settle()

    const composer = host.querySelector<HTMLElement>('.prompt-input')
    assert.ok(composer)
    composer.textContent = 'half a thought'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    setThreadDraftPrompt(store, blank.id, 'half a thought')
    await settle()

    assert.equal(composer.textContent, 'half a thought')
  })
})

describe('input bar model recents', () => {
  it('shows the current model first, followed by distinct thread models ordered by last use', async () => {
    const active: Thread = {
      ...thread(),
      id: 'thread-active',
      model: 'gpt-5.6-sol',
      updatedAt: 1,
    }
    const newest: Thread = {
      ...thread(),
      id: 'thread-newest',
      model: 'claude-opus-4-8',
      updatedAt: 3,
    }
    const older: Thread = {
      ...thread(),
      id: 'thread-older',
      model: 'claude-haiku-4-5',
      updatedAt: 2,
    }
    const duplicate: Thread = {
      ...thread(),
      id: 'thread-duplicate',
      model: 'claude-opus-4-8',
      updatedAt: 0,
    }
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: active.id,
      threads: [active, newest, older, duplicate],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(host, store, createApi({ currentBranch: 'main' }))
    await flush()

    const trigger = host.querySelector<HTMLButtonElement>('.model-picker-trigger')
    assert.ok(trigger)
    trigger.click()

    const recentLabels = [...host.querySelectorAll<HTMLElement>('.model-picker-option')].map(
      (option) => option.textContent.split(' — ')[0],
    )
    assert.deepEqual(recentLabels, ['GPT-5.6 Sol', 'Claude Opus 4.8', 'Claude Haiku 4.5'])
  })
})

/** A thread with one persisted message, which is what makes it exportable. */
function exportableThread(): Thread {
  const populated = thread()
  populated.messages = [
    {
      id: 'message-1',
      role: 'user',
      content: 'A persisted message makes this thread exportable.',
      toolCalls: [],
      createdAt: 1,
    },
  ]
  return populated
}

describe('input bar developer diagnostics', () => {
  it('hides diagnostics by default and reveals them in Developer mode', async () => {
    const populated = exportableThread()
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: populated.id,
      threads: [populated],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(host, store, createApi({ currentBranch: 'main' }))
    await settle()

    const overflow = host.querySelector<HTMLElement>('.footer-overflow')
    const trigger = host.querySelector<HTMLButtonElement>('.footer-overflow-trigger')
    assert.ok(overflow)
    assert.ok(trigger)
    assert.equal(overflow.hidden, false)
    trigger.click()
    // The two trace exits stay out in the open: someone whose thread just went
    // wrong is not going to have found a developer setting first.
    assert.deepEqual(
      Array.from(host.querySelectorAll('.footer-overflow-item')).map((item) =>
        item.textContent.trim(),
      ),
      ['Enable Guarded YOLO', 'Debug trace', 'Share trace'],
    )

    store.setState({ developerMode: true })
    store.emit('settings_changed')
    assert.equal(overflow.hidden, false)
    trigger.click()
    assert.deepEqual(
      Array.from(host.querySelectorAll('.footer-overflow-item')).map((item) =>
        item.textContent.trim(),
      ),
      [
        'Enable Guarded YOLO',
        'Copy thread ID',
        'Export conversation (JSONL)',
        'Export thread folder (ZIP)',
        'Debug trace',
        'Share trace',
      ],
    )

    store.setState({ developerMode: false })
    store.emit('settings_changed')
    assert.equal(overflow.hidden, false)
    trigger.click()
    assert.deepEqual(
      Array.from(host.querySelectorAll('.footer-overflow-item')).map((item) =>
        item.textContent.trim(),
      ),
      ['Enable Guarded YOLO', 'Debug trace', 'Share trace'],
    )
  })
})

describe('input bar debug trace', () => {
  function clickOverflowItem(host: HTMLElement, label: string): void {
    const trigger = host.querySelector<HTMLButtonElement>('.footer-overflow-trigger')
    assert.ok(trigger)
    trigger.click()
    const item = Array.from(host.querySelectorAll<HTMLButtonElement>('.footer-overflow-item')).find(
      (candidate) => candidate.textContent.trim() === label,
    )
    assert.ok(item, `overflow menu offers "${label}"`)
    item.click()
  }

  it('opens a new thread holding the zipped trace and an unsent diagnosis prompt', async () => {
    const populated = exportableThread()
    const exported: string[] = []
    const attached: { threadId: string; name: string; bytes: number }[] = []
    let runs = 0
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: populated.id,
      threads: [populated],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(
      host,
      store,
      createApi({
        currentBranch: 'main',
        onRun: async (): Promise<void> => {
          runs += 1
        },
        onExportArchive: (_projectId, threadId) => exported.push(threadId),
        onAttachArchive: (_projectId, threadId, name, bytes) => {
          attached.push({ threadId, name, bytes: bytes?.byteLength ?? 0 })
        },
      }),
    )
    await settle()

    clickOverflowItem(host, 'Debug trace')
    await flush()

    // The trace zipped is the thread the user was reading.
    assert.deepEqual(exported, [populated.id])

    const { activeThreadId, threads } = store.getState()
    assert.notEqual(activeThreadId, populated.id, 'the debug thread is a new, active thread')
    const debugThread = threads.find((candidate) => candidate.id === activeThreadId)
    assert.ok(debugThread)
    assert.equal(debugThread.title, 'Debug: Test thread')
    assert.equal(debugThread.messages.length, 0, 'nothing is sent on the user’s behalf')
    assert.equal(runs, 0, 'no agent run is dispatched')
    assert.match(debugThread.draftPrompt ?? '', /thread-1/)

    // The prompt is sitting in the composer, waiting to be added to and sent.
    const composer = host.querySelector<HTMLElement>('.prompt-input')
    assert.ok(composer)
    assert.match(composer.textContent, /Something went wrong in another Copse thread/)
    assert.match(composer.textContent, /What I saw:/)

    // ...with the archive stored under the *new* thread, so it lives as long as
    // the conversation about it does, and survives deleting the original.
    assert.equal(attached.length, 1)
    const [stored] = attached
    assert.ok(stored)
    assert.equal(stored.threadId, debugThread.id)
    assert.match(stored.name, /\.zip$/)
    assert.equal(stored.bytes, 4, 'the exported bytes reach the store intact')
    const chip = host.querySelector<HTMLElement>('.attachment-chips .archive-chip')
    assert.ok(chip, 'the trace shows as an archive chip on the new thread')
    assert.match(chip.textContent, /\.zip/)
  })

  it('leaves the user where they were when the export fails', async () => {
    const populated = exportableThread()
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: populated.id,
      threads: [populated],
    })
    const host = document.createElement('div')
    document.body.append(host)
    const base = createApi({ currentBranch: 'main' })
    mountInputBar(host, store, {
      ...base,
      threads: {
        ...base.threads,
        exportArchive: () => Promise.reject(new Error('store is gone')),
      },
    })
    await settle()

    clickOverflowItem(host, 'Debug trace')
    await flush()

    assert.equal(store.getState().activeThreadId, populated.id)
    assert.equal(store.getState().threads.length, 1, 'no empty thread is left behind')
  })
})

describe('input bar branch mismatch warning', () => {
  it('does not block submit when an isolated worktree binds a different branch', async () => {
    let runs = 0
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [
        {
          ...thread('copse/first-message'),
          worktreeChoice: 'worktree',
          worktree: {
            path: '/worktrees/thread-1',
            branch: 'copse/first-message',
            baseBranch: 'main',
            baseCommit: 'a'.repeat(40),
            createdAt: 2,
            seededFromDirtyProject: false,
          },
        },
      ],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(
      host,
      store,
      createApi({
        currentBranch: 'main',
        onRun: async () => {
          runs += 1
        },
      }),
    )
    await settle()

    const composer = host.querySelector<HTMLElement>('.prompt-input')
    const submitBtn = host.querySelector<HTMLButtonElement>('.submit-btn')
    assert.ok(composer)
    assert.ok(submitBtn)
    composer.textContent = 'Follow up in the worktree'
    submitBtn.click()
    await settle()

    assert.equal(runs, 1)
    const warning = host.querySelector<HTMLElement>('.composer-branch-warning')
    assert.ok(warning)
    assert.equal(warning.hidden, true)
  })

  it('shows an inline checkout action instead of native validation', async () => {
    let checkedOutBranch: string | null = null
    let branchRefreshes = 0
    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread('feature/thread-branch')],
    })
    store.on('git_branch_changed', () => {
      branchRefreshes += 1
    })
    const host = document.createElement('div')
    document.body.append(host)

    mountInputBar(
      host,
      store,
      createApi({
        currentBranch: 'main',
        onCheckoutBranch: async (branch) => {
          checkedOutBranch = branch
        },
      }),
    )
    await settle()

    const composer = host.querySelector<HTMLElement>('.prompt-input')
    assert.ok(composer)
    composer.textContent = 'Continue'
    const submitBtn = host.querySelector<HTMLButtonElement>('.submit-btn')
    assert.ok(submitBtn)
    submitBtn.click()
    await settle()

    const warning = host.querySelector<HTMLElement>('.composer-branch-warning')
    assert.ok(warning)
    assert.equal(warning.hidden, false)
    assert.match(warning.textContent, /This thread is for branch "feature\/thread-branch"/)

    const checkoutBtn = host.querySelector<HTMLButtonElement>('.composer-branch-checkout-btn')
    assert.ok(checkoutBtn)
    checkoutBtn.click()
    await settle()

    assert.equal(checkedOutBranch, 'feature/thread-branch')
    assert.equal(branchRefreshes, 1)
    assert.equal(warning.hidden, true)
  })
})

describe('input bar attachments across a thread switch', () => {
  /**
   * An attachment is bound to the thread that was active when it was attached:
   * `archive:attach` has already stored the file under that thread's
   * `blobs/media/`. Carrying the chip to another thread recorded a path into a
   * directory the receiving thread does not own — observed in the wild as a
   * thread whose `meta.archives` pointed into a different thread's blobs, which
   * dangles the moment the original thread is deleted.
   */
  it('drops attachment chips when the active thread changes', async () => {
    const first = thread()
    const second: Thread = { ...thread(), id: 'thread-2', title: 'Second' }
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: first.id,
      threads: [first, second],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(host, store, createApi({ currentBranch: 'main' }))
    await settle()

    const handlers = getPromptAttachmentHandlers()
    assert.ok(handlers, 'composer registered its attachment handlers')
    await handlers.attachArchive({ name: 'bundle.zip', bytes: new ArrayBuffer(8) })
    await settle()
    assert.equal(
      host.querySelectorAll('.attachment-chips .archive-chip').length,
      1,
      'the archive chip is attached to the active thread',
    )

    store.setState({ activeThreadId: second.id })
    store.emit('threads_changed')
    await settle()

    assert.equal(
      host.querySelectorAll('.attachment-chips .archive-chip').length,
      0,
      'switching threads clears the chip rather than re-homing it',
    )
  })

  it('binds a stored archive to the thread that was active when it was attached', async () => {
    // The other half of the same bug: the path the composer holds names the
    // attaching thread's directory, which is why carrying it across a switch
    // cannot be made correct simply by re-recording it on the new thread.
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(host, store, createApi({ currentBranch: 'main' }))
    await settle()

    const handlers = getPromptAttachmentHandlers()
    assert.ok(handlers)
    await handlers.attachArchive({ name: 'bundle.zip', bytes: new ArrayBuffer(8) })
    await settle()

    const chip = host.querySelector('.attachment-chips .archive-chip')
    assert.ok(chip)
    assert.match(chip.textContent, /bundle\.zip/)
  })
})

describe('input bar browse button', () => {
  it('opens the native file picker when the attach button is clicked', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(host, store, createApi({ currentBranch: 'main' }))
    await settle()

    const attachBtn = host.querySelector<HTMLButtonElement>('.attach-btn')
    assert.ok(attachBtn, 'attach button is rendered')
    const fileInput = host.querySelector<HTMLInputElement>('.attach-file-input')
    assert.ok(fileInput)
    assert.equal(attachBtn.getAttribute('aria-label'), 'Attach files')
    assert.equal(fileInput.type, 'file')
    assert.equal(fileInput.multiple, true)

    let clicked = false
    fileInput.click = (): void => {
      clicked = true
    }
    attachBtn.click()
    assert.equal(clicked, true, 'clicking the attach button opens the file picker')
  })

  it('attaches a selected file as a chip', async () => {
    const store = createStore({
      workspaceRoot: null,
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(host, store, createApi({ currentBranch: 'main' }))
    await settle()

    const fileInput = host.querySelector<HTMLInputElement>('.attach-file-input')
    assert.ok(fileInput)
    const file = new File(['hello world'], 'notes.txt', { type: 'text/plain' })
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    fileInput.dispatchEvent(new Event('change'))
    await flush()

    const chip = host.querySelector<HTMLElement>('.attachment-chips .attachment-chip')
    assert.ok(chip, 'an attachment chip is rendered for the selected file')
    // The name renders inside the clipped label span, so a long filename
    // ellipsizes instead of overflowing the pill.
    const label = chip.querySelector<HTMLElement>('.attachment-chip-label')
    assert.ok(label, 'the chip renders its name in the clipped label span')
    assert.match(label.textContent, /notes\.txt/)

    const composer = host.querySelector<HTMLElement>('.prompt-input')
    const submit = host.querySelector<HTMLButtonElement>('.submit-btn')
    assert.ok(composer)
    assert.ok(submit)
    composer.textContent = 'Review this file'
    submit.click()
    await flush()

    assert.deepEqual(store.getState().threads[0]?.messages[0]?.attachments, [
      { kind: 'file', label: 'notes.txt', content: 'hello world' },
    ])
  })
})

describe('input bar image compatibility', () => {
  function imageModelApi(onRun?: () => Promise<void>): ApiClient {
    return createApi({
      currentBranch: 'main',
      ...(onRun ? { onRun } : {}),
      availableProviders: async () => ({ openrouter: true }),
      openRouterModels: async () => [
        {
          id: 'deepseek/deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          inputPricePerMTok: 0,
          outputPricePerMTok: 0,
          supportsImages: false,
        },
        {
          id: 'anthropic/claude-sonnet',
          name: 'Claude Sonnet',
          inputPricePerMTok: 3,
          outputPricePerMTok: 15,
          supportsImages: true,
        },
      ],
      lmStudioModelInfo: async () => [
        { id: 'qwen/qwen3-vl', supportsImages: true },
        { id: 'qwen/qwen3-text', supportsImages: false },
      ],
    })
  }

  function imageModelStore(): ReturnType<typeof createStore> {
    return createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [{ ...thread(), model: 'openrouter:deepseek/deepseek-v4-flash' }],
    })
  }

  it('warns before send and keeps the image prompt intact while suggesting a supporting model', async () => {
    let runs = 0
    const store = imageModelStore()
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(
      host,
      store,
      imageModelApi(async () => {
        runs++
      }),
    )
    await settle()
    const composer = host.querySelector<HTMLElement>('.prompt-input')
    assert.ok(composer)
    composer.textContent = 'Describe this screenshot'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    getPromptAttachmentHandlers()?.attachImage('data:image/png;base64,abc', 'image/png')
    await flush()

    const warning = host.querySelector<HTMLElement>('.composer-image-warning')
    assert.ok(warning)
    assert.equal(warning.hidden, false)
    assert.match(warning.textContent, /DeepSeek V4 Flash can’t read image input/)
    assert.match(warning.textContent, /Use Claude Sonnet/)
    assert.match(warning.textContent, /Describe locally with qwen\/qwen3-vl/)

    host.querySelector<HTMLButtonElement>('.submit-btn')?.click()
    await flush()
    assert.equal(runs, 0, 'known-incompatible image prompt must not reach the provider')
    assert.equal(composer.textContent, 'Describe this screenshot')
    assert.equal(host.querySelectorAll('.image-chip').length, 1)

    host.querySelector<HTMLButtonElement>('.composer-image-model-btn')?.click()
    await flush()
    assert.equal(
      store.getState().threads[0]?.model,
      'openrouter:anthropic/claude-sonnet',
      'suggestion switches the thread but leaves sending to the user',
    )
    assert.equal(composer.textContent, 'Describe this screenshot')
    assert.equal(host.querySelectorAll('.image-chip').length, 1)
    assert.equal(warning.hidden, true)
  })

  it('can continue immediately by sending the prompt without its image', async () => {
    let runs = 0
    const store = imageModelStore()
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(
      host,
      store,
      imageModelApi(async () => {
        runs++
      }),
    )
    await settle()
    const composer = host.querySelector<HTMLElement>('.prompt-input')
    assert.ok(composer)
    composer.textContent = 'Continue from my text'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    getPromptAttachmentHandlers()?.attachImage('data:image/png;base64,abc', 'image/png')
    await flush()

    host.querySelector<HTMLButtonElement>('.composer-image-without-btn')?.click()
    await flush()
    assert.equal(runs, 1)
    const sent = store.getState().threads[0]?.messages.at(-1)
    assert.ok(sent)
    assert.equal(sent.content, 'Continue from my text')
    assert.equal(sent.images, undefined)
  })

  it('can describe locally, disclose the handoff, and send text to the selected model', async () => {
    let runs = 0
    let descriptorModel = ''
    let descriptorPrompt = ''
    const store = imageModelStore()
    const host = document.createElement('div')
    document.body.append(host)
    const api = imageModelApi(async () => {
      runs++
    })
    api.agent.describeImages = async (
      _projectId,
      _threadId,
      model,
      prompt,
      images,
    ): Promise<{ text: string }> => {
      descriptorModel = model
      descriptorPrompt = prompt
      assert.deepEqual(images, ['data:image/png;base64,abc'])
      return { text: 'A dark settings panel with a Sources section.' }
    }
    mountInputBar(host, store, api)
    await settle()
    const composer = host.querySelector<HTMLElement>('.prompt-input')
    assert.ok(composer)
    composer.textContent = 'Check the colour section'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    getPromptAttachmentHandlers()?.attachImage('data:image/png;base64,abc', 'image/png')
    await flush()

    host.querySelector<HTMLButtonElement>('.composer-image-describe-btn')?.click()
    await flush()

    assert.equal(descriptorModel, 'lmstudio:qwen/qwen3-vl')
    assert.equal(descriptorPrompt, 'Check the colour section')
    assert.equal(runs, 1)
    assert.equal(
      store.getState().threads[0]?.model,
      'openrouter:deepseek/deepseek-v4-flash',
      'the final turn stays on the originally selected text-only model',
    )
    const sent = store.getState().threads[0]?.messages.at(-1)
    assert.ok(sent)
    assert.equal(sent.images, undefined)
    assert.match(sent.content, /^Check the colour section/)
    assert.match(sent.content, /\[Image description generated by qwen\/qwen3-vl\]/)
    assert.match(sent.content, /A dark settings panel with a Sources section\./)
    assert.equal(host.querySelectorAll('.image-chip').length, 0)
  })
})

describe('input bar two-step stop', () => {
  it('arms on Escape and aborts on Enter without submitting the composer', async () => {
    let aborts = 0
    let runs = 0
    const runningThread = { ...thread(), status: 'running' as const }
    const store = createStore({
      workspaceRoot: '/repo',
      activeThreadId: runningThread.id,
      threads: [runningThread],
    })
    const host = document.createElement('div')
    document.body.append(host)
    const inputBar = mountInputBar(
      host,
      store,
      createApi({
        currentBranch: 'main',
        onAbort: async () => {
          aborts += 1
        },
        onRun: async () => {
          runs += 1
        },
      }),
    )
    await settle()

    const stopBtn = host.querySelector<HTMLButtonElement>('.stop-btn')
    const composer = host.querySelector<HTMLElement>('.prompt-input')
    assert.ok(stopBtn)
    assert.ok(composer)

    assert.equal(inputBar.handleStopShortcut('Escape'), true)
    assert.equal(stopBtn.classList.contains('stop-pending'), true)
    assert.equal(aborts, 0)

    composer.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await settle()

    assert.equal(aborts, 1)
    assert.equal(runs, 0)
    assert.equal(stopBtn.classList.contains('stop-pending'), false)
  })
})

describe('input bar skill invocation', () => {
  it('invokes /checkup even when the skills cache was primed empty', async () => {
    let runs = 0
    let listCalls = 0
    const checkup = {
      name: 'checkup',
      description: 'Run a Copse setup health check',
      source: 'bundled' as const,
      skillPath: '/app/assets/skills/checkup/SKILL.md',
      externalLinks: [] as string[],
    }
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      // Non-blank thread so submit skips checkout preparation.
      threads: [
        {
          ...thread(),
          messages: [{ id: 'm1', role: 'user', content: 'hi', toolCalls: [], createdAt: 1 }],
        },
      ],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(
      host,
      store,
      createApi({
        currentBranch: 'main',
        listSkills: async () => {
          listCalls += 1
          // First call primes the mount-time cache as empty (registry still
          // scanning). Later calls — picker open / submit — see checkup.
          return listCalls === 1 ? [] : [checkup]
        },
        onRun: async () => {
          runs += 1
        },
      }),
    )
    await flush()

    const composer = host.querySelector<HTMLElement>('.prompt-input')
    const submitBtn = host.querySelector<HTMLButtonElement>('.submit-btn')
    assert.ok(composer)
    assert.ok(submitBtn)

    // Open the slash picker the way a user would: type `/checkup`.
    composer.textContent = '/checkup'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()

    const picker = host.querySelector<HTMLElement>('.skill-picker')
    assert.ok(picker)
    assert.equal(picker.hidden, false)
    assert.equal(picker.querySelector('.skill-item-name')?.textContent, '/checkup')

    submitBtn.click()
    await flush()

    assert.equal(
      document.querySelector('.toast-error')?.textContent ?? '',
      '',
      'must not toast Unknown skill when checkup is registered',
    )
    assert.equal(runs, 1)
  })
})

describe('input bar footer overflow menu', () => {
  // The demo suite pins these labels and their order, but `build` (which runs it)
  // is skipped on draft PRs — so the Guarded YOLO item was added to this menu and
  // the stale count assertion only surfaced when #1251 left draft. Assert it here
  // too, where it runs in the ordinary unit suite.
  it('puts the Guarded YOLO action first among the thread actions', async () => {
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(host, store, createApi({ currentBranch: 'main' }))
    await settle()

    const trigger = host.querySelector<HTMLButtonElement>('.footer-overflow-trigger')
    assert.ok(trigger)
    trigger.click()
    await settle()

    const labels = [...host.querySelectorAll('.footer-overflow-item')].map(
      (item) => item.textContent,
    )
    // Developer diagnostics are disabled for this fixture, so only the ordinary
    // thread action remains visible.
    assert.deepEqual(labels, ['Enable Guarded YOLO'])
  })
})

describe('input bar footer usage counter', () => {
  function usageThread(): Thread {
    return {
      ...thread(),
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 12_900_000, outputTokens: 211_000 },
    }
  }

  async function mountWithUsage(): Promise<HTMLElement> {
    const store = createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [usageThread()],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(host, store, createApi({ currentBranch: 'main' }))
    await settle()
    return host
  }

  it('shows the total on the counter and the in/out/cost split on hover', async () => {
    const host = await mountWithUsage()

    const counter = host.querySelector<HTMLElement>('.footer-usage')
    assert.ok(counter)
    assert.equal(counter.textContent, '13.1M tokens')

    const popover = host.querySelector<HTMLElement>('.footer-usage-popover')
    assert.ok(popover)
    assert.equal(popover.hidden, true)

    counter.dispatchEvent(new Event('mouseenter'))
    assert.equal(popover.hidden, false)
    assert.match(popover.textContent, /Usage · 13\.1M tokens/)
    assert.match(popover.textContent, /Input\s*12\.9M/)
    assert.match(popover.textContent, /Output\s*211\.0k/)
    assert.match(popover.textContent, /Cost/)

    counter.dispatchEvent(new Event('mouseleave'))
    assert.equal(popover.hidden, true)
  })

  it('no longer toggles the breakdown on click', async () => {
    const host = await mountWithUsage()

    const counter = host.querySelector<HTMLElement>('.footer-usage')
    assert.ok(counter)
    counter.click()
    await settle()

    assert.equal(counter.textContent, '13.1M tokens')
    const popover = host.querySelector<HTMLElement>('.footer-usage-popover')
    assert.equal(popover?.hidden, true)
  })
})

describe('input bar context fit warning', () => {
  function contextFitStore(model: string): ReturnType<typeof createStore> {
    return createStore({
      workspaceRoot: '/repo',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [{ ...thread(), model }],
    })
  }

  function estimate(
    totalTokens: number,
    contextWindow: number,
  ): ApiClient['agent']['estimateContext'] {
    return async () => ({
      segments: [{ key: 'history' as const, label: 'Conversation', tokens: totalTokens }],
      totalTokens,
      contextWindow,
    })
  }

  async function mountWithEstimate(
    model: string,
    totalTokens: number,
    contextWindow: number,
  ): Promise<HTMLElement> {
    const host = document.createElement('div')
    document.body.append(host)
    mountInputBar(
      host,
      contextFitStore(model),
      createApi({ currentBranch: 'main', estimateContext: estimate(totalTokens, contextWindow) }),
    )
    await settle()
    await flush()
    return host
  }

  it('explains an overflowing thread and offers the model picker', async () => {
    const host = await mountWithEstimate('gpt-4o-mini', 240_000, 128_000)

    const warning = host.querySelector<HTMLElement>('.composer-context-warning')
    assert.ok(warning)
    assert.equal(warning.hidden, false)
    assert.match(warning.textContent, /no longer fits “GPT-4o mini”/)
    assert.match(warning.textContent, /240K tokens/)
    assert.match(warning.textContent, /context window holds 128K/)
    assert.match(warning.textContent, /Pick a model with a larger context window/)
    assert.ok(warning.classList.contains('is-over'))

    const menu = host.querySelector<HTMLElement>('.model-picker-menu')
    assert.ok(menu)
    assert.equal(menu.hidden, true)
    host.querySelector<HTMLButtonElement>('.composer-context-model-btn')?.click()
    await flush()
    assert.equal(menu.hidden, false, 'the action opens the model picker rather than just advising')
  })

  it('warns before the window is full, without the overflow styling', async () => {
    const host = await mountWithEstimate('gpt-4o-mini', 121_600, 128_000)

    const warning = host.querySelector<HTMLElement>('.composer-context-warning')
    assert.ok(warning)
    assert.equal(warning.hidden, false)
    assert.match(warning.textContent, /already fills 95% of the 128K context window/)
    assert.equal(warning.classList.contains('is-over'), false)
  })

  it('points local models at their load-time context length', async () => {
    const host = await mountWithEstimate('lmstudio:qwen3-4b', 12_000, 8000)

    const warning = host.querySelector<HTMLElement>('.composer-context-warning')
    assert.ok(warning)
    assert.equal(warning.hidden, false)
    assert.match(warning.textContent, /qwen3-4b/)
    assert.match(warning.textContent, /“Context Length” in LM Studio/)
  })

  it('stays hidden while the thread fits', async () => {
    const host = await mountWithEstimate('gpt-4o-mini', 12_000, 128_000)

    assert.equal(host.querySelector<HTMLElement>('.composer-context-warning')?.hidden, true)
  })
})

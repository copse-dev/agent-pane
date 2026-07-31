import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { setThreadDraftPrompt } from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountInputBar } from './input-bar.ts'
import { mountProjectsPane } from './projects-pane.ts'
import type { PreparedThreadCheckout, ThreadCheckoutPreview } from '@shared/types/worktree.ts'
import type { SkillSummary } from '@shared/types/skills.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

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
}): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      agent: {
        ...base['agent'],
        abort: options.onAbort ?? (async (): Promise<void> => {}),
        run: options.onRun ?? (async (): Promise<void> => {}),
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
      },
      settings: {
        ...base['settings'],
        availableProviders: async () => ({ anthropic: true, openai: true }),
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

describe('input bar developer diagnostics', () => {
  it('hides diagnostics by default and reveals them in Developer mode', async () => {
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
    assert.deepEqual(
      Array.from(host.querySelectorAll('.footer-overflow-item')).map((item) =>
        item.textContent.trim(),
      ),
      ['Enable Guarded YOLO'],
    )

    store.setState({ developerMode: true })
    store.emit('settings_changed')
    assert.equal(overflow.hidden, false)
    trigger.click()
    assert.deepEqual(
      Array.from(host.querySelectorAll('.footer-overflow-item')).map((item) =>
        item.textContent.trim(),
      ),
      ['Enable Guarded YOLO', 'Copy thread ID', 'Export conversation (JSONL)', 'Share trace'],
    )

    store.setState({ developerMode: false })
    store.emit('settings_changed')
    assert.equal(overflow.hidden, false)
    trigger.click()
    assert.deepEqual(
      Array.from(host.querySelectorAll('.footer-overflow-item')).map((item) =>
        item.textContent.trim(),
      ),
      ['Enable Guarded YOLO'],
    )
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

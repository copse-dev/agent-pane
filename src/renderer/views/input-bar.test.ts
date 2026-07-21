import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountInputBar } from './input-bar.ts'
import type { PreparedThreadCheckout, ThreadCheckoutPreview } from '@shared/types/worktree.ts'

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

;(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = TestResizeObserver
;(globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame = (
  callback,
): number =>
  setTimeout(() => {
    callback(Date.now())
  }, 0) as unknown as number
;(globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame }).cancelAnimationFrame = (
  id,
): void => {
  clearTimeout(id)
}
;(globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver =
  window.MutationObserver

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
}): ApiClient {
  return {
    agent: {
      abort: options.onAbort ?? (async (): Promise<void> => {}),
      run: options.onRun ?? (async (): Promise<void> => {}),
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
      refreshModelContext: async () => {},
      onRefreshContextEstimate: () => () => {},
    },
    fs: {
      onChanged: () => () => {},
    },
    git: {
      branchStatus: async () => ({ currentBranch: options.currentBranch, pr: null }),
      checkoutBranch: options.onCheckoutBranch ?? (async (): Promise<void> => {}),
      listBranches: async () => [{ name: options.currentBranch, lastCommitDate: '2024-01-01' }],
      getDefaultBranch: async () => 'main',
    },
    lmStudio: {
      models: async () => [],
    },
    settings: {
      availableProviders: async () => ({ anthropic: true, openai: true }),
      extraProviders: async () => [],
      get: async () => undefined,
      set: async () => {},
    },
    skills: {
      list: async () => [],
    },
    index: {
      status: async () => ({
        fileIndex: { phase: 'idle' },
        semantic: { phase: 'idle' },
      }),
      onStatusChanged: () => () => {},
    },
  } as unknown as ApiClient
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

describe('input bar developer diagnostics', () => {
  it('hides the overflow by default and reveals both diagnostics in Developer mode', async () => {
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
    assert.equal(overflow.hidden, true)

    store.setState({ developerMode: true })
    store.emit('settings_changed')
    assert.equal(overflow.hidden, false)
    trigger.click()
    assert.deepEqual(
      Array.from(host.querySelectorAll('.footer-overflow-item')).map((item) =>
        item.textContent.trim(),
      ),
      ['Copy thread ID', 'Export conversation (JSONL)'],
    )

    store.setState({ developerMode: false })
    store.emit('settings_changed')
    assert.equal(overflow.hidden, true)
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

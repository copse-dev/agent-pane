import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountInputBar } from './input-bar.ts'

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
  onCheckoutBranch?: (branch: string) => Promise<void>
}): ApiClient {
  return {
    agent: {
      abort: async () => {},
      run: async () => {},
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

describe('input bar branch mismatch warning', () => {
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
    assert.match(chip.textContent, /notes\.txt/)
  })
})

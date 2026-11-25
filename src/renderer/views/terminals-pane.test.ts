import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { build } from 'esbuild'
import type { ApiClient } from '../../preload/api.d.ts'
import { createStore, type AppStore } from '@shared/store/store.ts'
import type { CodeBlockRunResult } from '@shared/store/events.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { makeThread } from '../thread-fixture.test-support.ts'

type MountPane = typeof import('./terminals-pane.ts').mountTerminalsPane
type CreatedTerminal = Awaited<ReturnType<ApiClient['terminal']['create']>>
type CreateRequest = ReturnType<typeof deferred<CreatedTerminal>> & {
  meta: Parameters<ApiClient['terminal']['create']>[2]
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let finish: ((value: T) => void) | undefined
  let fail: ((error: Error) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  return {
    promise,
    resolve: (value): void => {
      assert.ok(finish)
      finish(value)
    },
    reject: (error): void => {
      assert.ok(fail)
      fail(error)
    },
  }
}

let paneModule: Promise<MountPane> | undefined

/** Inject the emulator at its import boundary, without a product test flag. */
function loadPane(): Promise<MountPane> {
  paneModule ??= (async (): Promise<MountPane> => {
    const result = await build({
      entryPoints: [resolve('src/renderer/views/terminals-pane.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      alias: { '@shared': resolve('src/shared') },
      loader: { '.css': 'empty' },
      plugins: [
        {
          name: 'terminal-emulator-boundary',
          setup(build): void {
            build.onResolve({ filter: /^@xterm\/(?:xterm|addon-fit)$/ }, () => ({
              path: resolve('src/renderer/terminal/xterm.test-support.ts'),
            }))
          },
        },
      ],
    })
    const javascript = result.outputFiles[0]
    assert.ok(javascript)
    const loaded: unknown = await import(
      `data:text/javascript;base64,${Buffer.from(javascript.contents).toString('base64')}`
    )
    assert.ok(typeof loaded === 'object' && loaded !== null)
    const mount: unknown = Reflect.get(loaded, 'mountTerminalsPane')
    assert.ok(typeof mount === 'function')
    return (listRoot, viewerRoot, store, api): (() => void) => {
      const dispose: unknown = Reflect.apply(mount, undefined, [listRoot, viewerRoot, store, api])
      assert.ok(typeof dispose === 'function')
      return (): void => {
        Reflect.apply(dispose, undefined, [])
      }
    }
  })()
  return paneModule
}

const disposePanes: Array<() => void> = []

afterEach(async () => {
  disposePanes.splice(0).forEach((dispose) => {
    dispose()
  })
  await setImmediate()
  document.body.replaceChildren()
})

async function mountPendingTerminal(): Promise<{
  nextCreate: () => Promise<CreateRequest>
  createCount: () => number
  store: AppStore
  activated: string[]
  writes: Array<{ sessionId: string; data: string }>
  destroyed: string[]
  emit: (sessionId: string, data: string) => void
  exit: (sessionId: string, code: number) => void
  output: (index?: number) => string
  add: () => void
  close: (index?: number) => void
  dispose: () => void
}> {
  Object.assign(globalThis, {
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
  })
  const store = createStore({
    workspaceRoot: '/workspace/project',
    projects: [{ id: 'project', path: '/workspace/project', name: 'Project' }],
    activeProjectId: 'project',
    activeThreadId: null,
    filesPaneOpen: true,
    rightPanelMode: 'terminal',
  })
  const creates: CreateRequest[] = []
  let createCount = 0
  let waitingCreate: ReturnType<typeof deferred<CreateRequest>> | null = null
  const activated: string[] = []
  const writes: Array<{ sessionId: string; data: string }> = []
  const destroyed: string[] = []
  let outputHandler: ((sessionId: string, data: string) => void) | null = null
  let exitHandler: ((sessionId: string, code: number) => void) | null = null
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    terminal: {
      ...base.terminal,
      create: (_cols, _rows, meta) => {
        createCount += 1
        const created: CreateRequest = { ...deferred<CreatedTerminal>(), meta }
        if (waitingCreate) {
          waitingCreate.resolve(created)
          waitingCreate = null
        } else creates.push(created)
        return created.promise
      },
      write: async (sessionId, data) => {
        writes.push({ sessionId, data })
      },
      setActive: async (sessionId) => {
        activated.push(sessionId)
      },
      destroy: async (sessionId) => {
        destroyed.push(sessionId)
      },
      onOutput: (handler) => {
        outputHandler = handler
        return () => {
          outputHandler = null
        }
      },
      onExit: (handler) => {
        exitHandler = handler
        return () => {
          exitHandler = null
        }
      },
    },
  }
  const list = document.createElement('div')
  const viewer = document.createElement('div')
  document.body.append(list, viewer)
  const mount = await loadPane()
  const dispose = mount(list, viewer, store, api)
  disposePanes.push(dispose)
  return {
    nextCreate: (): Promise<CreateRequest> => {
      const created = creates.shift()
      if (created) return Promise.resolve(created)
      assert.equal(waitingCreate, null)
      waitingCreate = deferred<CreateRequest>()
      return waitingCreate.promise
    },
    createCount: () => createCount,
    store,
    activated,
    writes,
    destroyed,
    emit: (sessionId, data) => outputHandler?.(sessionId, data),
    exit: (sessionId, code) => exitHandler?.(sessionId, code),
    output: (index = 0) =>
      viewer.querySelectorAll('.terminals-tab-panel')[index]?.textContent ?? '',
    add: (): void => {
      const button = list.querySelector('.terminals-new-btn')
      assert.ok(button instanceof HTMLElement)
      button.click()
    },
    close: (index = 0): void => {
      const button = list.querySelectorAll('.terminals-tab-close')[index]
      assert.ok(button instanceof HTMLElement)
      button.click()
    },
    dispose,
  }
}

describe('terminal pane create/output ordering', () => {
  it(
    'renders output received after the authorized create response',
    { timeout: 5000 },
    async () => {
      const pane = await mountPendingTerminal()
      const created = await pane.nextCreate()
      created.resolve({ sessionId: 'owned-session', checkoutMode: 'shared' })
      await setImmediate()
      assert.deepEqual(pane.activated, ['owned-session'])
      pane.emit('owned-session', '$ late\n')
      await setImmediate()
      assert.equal(pane.output(), '$ late\n')
    },
  )

  it(
    'retains same-session output delivered before create resolves',
    { timeout: 5000 },
    async () => {
      const pane = await mountPendingTerminal()
      const created = await pane.nextCreate()
      pane.emit('owned-session', '$ early\n')
      created.resolve({ sessionId: 'owned-session', checkoutMode: 'shared' })
      await setImmediate()
      assert.deepEqual(pane.activated, ['owned-session'])
      pane.emit('owned-session', 'later\n')
      await setImmediate()
      assert.equal(pane.output(), '$ early\nlater\n')
    },
  )

  it(
    'keeps unrelated session output out of the authorized terminal',
    { timeout: 5000 },
    async () => {
      const pane = await mountPendingTerminal()
      const created = await pane.nextCreate()
      pane.emit('different-session', 'foreign\n')
      created.resolve({ sessionId: 'owned-session', checkoutMode: 'shared' })
      await setImmediate()
      assert.deepEqual(pane.activated, ['owned-session'])
      pane.emit('owned-session', '$ owned\n')
      await setImmediate()
      assert.equal(pane.output(), '$ owned\n')
    },
  )

  it(
    'routes concurrent early streams only to their exact returned sessions',
    { timeout: 5000 },
    async () => {
      const pane = await mountPendingTerminal()
      const first = await pane.nextCreate()
      pane.add()
      const second = await pane.nextCreate()
      pane.emit('first-session', 'first early\n')
      pane.emit('second-session', 'second early\n')
      second.resolve({ sessionId: 'second-session', checkoutMode: 'shared' })
      await setImmediate()
      assert.equal(pane.output(0), '')
      assert.equal(pane.output(1), 'second early\n')
      pane.emit('first-session', 'first later\n')
      first.resolve({ sessionId: 'first-session', checkoutMode: 'shared' })
      await setImmediate()
      assert.equal(pane.output(0), 'first early\nfirst later\n')
      assert.equal(pane.output(1), 'second early\n')
    },
  )

  it(
    'replays an early exit after its output and leaves no live session',
    { timeout: 5000 },
    async () => {
      const pane = await mountPendingTerminal()
      const created = await pane.nextCreate()
      pane.emit('short-session', 'finished\n')
      pane.exit('short-session', 7)
      created.resolve({ sessionId: 'short-session', checkoutMode: 'shared' })
      await setImmediate()
      assert.match(pane.output(), /^finished\n\r\n.*Process exited with code 7/)
      assert.deepEqual(pane.activated, [])
      pane.dispose()
      await setImmediate()
      assert.deepEqual(pane.destroyed, [])
    },
  )

  it(
    'preserves project and thread ownership across a switch during create',
    { timeout: 5000 },
    async () => {
      const pane = await mountPendingTerminal()
      const first = await pane.nextCreate()
      pane.store.setState({
        workspaceRoot: '/workspace/other',
        activeProjectId: 'other-project',
        projects: [{ id: 'other-project', path: '/workspace/other', name: 'Other' }],
        activeThreadId: 'other-thread',
        threads: [makeThread({ id: 'other-thread' })],
      })
      const second = await pane.nextCreate()
      assert.deepEqual(first.meta, { label: 'Terminal 1', projectId: 'project', threadId: null })
      assert.deepEqual(second.meta, {
        label: 'Terminal 2',
        projectId: 'other-project',
        threadId: 'other-thread',
      })
      pane.emit('first-project-session', 'first project\n')
      pane.emit('other-project-session', 'other project\n')
      first.resolve({ sessionId: 'first-project-session', checkoutMode: 'shared' })
      second.resolve({ sessionId: 'other-project-session', checkoutMode: 'shared' })
      await setImmediate()
      assert.equal(pane.output(0), 'first project\n')
      assert.equal(pane.output(1), 'other project\n')
    },
  )

  it(
    'reports parsed early code-block output before its exit banner',
    { timeout: 5000 },
    async () => {
      const pane = await mountPendingTerminal()
      const initial = await pane.nextCreate()
      initial.resolve({ sessionId: 'initial-session', checkoutMode: 'shared' })
      await setImmediate()
      const finished = deferred<CodeBlockRunResult>()
      const results: CodeBlockRunResult[] = []
      pane.store.on('code_block_run_finished', (result) => {
        results.push(result)
        finished.resolve(result)
      })
      pane.store.emit('code_block_run_requested', {
        id: 'code-run',
        command: 'printf early',
        projectId: 'project',
        threadId: 'code-thread',
      })
      const created = await pane.nextCreate()
      pane.emit('code-session', 'early block output\n')
      pane.exit('code-session', 7)
      created.resolve({ sessionId: 'code-session', checkoutMode: 'shared' })
      assert.equal(results.length, 0)
      const result = await finished.promise
      assert.equal(result.id, 'code-run')
      assert.equal(result.exitCode, 7)
      assert.equal(result.output, 'early block output')
      assert.match(result.shell.content, /Terminal output:\nearly block output$/)
      assert.doesNotMatch(result.output, /Process exited|Terminal stopped/)
      pane.dispose()
      await setImmediate()
      assert.equal(results.length, 1)
    },
  )

  it(
    'does not replay a finished code-block startup command into a replacement shell',
    { timeout: 5000 },
    async () => {
      const pane = await mountPendingTerminal()
      const initial = await pane.nextCreate()
      initial.resolve({ sessionId: 'initial-session', checkoutMode: 'shared' })
      await setImmediate()
      pane.store.emit('code_block_run_requested', {
        id: 'early-exit-run',
        command: 'printf should-not-replay',
        projectId: 'project',
        threadId: 'code-thread',
      })
      const created = await pane.nextCreate()
      pane.emit('finished-session', 'startup failed\n')
      pane.exit('finished-session', 7)
      created.resolve({ sessionId: 'finished-session', checkoutMode: 'shared' })
      await setImmediate()
      assert.deepEqual(pane.writes, [])
      pane.store.setState({
        activeThreadId: 'code-thread',
        threads: [makeThread({ id: 'code-thread' })],
      })
      const replacement = await pane.nextCreate()
      replacement.resolve({ sessionId: 'replacement-session', checkoutMode: 'shared' })
      await setImmediate()
      assert.deepEqual(pane.writes, [])
    },
  )

  it(
    'does not replay startup input after a failed create is retried',
    { timeout: 5000 },
    async () => {
      const pane = await mountPendingTerminal()
      const initial = await pane.nextCreate()
      initial.resolve({ sessionId: 'initial-session', checkoutMode: 'shared' })
      await setImmediate()
      pane.store.emit('code_block_run_requested', {
        id: 'rejected-run',
        command: 'printf should-not-retry',
        projectId: 'project',
        threadId: 'code-thread',
      })
      const rejected = await pane.nextCreate()
      rejected.reject(new Error('create refused'))
      await setImmediate()
      pane.store.setState({
        activeThreadId: 'code-thread',
        threads: [makeThread({ id: 'code-thread' })],
      })
      const replacement = await pane.nextCreate()
      replacement.resolve({ sessionId: 'replacement-session', checkoutMode: 'shared' })
      await setImmediate()
      assert.deepEqual(pane.writes, [])
    },
  )

  it(
    'writes normal startup input once to its original authorized shell',
    { timeout: 5000 },
    async () => {
      const pane = await mountPendingTerminal()
      const initial = await pane.nextCreate()
      initial.resolve({ sessionId: 'initial-session', checkoutMode: 'shared' })
      await setImmediate()
      pane.store.emit('code_block_run_requested', {
        id: 'normal-run',
        command: 'printf once',
        projectId: 'project',
        threadId: 'code-thread',
      })
      const created = await pane.nextCreate()
      created.resolve({ sessionId: 'code-session', checkoutMode: 'shared' })
      await setImmediate()
      assert.deepEqual(pane.writes, [{ sessionId: 'code-session', data: 'printf once\rexit\r' }])
    },
  )

  it('discards unmatched early data when creation rejects', { timeout: 5000 }, async () => {
    const pane = await mountPendingTerminal()
    const rejected = await pane.nextCreate()
    pane.emit('later-session', 'stale output\n')
    rejected.reject(new Error('create refused'))
    await setImmediate()
    assert.match(pane.output(), /Failed to start terminal: create refused/)
    pane.add()
    const later = await pane.nextCreate()
    later.resolve({ sessionId: 'later-session', checkoutMode: 'shared' })
    await setImmediate()
    assert.equal(pane.output(1), '')
  })

  it('destroys a create result arriving after its tab closes', { timeout: 5000 }, async () => {
    const pane = await mountPendingTerminal()
    const closed = await pane.nextCreate()
    pane.emit('closed-session', 'closed output\n')
    pane.close()
    await setImmediate()
    const replacement = await pane.nextCreate()
    closed.resolve({ sessionId: 'closed-session', checkoutMode: 'shared' })
    replacement.resolve({ sessionId: 'replacement-session', checkoutMode: 'shared' })
    await setImmediate()
    assert.deepEqual(pane.destroyed, ['closed-session'])
    assert.deepEqual(pane.activated, ['replacement-session'])
    assert.equal(pane.output(), '')
  })

  it(
    'destroys a late create result without publishing after pane disposal',
    { timeout: 5000 },
    async () => {
      const pane = await mountPendingTerminal()
      const created = await pane.nextCreate()
      pane.emit('disposed-session', 'disposed output\n')
      pane.dispose()
      created.resolve({ sessionId: 'disposed-session', checkoutMode: 'shared' })
      await setImmediate()
      assert.deepEqual(pane.destroyed, ['disposed-session'])
      assert.deepEqual(pane.activated, [])
    },
  )

  it(
    'does not create a session after disposal during lazy emulator loading',
    { timeout: 5000 },
    async () => {
      const pane = await mountPendingTerminal()
      pane.dispose()
      await setImmediate()
      assert.equal(pane.createCount(), 0)
      assert.deepEqual(pane.activated, [])
    },
  )
})

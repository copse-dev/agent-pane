import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { HooksListResult } from '@shared/types/hooks.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createSourcesSection } from './settings/sources-section.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: Error) => void
}

interface LifecycleState {
  html: string
  headings: number
}

interface Harness {
  section: ReturnType<typeof createSourcesSection>
  status: Element
  list: Element
  state: () => LifecycleState
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    throw new Error('deferred promise not initialized')
  }
  let reject: (reason: Error) => void = () => {
    throw new Error('deferred promise not initialized')
  }
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function hooks(command: string): HooksListResult {
  return {
    hooks: [
      {
        family: 'cursor',
        event: 'beforeShellExecution',
        command,
        source: '/workspace/.cursor/hooks.json',
        scope: 'project',
        supported: true,
      },
    ],
    warnings: [],
  }
}

function harness(requests: Promise<HooksListResult>[]): Harness {
  const root = document.createElement('div')
  root.innerHTML = `
    <section class="settings-content">
      <button id="sources-reload-btn">Reload</button>
      <span id="sources-reload-status"></span>
      <div id="sources-instructions-list"></div>
      <fieldset id="cursor-rules-fieldset"><div id="sources-cursor-rules-list"></div></fieldset>
      <div id="sources-skills-list"></div>
      <div id="sources-agents-list"></div>
      <div id="sources-hooks-list"></div>
    </section>`
  document.body.replaceChildren(root)
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    instructions: { ...base.instructions, list: () => Promise.resolve([]) },
    cursorRules: { ...base.cursorRules, list: () => Promise.resolve([]) },
    skills: { ...base.skills, list: () => Promise.resolve([]) },
    agents: {
      ...base.agents,
      list: () => Promise.resolve({ agents: [], skipped: [], shadowed: [] }),
    },
    hooks: {
      ...base.hooks,
      list: () => {
        const request = requests.shift()
        assert.ok(request, 'each refresh must consume its fixture request')
        return request
      },
    },
  }
  let headings = 0
  const section = createSourcesSection({
    root,
    api,
    onTrusted: () => {},
    onHeadingsChanged: () => {
      headings += 1
    },
  })
  const status = root.querySelector('#sources-reload-status')
  const list = root.querySelector('#sources-hooks-list')
  assert.ok(status)
  assert.ok(list)
  return {
    section,
    status,
    list,
    state: (): LifecycleState => ({ html: root.innerHTML, headings }),
  }
}

describe('Sources discovery lifecycle', () => {
  it('keeps the newer refresh when an older success arrives last', async () => {
    const older = deferred<HooksListResult>()
    const newer = deferred<HooksListResult>()
    const h = harness([older.promise, newer.promise])
    const first = h.section.refresh()
    assert.equal(h.status.textContent, 'Loading…')
    const second = h.section.refresh()
    newer.resolve(hooks('new-command'))
    await second
    assert.equal(h.status.textContent, '')
    assert.match(h.list.textContent, /new-command/)
    assert.equal(h.state().headings, 1)
    const accepted = h.state()
    older.resolve(hooks('old-command'))
    await first
    assert.deepEqual(h.state(), accepted)
  })

  it('ignores an older rejection after a newer successful refresh', async () => {
    const older = deferred<HooksListResult>()
    const h = harness([older.promise, Promise.resolve(hooks('new-command'))])
    const first = h.section.refresh()
    await h.section.refresh()
    assert.equal(h.status.textContent, '')
    assert.match(h.list.textContent, /new-command/)
    assert.equal(h.state().headings, 1)
    const accepted = h.state()
    older.reject(new Error('stale discovery failure'))
    await first
    assert.deepEqual(h.state(), accepted)
  })

  for (const outcome of ['success', 'failure']) {
    it(`ignores a late ${outcome} after invalidation`, async () => {
      const pending = deferred<HooksListResult>()
      const h = harness([Promise.resolve(hooks('accepted-command')), pending.promise])
      await h.section.refresh()
      assert.match(h.list.textContent, /accepted-command/)
      assert.equal(h.state().headings, 1)
      const refresh = h.section.refresh()
      assert.equal(h.status.textContent, 'Loading…')
      h.section.invalidate()
      const invalidated = h.state()
      if (outcome === 'success') pending.resolve(hooks('stale-command'))
      else pending.reject(new Error('stale discovery failure'))
      await refresh
      assert.deepEqual(h.state(), invalidated)
    })
  }
})

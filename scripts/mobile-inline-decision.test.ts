import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { buildMobileAssets } from './mobile-build.mts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const row = {
  projectId: 'p',
  threadId: 't',
  projectName: 'Project',
  title: 'Review the release',
  state: 'needs-approval',
  group: 'needs-you',
  detail: '1 approval waiting',
  lastSavedAt: 0,
}
const pending = {
  access: 'control',
  sessionId: 's',
  runId: null,
  title: row.title,
  decisions: [{ id: 'decision', kind: 'approval', title: 'Run check?', body: 'pnpm run check' }],
  attention: [],
  messages: [],
}

async function harness(): Promise<{
  document: Document
  inline: HTMLElement | null
  requests: Array<(data: unknown) => void>
  poll(): void
  respond(index: number, data: unknown): void
  click(): void
  close(): Promise<void>
}> {
  const output = await mkdtemp('dist-mobile-inline-test-')
  await buildMobileAssets(output)
  const dom = new JSDOM(await readFile(join(output, 'index.html'), 'utf8'), {
    url: 'https://192.168.1.41:4000',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  const { window } = dom
  // JSDOM has no viewport intersection API; these fixtures contain no images.
  Object.defineProperty(window, 'IntersectionObserver', {
    value: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  })
  let poll = (): void => {}
  const requests: Array<(data: unknown) => void> = []
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: false, addEventListener(): void {} }),
  })
  Object.defineProperty(window, 'setInterval', {
    value: (callback: () => void) => {
      poll = callback
      return 1
    },
  })
  Object.defineProperty(window, 'fetch', {
    value: async (
      path: string,
    ): Promise<{
      ok: boolean
      status: number
      json(): Promise<unknown>
    }> => ({
      ok: true,
      status: 200,
      json: () =>
        path === '/api/activity'
          ? Promise.resolve({ access: 'control', sessionId: 's', projects: [], rows: [row] })
          : new Promise<unknown>((resolve) => requests.push(resolve)),
    }),
  })
  window.localStorage.setItem('copse-mobile-token', 'test-token')
  const inline = window.document.getElementById('inline-decision')
  window.eval(await readFile(join(output, 'app.js'), 'utf8'))
  await tick()
  return {
    document: window.document,
    inline,
    requests,
    poll: (): void => {
      poll()
    },
    respond: (index: number, data: unknown): void => {
      const resolve = requests[index]
      assert.ok(resolve, `Missing thread request ${String(index)}`)
      resolve(data)
    },
    click: (): void => {
      const button = window.document.querySelector<HTMLButtonElement>('.row')
      assert.ok(button)
      button.click()
    },
    close: async (): Promise<void> => {
      window.close()
      await rm(output, { recursive: true, force: true })
    },
  }
}

it('keeps desktop-only prompts and the full-thread route visible inline', async () => {
  const app = await harness()
  try {
    app.click()
    await tick()
    app.respond(0, {
      ...pending,
      decisions: [],
      attention: [{ title: 'Desktop prompt', body: 'Confirm in Copse' }],
    })
    await tick()
    assert.equal(app.document.getElementById('inline-decision')?.hidden, false)
    assert.match(
      app.document.querySelector('#inline-decision .attention')?.textContent ?? '',
      /Desktop prompt.*Confirm in Copse.*Answer this prompt on the desktop/,
    )
    assert.equal(app.document.querySelector('#inline-decision .decision-actions'), null)
    app.poll()
    await tick()
    app.respond(1, {
      ...pending,
      decisions: [],
      attention: [{ title: 'Updated prompt', body: 'Updated detail' }],
    })
    await tick()
    assert.match(
      app.document.getElementById('inline-decision')?.textContent ?? '',
      /Updated detail/,
    )
    const open = app.document.querySelector<HTMLButtonElement>('.open-thread-link')
    assert.ok(open)
    open.click()
    await tick()
    app.respond(2, {
      ...pending,
      decisions: [],
      attention: [{ title: 'Updated prompt', body: 'Updated detail' }],
    })
    await tick()
    assert.equal(app.document.getElementById('thread')?.hidden, false)
    assert.match(app.document.getElementById('attention')?.textContent ?? '', /Updated detail/)
  } finally {
    await app.close()
  }
})

it('does not restore old actions after a newer inline response observes settlement', async () => {
  const app = await harness()
  try {
    app.click()
    app.poll()
    await tick()
    assert.equal(app.requests.length, 2)
    app.respond(1, { ...pending, decisions: [] })
    await tick()
    // Reselect the same activity row while the older thread request is pending.
    app.click()
    await tick()
    app.respond(0, pending)
    await tick()
    assert.equal(app.document.querySelector('#inline-decision .decision-actions'), null)
    app.respond(2, { ...pending, decisions: [] })
    await tick()
    assert.equal(app.inline?.hidden, true)
  } finally {
    await app.close()
  }
})

it('discards a response from an earlier selection of the same row', async () => {
  const app = await harness()
  try {
    app.click()
    app.click()
    app.click()
    await tick()
    app.respond(0, pending)
    await tick()
    assert.equal(app.document.querySelector('#inline-decision .decision-actions'), null)
    app.respond(1, {
      ...pending,
      decisions: [],
      attention: [{ title: 'Current prompt', body: 'Desktop only' }],
    })
    await tick()
    assert.match(
      app.document.getElementById('inline-decision')?.textContent ?? '',
      /Current prompt/,
    )
  } finally {
    await app.close()
  }
})

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { buildMobileAssets } from './mobile-build.mts'

interface Sent {
  path: string
  validator: string | undefined
}

interface Row {
  projectId: string
  projectName: string
  threadId: string
  title: string
  group: 'needs-you' | 'working' | 'has-changes' | 'recent'
  state: string
  detail: string
  updatedAt: number
  lastSavedAt: number
}

const SESSION = '11111111-1111-4111-8111-111111111111'
const RUN = '44444444-4444-4444-8444-444444444444'

function row(threadId: string, title: string, group: Row['group'] = 'recent'): Row {
  return {
    projectId: 'p',
    projectName: 'Project',
    threadId,
    title,
    group,
    state: group === 'working' ? 'working' : 'finished',
    detail: 'Latest completed output',
    updatedAt: 1000,
    lastSavedAt: 1000,
  }
}

/** The Mac as the page sees it: the three polled reads, each with a validator. */
class Desktop {
  rows: Row[] = [row('a', 'Alpha'), row('b', 'Beta'), row('c', 'Gamma', 'working')]
  runId: string | null = null
  saved = [
    { id: 'u', imageCount: 0, role: 'user', content: 'Prepare the build', summary: null },
    {
      id: 'a',
      imageCount: 0,
      role: 'assistant',
      content: 'The build is **ready**.',
      summary: null,
    },
  ]
  revision = 1
  liveReply = 'The build is **ready**.'
  /** The desktop window's live relay is unreachable; its saved threads still answer. */
  liveUnavailable = false
  sent: Sent[] = []

  private validated(
    window: JSDOM['window'],
    validator: string | undefined,
    stable: unknown,
  ): unknown {
    const etag = `W/"${createHash('sha256').update(JSON.stringify(stable)).digest('base64url')}"`
    const headers = new window.Headers({ ETag: etag })
    if (validator === etag)
      return {
        ok: false,
        status: 304,
        headers,
        json: (): Promise<never> => Promise.reject(new Error('A 304 carries no body')),
      }
    return {
      ok: true,
      status: 200,
      headers,
      json: (): Promise<unknown> => Promise.resolve(structuredClone(stable)),
    }
  }

  answer(window: JSDOM['window'], path: string, validator: string | undefined): unknown {
    this.sent.push({ path, validator })
    if (path === '/api/activity')
      return this.validated(window, validator, {
        rows: this.rows,
        projects: [{ id: 'p', name: 'Project' }],
        access: 'control',
        sessionId: SESSION,
      })
    if (path.startsWith('/api/remote/') && this.liveUnavailable)
      return {
        ok: false,
        status: 503,
        headers: new window.Headers(),
        json: (): Promise<unknown> => Promise.resolve({ error: 'Desktop request unavailable.' }),
      }
    if (path.startsWith('/api/remote/state'))
      return this.validated(window, validator, {
        version: 1,
        sessionId: SESSION,
        revision: this.revision,
        views: [
          {
            projectId: 'p',
            threads: [
              {
                id: 'a',
                title: 'Alpha',
                status: this.runId ? 'running' : 'idle',
                createdAt: 1,
                updatedAt: 2,
                usage: { inputTokens: 0, outputTokens: 0 },
                messages: [
                  {
                    id: 'u',
                    role: 'user',
                    content: 'Prepare the build',
                    createdAt: 1,
                    toolCalls: [],
                  },
                  {
                    id: 'a',
                    role: 'assistant',
                    content: this.liveReply,
                    createdAt: 2,
                    toolCalls: [
                      { id: 'tool', name: 'run_command', args: {}, status: 'done', result: 'ok' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      })
    if (path === '/api/remote/read')
      // No next-step suggestion: the setting reads as off.
      return {
        ok: true,
        status: 200,
        headers: new window.Headers(),
        json: (): Promise<unknown> => Promise.resolve({ value: false }),
      }
    return this.validated(window, validator, {
      projectName: 'Project',
      title: 'Alpha',
      attention: [],
      decisions: [],
      runId: this.runId,
      messages: this.saved,
      access: 'control',
      sessionId: SESSION,
    })
  }

  /** The reads made since the last call, as `path` or `path (conditional)`. */
  drain(): string[] {
    const sent = this.sent.map(({ path, validator }) =>
      validator === undefined ? path : `${path} (conditional)`,
    )
    this.sent = []
    return sent
  }
}

describe('mobile companion polling', { timeout: 30_000 }, () => {
  let output = ''
  let script = ''
  let html = ''
  const doms: JSDOM[] = []

  before(async () => {
    output = await mkdtemp('dist-mobile-polling-test-')
    await buildMobileAssets(output)
    script = await readFile(join(output, 'app.js'), 'utf8')
    html = await readFile(join(output, 'index.html'), 'utf8')
  })

  after(async () => {
    for (const dom of doms) dom.window.close()
    await rm(output, { recursive: true, force: true })
  })

  /** Open the paired page against `desktop`, with the poll timer in the test's hands. */
  async function open(desktop: Desktop): Promise<{
    window: JSDOM['window']
    tick: () => Promise<void>
    settle: () => Promise<void>
    pollDelay: () => number | undefined
    clock: { now: number }
  }> {
    const dom = new JSDOM(html, {
      url: 'https://192.168.1.41:4000',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    })
    doms.push(dom)
    const { window } = dom
    Object.defineProperty(window, 'IntersectionObserver', {
      value: class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    })
    Object.defineProperty(window, 'matchMedia', {
      value: (): { matches: boolean; addEventListener(): void } => ({
        matches: false,
        addEventListener(): void {},
      }),
    })
    Object.defineProperty(window, 'scrollBy', { value: (): void => {} })
    Object.defineProperty(window.Element.prototype, 'scrollIntoView', { value: (): void => {} })
    const clock = { now: 1_000_000 }
    Object.defineProperty(window.Date, 'now', { value: (): number => clock.now })
    let timer: { callback: () => void; delay: number } | undefined
    Object.defineProperty(window, 'setInterval', {
      value: (callback: () => void, delay: number): number => {
        timer = { callback, delay }
        return 1
      },
    })
    Object.defineProperty(window, 'clearInterval', { value: (): void => {} })
    Object.defineProperty(window, 'fetch', {
      value: (path: string, init?: { headers?: Record<string, string> }): Promise<unknown> =>
        Promise.resolve(desktop.answer(window, path, init?.headers?.['If-None-Match'])),
    })
    window.localStorage.setItem('copse-mobile-token', 'test-token')
    window.eval(script)
    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 6; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await settle()
    return {
      window,
      settle,
      clock,
      pollDelay: () => timer?.delay,
      tick: async (): Promise<void> => {
        assert.ok(timer, 'the page armed its poll')
        clock.now += timer.delay
        timer.callback()
        await settle()
      },
    }
  }

  /**
   * Resolve once `predicate` holds for the transcript. A reply still arriving
   * is painted frame by frame, as on the desktop: wait for the paint itself.
   */
  const transcriptUntil = (
    window: JSDOM['window'],
    predicate: (text: string) => boolean,
  ): Promise<void> => {
    const messages = window.document.getElementById('messages')
    assert.ok(messages)
    if (predicate(messages.textContent)) return Promise.resolve()
    return new Promise((resolve) => {
      const observer = new window.MutationObserver(() => {
        if (!predicate(messages.textContent)) return
        observer.disconnect()
        resolve()
      })
      observer.observe(messages, { childList: true, subtree: true, characterData: true })
    })
  }

  const rowButtons = (window: JSDOM['window']): Map<string, Element> =>
    new Map(
      [...window.document.querySelectorAll('.row')].map((button) => [
        button.querySelector('.row-title')?.textContent ?? '',
        button,
      ]),
    )
  const groupOf = (button: Element | undefined): string | undefined =>
    button?.closest('.group')?.querySelector('.group-heading span')?.textContent

  it('leaves the Activity list alone while the Mac reports nothing changed', async () => {
    const desktop = new Desktop()
    const page = await open(desktop)
    assert.deepEqual(desktop.drain(), ['/api/activity'])
    const before = rowButtons(page.window)
    assert.deepEqual([...before.keys()], ['Gamma', 'Alpha', 'Beta'])
    const sections = [...page.window.document.querySelectorAll('.group')]

    await page.tick()
    await page.tick()
    assert.deepEqual(desktop.drain(), [
      '/api/activity (conditional)',
      '/api/activity (conditional)',
    ])
    const after = rowButtons(page.window)
    for (const [title, button] of before) assert.equal(after.get(title), button, title)
    assert.deepEqual([...page.window.document.querySelectorAll('.group')], sections)
    assert.match(
      page.window.document.getElementById('freshness')?.textContent ?? '',
      /^Updated 0s ago/,
    )
  })

  it('keeps a row’s own button as the list around it changes', async () => {
    const desktop = new Desktop()
    const page = await open(desktop)
    const before = rowButtons(page.window)
    const alpha = before.get('Alpha')
    assert.ok(alpha)
    assert.equal(groupOf(alpha), 'Recent')

    // Alpha starts running under a new title, Beta is archived, Delta appears.
    desktop.rows = [
      { ...row('a', 'Alpha, renamed', 'working'), lastSavedAt: 2000 },
      row('c', 'Gamma', 'working'),
      row('d', 'Delta'),
    ]
    await page.tick()
    const after = rowButtons(page.window)
    assert.deepEqual([...after.keys()], ['Alpha, renamed', 'Gamma', 'Delta'])
    assert.equal(after.get('Alpha, renamed'), alpha, 'the same button, moved and relabelled')
    assert.equal(groupOf(alpha), 'Working')
    assert.equal(alpha.querySelector('.state')?.className, 'state working')
    assert.equal(after.get('Gamma'), before.get('Gamma'))
    assert.equal(before.get('Beta')?.isConnected, false)
    const counts = [...page.window.document.querySelectorAll('.group-count')].map(
      (count) => count.textContent,
    )
    assert.deepEqual(counts, ['0', '2', '0', '1'])
    assert.equal(
      page.window.document.querySelectorAll('.group')[0]?.querySelector('.empty')?.textContent,
      'No decisions waiting for you.',
    )

    // A tap on the kept button opens the thread as the list now describes it.
    assert.ok(alpha instanceof page.window.HTMLElement)
    alpha.click()
    assert.equal(page.window.document.getElementById('thread-title')?.textContent, 'Alpha, renamed')
  })

  it('keeps ages moving on a list that is not redrawn', async () => {
    const desktop = new Desktop()
    const page = await open(desktop)
    const time = (): string | null | undefined =>
      rowButtons(page.window).get('Alpha')?.querySelector('.time')?.textContent
    const first = time()
    page.clock.now += 3_600_000
    await page.tick()
    assert.deepEqual(desktop.drain().at(-1), '/api/activity (conditional)')
    assert.notEqual(time(), first)
    assert.match(time() ?? '', /h ago$/)
  })

  it('leaves an open thread alone while nothing changed, and follows a run closely', async () => {
    const desktop = new Desktop()
    const page = await open(desktop)
    const { document } = page.window
    const alpha = rowButtons(page.window).get('Alpha')
    assert.ok(alpha instanceof page.window.HTMLElement)
    alpha.click()
    await page.settle()
    desktop.drain()
    assert.equal(page.pollDelay(), 2500)
    const cards = [...document.querySelectorAll('#messages .message')]
    assert.equal(cards.length, 2)
    assert.ok(cards[1]?.querySelector('strong'), 'the saved reply is rendered as Markdown')
    const tool = document.querySelector<HTMLDetailsElement>('#remote-tools details')
    assert.ok(tool, 'the live view lists the tool call')
    tool.open = true

    await page.tick()
    assert.deepEqual(desktop.drain().sort(), [
      '/api/remote/state?project=p&thread=a (conditional)',
      '/api/thread/p/a (conditional)',
    ])
    assert.deepEqual([...document.querySelectorAll('#messages .message')], cards)
    assert.equal(document.querySelector('#remote-tools details'), tool)
    assert.equal(tool.open, true, 'an unchanged poll does not close the tool card being read')

    // A run starts: the saved view reports it, and the page tightens its poll.
    desktop.runId = RUN
    desktop.revision++
    await page.tick()
    desktop.drain()
    assert.equal(page.pollDelay(), 1000)
    assert.equal(document.getElementById('working')?.hidden, false)

    // Streamed text arrives through the live view alone, a second at a time…
    desktop.revision++
    desktop.liveReply = 'The build is **ready**. Uploading now.'
    await page.tick()
    assert.deepEqual(desktop.drain(), ['/api/remote/state?project=p&thread=a (conditional)'])
    await transcriptUntil(page.window, (text) => text.includes('Uploading now.'))
    assert.deepEqual([...document.querySelectorAll('#messages .message')], cards)
    await page.tick()
    assert.deepEqual(desktop.drain(), ['/api/remote/state?project=p&thread=a (conditional)'])
    // …while the saved view, folded from disk on the Mac, keeps its own pace.
    await page.tick()
    assert.deepEqual(desktop.drain().sort(), [
      '/api/remote/state?project=p&thread=a (conditional)',
      '/api/thread/p/a (conditional)',
    ])

    // The run ends: back to the resting pace.
    desktop.runId = null
    desktop.revision++
    await page.tick()
    await page.tick()
    await page.tick()
    desktop.drain()
    assert.equal(page.pollDelay(), 2500)
    assert.equal(document.getElementById('working')?.hidden, true)
  })

  it('hands over to the saved view the moment the live view is lost', async () => {
    const desktop = new Desktop()
    desktop.runId = RUN
    desktop.liveReply = 'Live text the Mac has not saved yet.'
    const page = await open(desktop)
    const { document } = page.window
    const alpha = rowButtons(page.window).get('Alpha')
    assert.ok(alpha instanceof page.window.HTMLElement)
    alpha.click()
    await page.settle()
    await page.tick()
    desktop.drain()
    assert.equal(page.pollDelay(), 1000)
    const transcript = (): string => document.getElementById('messages')?.textContent ?? ''
    await transcriptUntil(page.window, (text) => text.includes('not saved yet.'))
    assert.ok(transcript().includes('Live text the Mac has not saved yet.'), transcript())

    // The next live read fails on a turn when the saved view is not due. It is
    // read anyway: the page must not sit on a transcript it can no longer follow.
    desktop.liveUnavailable = true
    await page.tick()
    assert.deepEqual(desktop.drain(), [
      '/api/remote/state?project=p&thread=a (conditional)',
      '/api/thread/p/a (conditional)',
    ])
    await transcriptUntil(page.window, (text) => text.includes('ready.'))
    assert.ok(transcript().includes('The build is ready.'), `saved reply shown: ${transcript()}`)
    assert.equal(transcript().includes('not saved yet'), false, transcript())
    assert.match(document.getElementById('thread-status')?.textContent ?? '', /Retrying/)
    assert.equal(document.getElementById('remote-connection')?.textContent, 'Reconnecting…')

    // Still unavailable: nothing changed, so the saved view is not reapplied each turn.
    await page.tick()
    assert.deepEqual(desktop.drain(), ['/api/remote/state?project=p&thread=a (conditional)'])

    desktop.liveUnavailable = false
    await page.tick()
    await transcriptUntil(page.window, (text) => text.includes('not saved yet.'))
    assert.ok(transcript().includes('Live text the Mac has not saved yet.'), transcript())
    assert.equal(document.getElementById('remote-connection')?.textContent, '● Connected')
  })

  it('reads at once when the phone returns to the page', async () => {
    const desktop = new Desktop()
    const page = await open(desktop)
    desktop.drain()
    page.window.document.dispatchEvent(new page.window.Event('visibilitychange'))
    await page.settle()
    assert.deepEqual(desktop.drain(), ['/api/activity (conditional)'])
  })
})

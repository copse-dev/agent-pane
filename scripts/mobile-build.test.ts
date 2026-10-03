import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { buildMobileAssets } from './mobile-build.mts'

it('bundles the mobile entry and renders saved Markdown through activity navigation', async () => {
  const output = await mkdtemp('dist-mobile-test-')
  let dom: JSDOM | undefined
  try {
    await buildMobileAssets(output)
    const css = await readFile(join(output, 'app.css'), 'utf8')
    assert.match(css, /\.topbar\s*\{[^}]*position: fixed/)
    assert.match(css, /\.topbar\s*\{[^}]*top: var\(--viewport-offset/)
    dom = new JSDOM(await readFile(join(output, 'index.html'), 'utf8'), {
      url: 'https://192.168.1.41:4000',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    })
    const { window } = dom
    const viewport = new window.EventTarget()
    let viewportHeight = 600
    let viewportOffset = 0
    Object.defineProperties(viewport, {
      height: { get: () => viewportHeight },
      offsetTop: { get: () => viewportOffset },
    })
    Object.defineProperty(window, 'visualViewport', { value: viewport })
    Object.defineProperty(window, 'requestAnimationFrame', {
      value: (callback: () => void) => window.setTimeout(callback, 0),
    })
    Object.defineProperty(window, 'cancelAnimationFrame', {
      value: (id: number) => {
        window.clearTimeout(id)
      },
    })
    const scrolls: number[] = []
    Object.defineProperty(window, 'scrollBy', {
      value: (options: { top: number }): number => scrolls.push(options.top),
    })
    let poll = (): void => {}
    Object.defineProperty(window, 'setInterval', {
      value: (callback: () => void) => {
        poll = callback
        return 1
      },
    })
    for (const [selector, rect] of [
      ['.topbar', { top: 0, bottom: 68, height: 68 }],
      ['#message', { top: 650, bottom: 750, height: 100 }],
      ['#send', { top: 770, bottom: 814, height: 44 }],
      ['#new-message', { top: 400, bottom: 500, height: 100 }],
      ['#new-chat-form button', { top: 550, bottom: 594, height: 44 }],
    ] as const) {
      Object.defineProperty(window.document.querySelector(selector), 'getBoundingClientRect', {
        value: () => rect,
      })
    }
    let access = 'control'
    window.localStorage.setItem('copse-mobile-token', 'test-token')
    Object.defineProperty(window, 'matchMedia', {
      value: (): { matches: boolean; addEventListener(): void } => ({
        matches: false,
        addEventListener(): void {},
      }),
    })
    const row = {
      projectId: 'p',
      threadId: 't',
      projectName: 'Project',
      title: 'Markdown thread',
      state: 'finished',
      group: 'recent',
      detail: 'Done',
      lastSavedAt: Date.now(),
    }
    Object.defineProperty(window, 'fetch', {
      value: async (path: string): Promise<unknown> => ({
        ok: true,
        status: 200,
        json: async () =>
          path === '/api/activity'
            ? { access, sessionId: 's', projects: [{ id: 'p', name: 'Project' }], rows: [row] }
            : path === '/api/action'
              ? { queued: false, threadId: 't' }
              : {
                  access,
                  sessionId: 's',
                  runId: null,
                  title: row.title,
                  decisions: [],
                  attention: [],
                  messages: [
                    {
                      role: 'assistant',
                      summary: null,
                      content:
                        '# Heading\n\n**Bold** and `code`\n\n- First\n- Second\n\n> Quote\n\n```js\nconst x = 1\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n[Docs](https://example.com)\n\n![Remote](https://example.com/image.png)\n\n<script>alert(1)</script>\n\n[Bad](javascript:alert(1))',
                    },
                    { role: 'user', summary: null, content: 'Please **check** this.' },
                    { role: 'error', summary: null, content: '**literal error**\nnext line' },
                  ],
                },
      }),
    })
    window.eval(await readFile(join(output, 'app.js'), 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const activityRow = window.document.querySelector<HTMLButtonElement>('.row')
    assert.ok(activityRow)
    activityRow.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const input = window.document.querySelector<HTMLTextAreaElement>('#message')
    assert.ok(input)
    assert.equal(window.document.getElementById('composer')?.hidden, false)
    assert.equal(window.document.activeElement, input)
    assert.ok(scrolls.includes(226), 'scrolls far enough to expose Send below the textbox')
    input.value = 'A draft'
    input.setSelectionRange(2, 2)
    poll()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(input.selectionStart, 2, 'polling does not reset the caret')
    viewportHeight = 400
    viewportOffset = 20
    viewport.dispatchEvent(new window.Event('resize'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(scrolls.includes(406), 'repositions Send when the keyboard shrinks the viewport')
    assert.equal(
      window.document.documentElement.style.getPropertyValue('--viewport-offset'),
      '20px',
    )
    assert.equal(
      window.document.documentElement.style.getPropertyValue('--viewport-height'),
      '400px',
    )
    const content = window.document.querySelector('.message-content')
    assert.ok(content)
    for (const selector of ['h1', 'strong', 'code', 'ul li', 'blockquote', 'pre code', 'table td'])
      assert.ok(content.querySelector(selector), selector)
    assert.equal(
      content.querySelector('a[href="https://example.com"]')?.getAttribute('rel'),
      'noopener noreferrer',
    )
    assert.equal(
      content.querySelector('a[href="https://example.com"]')?.getAttribute('target'),
      '_blank',
    )
    assert.equal(content.querySelector('script, [onclick], a[href^="javascript:"], img[src]'), null)
    assert.ok(content.textContent.includes('<script>alert(1)</script>'))
    assert.equal(
      window.document.querySelectorAll('.message-content')[1]?.querySelector('strong')?.textContent,
      'check',
    )
    const error = window.document.querySelector('.message-content-plain')
    assert.equal(error?.textContent, '**literal error**\nnext line')
    input.value = 'Follow-up'
    window.document
      .getElementById('composer')
      ?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(input.value, '')
    assert.equal(window.document.activeElement, input, 'returns focus after submission')
    assert.equal(window.history.length, 2, 'opening a thread adds exactly one history entry')
    const historyState: unknown = window.history.state
    assert.ok(historyState !== null && typeof historyState === 'object')
    assert.equal(Reflect.get(historyState, 'mobileView'), 'thread')
    input.value = 'Keep this draft'
    const back = window.document.querySelector<HTMLButtonElement>('#back')
    assert.ok(back)
    assert.ok(back.querySelector('svg[aria-hidden="true"]'))
    assert.equal(back.textContent.trim(), 'Activity')
    assert.ok(back.closest('.topbar'), 'Activity navigation lives in the fixed header')
    assert.equal(back.hidden, false)
    assert.equal(window.document.querySelector('.session-label'), null)
    const goBack = new Promise((resolve) => {
      window.addEventListener('popstate', resolve, { once: true })
    })
    back.click()
    await goBack
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(window.document.getElementById('activity')?.hidden, false)
    assert.equal(window.document.getElementById('thread')?.hidden, true)
    assert.equal(back.hidden, true, 'Activity does not show a redundant back button')
    const goForward = new Promise((resolve) => {
      window.addEventListener('popstate', resolve, { once: true })
    })
    window.history.forward()
    await goForward
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(window.document.getElementById('thread')?.hidden, false)
    assert.equal(back.hidden, false)
    assert.equal(input.value, 'Keep this draft')
    assert.equal(window.history.length, 2, 'Forward restores without pushing another entry')
    const backAgain = new Promise((resolve) => {
      window.addEventListener('popstate', resolve, { once: true })
    })
    window.history.back()
    await backAgain
    await new Promise((resolve) => setTimeout(resolve, 0))
    window.document.querySelector<HTMLButtonElement>('#new-chat')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(window.document.activeElement.id, 'new-message')
    assert.ok(scrolls.includes(186), 'shows Start chat alongside the new-message textbox')
    access = 'read'
    window.document.querySelector<HTMLButtonElement>('.row')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(window.document.getElementById('composer')?.hidden, true)
    assert.notEqual(window.document.activeElement.id, 'message')
    access = 'control'
    poll()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(window.document.getElementById('composer')?.hidden, false)
    assert.equal(window.document.activeElement, input, 'focuses when control reveals the composer')
  } finally {
    dom?.window.close()
    await rm(output, { recursive: true, force: true })
  }
})

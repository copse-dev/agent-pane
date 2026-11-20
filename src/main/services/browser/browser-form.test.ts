import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Window, type DOMRect } from 'happy-dom'
import { browserFormFieldsSchema, fillBrowserForm } from './browser-form.ts'

const windows: Window[] = []

interface PageFixture {
  window: Window
  contents: { executeJavaScript(code: string, gesture?: boolean): Promise<unknown> }
  scripts: Array<{ code: string; gesture: boolean | undefined }>
}

function page(body = ''): PageFixture {
  const window = new Window()
  windows.push(window)
  window.document.head.innerHTML = '<style>input, textarea, select, button { opacity: 1; }</style>'
  window.document.body.innerHTML =
    body ||
    `
    <input aria-label="Title" data-copse-ref="e1" value="Old title">
    <textarea aria-label="Notes" data-copse-ref="e2">User draft</textarea>
    <select aria-label="Priority" data-copse-ref="e3"><option value="low">Low</option><option value="high">High</option></select>`
  // Happy DOM has no layout. Real Electron evidence separately asserts these
  // controls' geometry; this boundary fixture only models visible vs hidden.
  window.HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    return this.hidden ? new window.DOMRect() : new window.DOMRect(0, 0, 200, 24)
  }
  const scripts: Array<{ code: string; gesture: boolean | undefined }> = []
  const contents = {
    async executeJavaScript(code: string, gesture?: boolean): Promise<unknown> {
      scripts.push({ code, gesture })
      const result: unknown = window.eval(code)
      return result
    },
  }
  return { window, contents, scripts }
}

afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()))
})

describe('native browser form entry', () => {
  it('fills inputs, textareas and selects with normal input/change events', async () => {
    const { window, contents, scripts } = page()
    const events: string[] = []
    for (const type of ['input', 'change']) {
      window.document.body.addEventListener(type, (event) => {
        const element = event.target
        if (element instanceof window.HTMLElement)
          events.push(`${element.getAttribute('data-copse-ref') ?? 'unknown'}:${type}`)
      })
    }
    const result = await fillBrowserForm(contents, [
      { ref: 'e1', text: 'Release checklist' },
      { ref: 'e2', text: 'Keep the manual note' },
      { ref: 'e3', text: 'high' },
    ])
    assert.equal(window.document.querySelector('input')?.value, 'Release checklist')
    assert.equal(window.document.querySelector('textarea')?.value, 'Keep the manual note')
    assert.equal(window.document.querySelector('select')?.value, 'high')
    assert.deepEqual(events, [
      'e1:input',
      'e1:change',
      'e2:input',
      'e2:change',
      'e3:input',
      'e3:change',
    ])
    assert.match(result, /Entered 3 fields/)
    assert.doesNotMatch(result, /Release checklist|Keep the manual note/)
    assert.deepEqual(
      Object.getOwnPropertyNames(window).filter((key) => key.startsWith('__copseForm_')),
      [],
    )
    assert.equal(scripts.at(-1)?.gesture, false, 'cleanup does not grant another user activation')
  })

  it('checks every target before any field changes', async () => {
    const { window, contents } = page()
    await assert.rejects(
      fillBrowserForm(contents, [
        { ref: 'e1', text: 'New title' },
        { ref: 'missing', text: 'Ignored' },
      ]),
      /stopped after 0 confirmed fields of 2.*No fields were entered/,
    )
    assert.equal(window.document.querySelector('input')?.value, 'Old title')
  })

  it('ignores stale refs on hidden dialogs and refuses two current matching controls', async () => {
    const { window, contents } = page(
      '<input hidden data-copse-ref="e1" value="Hidden draft"><input data-copse-ref="e1" value="Visible draft">',
    )
    await fillBrowserForm(contents, [{ ref: 'e1', text: 'Visible edit' }])
    assert.equal(window.document.querySelectorAll('input')[0]?.value, 'Hidden draft')
    assert.equal(window.document.querySelectorAll('input')[1]?.value, 'Visible edit')
    window.document.body.insertAdjacentHTML(
      'beforeend',
      '<input data-copse-ref="e1" value="Another draft">',
    )
    await assert.rejects(
      fillBrowserForm(contents, [{ ref: 'e1', text: 'Ambiguous edit' }]),
      /ambiguous/,
    )
    assert.equal(window.document.querySelectorAll('input')[1]?.value, 'Visible edit')
  })

  it('refuses disabled, readonly, file and noneditable controls before entering the form', async () => {
    for (const second of [
      '<input data-copse-ref="e2" disabled>',
      '<textarea data-copse-ref="e2" readonly></textarea>',
      '<input data-copse-ref="e2" type="file">',
      '<button data-copse-ref="e2">Save</button>',
    ]) {
      const { window, contents } = page(`<input data-copse-ref="e1" value="User draft">${second}`)
      await assert.rejects(
        fillBrowserForm(contents, [
          { ref: 'e1', text: 'New' },
          { ref: 'e2', text: 'Ignored' },
        ]),
        /stopped after 0/,
      )
      assert.equal(window.document.querySelector('input')?.value, 'User draft')
    }
  })

  it('ignores a stale control in an invisible ancestor', async () => {
    const { window, contents } = page(
      '<div style="opacity:0"><input data-copse-ref="e1" value="Hidden draft"></div><input data-copse-ref="e1" value="Visible draft">',
    )
    await fillBrowserForm(contents, [{ ref: 'e1', text: 'Visible edit' }])
    assert.equal(window.document.querySelectorAll('input')[0]?.value, 'Hidden draft')
    assert.equal(window.document.querySelectorAll('input')[1]?.value, 'Visible edit')
  })

  it('validates a select option before changing earlier fields', async () => {
    const { window, contents } = page()
    await assert.rejects(
      fillBrowserForm(contents, [
        { ref: 'e1', text: 'New' },
        { ref: 'e3', text: 'missing-option' },
      ]),
      /no matching option/,
    )
    assert.equal(window.document.querySelector('input')?.value, 'Old title')
  })

  it('stops on a replaced control and reports completed fields without replay', async () => {
    const { window, contents } = page()
    let firstEvents = 0
    window.document.querySelector('input')?.addEventListener('change', () => {
      firstEvents += 1
      window.document
        .querySelector('textarea')
        ?.replaceWith(window.document.createElement('textarea'))
    })
    await assert.rejects(
      fillBrowserForm(contents, [
        { ref: 'e1', text: 'First edit' },
        { ref: 'e2', text: 'Second edit' },
      ]),
      /stopped after 1 confirmed fields of 2.*Entered: e1.*changed/,
    )
    assert.equal(firstEvents, 1)
    assert.equal(window.document.querySelector('input')?.value, 'First edit')
    assert.equal(window.document.querySelector('textarea')?.value, '')
    assert.deepEqual(
      Object.getOwnPropertyNames(window).filter((key) => key.startsWith('__copseForm_')),
      [],
    )
  })

  it('does not retarget a batch when another snapshot renumbers the same nodes', async () => {
    const { window, contents } = page()
    window.document.querySelector('input')?.addEventListener('change', () => {
      window.document.querySelector('textarea')?.setAttribute('data-copse-ref', 'e3')
      window.document.querySelector('select')?.setAttribute('data-copse-ref', 'e2')
    })
    await assert.rejects(
      fillBrowserForm(contents, [
        { ref: 'e1', text: 'First edit' },
        { ref: 'e2', text: 'Wrong target' },
      ]),
      /stopped after 1.*changed/,
    )
    assert.equal(window.document.querySelector('select')?.value, 'low')
    assert.equal(window.document.querySelector('textarea')?.value, 'User draft')
  })

  it('rejects a replacement even when cloneNode copied every DOM attribute', async () => {
    const { window, contents } = page()
    window.document.querySelector('input')?.addEventListener('change', () => {
      const notes = window.document.querySelector('textarea')
      if (notes) notes.replaceWith(notes.cloneNode(true))
    })
    await assert.rejects(
      fillBrowserForm(contents, [
        { ref: 'e1', text: 'First edit' },
        { ref: 'e2', text: 'Wrong replacement' },
      ]),
      /stopped after 1.*changed/,
    )
    assert.equal(window.document.querySelector('textarea')?.value, 'User draft')
  })

  it('rechecks node identity after a focus handler replaces the target', async () => {
    const { window, contents } = page()
    const title = window.document.querySelector('input')
    title?.addEventListener('focus', () => {
      title.replaceWith(title.cloneNode(true))
    })
    await assert.rejects(
      fillBrowserForm(contents, [{ ref: 'e1', text: 'Detached edit' }]),
      /changed/,
    )
    assert.equal(window.document.querySelector('input')?.value, 'Old title')
  })

  it('reports an uncertain field when the page applied input but its reply was lost', async () => {
    const { window, contents } = page()
    let interrupted = false
    const unreliable = {
      async executeJavaScript(code: string, gesture?: boolean): Promise<unknown> {
        const result = await contents.executeJavaScript(code, gesture)
        if (!interrupted && window.document.querySelector('input')?.value === 'Delivered once') {
          interrupted = true
          throw new Error('Page context disappeared before its reply arrived')
        }
        return result
      },
    }
    await assert.rejects(
      fillBrowserForm(unreliable, [
        { ref: 'e1', text: 'Delivered once' },
        { ref: 'e2', text: 'Not attempted' },
      ]),
      /e1 may already have changed.*Inspect.*before retrying/,
    )
    assert.equal(window.document.querySelector('input')?.value, 'Delivered once')
    assert.equal(window.document.querySelector('textarea')?.value, 'User draft')
  })

  it('rejects values the native control would sanitize before changing any field', async () => {
    const { window, contents } = page(
      '<input data-copse-ref="e1" value="Manual title"><input data-copse-ref="e2" type="number" value="7">',
    )
    await assert.rejects(
      fillBrowserForm(contents, [
        { ref: 'e1', text: 'New title' },
        { ref: 'e2', text: 'not a number' },
      ]),
      /does not accept/,
    )
    assert.equal(window.document.querySelectorAll('input')[0]?.value, 'Manual title')
    assert.equal(window.document.querySelectorAll('input')[1]?.value, '7')
  })

  it('rejects disabled select choices before changing any field', async () => {
    for (const options of [
      '<option value="low">Low</option><option value="high" disabled>High</option>',
      '<option value="low">Low</option><optgroup label="Unavailable" disabled><option value="high">High</option></optgroup>',
    ]) {
      const { window, contents } = page(
        `<input data-copse-ref="e1" value="Manual title"><select data-copse-ref="e2">${options}</select>`,
      )
      await assert.rejects(
        fillBrowserForm(contents, [
          { ref: 'e1', text: 'New title' },
          { ref: 'e2', text: 'high' },
        ]),
        /disabled option/,
      )
      assert.equal(window.document.querySelector('input')?.value, 'Manual title')
      assert.equal(window.document.querySelector('select')?.value, 'low')
    }
  })

  it('cancels before input and between fields while retaining completed input', async () => {
    const { window, contents, scripts } = page()
    const before = AbortSignal.abort()
    await assert.rejects(
      fillBrowserForm(contents, [{ ref: 'e1', text: 'Never entered' }], before),
      { name: 'AbortError' },
    )
    assert.equal(scripts.length, 0)
    const controller = new AbortController()
    window.document.querySelector('input')?.addEventListener('change', () => {
      controller.abort()
    })
    await assert.rejects(
      fillBrowserForm(
        contents,
        [
          { ref: 'e1', text: 'Completed once' },
          { ref: 'e2', text: 'Never entered' },
        ],
        controller.signal,
      ),
      { name: 'AbortError', message: /Entered: e1/ },
    )
    assert.equal(window.document.querySelector('input')?.value, 'Completed once')
    assert.equal(window.document.querySelector('textarea')?.value, 'User draft')
    assert.deepEqual(
      Object.getOwnPropertyNames(window).filter((key) => key.startsWith('__copseForm_')),
      [],
    )
  })

  it('rejects duplicate refs and empty forms at the supported boundary', () => {
    assert.equal(browserFormFieldsSchema.safeParse([]).success, false)
    assert.equal(
      browserFormFieldsSchema.safeParse([
        { ref: 'e1', text: 'First' },
        { ref: 'e1', text: 'Second' },
      ]).success,
      false,
    )
  })
})

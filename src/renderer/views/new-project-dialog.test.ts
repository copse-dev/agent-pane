// The "New project" dialog shipped for a long time with `class: 'ui-btn primary'`
// on its Create button. `.primary` on its own matches no rule in the stylesheet —
// the accent lives on `.ui-btn-primary` — so the primary action rendered as a
// plain secondary button and nothing caught it, because this dialog had no test.
// These pin the button contract rather than the pixels.
import '../../../tests/setup-dom.ts'
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { openNewProjectDialog } from './new-project-dialog.ts'
import { createPendingApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'

/** happy-dom has no modal-dialog implementation; shim just enough to open/close. */
function shimDialog(): void {
  const proto = window.HTMLElement.prototype
  const define = (name: string, value: unknown): void => {
    if (!(name in proto)) Object.defineProperty(proto, name, { configurable: true, value })
  }
  define('showModal', function (this: HTMLElement): void {
    Object.defineProperty(this, 'open', { configurable: true, value: true, writable: true })
  })
  define('close', function (this: HTMLElement): void {
    Object.defineProperty(this, 'open', { configurable: true, value: false, writable: true })
    this.dispatchEvent(new window.Event('close'))
  })
}

describe('new project dialog', () => {
  before(shimDialog)

  it('renders Create as the accented primary action and Cancel as the plain one', async () => {
    const pending = openNewProjectDialog(createPendingApi(), '/home/user/projects')

    const create = qsRequired<HTMLButtonElement>(document, '.new-project-actions .ui-btn-primary')
    assert.equal(create.textContent, 'Create')
    // Both classes matter: `ui-btn` carries the shape, `ui-btn-primary` the accent.
    assert.ok(create.classList.contains('ui-btn'))
    assert.ok(create.classList.contains('ui-btn-primary'))

    const buttons = [...document.querySelectorAll('.new-project-actions button')]
    const cancel = buttons.find((button) => button.textContent === 'Cancel')
    assert.ok(cancel)
    assert.equal(cancel.classList.contains('ui-btn-primary'), false)

    cancel.dispatchEvent(new window.Event('click'))
    assert.equal(await pending, null)
  })

  it('resolves with the typed name and parent directory', async () => {
    const pending = openNewProjectDialog(createPendingApi(), '/home/user/projects')

    const name = qsRequired<HTMLInputElement>(document, '#new-project-dialog input')
    name.value = '  copse-demo  '

    qsRequired<HTMLButtonElement>(document, '.new-project-actions .ui-btn-primary').dispatchEvent(
      new window.Event('click'),
    )
    assert.deepEqual(await pending, { name: 'copse-demo', parentDir: '/home/user/projects' })
  })
})

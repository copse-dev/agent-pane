// Verifies the SSH askpass modal's "Remember for this session" affordance: it
// is offered (and pre-selected) for secret prompts, hidden for host-key
// confirmations, and its state rides along with the answer so the main process
// knows whether it may cache the secret (ssh-credential-cache.ts).
//
// happy-dom has no modal-dialog implementation, so showModal/close/open are
// shimmed the same way as the other dialog specs; real top-layer behaviour is
// covered by the Chromium e2e spec.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mountSshPromptDialog, type SshPromptApi } from './ssh-prompt-dialog.ts'

interface SshPromptRequest {
  id: string
  prompt: string
  kind: 'confirm' | 'secret'
}

interface Response {
  id: string
  value: string
  remember: boolean | undefined
}

interface Harness {
  emit: (req: SshPromptRequest) => void
  responses: Response[]
}

function stubApi(): { api: SshPromptApi; harness: Harness } {
  let listener: ((req: SshPromptRequest) => void) | null = null
  const responses: Response[] = []
  const api: SshPromptApi = {
    sshPrompt: {
      respond: (id: string, value: string, remember?: boolean): Promise<void> => {
        responses.push({ id, value, remember })
        return Promise.resolve()
      },
      onRequest: (handler: (req: SshPromptRequest) => void): (() => void) => {
        listener = handler
        return (): void => {}
      },
    },
  }
  const harness: Harness = {
    emit: (req) => {
      if (!listener) throw new Error('no ssh prompt listener registered')
      listener(req)
    },
    responses,
  }
  return { api, harness }
}

function shimModal(node: HTMLDialogElement): void {
  let open = false
  Object.defineProperties(node, {
    showModal: { configurable: true, value: () => void (open = true) },
    close: { configurable: true, value: () => void (open = false) },
    open: { configurable: true, get: () => open },
  })
}

function dialog(): HTMLDialogElement {
  const found = document.querySelector<HTMLDialogElement>('#ssh-prompt-dialog')
  if (!found) throw new Error('ssh prompt dialog not mounted')
  return found
}

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector)
  if (!found) throw new Error(`no element matches ${selector}`)
  return found
}

function input(selector: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(selector)
  if (!found) throw new Error(`no input matches ${selector}`)
  return found
}

function rememberBox(): HTMLInputElement {
  return input('.ssh-prompt-remember-input')
}

/**
 * Confirm and secret rows share button classes; the confirm row is appended
 * first, so index 0 is the confirm button and index 1 the secret one.
 */
function buttonAt(selector: string, index: number): HTMLButtonElement {
  const found = document.querySelectorAll<HTMLButtonElement>(selector)[index]
  if (!found) throw new Error(`no ${selector} at index ${String(index)}`)
  return found
}

function submitForm(): void {
  const form = document.querySelector<HTMLFormElement>('#ssh-prompt-form')
  if (!form) throw new Error('ssh prompt form not mounted')
  form.requestSubmit()
}

function mount(api: SshPromptApi): void {
  mountSshPromptDialog(api)
  shimModal(dialog())
}

const PASSWORD_PROMPT: SshPromptRequest = {
  id: 'req-1',
  prompt: '(me@dev.example) Password:',
  kind: 'secret',
}

describe('ssh prompt dialog (component)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('remembers the secret by default so one dialog covers the session', () => {
    const { api, harness } = stubApi()
    mount(api)
    harness.emit(PASSWORD_PROMPT)

    const field = element('.ssh-prompt-remember')
    assert.equal(field.hidden, false)
    assert.equal(rememberBox().checked, true)

    input('.ssh-prompt-input').value = 'hunter2'
    submitForm()

    assert.deepEqual(harness.responses, [{ id: 'req-1', value: 'hunter2', remember: true }])
  })

  it('passes the opt-out through when the box is cleared', () => {
    const { api, harness } = stubApi()
    mount(api)
    harness.emit(PASSWORD_PROMPT)

    rememberBox().checked = false
    input('.ssh-prompt-input').value = 'hunter2'
    submitForm()

    assert.deepEqual(harness.responses, [{ id: 'req-1', value: 'hunter2', remember: false }])
  })

  it('re-checks the box for the next queued prompt', () => {
    const { api, harness } = stubApi()
    mount(api)
    harness.emit(PASSWORD_PROMPT)
    harness.emit({ id: 'req-2', prompt: "Enter passphrase for key '/k':", kind: 'secret' })

    rememberBox().checked = false
    input('.ssh-prompt-input').value = 'first'
    submitForm()

    assert.equal(rememberBox().checked, true)
    assert.equal(element('.ssh-prompt-body').textContent, "Enter passphrase for key '/k':")
  })

  it('hides the option for host-key confirmations', () => {
    const { api, harness } = stubApi()
    mount(api)
    harness.emit({
      id: 'req-3',
      prompt: 'Are you sure you want to continue connecting (yes/no)?',
      kind: 'confirm',
    })

    assert.equal(element('.ssh-prompt-remember').hidden, true)

    buttonAt('.ssh-prompt-submit', 0).click()
    assert.deepEqual(harness.responses, [{ id: 'req-3', value: 'yes', remember: false }])
  })

  it('never remembers a cancelled prompt', () => {
    const { api, harness } = stubApi()
    mount(api)
    harness.emit(PASSWORD_PROMPT)

    input('.ssh-prompt-input').value = 'hunter2'
    buttonAt('.ssh-prompt-cancel', 1).click()

    assert.deepEqual(harness.responses, [{ id: 'req-1', value: '', remember: false }])
  })
})

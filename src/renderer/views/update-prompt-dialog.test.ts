import '../../../tests/setup-dom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountUpdatePromptDialog } from './update-prompt-dialog.ts'

type UpdatePromptHandler = (req: {
  id: string
  message: string
  detail?: string
  buttons: string[]
  defaultIndex?: number
  cancelIndex?: number
}) => void

const responses: { id: string; buttonIndex: number }[] = []
let emit: UpdatePromptHandler = (): void => {}

const api = {
  updatePrompt: {
    respond: (id: string, buttonIndex: number): Promise<void> => {
      responses.push({ id, buttonIndex })
      return Promise.resolve()
    },
    onRequest: (handler: UpdatePromptHandler): (() => void) => {
      emit = handler
      return (): void => {}
    },
    onDevNotice: (): (() => void) => (): void => {},
  },
} as unknown as ApiClient

afterEach((): void => {
  document.getElementById('update-prompt-dialog')?.remove()
  responses.length = 0
  emit = (): void => {}
})

describe('update-prompt-dialog', () => {
  it('shows an in-app modal and returns the clicked button index', () => {
    mountUpdatePromptDialog(api)

    emit({
      id: 'prompt-1',
      message: 'Copse 1.2.3 is available',
      detail: 'Download the update now?',
      buttons: ['Download', 'Later'],
      defaultIndex: 0,
      cancelIndex: 1,
    })

    const dialog = document.getElementById('update-prompt-dialog') as HTMLDialogElement
    assert.ok(dialog.open)
    assert.match(dialog.textContent, /Copse 1\.2\.3 is available/)
    assert.match(dialog.textContent, /Download the update now/)

    const later = dialog.querySelector<HTMLButtonElement>('.update-prompt-secondary')
    assert.ok(later)
    later.click()

    assert.equal(responses.length, 1)
    assert.deepEqual(responses[0], { id: 'prompt-1', buttonIndex: 1 })
    assert.equal(dialog.open, false)
  })
})

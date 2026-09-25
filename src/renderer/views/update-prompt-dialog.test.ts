import '../../../tests/setup-dom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountUpdatePromptDialog } from './update-prompt-dialog.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'

type UpdatePromptHandler = (req: {
  id: string
  message: string
  detail?: string
  changelog?: { version: string; notes: string }[]
  changelogUrl?: string
  buttons: string[]
  defaultIndex?: number
  cancelIndex?: number
}) => void

const responses: { id: string; buttonIndex: number }[] = []
let emit: UpdatePromptHandler = (): void => {}

const api = ((): ApiClient => {
  const base = createFakeApi()
  return {
    ...base,
    updatePrompt: {
      ...base['updatePrompt'],
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
  } satisfies ApiClient
})()

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

    const dialog = qsRequired<HTMLDialogElement>(document, '#update-prompt-dialog')
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

  // Sanitization is the shared renderer's contract, and happy-dom cannot run
  // DOMPurify; tests/demo/update-prompt-changelog.demo.ts checks it in Chromium.
  it('lists every missed release, newest first, as rendered Markdown', () => {
    mountUpdatePromptDialog(api)

    emit({
      id: 'prompt-2',
      message: 'Copse 0.1.0-beta.11 is available',
      changelog: [
        { version: '0.1.0-beta.11', notes: '- Faster **search**.' },
        { version: '0.1.0-beta.10', notes: '' },
        { version: '0.1.0-beta.9', notes: 'Fixed the thing.' },
      ],
      changelogUrl: 'https://github.com/copse-dev/copse-releases/releases',
      buttons: ['Download', 'Later'],
    })

    const dialog = qsRequired<HTMLDialogElement>(document, '#update-prompt-dialog')
    assert.ok(dialog.classList.contains('has-changelog'))
    const changelog = qsRequired(dialog, '.update-prompt-changelog')
    assert.equal(changelog.hidden, false)
    assert.match(changelog.textContent, /What's new in 3 releases/)
    const versions = Array.from(
      dialog.querySelectorAll<HTMLElement>('.update-prompt-release'),
      (release) => release.dataset['version'],
    )
    assert.deepEqual(versions, ['0.1.0-beta.11', '0.1.0-beta.10', '0.1.0-beta.9'])
    assert.ok(dialog.querySelector('.update-prompt-notes strong'), 'notes render as Markdown')
    assert.match(changelog.textContent, /No notes for this release/)
    const all = qsRequired<HTMLAnchorElement>(dialog, '.update-prompt-all-notes')
    assert.equal(all.getAttribute('href'), 'https://github.com/copse-dev/copse-releases/releases')
  })

  it('hides the changelog when a later prompt has none', () => {
    mountUpdatePromptDialog(api)
    emit({
      id: 'prompt-3',
      message: 'Copse 1.2.3 is available',
      changelog: [{ version: '1.2.3', notes: 'Notes.' }],
      buttons: ['Download', 'Later'],
    })
    qsRequired<HTMLButtonElement>(document, '.update-prompt-secondary').click()
    emit({
      id: 'prompt-4',
      message: 'Copse 1.2.3 is ready to install',
      buttons: ['Restart now', 'Later'],
    })

    const dialog = qsRequired<HTMLDialogElement>(document, '#update-prompt-dialog')
    assert.equal(qsRequired(dialog, '.update-prompt-changelog').hidden, true)
    assert.equal(dialog.classList.contains('has-changelog'), false)
    assert.equal(dialog.querySelector('.update-prompt-all-notes'), null)
  })
})

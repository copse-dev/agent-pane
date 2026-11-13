import { el } from '../dom/helpers.ts'
import { mountComposerEditor } from './composer-editor.ts'

/** The editor and primary actions mounted by every chat host. */
export function createChatComposer(): {
  composer: ReturnType<typeof mountComposerEditor>
  submitBtn: HTMLButtonElement
  stopBtn: HTMLButtonElement
} {
  const composer = mountComposerEditor()
  composer.setPlaceholder('Message…')
  const submitBtn = el(
    'button',
    {
      class: 'submit-btn',
      type: 'button',
      'data-tooltip-placement': 'top',
    },
    'Send',
  )
  const stopBtn = el(
    'button',
    {
      class: 'stop-btn',
      type: 'button',
      hidden: '',
      'aria-label': 'Stop agent',
      'data-tooltip': 'Stop the running agent',
      'data-tooltip-placement': 'top',
    },
    'Stop',
  )
  return { composer, submitBtn, stopBtn }
}

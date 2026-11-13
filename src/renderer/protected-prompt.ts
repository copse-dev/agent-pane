import './styles/protected-prompt.css'
import type { ProtectedPromptSeed, ProtectedPromptSubmission } from '@shared/types'

declare global {
  interface Window {
    protectedPrompt: {
      onSeed(handler: (seed: ProtectedPromptSeed) => void): () => void
      submit(submission: ProtectedPromptSubmission): Promise<void>
      cancel(): Promise<void>
    }
  }
}

function required<T extends Element>(element: T | null, selector: string): T {
  if (!element) throw new Error(`Protected prompt window is missing ${selector}`)
  return element
}

const form = required(
  document.querySelector<HTMLFormElement>('#protected-prompt-form'),
  '#protected-prompt-form',
)
const text = required(
  document.querySelector<HTMLTextAreaElement>('#protected-prompt-text'),
  '#protected-prompt-text',
)
const project = required(
  document.querySelector<HTMLElement>('#protected-prompt-project'),
  '#protected-prompt-project',
)
const thread = required(
  document.querySelector<HTMLElement>('#protected-prompt-thread'),
  '#protected-prompt-thread',
)
const model = required(
  document.querySelector<HTMLElement>('#protected-prompt-model'),
  '#protected-prompt-model',
)
const details = required(
  document.querySelector<HTMLElement>('#protected-prompt-details'),
  '#protected-prompt-details',
)
const imagesSection = required(
  document.querySelector<HTMLElement>('#protected-prompt-images'),
  '#protected-prompt-images',
)
const imagesList = required(
  document.querySelector<HTMLElement>('#protected-prompt-image-list'),
  '#protected-prompt-image-list',
)
const contextSection = required(
  document.querySelector<HTMLElement>('#protected-prompt-context'),
  '#protected-prompt-context',
)
const contextList = required(
  document.querySelector<HTMLElement>('#protected-prompt-context-list'),
  '#protected-prompt-context-list',
)
const cancel = required(
  document.querySelector<HTMLButtonElement>('#protected-prompt-cancel'),
  '#protected-prompt-cancel',
)
const send = required(
  document.querySelector<HTMLButtonElement>('#protected-prompt-send'),
  '#protected-prompt-send',
)

let seed: ProtectedPromptSeed | null = null
let settling = false

function setSettling(value: boolean): void {
  settling = value
  text.disabled = value
  cancel.disabled = value
  send.disabled = value
}

window.protectedPrompt.onSeed((next) => {
  seed = next
  project.textContent = next.projectLabel
  thread.textContent = next.threadLabel
  model.textContent = next.model ?? 'Default model'
  const counts: string[] = []
  if (next.imageCount > 0)
    counts.push(`${String(next.imageCount)} image${next.imageCount === 1 ? '' : 's'}`)
  if (next.attachments.length > 0) {
    counts.push(
      `${String(next.attachments.length)} attachment${next.attachments.length === 1 ? '' : 's'}`,
    )
  }
  details.textContent = counts.length > 0 ? counts.join(' · ') : 'No attachments'
  imagesList.replaceChildren()
  for (const [index, dataUrl] of next.images.entries()) {
    const preview = document.createElement('img')
    preview.alt = `Attached image ${String(index + 1)} of ${String(next.images.length)}`
    preview.src = dataUrl
    imagesList.append(preview)
  }
  imagesSection.hidden = next.images.length === 0
  contextList.replaceChildren()
  for (const entry of next.context) {
    const row = document.createElement('div')
    const label = document.createElement('dt')
    const value = document.createElement('dd')
    label.textContent = entry.label
    value.textContent = entry.value
    row.append(label, value)
    contextList.append(row)
  }
  contextSection.hidden = next.context.length === 0
  text.value = next.text
  text.focus()
  text.setSelectionRange(text.value.length, text.value.length)
})

form.addEventListener('submit', (event) => {
  event.preventDefault()
  if (!seed || settling) return
  if (!text.value.trim() && seed.imageCount === 0) {
    text.focus()
    return
  }
  setSettling(true)
  void window.protectedPrompt.submit({ text: text.value }).catch(() => {
    setSettling(false)
  })
})

cancel.addEventListener('click', () => {
  if (settling) return
  setSettling(true)
  void window.protectedPrompt.cancel().catch(() => {
    setSettling(false)
  })
})

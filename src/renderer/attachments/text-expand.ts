import { showContextMenu } from '../dom/context-menu.ts'
import { el } from '../dom/helpers.ts'
import { showErrorToast, showToast } from '../views/toast.ts'
import { openAttachmentPreview } from './attachment-preview.ts'

function copyText(text: string): void {
  void navigator.clipboard
    .writeText(text)
    .then(() => showToast('Copied', { durationMs: 1500 }))
    .catch((error: unknown) => {
      showErrorToast('Failed to copy', error)
    })
}

/** Open a plain-text snapshot without interpreting its contents as markup. */
export function openTextExpand(content: string, name: string): void {
  const text = el('pre', { class: 'attachment-preview-text' })
  text.textContent = content
  text.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    event.stopPropagation()
    // The preview is the only selectable text in the dialog, so a non-empty
    // selection was made inside it; copy just that, otherwise the whole file.
    const selected = window.getSelection()?.toString()
    const hasSelection = Boolean(selected)
    showContextMenu(
      event.clientX,
      event.clientY,
      [
        {
          label: hasSelection ? 'Copy selection' : 'Copy',
          onSelect: (): void => {
            copyText(hasSelection && selected ? selected : content)
          },
        },
      ],
      text,
    )
  })
  openAttachmentPreview({
    kind: 'text',
    title: name,
    ariaLabel: `Text preview: ${name}`,
    content: text,
  })
}

/** Make a sent text attachment keyboard- and pointer-openable. */
export function attachTextExpand(chip: HTMLElement, content: string, name: string): void {
  if (chip.dataset['textExpand'] === 'true') return
  chip.dataset['textExpand'] = 'true'
  chip.classList.add('text-expandable')
  chip.setAttribute('role', 'button')
  chip.setAttribute('tabindex', '0')
  chip.setAttribute('aria-label', `Preview ${name}`)

  const open = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
    openTextExpand(content, name)
  }
  chip.addEventListener('click', open)
  chip.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    open(event)
  })
}

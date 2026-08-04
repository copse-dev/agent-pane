import { el } from '../dom/helpers.ts'

const COPY_LABEL = 'Copy'
const COPIED_LABEL = 'Copied'
const FEEDBACK_MS = 1200

function copyButtonText(code: HTMLElement): string {
  return code.textContent.trimStart()
}

export function attachCodeBlockCopyButtons(root: ParentNode): void {
  // Keep the selector compatible with engines that do not yet implement
  // relational `:has()` in the Selectors API (notably Servo). The `code`
  // lookup below already provides the same filtering behavior.
  const blocks = root.querySelectorAll('pre:not(.mermaid):not([data-copy-attached])')
  for (const node of blocks) {
    if (!(node instanceof HTMLElement)) continue
    const pre = node
    if (pre.closest('.mermaid-diagram')) continue

    const code = pre.querySelector('code')
    if (!code) continue

    const parent = pre.parentNode
    if (!parent) continue

    pre.dataset['copyAttached'] = 'true'
    pre.classList.add('code-block')

    const shell = el('div', { class: 'code-block-shell' })
    parent.insertBefore(shell, pre)
    shell.append(pre)

    const copyBtn = el(
      'button',
      { class: 'code-block-copy', 'aria-label': 'Copy code' },
      COPY_LABEL,
    )
    copyBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void navigator.clipboard.writeText(copyButtonText(code)).then(() => {
        copyBtn.textContent = COPIED_LABEL
        setTimeout(() => {
          copyBtn.textContent = COPY_LABEL
        }, FEEDBACK_MS)
      })
    })
    shell.prepend(copyBtn)
  }
}

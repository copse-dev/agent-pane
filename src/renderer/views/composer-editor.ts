import { renderTextBlock, textBlockLabel } from '@copse/agent/build-text-with-attachments.ts'

/**
 * The composer's rich input: a `contenteditable` that renders pasted text
 * blocks as atomic chips *inline with the typed text*, instead of a plain
 * `<textarea>` plus a detached chip row (issue: an attachment chip above the
 * composer loses its position in the sentence — "The editor points: [chip]"
 * reads as one thought and should stay one).
 *
 * The editor exposes a textarea-shaped surface so the mention/skill pickers and
 * the input bar port without rethinking their string logic:
 *
 * - `value` / `selectionStart` / `setSelectionRange` operate in *visible space*,
 *   where each chip counts as a single {@link CHIP_CHAR} (U+FFFC, the Unicode
 *   object-replacement character — its standard meaning). Setting `value` with
 *   CHIP_CHARs re-binds the existing chips to those slots in order, so the
 *   pickers' slice-and-reassemble edits pass chips through untouched.
 * - `expandedValue()` renders each chip as its fenced attachment block at its
 *   exact position — this is what submit, drafts, and the context estimate use.
 *
 * Editing this file? The chips must stay atomic: `contenteditable="false"`
 * children inside a `plaintext-only` root, so the caret treats a chip like one
 * character and Backspace deletes it whole. Known limitation: chip insert and
 * removal are DOM surgery, so the browser's undo stack does not restore them.
 */

/** Stand-in for one inline paste chip in `value` (U+FFFC OBJECT REPLACEMENT). */
export const CHIP_CHAR = '\uFFFC'

export interface InlinePasteBlock {
  id: string
  label: string
  content: string
}

/**
 * The textarea-shaped slice of the editor the autocomplete pickers depend on:
 * string value, linear caret offsets, and an element to listen on. Kept narrow
 * so the pickers stay ignorant of chips entirely.
 */
export interface ComposerTextInput {
  /** The contenteditable root (`.prompt-input`); listen for input/keydown here. */
  el: HTMLElement
  /** Visible text with each chip as one {@link CHIP_CHAR}. */
  value: string
  readonly selectionStart: number
  setSelectionRange(start: number, end: number): void
  focus(): void
}

export interface ComposerEditor extends ComposerTextInput {
  isFocused(): boolean
  setPlaceholder(text: string): void
  /** Blocks backing the chips, in document order. */
  getBlocks(): InlinePasteBlock[]
  /** Insert a paste chip at the caret (end when unfocused) and emit `input`. */
  insertPasteChip(content: string, label?: string): void
  /** Text with each chip expanded to its fenced block, in place. */
  expandedValue(): string
  clear(): void
}

const CHIP_SELECTOR = '.inline-paste-chip'

/** Visible-space text of a node tree: text as-is, `<br>` → `\n`, chip → CHIP_CHAR. */
function visibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? ''
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE)
    return ''
  if (node.nodeType === Node.ELEMENT_NODE) {
    const elNode = node as HTMLElement
    if (elNode.classList.contains('inline-paste-chip')) return CHIP_CHAR
    if (elNode.tagName === 'BR') return '\n'
  }
  let out = ''
  for (const child of Array.from(node.childNodes)) out += visibleText(child)
  return out
}

export function mountComposerEditor(): ComposerEditor {
  const root = document.createElement('div')
  root.className = 'prompt-input'
  root.setAttribute('contenteditable', 'plaintext-only')
  root.setAttribute('role', 'textbox')
  root.setAttribute('aria-multiline', 'true')
  root.setAttribute('aria-label', 'Message')

  const blocks = new Map<string, InlinePasteBlock>()

  function emitInput(): void {
    root.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function chipElements(): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(CHIP_SELECTOR))
  }

  /** Drop block entries whose chip is no longer in the DOM (user deleted it). */
  function pruneBlocks(): void {
    const present = new Set(chipElements().map((c) => c.dataset['blockId']))
    for (const id of blocks.keys()) if (!present.has(id)) blocks.delete(id)
  }

  function makeChip(block: InlinePasteBlock): HTMLElement {
    const chip = document.createElement('span')
    chip.className = 'inline-paste-chip'
    chip.setAttribute('contenteditable', 'false')
    chip.dataset['blockId'] = block.id
    chip.title = block.label
    const label = document.createElement('span')
    label.className = 'inline-paste-chip-label'
    label.textContent = block.label
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'inline-paste-chip-remove'
    remove.textContent = '✕'
    remove.setAttribute('aria-label', `Remove pasted text: ${block.label}`)
    remove.addEventListener('click', (e) => {
      e.preventDefault()
      chip.remove()
      blocks.delete(block.id)
      root.focus()
      emitInput()
    })
    chip.append(label, remove)
    return chip
  }

  /** Visible-space offset of a DOM point, counting chips crossed as one char. */
  function offsetOfPoint(node: Node, offset: number): number {
    const range = document.createRange()
    range.selectNodeContents(root)
    range.setEnd(node, offset)
    return visibleText(range.cloneContents()).length
  }

  /** DOM point for a visible-space offset (clamped to the content length). */
  function pointOfOffset(target: number): { node: Node; offset: number } {
    let remaining = target
    const walk = (parent: Node): { node: Node; offset: number } | null => {
      for (const child of Array.from(parent.childNodes)) {
        const len = visibleText(child).length
        if (remaining > len) {
          remaining -= len
          continue
        }
        if (child.nodeType === Node.TEXT_NODE) return { node: child, offset: remaining }
        // Atomic (chip/br) or nested element: land before/after it, or recurse.
        const idx = Array.from(parent.childNodes).indexOf(child)
        if (remaining === 0) return { node: parent, offset: idx }
        if (
          child.nodeType === Node.ELEMENT_NODE &&
          !isAtomic(child as HTMLElement) &&
          child.childNodes.length > 0
        ) {
          const inner = walk(child)
          if (inner) return inner
          continue
        }
        return { node: parent, offset: idx + 1 }
      }
      return null
    }
    const isAtomic = (elNode: HTMLElement): boolean =>
      elNode.classList.contains('inline-paste-chip') || elNode.tagName === 'BR'
    return walk(root) ?? { node: root, offset: root.childNodes.length }
  }

  function selectionInRoot(): Selection | null {
    const sel = document.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    if (!root.contains(range.startContainer)) return null
    return sel
  }

  function caretToEnd(): void {
    const sel = document.getSelection()
    if (!sel) return
    const range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  }

  // Chromium leaves a lone <br> behind when the user deletes the last character,
  // which defeats the CSS `:empty` placeholder; normalise it away.
  root.addEventListener('input', () => {
    if (root.childNodes.length === 1 && root.firstChild?.nodeName === 'BR') {
      root.replaceChildren()
    }
    pruneBlocks()
  })

  const editor: ComposerEditor = {
    el: root,

    get value(): string {
      return visibleText(root)
    },

    set value(v: string) {
      const existing = chipElements()
      const parts = v.split(CHIP_CHAR)
      const frag = document.createDocumentFragment()
      parts.forEach((part, i) => {
        if (part) frag.append(document.createTextNode(part))
        if (i < parts.length - 1) {
          const chip = existing[i]
          // A CHIP_CHAR with no chip to re-bind (e.g. a restored draft) is
          // dropped — there is no content behind it to represent.
          if (chip) frag.append(chip)
        }
      })
      root.replaceChildren(frag)
      pruneBlocks()
      if (editor.isFocused()) caretToEnd()
    },

    get selectionStart(): number {
      const sel = selectionInRoot()
      if (!sel) return visibleText(root).length
      const range = sel.getRangeAt(0)
      return offsetOfPoint(range.startContainer, range.startOffset)
    },

    setSelectionRange(start: number, end: number): void {
      const sel = document.getSelection()
      if (!sel) return
      const from = pointOfOffset(start)
      const to = start === end ? from : pointOfOffset(end)
      const range = document.createRange()
      range.setStart(from.node, from.offset)
      range.setEnd(to.node, to.offset)
      sel.removeAllRanges()
      sel.addRange(range)
    },

    focus(): void {
      root.focus()
      if (!selectionInRoot()) caretToEnd()
    },

    isFocused(): boolean {
      return document.activeElement === root
    },

    setPlaceholder(text: string): void {
      root.setAttribute('data-placeholder', text)
    },

    getBlocks(): InlinePasteBlock[] {
      return chipElements()
        .map((c) => blocks.get(c.dataset['blockId'] ?? ''))
        .filter((b): b is InlinePasteBlock => b !== undefined)
    },

    insertPasteChip(content: string, label?: string): void {
      const block: InlinePasteBlock = {
        id: crypto.randomUUID(),
        label: label ?? textBlockLabel(content),
        content,
      }
      blocks.set(block.id, block)
      const chip = makeChip(block)
      const sel = editor.isFocused() ? selectionInRoot() : null
      if (sel) {
        const range = sel.getRangeAt(0)
        range.deleteContents()
        range.insertNode(chip)
        range.setStartAfter(chip)
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
      } else {
        root.append(chip)
      }
      emitInput()
    },

    expandedValue(): string {
      const ordered = editor.getBlocks()
      let chipIdx = 0
      const parts = visibleText(root).split(CHIP_CHAR)
      let out = parts[0] ?? ''
      for (let i = 1; i < parts.length; i++) {
        const block = ordered[chipIdx++]
        const fence = block ? renderTextBlock(block.label, block.content) : ''
        if (fence) {
          if (out !== '' && !out.endsWith('\n')) out += '\n\n'
          else if (out.endsWith('\n') && !out.endsWith('\n\n')) out += '\n'
          out += fence
          const rest = parts[i] ?? ''
          if (rest !== '' && !rest.startsWith('\n')) out += '\n\n'
        }
        out += parts[i] ?? ''
      }
      return out
    },

    clear(): void {
      root.replaceChildren()
      blocks.clear()
    },
  }

  return editor
}

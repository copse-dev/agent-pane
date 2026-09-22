import { renderTextBlock, textBlockLabel } from '@copse/agent/build-text-with-attachments.ts'
import { attachTextExpand } from '../attachments/text-expand.ts'
import { attachmentIcon } from '../dom/attachment-icons.ts'
import { closeIcon } from '../dom/icons.ts'
import { isDefined } from '@shared/nullish.ts'

/**
 * The composer's rich input: a `contenteditable` that renders pasted text and
 * referenced threads as atomic chips *inline with the typed text*, instead of a
 * plain `<textarea>` plus a detached chip row (issue: a chip above the composer
 * loses its position in the sentence — "The editor points: [chip]" reads as one
 * thought and should stay one).
 *
 * The editor exposes a textarea-shaped surface so the mention/skill pickers and
 * the input bar port without rethinking their string logic:
 *
 * - `value` / `selectionStart` / `setSelectionRange` operate in *visible space*,
 *   where each chip counts as a single {@link CHIP_CHAR} (U+FFFC, the Unicode
 *   object-replacement character — its standard meaning). Setting `value` with
 *   CHIP_CHARs re-binds the existing chips to those slots in order, so the
 *   pickers' slice-and-reassemble edits pass chips through untouched.
 * - `expandedValue()` renders pasted-text chips as fenced attachment blocks at
 *   their exact positions and removes thread placeholders. Thread context stays
 *   in the existing structured attachment path.
 *
 * Editing this file? The chips must stay atomic: `contenteditable="false"`
 * children inside a `plaintext-only` root, so the caret treats a chip like one
 * character and Backspace deletes it whole. Known limitation: chip insert and
 * removal are DOM surgery, so the browser's undo stack does not restore them.
 */

/** Stand-in for one inline composer chip in `value` (U+FFFC OBJECT REPLACEMENT). */
export const CHIP_CHAR = '\uFFFC'

export interface InlinePasteBlock {
  id: string
  label: string
  content: string
}

export interface InlineThreadChip {
  threadId: string
  label: string
}

export type InlineComposerChip =
  | { kind: 'paste'; block: InlinePasteBlock }
  | { kind: 'thread'; thread: InlineThreadChip }

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
  /** Blocks backing pasted-text chips, in document order. */
  getBlocks(): InlinePasteBlock[]
  /** Every positional chip, in document order. */
  getInlineChips(): InlineComposerChip[]
  /** Insert a paste chip at the caret (end when unfocused) and emit `input`. */
  insertPasteChip(content: string, label?: string): void
  /** Insert a thread chip at the caret and keep its attachment state in sync. */
  insertThreadChip(thread: InlineThreadChip, onRemove: () => void): void
  /** Text with paste chips expanded and thread placeholders removed. */
  expandedValue(): string
  /** Draft text with paste chips expanded and thread positions preserved. */
  draftValue(): string
  clear(): void
}

const CHIP_SELECTOR = '.inline-paste-chip, .inline-thread-chip'

/** Visible-space text of a node tree: text as-is, `<br>` → `\n`, chip → CHIP_CHAR. */
function visibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? ''
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE)
    return ''
  if (node.nodeType === Node.ELEMENT_NODE) {
    if (!(node instanceof HTMLElement)) return ''
    const elNode = node
    if (
      elNode.classList.contains('inline-paste-chip') ||
      elNode.classList.contains('inline-thread-chip')
    )
      return CHIP_CHAR
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
  const threadChips = new Map<string, { thread: InlineThreadChip; onRemove: () => void }>()

  function emitInput(): void {
    root.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function chipElements(): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(CHIP_SELECTOR))
  }

  function inlineChipsInOrder(): InlineComposerChip[] {
    return chipElements().flatMap((chip): InlineComposerChip[] => {
      const id = chip.dataset['chipId'] ?? ''
      const block = blocks.get(id)
      if (block) return [{ kind: 'paste', block }]
      const thread = threadChips.get(id)?.thread
      return thread ? [{ kind: 'thread', thread }] : []
    })
  }

  /** Drop entries whose chip is no longer in the DOM (Backspace/Delete). */
  function pruneChips(): void {
    const present = new Set(chipElements().map((chip) => chip.dataset['chipId']))
    for (const id of blocks.keys()) if (!present.has(id)) blocks.delete(id)
    for (const [id, state] of threadChips) {
      if (present.has(id)) continue
      threadChips.delete(id)
      state.onRemove()
    }
  }

  function makePasteChip(block: InlinePasteBlock): HTMLElement {
    const chip = document.createElement('span')
    chip.className = 'inline-paste-chip'
    chip.setAttribute('contenteditable', 'false')
    chip.dataset['chipId'] = block.id
    chip.title = block.label
    const label = document.createElement('span')
    label.className = 'inline-paste-chip-label'
    label.textContent = block.label
    // Openable before send, so a paste can be checked without sending it. The
    // handler preventDefaults, so a click reads as "open" rather than dropping
    // the caret into a chip the editor treats as one atomic character.
    attachTextExpand(label, block.content, block.label)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'inline-paste-chip-remove'
    remove.append(closeIcon('ui-icon ui-icon-sm'))
    remove.setAttribute('aria-label', `Remove pasted text: ${block.label}`)
    remove.addEventListener('click', (event) => {
      event.preventDefault()
      chip.remove()
      blocks.delete(block.id)
      root.focus()
      emitInput()
    })
    chip.append(label, remove)
    return chip
  }

  function makeThreadChip(
    id: string,
    state: { thread: InlineThreadChip; onRemove: () => void },
  ): HTMLElement {
    const chip = document.createElement('span')
    chip.className = 'inline-thread-chip'
    chip.setAttribute('contenteditable', 'false')
    chip.dataset['chipId'] = id
    chip.dataset['threadId'] = state.thread.threadId
    chip.title = state.thread.label

    const label = document.createElement('span')
    label.className = 'inline-thread-chip-label'
    label.textContent = state.thread.label

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'inline-thread-chip-remove'
    remove.append(closeIcon('ui-icon ui-icon-sm'))
    remove.setAttribute('aria-label', `Remove thread: ${state.thread.label}`)
    remove.addEventListener('click', (event) => {
      event.preventDefault()
      chip.remove()
      threadChips.delete(id)
      state.onRemove()
      root.focus()
      emitInput()
    })

    chip.append(attachmentIcon('thread', 'thread-chip-icon'), label, remove)
    return chip
  }

  function insertChip(chip: HTMLElement): void {
    const selection = editor.isFocused() ? selectionInRoot() : null
    if (selection) {
      const range = selection.getRangeAt(0)
      range.deleteContents()
      range.insertNode(chip)
      range.setStartAfter(chip)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    } else {
      root.append(chip)
    }
    emitInput()
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
        if (child instanceof HTMLElement && !isAtomic(child) && child.childNodes.length > 0) {
          const inner = walk(child)
          if (inner) return inner
          continue
        }
        return { node: parent, offset: idx + 1 }
      }
      return null
    }
    const isAtomic = (elNode: HTMLElement): boolean =>
      elNode.classList.contains('inline-paste-chip') ||
      elNode.classList.contains('inline-thread-chip') ||
      elNode.tagName === 'BR'
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
    pruneChips()
  })

  function serializedValue(preserveThreadPlaceholders: boolean): string {
    const ordered = inlineChipsInOrder()
    let chipIdx = 0
    const parts = visibleText(root).split(CHIP_CHAR)
    let out = parts[0] ?? ''
    for (let i = 1; i < parts.length; i++) {
      const chip = ordered[chipIdx++]
      if (chip?.kind === 'thread') {
        out += preserveThreadPlaceholders ? CHIP_CHAR : `@${chip.thread.label}`
        out += parts[i] ?? ''
        continue
      }
      const block = chip?.kind === 'paste' ? chip.block : undefined
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
  }

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
      pruneChips()
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
      return editor
        .getInlineChips()
        .map((chip) => (chip.kind === 'paste' ? chip.block : undefined))
        .filter(isDefined)
    },

    getInlineChips(): InlineComposerChip[] {
      return inlineChipsInOrder()
    },

    insertPasteChip(content: string, label?: string): void {
      const block: InlinePasteBlock = {
        id: crypto.randomUUID(),
        label: label ?? textBlockLabel(content),
        content,
      }
      blocks.set(block.id, block)
      insertChip(makePasteChip(block))
    },

    insertThreadChip(thread: InlineThreadChip, onRemove: () => void): void {
      const id = crypto.randomUUID()
      const state = { thread, onRemove }
      threadChips.set(id, state)
      insertChip(makeThreadChip(id, state))
    },

    expandedValue(): string {
      return serializedValue(false)
    },

    draftValue(): string {
      return serializedValue(true)
    },

    clear(): void {
      root.replaceChildren()
      blocks.clear()
      threadChips.clear()
    },
  }

  return editor
}

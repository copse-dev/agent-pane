import { Editor, getDebugJSON } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import Image from '@tiptap/extension-image'
import { diffChars } from 'diff'
import { el } from '../dom/helpers.ts'
import { undoIcon } from '../dom/icons.ts'

export interface PlanPassage {
  start: number
  end: number
  text: string
}

interface PlanDocumentEditor {
  element: HTMLElement
  value: string
  readOnly: boolean
  readonly passage: PlanPassage | null
  destroy: () => void
}

// Keep image Markdown editable without fetching arbitrary agent-authored URLs.
const ImageReference = Image.extend({
  renderHTML({ node }) {
    const alt: unknown = node.attrs['alt']
    return [
      'span',
      { class: 'plan-image-reference' },
      `Image: ${typeof alt === 'string' ? alt : ''}`,
    ]
  },
})

/** Map a rendered selection back to the saved Markdown, including repeated text. */
function sourceRange(
  canonical: string,
  source: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  const changes = diffChars(canonical, source, { timeout: 30, maxEditLength: 10000 })
  if (!changes) return null
  function point(offset: number, endBoundary: boolean): number {
    let from = 0
    let to = 0
    for (const change of changes ?? []) {
      const length = change.value.length
      if (change.added) {
        if (from === offset && endBoundary) return to
        to += length
      } else if (change.removed) {
        if (offset < from + length) return to
        from += length
      } else {
        if (offset < from + length) return to + offset - from
        from += length
        to += length
      }
    }
    return to
  }
  const range = { start: point(start, false), end: point(end, true) }
  return range.end > range.start ? range : null
}

/** The selection is an offset range into the exact saved Markdown revision. */
export function getPlanPassage(editor: Editor, source: string): PlanPassage | null {
  const { from, to, empty } = editor.state.selection
  if (empty || !editor.markdown) return null
  const startPosition = editor.state.doc.resolve(from)
  const endPosition = editor.state.doc.resolve(to)
  if (!startPosition.parent.inlineContent || !endPosition.parent.inlineContent) return null
  // Insert markers in a detached transaction: never alter the live document or
  // undo history just to locate a passage in its Markdown serialization.
  const startMarker = `COPSESTART${crypto.randomUUID().replaceAll('-', '')}`
  const endMarker = `COPSEEND${crypto.randomUUID().replaceAll('-', '')}`
  const marked = editor.state.tr
    .insert(to, editor.schema.text(endMarker, endPosition.nodeBefore?.marks ?? endPosition.marks()))
    .insert(
      from,
      editor.schema.text(startMarker, startPosition.nodeAfter?.marks ?? startPosition.marks()),
    )
  const serialized = editor.markdown.serialize(getDebugJSON(marked.doc))
  const start = serialized.indexOf(startMarker)
  const end = serialized.indexOf(endMarker) - startMarker.length
  const plain = serialized.replace(startMarker, '').replace(endMarker, '')
  const current = editor.getMarkdown()
  if (start < 0 || end <= start || plain !== current) return null
  const range = sourceRange(current, source, start, end)
  return range ? { ...range, text: editor.state.doc.textBetween(from, to, '\n') } : null
}

/** Rich document editing, with exact source retained until the document changes. */
export function mountPlanDocumentEditor(
  onChange: () => void,
  onSelection: () => void,
  identity = { id: 'plan', label: 'Plan' },
): PlanDocumentEditor {
  const root = el('section', { class: 'plan-document' })
  const toolbar = el('div', {
    class: 'plan-format-toolbar',
    role: 'toolbar',
    'aria-label': `${identity.label} formatting`,
  })
  const formatting = el('div', { class: 'plan-format-actions' })
  const modes = el('div', { class: 'plan-editor-modes', 'aria-label': 'Editor view' })
  const documentButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-ghost ui-btn-compact' },
    'Document',
  )
  const sourceButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-ghost ui-btn-compact' },
    'Markdown',
  )
  modes.append(documentButton, sourceButton)
  toolbar.append(formatting, modes)
  const host = el('div', { class: 'plan-document-page' })
  const source = el('textarea', {
    id: `${identity.id}-source`,
    class: 'plan-editor-source',
    'aria-label': `${identity.label} Markdown`,
    spellcheck: 'false',
  })
  source.hidden = true
  root.append(toolbar, host, source)
  let original = ''
  let canonical = ''
  let locked = false
  let sourceMode = false
  let passage: PlanPassage | null = null
  const formatButtons: Array<{ button: HTMLButtonElement; active: () => boolean }> = []

  function createEditor(content: string): Editor {
    return new Editor({
      element: host,
      extensions: [
        StarterKit.configure({
          underline: false,
          trailingNode: false,
          link: { openOnClick: false },
        }),
        Markdown,
        TableKit,
        TaskList,
        TaskItem.configure({ nested: true, HTMLAttributes: { 'data-type': 'taskItem' } }),
        ImageReference,
      ],
      content,
      contentType: 'markdown',
      editable: !locked,
      editorProps: {
        attributes: {
          id: `${identity.id}-body`,
          class: 'plan-editor-body',
          role: 'textbox',
          'aria-label': `${identity.label} body`,
          'aria-multiline': 'true',
          spellcheck: 'true',
        },
        handleClick: (_view, _pos, event): boolean => {
          if (event.target instanceof Element && event.target.closest('a')) event.preventDefault()
          return false
        },
      },
      onUpdate: (): void => {
        passage = null
        refreshToolbar()
        onChange()
        onSelection()
      },
      onSelectionUpdate: (): void => {
        passage = selectedPassage()
        refreshToolbar()
        onSelection()
      },
    })
  }
  let editor = createEditor('')
  function value(): string {
    if (sourceMode) return source.value
    const next = editor.getMarkdown()
    return next === canonical ? original : next
  }
  function selectedPassage(): PlanPassage | null {
    if (sourceMode) {
      const { selectionStart: start, selectionEnd: end } = source
      return end > start ? { start, end, text: source.value.slice(start, end) } : null
    }
    return getPlanPassage(editor, value())
  }

  function refreshToolbar(): void {
    formatting.hidden = locked || sourceMode
    for (const item of formatButtons) {
      item.button.disabled = locked
      item.button.setAttribute('aria-pressed', String(item.active()))
    }
    documentButton.setAttribute('aria-pressed', String(!sourceMode))
    sourceButton.setAttribute('aria-pressed', String(sourceMode))
  }
  function addFormat(
    label: string,
    text: string | Node,
    run: () => void,
    active = (): boolean => false,
  ): void {
    const button = el(
      'button',
      {
        type: 'button',
        class: 'ui-btn ui-btn-ghost ui-btn-compact',
        'aria-label': label,
        title: label,
      },
      text,
    )
    // Preserve the selection until the formatting command has consumed it.
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
    })
    button.addEventListener('click', () => {
      if (!locked) run()
    })
    formatButtons.push({ button, active })
    formatting.append(button)
  }
  addFormat(
    'Paragraph',
    'Text',
    () => {
      editor.chain().focus().setParagraph().run()
    },
    () => editor.isActive('paragraph'),
  )
  addFormat(
    'Heading',
    'H',
    () => {
      editor.chain().focus().toggleHeading({ level: 1 }).run()
    },
    () => editor.isActive('heading'),
  )
  addFormat(
    'Bold',
    'B',
    () => {
      editor.chain().focus().toggleBold().run()
    },
    () => editor.isActive('bold'),
  )
  addFormat(
    'Italic',
    'I',
    () => {
      editor.chain().focus().toggleItalic().run()
    },
    () => editor.isActive('italic'),
  )
  addFormat(
    'Bullet list',
    '• List',
    () => {
      editor.chain().focus().toggleBulletList().run()
    },
    () => editor.isActive('bulletList'),
  )
  addFormat(
    'Numbered list',
    '1. List',
    () => {
      editor.chain().focus().toggleOrderedList().run()
    },
    () => editor.isActive('orderedList'),
  )
  addFormat(
    'Inline code',
    '<>',
    () => {
      editor.chain().focus().toggleCode().run()
    },
    () => editor.isActive('code'),
  )
  addFormat('Undo', undoIcon(), () => {
    editor.chain().focus().undo().run()
  })
  const redoIcon = undoIcon()
  redoIcon.classList.add('plan-redo-icon')
  addFormat('Redo', redoIcon, () => {
    editor.chain().focus().redo().run()
  })

  function load(markdown: string): void {
    original = markdown
    source.value = markdown
    passage = null
    editor.destroy()
    host.replaceChildren()
    editor = createEditor(markdown)
    canonical = editor.getMarkdown()
    refreshToolbar()
  }
  function mode(useSource: boolean): void {
    if (sourceMode === useSource) return
    const markdown = value()
    sourceMode = useSource
    if (useSource) source.value = markdown
    else load(markdown)
    host.hidden = useSource
    source.hidden = !useSource
    passage = null
    refreshToolbar()
    onSelection()
  }
  documentButton.addEventListener('click', () => {
    mode(false)
  })
  sourceButton.addEventListener('click', () => {
    mode(true)
  })
  source.addEventListener('input', () => {
    passage = null
    onChange()
    onSelection()
  })
  source.addEventListener('select', () => {
    passage = selectedPassage()
    onSelection()
  })
  refreshToolbar()
  return {
    element: root,
    get value(): string {
      return value()
    },
    set value(markdown: string) {
      load(markdown)
    },
    get readOnly(): boolean {
      return locked
    },
    set readOnly(readOnly: boolean) {
      if (locked !== readOnly) editor.setEditable(!readOnly, false)
      locked = readOnly
      source.readOnly = readOnly
      editor.view.dom.setAttribute('aria-readonly', String(readOnly))
      refreshToolbar()
    },
    get passage(): PlanPassage | null {
      return passage
    },
    destroy(): void {
      editor.destroy()
    },
  }
}

import type * as Monaco from 'monaco-editor'
import { el } from '../dom/helpers.ts'
import type { GitDiffCodeEditor, GitDiffEditor } from './git-diff-viewer.ts'

/**
 * Review comments left on lines of a diff, collected and sent to the agent as
 * one message — so a review of agent-written code is one turn for the agent,
 * not one interruption per remark.
 *
 * Comments are drafts held in this window's memory, keyed by the thread whose
 * changes they review; sending or discarding clears them. They anchor to a line
 * number plus that line's text, so a comment follows its line when the agent
 * edits around it before the batch goes out.
 */

/** `before` comments sit on the original file (a removed line); `after` on the new one. */
export type LineCommentSide = 'before' | 'after'

export interface LineComment {
  readonly id: string
  readonly path: string
  readonly side: LineCommentSide
  /** 1-based line in the file on `side`. */
  readonly line: number
  /** The line's text when the comment was written; quoted to the agent and used to re-anchor. */
  readonly lineText: string
  readonly body: string
}

type Listener = () => void

/** Draft comments for each owner (a project/thread pair), in the order they were written. */
export class LineCommentDrafts {
  private readonly byOwner = new Map<string, LineComment[]>()
  private readonly listeners = new Set<Listener>()
  private nextId = 1

  list(owner: string): readonly LineComment[] {
    return this.byOwner.get(owner) ?? []
  }

  add(owner: string, comment: Omit<LineComment, 'id'>): LineComment {
    const added: LineComment = {
      ...comment,
      id: `line-comment-${String(this.nextId++)}`,
    }
    this.byOwner.set(owner, [...this.list(owner), added])
    this.emit()
    return added
  }

  update(owner: string, id: string, patch: Partial<Pick<LineComment, 'body' | 'line'>>): void {
    const current = this.list(owner)
    if (!current.some((comment) => comment.id === id)) return
    this.byOwner.set(
      owner,
      current.map((comment) => (comment.id === id ? { ...comment, ...patch } : comment)),
    )
    this.emit()
  }

  remove(owner: string, id: string): void {
    const remaining = this.list(owner).filter((comment) => comment.id !== id)
    if (remaining.length === 0) this.byOwner.delete(owner)
    else this.byOwner.set(owner, remaining)
    this.emit()
  }

  clear(owner: string): void {
    if (!this.byOwner.delete(owner)) return
    this.emit()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function codeFence(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longestRun + 1))
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `${prefix}${line}` : line))
    .join('\n')
}

/** Label for the composer chip and transcript that carries a batch. */
export function lineCommentBatchLabel(count: number): string {
  return count === 1 ? '1 review comment' : `${String(count)} review comments`
}

/**
 * The message the agent receives: every comment with its file, line and the
 * line's text, grouped by file in line order so related remarks read together.
 */
export function formatLineCommentBatch(comments: readonly LineComment[]): string {
  const ordered = [...comments].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      (a.side === b.side ? 0 : a.side === 'before' ? -1 : 1) ||
      a.line - b.line,
  )
  const items = ordered.map((comment, index) => {
    const where =
      comment.side === 'before'
        ? `\`${comment.path}\` line ${String(comment.line)} (removed by your change)`
        : `\`${comment.path}\` line ${String(comment.line)}`
    const fence = codeFence(comment.lineText)
    const quoted = `${fence}\n${comment.lineText}\n${fence}`
    return `${String(index + 1)}. ${where}:\n${indent(quoted, '   ')}\n${indent(comment.body.trim(), '   ')}`
  })
  const heading =
    comments.length === 1
      ? 'I left a review comment on your changes. Please address it:'
      : `I left ${String(comments.length)} review comments on your changes. Please address each one:`
  return `${heading}\n\n${items.join('\n\n')}`
}

/**
 * Where a comment's line is now: its recorded line if that still holds the
 * text it was written on, otherwise the nearest line with that text, otherwise
 * the recorded line clamped into the file.
 */
export function reanchorLine(lines: readonly string[], line: number, lineText: string): number {
  if (lines.length === 0) return 1
  if (lines[line - 1] === lineText) return line
  for (let distance = 1; distance < lines.length; distance++) {
    if (lines[line - 1 - distance] === lineText) return line - distance
    if (lines[line - 1 + distance] === lineText) return line + distance
  }
  return Math.min(Math.max(1, line), lines.length)
}

/**
 * Monaco's `MouseTargetType.GUTTER_GLYPH_MARGIN`. The enum is a runtime value
 * of the lazily loaded Monaco bundle, which this module only sees as types.
 * The e2e spec clicks the real glyph margin, so a renumbering fails there.
 */
export const GLYPH_MARGIN_TARGET = 2

interface MouseTarget {
  readonly type: number
  readonly position: { readonly lineNumber: number } | null
}

interface DecorationsCollection {
  set(decorations: readonly Monaco.editor.IModelDeltaDecoration[]): unknown
  clear(): void
}

interface ViewZoneAccessor {
  addZone(zone: Monaco.editor.IViewZone): string
  removeZone(id: string): void
  layoutZone(id: string): void
}

/** The parts of a Monaco code editor that line comments draw on. */
interface CommentSurface {
  onMouseMove(listener: (event: { target: MouseTarget }) => void): {
    dispose(): void
  }
  onMouseLeave(listener: () => void): { dispose(): void }
  onMouseDown(
    listener: (event: { target: MouseTarget; event: { preventDefault(): void } }) => void,
  ): { dispose(): void }
  createDecorationsCollection(): DecorationsCollection
  changeViewZones(callback: (accessor: ViewZoneAccessor) => void): void
  updateOptions(options: Monaco.editor.IEditorOptions): void
}

/**
 * Optional on {@link GitDiffCodeEditor} because the narrow test doubles of the
 * diff editor omit them; Monaco's code editor always has every one.
 */
export interface CommentableCodeEditor {
  onMouseMove?: CommentSurface['onMouseMove']
  onMouseLeave?: CommentSurface['onMouseLeave']
  onMouseDown?: CommentSurface['onMouseDown']
  createDecorationsCollection?: CommentSurface['createDecorationsCollection']
  changeViewZones?: CommentSurface['changeViewZones']
}

function commentSurface(editor: GitDiffCodeEditor): CommentSurface | null {
  const { onMouseMove, onMouseLeave, onMouseDown, createDecorationsCollection, changeViewZones } =
    editor
  if (!onMouseMove || !onMouseLeave || !onMouseDown) return null
  if (!createDecorationsCollection || !changeViewZones) return null
  return {
    onMouseMove: (listener) => onMouseMove.call(editor, listener),
    onMouseLeave: (listener) => onMouseLeave.call(editor, listener),
    onMouseDown: (listener) => onMouseDown.call(editor, listener),
    createDecorationsCollection: () => createDecorationsCollection.call(editor),
    changeViewZones: (callback): void => {
      changeViewZones.call(editor, callback)
    },
    updateOptions: (options): void => {
      editor.updateOptions(options)
    },
  }
}

/** What the diff on screen is, or null while no commentable file diff is shown. */
export interface LineCommentContext {
  readonly owner: string
  readonly path: string
}

interface Draft {
  readonly side: LineCommentSide
  readonly line: number
  /** Set while editing a saved comment rather than writing a new one. */
  readonly editingId?: string
}

/** Events inside a comment card stay in the card instead of reaching Monaco. */
const ISOLATED_EVENTS = [
  'pointerdown',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'contextmenu',
  'keydown',
  'keypress',
  'keyup',
  'copy',
  'cut',
  'paste',
] as const

/**
 * A zone spans the editor's whole scrollable width, which for a long line is
 * far wider than the pane; size cards to the visible text area instead.
 */
function fitToEditor(zoneNode: HTMLElement): void {
  const editor = zoneNode.closest<HTMLElement>('.monaco-editor')
  const margin = editor?.querySelector<HTMLElement>('.margin')
  if (!editor || !margin) return
  const width = Math.max(0, editor.clientWidth - margin.offsetWidth - SCROLLBAR_ALLOWANCE)
  editor.style.setProperty('--diff-line-comment-width', `${String(width)}px`)
}

/** Room left for the editor's vertical scrollbar beside a card. */
const SCROLLBAR_ALLOWANCE = 16

function isolate(node: HTMLElement): void {
  for (const type of ISOLATED_EVENTS) {
    node.addEventListener(type, (event) => {
      event.stopPropagation()
    })
  }
}

/**
 * Let the user comment on lines of `diffEditor`: a "+" appears in the gutter
 * of the hovered line, a click opens a comment box under it, and saved
 * comments stay drawn under their lines. Returns a function that removes it.
 */
export function attachDiffLineComments(
  diffEditor: GitDiffEditor,
  drafts: LineCommentDrafts,
  getContext: () => LineCommentContext | null,
): () => void {
  const sides = [
    { side: 'before' as const, editor: diffEditor.getOriginalEditor() },
    { side: 'after' as const, editor: diffEditor.getModifiedEditor() },
  ].flatMap(({ side, editor }) => {
    const surface = commentSurface(editor)
    return surface ? [{ side, surface, hover: surface.createDecorationsCollection() }] : []
  })
  if (sides.length === 0) return () => {}

  let draft: Draft | null = null
  let draftContext: LineCommentContext | null = null
  // Built once per open draft, so a re-render (a diff refresh, another comment
  // saved) keeps what the user has typed and where their caret is.
  let draftNode: HTMLElement | null = null
  let focusDraft = false
  const zoneIds = new Map<LineCommentSide, string[]>()
  const resizeObservers: ResizeObserver[] = []
  const disposables: Array<{ dispose(): void }> = []

  function linesFor(side: LineCommentSide): readonly string[] {
    const models = diffEditor.getModel()
    if (!models) return []
    return (side === 'before' ? models.original : models.modified).getValue().split('\n')
  }

  function openDraft(side: LineCommentSide, line: number, editingId?: string): void {
    const context = getContext()
    if (!context) return
    draft = editingId ? { side, line, editingId } : { side, line }
    draftContext = context
    draftNode = draftCard(context, draft)
    focusDraft = true
    render()
  }

  function dropDraft(): void {
    draft = null
    draftContext = null
    draftNode = null
  }

  function closeDraft(): void {
    dropDraft()
    render()
  }

  function commentCard(context: LineCommentContext, comment: LineComment): HTMLElement {
    const edit = el(
      'button',
      {
        type: 'button',
        class: 'ui-btn ui-btn-ghost ui-btn-compact diff-line-comment-edit',
      },
      'Edit',
    )
    const remove = el(
      'button',
      {
        type: 'button',
        class: 'ui-btn ui-btn-ghost ui-btn-compact diff-line-comment-delete',
      },
      'Delete',
    )
    edit.addEventListener('click', () => {
      openDraft(comment.side, comment.line, comment.id)
    })
    remove.addEventListener('click', () => {
      drafts.remove(context.owner, comment.id)
    })
    return el(
      'div',
      { class: 'diff-line-comment', 'data-comment-id': comment.id },
      el('div', { class: 'diff-line-comment-body' }, comment.body),
      el('div', { class: 'diff-line-comment-actions' }, edit, remove),
    )
  }

  function draftCard(context: LineCommentContext, open: Draft): HTMLElement {
    const existing = open.editingId
      ? drafts.list(context.owner).find((comment) => comment.id === open.editingId)
      : undefined
    const input = el('textarea', {
      class: 'diff-line-comment-input',
      rows: '3',
      placeholder: 'Comment for the agent',
      'aria-label': `Comment on line ${String(open.line)}`,
    })
    input.value = existing?.body ?? ''
    const cancel = el(
      'button',
      {
        type: 'button',
        class: 'ui-btn ui-btn-secondary ui-btn-compact diff-line-comment-cancel',
      },
      'Cancel',
    )
    const save = el(
      'button',
      {
        type: 'button',
        class: 'ui-btn ui-btn-primary ui-btn-compact diff-line-comment-save',
      },
      existing ? 'Save' : 'Add comment',
    )
    const syncSave = (): void => {
      save.disabled = !input.value.trim()
    }
    syncSave()
    const commit = (): void => {
      const body = input.value.trim()
      if (!body) return
      if (existing) {
        drafts.update(context.owner, existing.id, { body })
      } else {
        drafts.add(context.owner, {
          path: context.path,
          side: open.side,
          line: open.line,
          lineText: linesFor(open.side)[open.line - 1] ?? '',
          body,
        })
      }
      closeDraft()
    }
    input.addEventListener('input', syncSave)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeDraft()
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        commit()
      }
    })
    cancel.addEventListener('click', closeDraft)
    save.addEventListener('click', commit)
    return el(
      'div',
      { class: 'diff-line-comment is-draft' },
      input,
      el('div', { class: 'diff-line-comment-actions' }, cancel, save),
    )
  }

  function clearZones(): void {
    for (const observer of resizeObservers.splice(0)) observer.disconnect()
    for (const { side, surface } of sides) {
      const ids = zoneIds.get(side) ?? []
      if (ids.length === 0) continue
      surface.changeViewZones((accessor) => {
        for (const id of ids) accessor.removeZone(id)
      })
      zoneIds.set(side, [])
    }
  }

  function addZone(
    surface: CommentSurface,
    side: LineCommentSide,
    line: number,
    card: HTMLElement,
  ): void {
    const domNode = el('div', { class: 'diff-line-comment-zone' }, card)
    isolate(domNode)
    const zone: Monaco.editor.IViewZone = {
      afterLineNumber: line,
      heightInPx: 72,
      domNode,
      suppressMouseDown: true,
      // Monaco shows the zone on its next render, after this call; a
      // just-opened draft takes focus once it can.
      onDomNodeTop: () => {
        fitToEditor(domNode)
        if (card !== draftNode || !focusDraft) return
        requestAnimationFrame(() => {
          const input = card.querySelector('textarea')
          if (!focusDraft || card !== draftNode || !input) return
          // No scroll: the box is already under the clicked line, and scrolling
          // a wide diff sideways to its caret would hide the line numbers.
          input.focus({ preventScroll: true })
          focusDraft = document.activeElement !== input
        })
      },
    }
    let id = ''
    surface.changeViewZones((accessor) => {
      id = accessor.addZone(zone)
    })
    zoneIds.set(side, [...(zoneIds.get(side) ?? []), id])
    // The zone's height is the card's: measured once it is in the DOM, and again
    // whenever it reflows (a wrapping comment, a growing textarea).
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(domNode.scrollHeight)
      if (height <= 0 || height === zone.heightInPx) return
      zone.heightInPx = height
      surface.changeViewZones((accessor) => {
        accessor.layoutZone(id)
      })
    })
    observer.observe(card)
    resizeObservers.push(observer)
  }

  function render(): void {
    // Moving the draft into its new zone blurs it; give the caret back after.
    const draftFocused = draftNode?.contains(document.activeElement) === true
    clearZones()
    renderZones()
    if (draftFocused) draftNode?.querySelector('textarea')?.focus()
  }

  function renderZones(): void {
    const context = getContext()
    if (
      draft &&
      (!context || context.owner !== draftContext?.owner || context.path !== draftContext.path)
    ) {
      dropDraft()
    }
    if (!context) return
    for (const { side, surface } of sides) {
      const lines = linesFor(side)
      for (const comment of drafts.list(context.owner)) {
        if (comment.path !== context.path || comment.side !== side) continue
        if (draft?.editingId === comment.id) continue
        const line = reanchorLine(lines, comment.line, comment.lineText)
        if (line !== comment.line) {
          // Keep the stored line current; the update re-renders.
          drafts.update(context.owner, comment.id, { line })
          return
        }
        addZone(surface, side, line, commentCard(context, comment))
      }
      if (draft?.side === side && draftNode) addZone(surface, side, draft.line, draftNode)
    }
  }

  for (const { side, surface, hover } of sides) {
    surface.updateOptions({ glyphMargin: true })
    disposables.push(
      surface.onMouseMove(({ target }) => {
        const line = target.position?.lineNumber
        if (line === undefined || !getContext()) {
          hover.clear()
          return
        }
        hover.set([
          {
            range: {
              startLineNumber: line,
              startColumn: 1,
              endLineNumber: line,
              endColumn: 1,
            },
            options: {
              glyphMarginClassName: 'diff-line-comment-add',
              glyphMarginHoverMessage: { value: 'Comment on this line' },
            },
          },
        ])
      }),
      surface.onMouseLeave(() => {
        hover.clear()
      }),
      surface.onMouseDown(({ target, event }) => {
        if (target.type !== GLYPH_MARGIN_TARGET || !target.position) return
        event.preventDefault()
        openDraft(side, target.position.lineNumber)
      }),
    )
  }

  const unsubscribe = drafts.subscribe(render)
  // A new file, or new text for this one, moves or drops the comments drawn.
  disposables.push(diffEditor.onDidUpdateDiff(render))
  render()

  return () => {
    unsubscribe()
    clearZones()
    for (const { hover, surface } of sides) {
      hover.clear()
      surface.updateOptions({ glyphMargin: false })
    }
    for (const disposable of disposables) disposable.dispose()
  }
}

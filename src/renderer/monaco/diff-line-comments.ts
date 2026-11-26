import type * as Monaco from 'monaco-editor'
import { el } from '../dom/helpers.ts'
import type { GitDiffEditor } from './git-diff-viewer.ts'

/**
 * Review comments left on lines of a diff, collected and sent to the agent as
 * one message — so a review of agent-written code is one turn for the agent,
 * not one interruption per remark.
 *
 * Comments are drafts held in this window's memory, keyed by the thread whose
 * changes they review; sending or discarding clears them. They sit on lines of
 * the new side of the diff (the removed side is not on screen in the docked
 * pane's inline layout), and anchor to a line number plus that line's text and
 * its neighbours, so a comment follows its line when the agent edits around it
 * before the batch goes out.
 */

/** Which version of the file the diff on screen shows as its new side. */
export type LineCommentVersion = 'working' | 'staged' | 'committed' | 'proposed'

/** Where a comment sits: a line, and enough of its text to find it again. */
export interface LineAnchor {
  /** 1-based line in the new side of the diff. */
  readonly line: number
  /** The line's text when the comment was written; quoted to the agent. */
  readonly lineText: string
  /** The lines just above and below, which tell repeated lines (`}`, blanks) apart. */
  readonly above: string | undefined
  readonly below: string | undefined
}

export interface LineComment extends LineAnchor {
  readonly id: string
  readonly path: string
  readonly version: LineCommentVersion
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

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
}

function codeFence(text: string): string {
  return '`'.repeat(Math.max(3, longestBacktickRun(text) + 1))
}

/** `text` as an inline code span that a backtick inside it cannot close early. */
function inlineCode(text: string): string {
  const ticks = '`'.repeat(longestBacktickRun(text) + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${text}${pad}${ticks}`
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `${prefix}${line}` : line))
    .join('\n')
}

/**
 * Longest stretch of a line quoted to the agent. A comment on one line of a
 * minified bundle should not paste the whole bundle into the user message.
 */
export const MAX_QUOTED_LINE = 240

function quotedLine(text: string): string {
  return text.length > MAX_QUOTED_LINE ? `${text.slice(0, MAX_QUOTED_LINE)}…` : text
}

const VERSION_NOTE: Record<LineCommentVersion, string> = {
  working: '',
  staged: ' (staged version)',
  committed: ' (as committed)',
  proposed: ' (in your proposed edit)',
}

/** Label for the bar that counts what is waiting to be sent. */
export function lineCommentBatchLabel(count: number): string {
  return count === 1 ? '1 review comment' : `${String(count)} review comments`
}

/**
 * The message the agent receives: every comment with its file, line and the
 * line's text, grouped by file in line order so related remarks read together.
 */
export function formatLineCommentBatch(comments: readonly LineComment[]): string {
  const ordered = [...comments].sort(
    (a, b) => a.path.localeCompare(b.path) || a.version.localeCompare(b.version) || a.line - b.line,
  )
  const items = ordered.map((comment, index) => {
    const where = `${inlineCode(comment.path)} line ${String(comment.line)}${VERSION_NOTE[comment.version]}`
    const text = quotedLine(comment.lineText)
    const fence = codeFence(text)
    const quoted = `${fence}\n${text}\n${fence}`
    return `${String(index + 1)}. ${where}:\n${indent(quoted, '   ')}\n${indent(comment.body.trim(), '   ')}`
  })
  const heading =
    comments.length === 1
      ? 'I left a review comment on your changes. Please address it:'
      : `I left ${String(comments.length)} review comments on your changes. Please address each one:`
  return `${heading}\n\n${items.join('\n\n')}`
}

/**
 * A batch handed to the composer whose send stopped short of the thread (a
 * checkout prompt, a branch mismatch): it waits there for the user, and its
 * comments stay until a user message carrying it is recorded.
 */
export interface PendingLineCommentBatch {
  readonly owner: string
  readonly threadId: string
  readonly text: string
  readonly ids: readonly string[]
}

function removeComments(drafts: LineCommentDrafts, owner: string, ids: readonly string[]): void {
  const sent = new Set(ids)
  // Only what went out: a comment added since waits for the next batch.
  for (const comment of drafts.list(owner)) {
    if (sent.has(comment.id)) drafts.remove(owner, comment.id)
  }
}

/**
 * Send every comment `owner` has as one message. Returns null once the message
 * is recorded (and those comments are gone), or the batch still waiting in the
 * composer, whose comments stay until {@link settleLineCommentBatch} sees it land.
 */
export async function sendLineCommentBatch(
  drafts: LineCommentDrafts,
  owner: { readonly key: string; readonly threadId: string },
  send: (text: string) => Promise<boolean>,
): Promise<PendingLineCommentBatch | null> {
  const comments = drafts.list(owner.key)
  if (comments.length === 0) return null
  const batch: PendingLineCommentBatch = {
    owner: owner.key,
    threadId: owner.threadId,
    text: formatLineCommentBatch(comments),
    ids: comments.map((comment) => comment.id),
  }
  if (!(await send(batch.text))) return batch
  removeComments(drafts, batch.owner, batch.ids)
  return null
}

/** Clear a waiting batch's comments if `message` is the user message that carried it. */
export function settleLineCommentBatch(
  drafts: LineCommentDrafts,
  batch: PendingLineCommentBatch,
  threadId: string,
  message: { readonly role: string; readonly content: string } | undefined,
): boolean {
  if (threadId !== batch.threadId || message?.role !== 'user') return false
  if (!message.content.includes(batch.text)) return false
  removeComments(drafts, batch.owner, batch.ids)
  return true
}

/** The anchor for `line` in `lines`. */
export function anchorAt(lines: readonly string[], line: number): LineAnchor {
  return {
    line,
    lineText: lines[line - 1] ?? '',
    above: lines[line - 2],
    below: lines[line],
  }
}

/**
 * Where an anchored line is now. Of the lines holding its text, the one whose
 * neighbours still match best wins, the nearest breaking a tie; with no line
 * holding the text, the recorded line clamped into the file.
 */
export function reanchorLine(lines: readonly string[], anchor: LineAnchor): number {
  if (lines.length === 0) return 1
  let best: { line: number; score: number; distance: number } | null = null
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] !== anchor.lineText) continue
    const score =
      (lines[index - 1] === anchor.above ? 1 : 0) + (lines[index + 1] === anchor.below ? 1 : 0)
    const distance = Math.abs(index + 1 - anchor.line)
    if (!best || score > best.score || (score === best.score && distance < best.distance)) {
      best = { line: index + 1, score, distance }
    }
  }
  return best?.line ?? Math.min(Math.max(1, anchor.line), lines.length)
}

/**
 * Monaco's `MouseTargetType` values this module reads. The enum is a runtime
 * value of the lazily loaded Monaco bundle, which this module only sees as
 * types. The e2e spec clicks the real glyph margin, so a renumbering fails there.
 */
export const GLYPH_MARGIN_TARGET = 2
/** Targets on a line of the file itself: gutter, line number, text. Not a view zone. */
const LINE_TARGETS: ReadonlySet<number> = new Set([
  GLYPH_MARGIN_TARGET,
  3, // GUTTER_LINE_NUMBERS
  4, // GUTTER_LINE_DECORATIONS
  6, // CONTENT_TEXT
  7, // CONTENT_EMPTY
])

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
export interface CommentableCodeEditor {
  onMouseMove(listener: (event: { target: MouseTarget }) => void): { dispose(): void }
  onMouseLeave(listener: () => void): { dispose(): void }
  onMouseDown(
    listener: (event: { target: MouseTarget; event: { preventDefault(): void } }) => void,
  ): { dispose(): void }
  createDecorationsCollection(): DecorationsCollection
  changeViewZones(callback: (accessor: ViewZoneAccessor) => void): void
  updateOptions(options: Monaco.editor.IEditorOptions): void
}

/** What the diff on screen is, or null while no commentable file diff is shown. */
export interface LineCommentContext {
  readonly owner: string
  readonly path: string
  readonly version: LineCommentVersion
}

function contextKey(context: LineCommentContext): string {
  return JSON.stringify([context.owner, context.version, context.path])
}

/** An open comment box. It lives until saved or cancelled, whatever is on screen meanwhile. */
interface OpenDraft {
  anchor: LineAnchor
  /** Set while editing a saved comment rather than writing a new one. */
  readonly editingId?: string
  node: HTMLElement | null
  focusPending: boolean
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
 * Let the user comment on lines of `diffEditor`'s new side: a "+" appears in
 * the gutter of the hovered line, a click opens a comment box under it, and
 * saved comments stay drawn under their lines. Returns a function that removes it.
 */
export function attachDiffLineComments(
  diffEditor: GitDiffEditor,
  drafts: LineCommentDrafts,
  getContext: () => LineCommentContext | null,
): () => void {
  const editor = diffEditor.getModifiedEditor()
  const hover = editor.createDecorationsCollection()
  let hoverLine: number | null = null
  // One per file view, so a half-written comment survives a look at another file.
  const openDrafts = new Map<string, OpenDraft>()
  let zoneIds: string[] = []
  const resizeObservers: ResizeObserver[] = []
  const disposables: Array<{ dispose(): void }> = []
  let fitObserver: ResizeObserver | null = null

  function currentLines(): readonly string[] {
    return diffEditor.getModel()?.modified.getValue().split('\n') ?? []
  }

  /**
   * A zone spans the editor's whole scrollable width, which for a long line is
   * far wider than the pane; size cards to the visible text area, re-measured
   * when the editor resizes rather than on every render.
   */
  function watchWidth(zoneNode: HTMLElement): void {
    if (fitObserver) return
    const root = zoneNode.closest<HTMLElement>('.monaco-editor')
    const margin = root?.querySelector<HTMLElement>('.margin')
    if (!root || !margin) return
    const fit = (): void => {
      const width = Math.max(0, root.clientWidth - margin.offsetWidth - SCROLLBAR_ALLOWANCE)
      root.style.setProperty('--diff-line-comment-width', `${String(width)}px`)
    }
    fitObserver = new ResizeObserver(fit)
    fitObserver.observe(root)
    fit()
  }

  function openDraft(context: LineCommentContext, anchor: LineAnchor, editingId?: string): void {
    const draft: OpenDraft = editingId
      ? { anchor, editingId, node: null, focusPending: true }
      : { anchor, node: null, focusPending: true }
    draft.node = draftCard(context, draft)
    openDrafts.set(contextKey(context), draft)
    render()
  }

  function closeDraft(context: LineCommentContext): void {
    openDrafts.delete(contextKey(context))
    render()
  }

  function commentCard(context: LineCommentContext, comment: LineComment): HTMLElement {
    const edit = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-ghost ui-btn-compact diff-line-comment-edit' },
      'Edit',
    )
    const remove = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-ghost ui-btn-compact diff-line-comment-delete' },
      'Delete',
    )
    edit.addEventListener('click', () => {
      openDraft(context, comment, comment.id)
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

  function draftCard(context: LineCommentContext, draft: OpenDraft): HTMLElement {
    const existing = draft.editingId
      ? drafts.list(context.owner).find((comment) => comment.id === draft.editingId)
      : undefined
    const input = el('textarea', {
      class: 'diff-line-comment-input',
      rows: '3',
      placeholder: 'Comment for the agent',
      'aria-label': `Comment on line ${String(draft.anchor.line)}`,
    })
    input.value = existing?.body ?? ''
    const cancel = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-secondary ui-btn-compact diff-line-comment-cancel' },
      'Cancel',
    )
    const save = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-primary ui-btn-compact diff-line-comment-save' },
      existing ? 'Save' : 'Add comment',
    )
    const syncSave = (): void => {
      save.disabled = !input.value.trim()
    }
    syncSave()
    const commit = (): void => {
      const body = input.value.trim()
      if (!body) return
      // The anchor was taken when the box opened and has followed its line
      // since, so an edit by the agent in between cannot move the comment.
      const { line } = draft.anchor
      openDrafts.delete(contextKey(context))
      if (existing) {
        drafts.update(context.owner, existing.id, { body, line })
      } else {
        drafts.add(context.owner, {
          ...draft.anchor,
          path: context.path,
          version: context.version,
          body,
        })
      }
    }
    input.addEventListener('input', syncSave)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeDraft(context)
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        commit()
      }
    })
    cancel.addEventListener('click', () => {
      closeDraft(context)
    })
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
    if (zoneIds.length === 0) return
    const ids = zoneIds
    zoneIds = []
    editor.changeViewZones((accessor) => {
      for (const id of ids) accessor.removeZone(id)
    })
  }

  function addZone(line: number, card: HTMLElement, draft?: OpenDraft): void {
    const domNode = el('div', { class: 'diff-line-comment-zone' }, card)
    isolate(domNode)
    const zone: Monaco.editor.IViewZone = {
      afterLineNumber: line,
      heightInPx: 72,
      domNode,
      suppressMouseDown: true,
      // A line inside a collapsed unchanged region still shows its comment.
      showInHiddenAreas: true,
      // Monaco shows the zone on its next render, after this call; a
      // just-opened draft takes focus once it can.
      onDomNodeTop: () => {
        watchWidth(domNode)
        if (!draft?.focusPending) return
        requestAnimationFrame(() => {
          const input = card.querySelector('textarea')
          if (!draft.focusPending || !input) return
          // No scroll: the box is already under the clicked line, and scrolling
          // a wide diff sideways to its caret would hide the line numbers.
          input.focus({ preventScroll: true })
          draft.focusPending = document.activeElement !== input
        })
      },
    }
    editor.changeViewZones((accessor) => {
      const id = accessor.addZone(zone)
      zoneIds.push(id)
      // The zone's height is the card's: measured once it is in the DOM, and
      // again whenever it reflows (a wrapping comment, a growing textarea).
      const observer = new ResizeObserver(() => {
        const height = Math.ceil(domNode.scrollHeight)
        if (height <= 0 || height === zone.heightInPx) return
        zone.heightInPx = height
        editor.changeViewZones((layout) => {
          layout.layoutZone(id)
        })
      })
      observer.observe(card)
      resizeObservers.push(observer)
    })
  }

  function render(): void {
    // Moving a draft into its new zone blurs it; give the caret back after.
    const focused = [...openDrafts.values()].find(
      (draft) => draft.node?.contains(document.activeElement) === true,
    )
    clearZones()
    renderZones()
    if (focused?.node?.isConnected) focused.node.querySelector('textarea')?.focus()
  }

  function renderZones(): void {
    const context = getContext()
    if (!context) return
    const lines = currentLines()
    if (lines.length === 0) return
    const draft = openDrafts.get(contextKey(context))
    for (const comment of drafts.list(context.owner)) {
      if (comment.path !== context.path || comment.version !== context.version) continue
      if (draft?.editingId === comment.id) continue
      const line = reanchorLine(lines, comment)
      if (line !== comment.line) {
        // Keep the stored line current; the update re-renders.
        drafts.update(context.owner, comment.id, { line })
        return
      }
      addZone(line, commentCard(context, comment))
    }
    if (draft?.node) {
      draft.anchor = { ...draft.anchor, line: reanchorLine(lines, draft.anchor) }
      addZone(draft.anchor.line, draft.node, draft)
    }
  }

  function setHover(line: number | null): void {
    if (line === hoverLine) return
    hoverLine = line
    if (line === null) {
      hover.clear()
      return
    }
    hover.set([
      {
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        options: {
          glyphMarginClassName: 'diff-line-comment-add',
          glyphMarginHoverMessage: { value: 'Comment on this line' },
        },
      },
    ])
  }

  editor.updateOptions({ glyphMargin: true })
  disposables.push(
    editor.onMouseMove(({ target }) => {
      const onLine = LINE_TARGETS.has(target.type) && getContext() !== null
      setHover(onLine ? (target.position?.lineNumber ?? null) : null)
    }),
    editor.onMouseLeave(() => {
      setHover(null)
    }),
    editor.onMouseDown(({ target, event }) => {
      const context = getContext()
      if (target.type !== GLYPH_MARGIN_TARGET || !target.position || !context) return
      event.preventDefault()
      openDraft(context, anchorAt(currentLines(), target.position.lineNumber))
    }),
    // A new file, or new text for this one, moves the comments drawn.
    diffEditor.onDidUpdateDiff(render),
  )
  const unsubscribe = drafts.subscribe(render)
  render()

  return () => {
    unsubscribe()
    clearZones()
    setHover(null)
    fitObserver?.disconnect()
    editor.updateOptions({ glyphMargin: false })
    for (const disposable of disposables) disposable.dispose()
  }
}

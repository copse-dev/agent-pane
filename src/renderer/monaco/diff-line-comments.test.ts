import '../../../tests/setup-dom.ts'
import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type * as Monaco from 'monaco-editor'
import {
  anchorAt,
  attachDiffLineComments,
  formatLineCommentBatch,
  GLYPH_MARGIN_TARGET,
  LineCommentDrafts,
  lineCommentBatchLabel,
  MAX_QUOTED_LINE,
  reanchorLine,
  sendLineCommentBatch,
  settleLineCommentBatch,
  type CommentableCodeEditor,
  type LineComment,
  type LineCommentContext,
} from './diff-line-comments.ts'
import type { GitDiffCodeEditor, GitDiffEditor } from './git-diff-viewer.ts'

before(() => {
  // The zone height follows the card through a ResizeObserver; the test DOM has none.
  if (typeof globalThis.ResizeObserver === 'function') return
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

function comment(overrides: Partial<LineComment>): LineComment {
  return {
    id: 'c',
    path: 'src/a.ts',
    version: 'working',
    line: 1,
    lineText: 'const a = 1',
    above: undefined,
    below: undefined,
    body: 'Rename this',
    ...overrides,
  }
}

describe('formatLineCommentBatch', () => {
  it('lists every comment with its file, line, line text and body, ordered by file and line', () => {
    const text = formatLineCommentBatch([
      comment({ id: '1', path: 'src/b.ts', line: 3, lineText: 'b()', body: 'Second file' }),
      comment({ id: '2', path: 'src/a.ts', line: 9, lineText: 'late()', body: 'Later line' }),
      comment({ id: '3', path: 'src/a.ts', line: 2, lineText: 'early()', body: 'Earlier line' }),
    ])
    assert.equal(
      text,
      [
        'I left 3 review comments on your changes. Please address each one:',
        '',
        '1. `src/a.ts` line 2:',
        '   ```',
        '   early()',
        '   ```',
        '   Earlier line',
        '',
        '2. `src/a.ts` line 9:',
        '   ```',
        '   late()',
        '   ```',
        '   Later line',
        '',
        '3. `src/b.ts` line 3:',
        '   ```',
        '   b()',
        '   ```',
        '   Second file',
      ].join('\n'),
    )
  })

  it('says which version of the file a line is in when it is not the working copy', () => {
    const text = formatLineCommentBatch([
      comment({ id: '1', version: 'staged' }),
      comment({ id: '2', version: 'committed', line: 2 }),
      comment({ id: '3', version: 'proposed', line: 3 }),
    ])
    assert.match(text, /`src\/a\.ts` line 2 \(as committed\):/)
    assert.match(text, /`src\/a\.ts` line 3 \(in your proposed edit\):/)
    assert.match(text, /`src\/a\.ts` line 1 \(staged version\):/)
  })

  it('keeps backticks in a path or line inside their code spans', () => {
    const text = formatLineCommentBatch([
      comment({ path: 'docs/`odd`.md', lineText: 'const s = ```x```', body: 'Why?' }),
    ])
    assert.match(text, /^I left a review comment on your changes\. Please address it:/)
    assert.ok(text.includes('1. ``docs/`odd`.md`` line 1:'))
    assert.match(text, /\n {3}````\n {3}const s = ```x```\n {3}````\n/)
  })

  it('shortens a very long line', () => {
    const text = formatLineCommentBatch([comment({ lineText: 'x'.repeat(MAX_QUOTED_LINE + 50) })])
    assert.ok(text.includes(`${'x'.repeat(MAX_QUOTED_LINE)}…`))
    assert.ok(!text.includes('x'.repeat(MAX_QUOTED_LINE + 1)))
  })

  it('indents every line of a multi-line comment under its item', () => {
    const text = formatLineCommentBatch([comment({ body: 'First\nSecond' })])
    assert.match(text, /\n {3}First\n {3}Second$/)
  })
})

describe('lineCommentBatchLabel', () => {
  it('counts the comments', () => {
    assert.equal(lineCommentBatchLabel(1), '1 review comment')
    assert.equal(lineCommentBatchLabel(4), '4 review comments')
  })
})

describe('reanchorLine', () => {
  it('keeps a line that still holds its text and neighbours', () => {
    const lines = ['a', 'target', 'b']
    assert.equal(reanchorLine(lines, anchorAt(lines, 2)), 2)
  })

  it('follows a repeated line by its neighbours, not by distance', () => {
    const before = ['function a() {', '  one()', '}', 'function b() {', '  two()', '  three()', '}']
    const anchor = anchorAt(before, 7)
    const after = [...before.slice(0, 5), 'x()', 'y()', 'z()', 'w()', 'v()', '  three()', '}']
    assert.equal(reanchorLine(after, anchor), 12)
  })

  it('takes the nearest of equally good matches', () => {
    const anchor = { line: 2, lineText: 'target', above: 'gone', below: 'gone' }
    assert.equal(reanchorLine(['a', 'b', 'target', 'c', 'd', 'e', 'target'], anchor), 3)
  })

  it('clamps into the file when the text is gone', () => {
    const anchor = { line: 9, lineText: 'missing', above: undefined, below: undefined }
    assert.equal(reanchorLine(['a', 'b'], anchor), 2)
    assert.equal(reanchorLine([], anchor), 1)
  })
})

describe('LineCommentDrafts', () => {
  it('keeps each owner’s comments apart and notifies on every change', () => {
    const drafts = new LineCommentDrafts()
    let changes = 0
    drafts.subscribe(() => {
      changes++
    })
    const first = drafts.add('p/t1', comment({}))
    drafts.add('p/t2', comment({ body: 'Other thread' }))
    drafts.update('p/t1', first.id, { body: 'Edited' })
    assert.deepEqual(
      drafts.list('p/t1').map((c) => c.body),
      ['Edited'],
    )
    drafts.remove('p/t1', first.id)
    assert.equal(drafts.list('p/t1').length, 0)
    drafts.clear('p/t2')
    assert.equal(drafts.list('p/t2').length, 0)
    assert.equal(changes, 5)
  })
})

describe('sendLineCommentBatch', () => {
  const owner = { key: 'p/t', threadId: 't' }

  it('clears the comments once the message is recorded', async () => {
    const drafts = new LineCommentDrafts()
    drafts.add('p/t', comment({}))
    const sent: string[] = []
    const pending = await sendLineCommentBatch(drafts, owner, async (text) => {
      sent.push(text)
      return true
    })
    assert.equal(pending, null)
    assert.equal(sent.length, 1)
    assert.equal(drafts.list('p/t').length, 0)
  })

  it('keeps the comments while the message waits in the composer, until it lands', async () => {
    const drafts = new LineCommentDrafts()
    drafts.add('p/t', comment({}))
    const pending = await sendLineCommentBatch(drafts, owner, async () => false)
    assert.ok(pending)
    assert.equal(drafts.list('p/t').length, 1)

    // A comment written meanwhile is not part of the waiting batch.
    drafts.add('p/t', comment({ body: 'Written later' }))
    assert.equal(
      settleLineCommentBatch(drafts, pending, 't', { role: 'user', content: 'unrelated' }),
      false,
    )
    assert.equal(
      settleLineCommentBatch(drafts, pending, 'other', { role: 'user', content: pending.text }),
      false,
    )
    assert.equal(
      settleLineCommentBatch(drafts, pending, 't', {
        role: 'user',
        content: `Also check the tests.\n\n${pending.text}`,
      }),
      true,
    )
    assert.deepEqual(
      drafts.list('p/t').map((c) => c.body),
      ['Written later'],
    )
  })
})

type MouseListener = Parameters<CommentableCodeEditor['onMouseDown']>[0]
type MoveListener = Parameters<CommentableCodeEditor['onMouseMove']>[0]

interface FakeDiff {
  diffEditor: GitDiffEditor
  zones: Map<string, Monaco.editor.IViewZone>
  hovered: number[]
  clickGlyph(line: number): void
  move(type: number, line: number): void
  /** Replace the new side's text and fire the diff update, as a refresh does. */
  setAfter(text: string): void
}

function fakeDiff(after: string): FakeDiff {
  const zones = new Map<string, Monaco.editor.IViewZone>()
  const hovered: number[] = []
  let nextZone = 0
  let onDown: MouseListener | null = null
  let onMove: MoveListener | null = null
  const updates = new Set<() => void>()
  const disposable = { dispose(): void {} }
  let modifiedText = after
  const model = (value: () => string): { dispose(): void; getValue(): string } => ({
    dispose(): void {},
    getValue: value,
  })
  const models = { original: model(() => ''), modified: model(() => modifiedText) }
  const modified: GitDiffCodeEditor = {
    onKeyDown: () => disposable,
    onDidFocusEditorText: () => disposable,
    getSelection: () => null,
    getModel: () => null,
    revealLineInCenterIfOutsideViewport(): void {},
    updateOptions(): void {},
    onMouseMove: (listener) => {
      onMove = listener
      return disposable
    },
    onMouseLeave: () => disposable,
    onMouseDown: (listener) => {
      onDown = listener
      return disposable
    },
    createDecorationsCollection: () => ({
      set: (decorations): unknown[] => {
        for (const decoration of decorations) hovered.push(decoration.range.startLineNumber)
        return []
      },
      clear(): void {},
    }),
    changeViewZones: (callback) => {
      callback({
        addZone: (zone) => {
          const id = String(nextZone++)
          zones.set(id, zone)
          return id
        },
        removeZone: (id) => {
          zones.delete(id)
        },
        layoutZone(): void {},
      })
    },
  }
  const diffEditor: GitDiffEditor = {
    createViewModel: (m) => ({
      model: m,
      dispose(): void {},
      waitForDiff: async (): Promise<void> => {},
    }),
    dispose(): void {},
    getLineChanges: () => null,
    getModel: () => models,
    getModifiedEditor: () => modified,
    getOriginalEditor: () => modified,
    layout(): void {},
    onDidUpdateDiff: (listener) => {
      updates.add(listener)
      return {
        dispose: (): void => {
          updates.delete(listener)
        },
      }
    },
    setModel(): void {},
    updateOptions(): void {},
  }
  return {
    diffEditor,
    zones,
    hovered,
    clickGlyph: (line): void => {
      onDown?.({
        target: { type: GLYPH_MARGIN_TARGET, position: { lineNumber: line } },
        event: { preventDefault(): void {} },
      })
    },
    move: (type, line): void => {
      onMove?.({ target: { type, position: { lineNumber: line } } })
    },
    setAfter: (text): void => {
      modifiedText = text
      for (const listener of [...updates]) listener()
    },
  }
}

function zoneTexts(diff: FakeDiff): string[] {
  return [...diff.zones.values()].map((zone) => zone.domNode.textContent)
}

function draftInput(diff: FakeDiff): HTMLTextAreaElement {
  const input = [...diff.zones.values()]
    .map((zone) => zone.domNode.querySelector('textarea'))
    .find((node) => node !== null)
  assert.ok(input, 'expected an open comment box')
  return input
}

function type(input: HTMLTextAreaElement, text: string): void {
  input.value = text
  input.dispatchEvent(new Event('input'))
}

function save(diff: FakeDiff): void {
  const button = [...diff.zones.values()]
    .map((zone) => zone.domNode.querySelector<HTMLButtonElement>('.diff-line-comment-save'))
    .find((node) => node !== null)
  assert.ok(button)
  button.click()
}

const fileA: LineCommentContext = { owner: 'p/t', path: 'src/a.ts', version: 'working' }

describe('attachDiffLineComments', () => {
  it('opens a comment box from the gutter and keeps the saved comment under its line', () => {
    const diff = fakeDiff('one\ntwo\nthree')
    const drafts = new LineCommentDrafts()
    const detach = attachDiffLineComments(diff.diffEditor, drafts, () => fileA)

    diff.clickGlyph(2)
    assert.equal([...diff.zones.values()][0]?.afterLineNumber, 2)
    type(draftInput(diff), 'Use a constant')
    save(diff)

    assert.deepEqual(
      drafts.list('p/t').map(({ id: _id, ...rest }) => rest),
      [
        {
          line: 2,
          lineText: 'two',
          above: 'one',
          below: 'three',
          path: 'src/a.ts',
          version: 'working',
          body: 'Use a constant',
        },
      ],
    )
    assert.deepEqual(zoneTexts(diff), ['Use a constantEditDelete'])

    const del = [...diff.zones.values()][0]?.domNode.querySelector<HTMLButtonElement>(
      '.diff-line-comment-delete',
    )
    del?.click()
    assert.equal(drafts.list('p/t').length, 0)
    assert.equal(diff.zones.size, 0)
    detach()
  })

  it('keeps an open comment box on its line while the agent edits above it', () => {
    const diff = fakeDiff('one\ntwo\nthree')
    const drafts = new LineCommentDrafts()
    attachDiffLineComments(diff.diffEditor, drafts, () => fileA)

    diff.clickGlyph(2)
    type(draftInput(diff), 'About two')
    diff.setAfter('zero\none\ntwo\nthree')
    assert.equal([...diff.zones.values()][0]?.afterLineNumber, 3)
    assert.equal(draftInput(diff).value, 'About two')
    save(diff)

    assert.deepEqual(
      drafts.list('p/t').map(({ line, lineText }) => ({ line, lineText })),
      [{ line: 3, lineText: 'two' }],
    )
  })

  it('keeps a half-written comment while another file is on screen', () => {
    const diff = fakeDiff('one\ntwo')
    const drafts = new LineCommentDrafts()
    let context = fileA
    attachDiffLineComments(diff.diffEditor, drafts, () => context)

    diff.clickGlyph(1)
    type(draftInput(diff), 'Half a thought')
    context = { ...fileA, path: 'src/b.ts' }
    diff.setAfter('other file')
    assert.equal(diff.zones.size, 0)

    context = fileA
    diff.setAfter('one\ntwo')
    assert.equal(draftInput(diff).value, 'Half a thought')
  })

  it('draws only the comments for the file and version on screen', () => {
    const diff = fakeDiff('one')
    const drafts = new LineCommentDrafts()
    drafts.add('p/t', comment({ path: 'src/other.ts', lineText: 'one', body: 'Other file' }))
    drafts.add('p/t', comment({ version: 'staged', lineText: 'one', body: 'Staged copy' }))
    drafts.add('p/t', comment({ lineText: 'one', body: 'Here' }))
    const detach = attachDiffLineComments(diff.diffEditor, drafts, () => fileA)
    assert.deepEqual(zoneTexts(diff), ['HereEditDelete'])
    detach()
    assert.equal(diff.zones.size, 0)
  })

  it('offers "+" only over a line of the file, once per line', () => {
    const diff = fakeDiff('one\ntwo')
    attachDiffLineComments(diff.diffEditor, new LineCommentDrafts(), () => fileA)
    const CONTENT_TEXT = 6
    const CONTENT_VIEW_ZONE = 8
    diff.move(CONTENT_TEXT, 1)
    diff.move(CONTENT_TEXT, 1)
    diff.move(CONTENT_VIEW_ZONE, 2)
    diff.move(GLYPH_MARGIN_TARGET, 2)
    assert.deepEqual(diff.hovered, [1, 2])
  })
})

import '../../../tests/setup-dom.ts'
import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type * as Monaco from 'monaco-editor'
import {
  attachDiffLineComments,
  formatLineCommentBatch,
  GLYPH_MARGIN_TARGET,
  LineCommentDrafts,
  lineCommentBatchLabel,
  reanchorLine,
  type LineComment,
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
    side: 'after',
    line: 1,
    lineText: 'const a = 1',
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

  it('names a removed line and keeps a backtick-laden line inside its fence', () => {
    const text = formatLineCommentBatch([
      comment({ side: 'before', line: 4, lineText: 'const s = ```x```', body: 'Why drop this?' }),
    ])
    assert.match(text, /^I left a review comment on your changes\. Please address it:/)
    assert.match(text, /`src\/a\.ts` line 4 \(removed by your change\):/)
    assert.match(text, /\n {3}````\n {3}const s = ```x```\n {3}````\n/)
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
  const lines = ['a', 'b', 'target', 'c', 'target']
  it('keeps a line that still holds its text', () => {
    assert.equal(reanchorLine(lines, 5, 'target'), 5)
  })
  it('moves to the nearest line holding the text', () => {
    assert.equal(reanchorLine(lines, 2, 'target'), 3)
  })
  it('clamps into the file when the text is gone', () => {
    assert.equal(reanchorLine(lines, 9, 'missing'), 5)
    assert.equal(reanchorLine([], 3, 'x'), 1)
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

interface FakeSide {
  editor: GitDiffCodeEditor
  zones: Map<string, Monaco.editor.IViewZone>
  clickGlyph(line: number): void
}

function fakeCodeEditor(): FakeSide {
  const zones = new Map<string, Monaco.editor.IViewZone>()
  let nextZone = 0
  let onDown:
    | ((event: Parameters<Parameters<NonNullable<GitDiffCodeEditor['onMouseDown']>>[0]>[0]) => void)
    | null = null
  const disposable = { dispose(): void {} }
  const editor: GitDiffCodeEditor = {
    onKeyDown: () => disposable,
    getSelection: () => null,
    getModel: () => null,
    revealLineInCenterIfOutsideViewport(): void {},
    updateOptions(): void {},
    onMouseMove: () => disposable,
    onMouseLeave: () => disposable,
    onMouseDown: (listener) => {
      onDown = listener
      return disposable
    },
    createDecorationsCollection: () => ({ set: () => [], clear(): void {} }),
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
  return {
    editor,
    zones,
    clickGlyph: (line): void => {
      onDown?.({
        target: { type: GLYPH_MARGIN_TARGET, position: { lineNumber: line } },
        event: { preventDefault(): void {} },
      })
    },
  }
}

function fakeDiffEditor(original: FakeSide, modified: FakeSide, after: string): GitDiffEditor {
  const model = (value: string): { dispose(): void; getValue(): string } => ({
    dispose(): void {},
    getValue: () => value,
  })
  const models = { original: model('old line'), modified: model(after) }
  return {
    createViewModel: (m) => ({
      model: m,
      dispose(): void {},
      waitForDiff: async (): Promise<void> => {},
    }),
    dispose(): void {},
    getLineChanges: () => null,
    getModel: () => models,
    getModifiedEditor: () => modified.editor,
    getOriginalEditor: () => original.editor,
    layout(): void {},
    onDidUpdateDiff: () => ({ dispose(): void {} }),
    setModel(): void {},
    updateOptions(): void {},
  }
}

function zoneTexts(side: FakeSide): string[] {
  return [...side.zones.values()].map((zone) => zone.domNode.textContent)
}

describe('attachDiffLineComments', () => {
  it('opens a comment box from the gutter and keeps the saved comment under its line', () => {
    const original = fakeCodeEditor()
    const modified = fakeCodeEditor()
    const drafts = new LineCommentDrafts()
    const detach = attachDiffLineComments(
      fakeDiffEditor(original, modified, 'one\ntwo\nthree'),
      drafts,
      () => ({ owner: 'p/t', path: 'src/a.ts' }),
    )

    modified.clickGlyph(2)
    const [draftZone] = modified.zones.values()
    assert.ok(draftZone)
    assert.equal(draftZone.afterLineNumber, 2)
    const input = draftZone.domNode.querySelector('textarea')
    const save = draftZone.domNode.querySelector<HTMLButtonElement>('.diff-line-comment-save')
    assert.ok(input && save)
    assert.equal(save.disabled, true)
    input.value = 'Use a constant'
    input.dispatchEvent(new Event('input'))
    save.click()

    assert.deepEqual(
      drafts.list('p/t').map(({ path, side, line, lineText, body }) => ({
        path,
        side,
        line,
        lineText,
        body,
      })),
      [{ path: 'src/a.ts', side: 'after', line: 2, lineText: 'two', body: 'Use a constant' }],
    )
    assert.deepEqual(zoneTexts(modified), ['Use a constantEditDelete'])
    assert.equal(original.zones.size, 0)

    const del = [...modified.zones.values()][0]?.domNode.querySelector<HTMLButtonElement>(
      '.diff-line-comment-delete',
    )
    del?.click()
    assert.equal(drafts.list('p/t').length, 0)
    assert.equal(modified.zones.size, 0)
    detach()
  })

  it('draws only the comments for the file on screen', () => {
    const original = fakeCodeEditor()
    const modified = fakeCodeEditor()
    const drafts = new LineCommentDrafts()
    drafts.add('p/t', comment({ path: 'src/other.ts', line: 1, lineText: 'x' }))
    drafts.add('p/t', comment({ path: 'src/a.ts', line: 1, lineText: 'one', body: 'Here' }))
    const detach = attachDiffLineComments(
      fakeDiffEditor(original, modified, 'one'),
      drafts,
      () => ({ owner: 'p/t', path: 'src/a.ts' }),
    )
    assert.deepEqual(zoneTexts(modified), ['HereEditDelete'])
    detach()
    assert.equal(modified.zones.size, 0)
  })
})

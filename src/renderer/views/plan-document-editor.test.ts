import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { getPlanPassage, mountPlanDocumentEditor } from './plan-document-editor.ts'

const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup.splice(0).forEach((run) => {
    run()
  })
  document.body.replaceChildren()
})

function select(editor: Editor, text: string, occurrence = 0): void {
  let remaining = occurrence
  let position: number | undefined
  editor.state.doc.descendants((node, pos) => {
    if (position !== undefined || !node.isText) return
    const offset = node.text?.indexOf(text) ?? -1
    if (offset >= 0 && remaining-- === 0) position = pos + offset
  })
  assert.notEqual(position, undefined)
  if (position === undefined) throw new Error('Missing text')
  editor.commands.setTextSelection({ from: position, to: position + text.length })
}

describe('plan document editor', () => {
  it('preserves original Markdown bytes across viewing, locking and source toggles', () => {
    const editor = mountPlanDocumentEditor(
      () => {},
      () => {},
    )
    cleanup.push(() => {
      editor.destroy()
    })
    document.body.append(editor.element)
    const original =
      '# Goal\n\nUse __bold__ and [a link][ref].\n\n* Keep it simple\n\n[ref]: https://example.com\n'
    editor.value = original
    assert.equal(editor.value, original)
    assert.equal(editor.element.querySelector('strong')?.textContent, 'bold')
    editor.readOnly = true
    assert.equal(
      editor.element.querySelector('#plan-body')?.getAttribute('contenteditable'),
      'false',
    )
    for (const label of ['Markdown', 'Document']) {
      Array.from(editor.element.querySelectorAll('button'))
        .find((button) => button.textContent === label)
        ?.click()
      assert.equal(editor.value, original)
    }
  })

  it('anchors the selected occurrence through normalized emphasis, lists and non-ASCII text', () => {
    const source =
      '# Goal\nRepeated words.\n\n# Definition of done\n* Repeated words.\n* Keep __café 🌿__ safe.\n'
    const editor = new Editor({
      extensions: [StarterKit, Markdown],
      content: source,
      contentType: 'markdown',
    })
    cleanup.push(() => {
      editor.destroy()
    })
    select(editor, 'Repeated words.', 1)
    const repeated = getPlanPassage(editor, source)
    assert.ok(repeated)
    assert.equal(repeated.start, source.lastIndexOf('Repeated words.'))
    assert.equal(source.slice(repeated.start, repeated.end), 'Repeated words.')
    select(editor, 'café 🌿')
    const emphasis = getPlanPassage(editor, source)
    assert.ok(emphasis)
    assert.equal(source.slice(emphasis.start, emphasis.end), 'café 🌿')
    assert.equal(editor.getText().includes('COPSESTART'), false)
  })

  it('keeps tables, task items and image references without loading image URLs', () => {
    const editor = mountPlanDocumentEditor(
      () => {},
      () => {},
    )
    cleanup.push(() => {
      editor.destroy()
    })
    editor.value =
      '# Scope\n\n| Item | State |\n| --- | --- |\n| Login | Ready |\n\n- [ ] Verify expiry\n\n![diagram](https://example.com/private.png)'
    assert.ok(editor.element.querySelector('table'))
    assert.ok(editor.element.querySelector('[data-type="taskItem"]'))
    assert.equal(editor.element.querySelectorAll('img').length, 0)
    assert.match(editor.element.textContent, /Image: diagram/)
  })
})

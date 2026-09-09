import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('main layout boot', () => {
  it('syncs files pane visibility when the layout mounts', () => {
    const src = readFileSync(join(process.cwd(), 'src/renderer/main.ts'), 'utf8')
    assert.match(src, /store\.on\('files_pane_changed', updateFilesPane\)/)
    assert.match(src, /mountFullLayout\(\)[\s\S]*updateFilesPane\(\)/)
    assert.match(
      src,
      /store\.on\('files_pane_changed', updateFilesPane\)[\s\S]*updateFilesPane\(\)/,
    )
  })
})

// #2474: Cmd/Ctrl+W deletes the active thread, and with Settings — or any other
// dialog — on screen the keystroke a user meant as "close this" destroyed a
// conversation instead. main.ts binds its shortcuts inside a boot function with
// no seam to call, so the wiring is pinned at the source level (as the layout
// test above does); the gate itself is unit-tested in
// `views/dialog-shell.test.ts`.
describe('destructive shortcuts defer to an open dialog', () => {
  const src = readFileSync(join(process.cwd(), 'src/renderer/main.ts'), 'utf8')

  it('never calls the thread delete without asking whether a dialog is open', () => {
    // Every call, not just the one: a second unguarded call site would
    // reintroduce the bug somewhere the first assertion never looks.
    const calls = [...src.matchAll(/^.*confirmDeleteThread\(\).*$/gm)]
      .map((m) => m[0])
      .filter((line) => !line.includes('function confirmDeleteThread'))
    assert.ok(calls.length > 0, 'expected main.ts to invoke confirmDeleteThread')
    const unguarded = calls.filter((line) => !line.includes('!isAnyDialogOpen()'))
    assert.deepEqual(
      unguarded,
      [],
      `these delete the active thread without checking for an open dialog:\n${unguarded.join('\n')}`,
    )
  })

  it('still swallows the keystroke whether or not the delete runs', () => {
    // preventDefault is what keeps Cmd+W from also reaching the File ▸ Close
    // accelerator. Moving it inside the guard would hand the keystroke back to
    // the menu exactly when a dialog is up.
    const block = /if \(meta && e\.key === 'w'\) \{([\s\S]*?)\n {4}\}/.exec(src)?.[1]
    assert.ok(block, 'could not find the Cmd/Ctrl+W handler')
    const preventIndex = block.indexOf('e.preventDefault()')
    const guardIndex = block.indexOf('isAnyDialogOpen()')
    assert.ok(preventIndex >= 0, 'the Cmd/Ctrl+W handler must preventDefault')
    assert.ok(guardIndex >= 0, 'the Cmd/Ctrl+W handler must consult isAnyDialogOpen')
    assert.ok(preventIndex < guardIndex, 'preventDefault must run before the dialog guard')
  })

  it('does not open the find bar underneath a dialog either', () => {
    // The same gate, on the shortcut that used to name four dialogs of seventeen.
    const block = /if \(matchFindInChatShortcut\(e\)\) \{([\s\S]*?)\n {4}\}/.exec(src)?.[1]
    assert.ok(block, 'could not find the find-in-chat handler')
    assert.match(block, /if \(isAnyDialogOpen\(\)\) return/)
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTerminalTabScope, type TerminalTabScopeState } from './tab-scope.ts'

function state(over: Partial<TerminalTabScopeState> = {}): TerminalTabScopeState {
  return {
    activeProjectId: 'proj-a',
    activeThreadId: 't-1',
    threads: [{ id: 't-1' }, { id: 't-2' }],
    ...over,
  }
}

describe('resolveTerminalTabScope', () => {
  it('pairs the active thread with the active project when it belongs to it', () => {
    assert.deepEqual(resolveTerminalTabScope(state()), {
      scopeProjectId: 'proj-a',
      scopeId: 't-1',
    })
  })

  it('drops a thread the active project does not have (#2484)', () => {
    // The reported state: a project hand-off moved `activeProjectId` while the
    // outgoing project's thread was still selected. Sending that pair spawns
    // nothing — main refuses it — so the tab takes the project alone.
    const scope = resolveTerminalTabScope(state({ activeThreadId: 't-from-elsewhere' }))
    assert.deepEqual(scope, { scopeProjectId: 'proj-a', scopeId: null })
  })

  it('handles a project with no threads loaded yet', () => {
    const scope = resolveTerminalTabScope(state({ threads: [] }))
    assert.deepEqual(scope, { scopeProjectId: 'proj-a', scopeId: null })
  })

  it('carries a null thread through', () => {
    assert.deepEqual(resolveTerminalTabScope(state({ activeThreadId: null })), {
      scopeProjectId: 'proj-a',
      scopeId: null,
    })
  })

  it('carries a null project through, which the pane refuses to spawn against', () => {
    assert.deepEqual(
      resolveTerminalTabScope(state({ activeProjectId: null, activeThreadId: null })),
      { scopeProjectId: null, scopeId: null },
    )
  })

  it('leaves an explicit scope alone, membership unchecked', () => {
    // A tab being restored, or re-created for a worktree, names a project the
    // store is not on — `threads` is the wrong list to judge it by, and
    // "correcting" it would silently move the shell to another project.
    assert.deepEqual(
      resolveTerminalTabScope(state(), { scopeProjectId: 'proj-b', scopeId: 't-b' }),
      { scopeProjectId: 'proj-b', scopeId: 't-b' },
    )
  })

  it('treats a half-given explicit scope as explicit, not as a default', () => {
    assert.deepEqual(resolveTerminalTabScope(state(), { scopeProjectId: 'proj-b' }), {
      scopeProjectId: 'proj-b',
      scopeId: null,
    })
    assert.deepEqual(resolveTerminalTabScope(state(), { scopeId: 't-b' }), {
      scopeProjectId: null,
      scopeId: 't-b',
    })
  })

  it('falls back to the store when given an empty options object', () => {
    assert.deepEqual(resolveTerminalTabScope(state(), {}), {
      scopeProjectId: 'proj-a',
      scopeId: 't-1',
    })
  })
})

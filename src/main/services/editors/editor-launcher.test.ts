import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { listExternalEditors, resetEditorScanForTest } from './editor-launcher.ts'

beforeEach(() => {
  resetEditorScanForTest()
})

afterEach(() => {
  delete process.env['COPSE_PANEL_MOCK_EDITORS']
  resetEditorScanForTest()
})

describe('listExternalEditors', () => {
  it('maps detected editors to id/name pairs for the renderer', async () => {
    process.env['COPSE_PANEL_MOCK_EDITORS'] = 'vscode,cursor'
    const { editors } = await listExternalEditors()
    assert.deepEqual(editors, [
      { id: 'vscode', name: 'Visual Studio Code' },
      { id: 'cursor', name: 'Cursor' },
    ])
  })

  it('reports no last-used default when none is persisted', async () => {
    process.env['COPSE_PANEL_MOCK_EDITORS'] = 'zed'
    const { lastUsedId } = await listExternalEditors()
    assert.equal(lastUsedId, null)
  })
})

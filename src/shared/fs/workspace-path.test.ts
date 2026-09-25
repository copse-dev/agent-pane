import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { localPathFromUri, workspaceRelativePath } from './workspace-path.ts'

describe('workspaceRelativePath', () => {
  it('strips the workspace root and trailing separators', () => {
    assert.equal(workspaceRelativePath('/repo/src/a.ts', '/repo'), 'src/a.ts')
    assert.equal(workspaceRelativePath('/repo/src/a.ts', '/repo/'), 'src/a.ts')
    assert.equal(workspaceRelativePath('/repo', '/repo'), '')
    assert.equal(workspaceRelativePath('/a.ts', '/'), 'a.ts')
  })

  it('rejects sibling prefixes and paths that climb out', () => {
    assert.equal(workspaceRelativePath('/repo-other/a.ts', '/repo'), null)
    assert.equal(workspaceRelativePath('/elsewhere/a.ts', '/repo'), null)
    assert.equal(workspaceRelativePath('/repo/../secret', '/repo'), null)
  })

  it('normalizes Windows separators and drive letter case', () => {
    assert.equal(
      workspaceRelativePath(String.raw`c:\Repo\src\a.ts`, String.raw`C:\Repo`),
      'src/a.ts',
    )
    assert.equal(
      workspaceRelativePath('/Repo/a.ts', '/repo'),
      null,
      'POSIX paths stay case-sensitive',
    )
  })
})

describe('localPathFromUri', () => {
  it('passes bare paths through', () => {
    assert.equal(localPathFromUri('/repo/a.png'), '/repo/a.png')
    assert.equal(localPathFromUri('images/a.png'), 'images/a.png')
    assert.equal(localPathFromUri(String.raw`C:\repo\a.png`), String.raw`C:\repo\a.png`)
  })

  it('decodes local file URIs', () => {
    assert.equal(localPathFromUri('file:///repo/shot%20one.png'), '/repo/shot one.png')
    assert.equal(localPathFromUri('file://localhost/repo/a.png'), '/repo/a.png')
    assert.equal(localPathFromUri('file:///C:/repo/a.png'), 'C:/repo/a.png')
  })

  it('rejects remote, network, and malformed targets', () => {
    assert.equal(localPathFromUri('https://example.test/a.png'), null)
    assert.equal(localPathFromUri('file://server/share/a.png'), null)
    assert.equal(localPathFromUri(String.raw`\\server\share\a.png`), null)
    assert.equal(localPathFromUri('//example.test/a.png'), null)
    assert.equal(localPathFromUri('file:///repo/%E0%A4%A.png'), null)
    assert.equal(localPathFromUri(''), null)
  })
})

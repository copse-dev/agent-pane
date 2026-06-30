import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectAcpAgents } from './acp-detect.ts'

describe('detectAcpAgents', () => {
  it('marks a command present on PATH as installed and an absent one as not', async () => {
    const results = await detectAcpAgents([
      // `node` is guaranteed present (this test runs under it).
      { id: 'node-probe', title: 'Node', command: 'node', args: [] },
      { id: 'absent', title: 'Absent', command: 'definitely-not-a-real-command-xyz', args: [] },
    ])

    const node = results.find((r) => r.id === 'node-probe')
    const absent = results.find((r) => r.id === 'absent')
    assert.ok(node)
    assert.ok(absent)

    assert.equal(node.installed, true)
    assert.ok(node.path, 'an installed command resolves to a path')
    assert.equal(absent.installed, false)
    assert.equal(absent.path, null)
    assert.equal(absent.running, false)
  })

  it('preserves the catalog fields on each result', async () => {
    const [result] = await detectAcpAgents([
      { id: 'x', title: 'X', command: 'definitely-not-real-xyz', args: ['--flag'], note: 'hi' },
    ])
    assert.ok(result)
    assert.equal(result.title, 'X')
    assert.deepEqual(result.args, ['--flag'])
    assert.equal(result.note, 'hi')
  })
})

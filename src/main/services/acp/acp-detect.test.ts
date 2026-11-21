import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectAcpAgents, findExecutableOnPath } from './acp-detect.ts'

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

describe('findExecutableOnPath', () => {
  const roots: string[] = []
  after(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true })
  })

  async function layout(): Promise<{ root: string; cwd: string; marker: string }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'copse-find-exec-')))
    roots.push(root)
    const cwd = join(root, 'workspace')
    await mkdir(join(cwd, 'bin'), { recursive: true })
    await mkdir(join(root, 'tools'))
    const marker = join(root, 'which-ran')
    // A workspace-planted `which`: running it would leave the marker.
    await writeFile(join(cwd, 'bin', 'which'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`)
    await chmod(join(cwd, 'bin', 'which'), 0o755)
    await writeFile(join(root, 'tools', 'agent'), '#!/bin/sh\n')
    await chmod(join(root, 'tools', 'agent'), 0o755)
    await writeFile(join(root, 'tools', 'not-executable'), 'data\n')
    return { root, cwd, marker }
  }

  it('finds the first executable file without running anything on the PATH', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX PATH lookup')
      return
    }
    const { root, cwd, marker } = await layout()
    const agent = join(root, 'tools', 'agent')
    const path = `bin:${join(root, 'tools')}:/usr/bin:/bin`
    assert.equal(await findExecutableOnPath('agent', path, cwd), agent)
    // A relative entry resolves from cwd, as the wrapper shell resolves it.
    assert.equal(await findExecutableOnPath('agent', '../workspace/bin:../tools', cwd), agent)
    assert.equal(await findExecutableOnPath('which', path, cwd), join(cwd, 'bin', 'which'))
    assert.equal(existsSync(marker), false)
  })

  it('skips a non-executable file and does not search for a path with a slash', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX PATH lookup')
      return
    }
    const { root, cwd } = await layout()
    const agent = join(root, 'tools', 'agent')
    assert.equal(await findExecutableOnPath('not-executable', join(root, 'tools'), cwd), null)
    assert.equal(await findExecutableOnPath('../tools/agent', '/usr/bin', cwd), agent)
    assert.equal(await findExecutableOnPath('tools/agent', root, cwd), null)
  })
})

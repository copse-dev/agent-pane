import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeReadOutsideProject } from './read-outside-project.ts'

const ROOT = '/work/project'
const HOME = '/home/dev'

function eligible(command: string): boolean {
  return analyzeReadOutsideProject(command, ROOT, { homeDir: HOME }).eligible
}

describe('analyzeReadOutsideProject — writers and launchers behind a read-only head', () => {
  it('accepts the plain reads these heads are listed for', () => {
    for (const command of [
      'sort ~/notes/a.txt',
      'uniq -c ~/notes/a.txt',
      'tree ~/notes',
      'cd ~/other && git grep -n needle',
    ]) {
      assert.equal(eligible(command), true, command)
    }
  })

  it('refuses every spelling of a flag that writes a file or runs a program', () => {
    for (const command of [
      'sort -uo ~/notes/b.txt ~/notes/a.txt',
      'sort -o~/notes/b.txt ~/notes/a.txt',
      'sort --out=/home/dev/notes/b.txt ~/notes/a.txt',
      'sort --compress-program=/home/dev/notes/tool ~/notes/a.txt',
      'sort --compress-prog=/home/dev/notes/tool ~/notes/a.txt',
      'uniq ~/notes/a.txt ~/notes/b.txt',
      'tree -o~/notes/out ~/notes',
      'fd -xrm . ~/notes',
      'file -C -m ~/notes/magic',
      'rg --hostname-bin ~/notes/tool needle ~/notes',
      'cd ~/other && git grep -O./tool needle',
      'cd ~/other && git grep --open-files-in-pager=./tool needle',
      'cd ~/other && git diff --outp=patch.txt',
      'cd ~/other && git log -p --ext-diff',
      'cd ~/other && git cat-file --filters HEAD:a.txt',
    ]) {
      const analysis = analyzeReadOutsideProject(command, ROOT, { homeDir: HOME })
      assert.equal(analysis.eligible, false, command)
      assert.ok(
        analysis.blockers.some((blocker) => blocker.includes('asked to write or execute')),
        `${command}: ${analysis.blockers.join(' | ')}`,
      )
    }
  })

  it('sees a write on a line after one that ends in a comment', () => {
    const analysis = analyzeReadOutsideProject(
      'cat ~/notes/a.txt # first\ncat ~/notes/b.txt > ~/notes/c.txt',
      ROOT,
      { homeDir: HOME },
    )
    assert.deepEqual(analysis.blockers, ['writes to ~/notes/c.txt'])
  })
})

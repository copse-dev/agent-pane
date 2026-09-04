import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isGhostMountPoint,
  isGhostMountPointEntry,
  withoutGhostMountPoints,
} from './ghost-mount-points.ts'

function withRoot<T>(build: (root: string) => void, run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'copse-ghost-'))
  try {
    build(root)
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('isGhostMountPoint', () => {
  it('matches a zero-byte file at a mandatory deny path', () => {
    withRoot(
      (root) => {
        writeFileSync(join(root, '.bashrc'), '')
      },
      (root) => {
        assert.equal(isGhostMountPoint(root, '.bashrc'), true)
      },
    )
  })

  it('keeps a real rc file with content', () => {
    withRoot(
      (root) => {
        writeFileSync(join(root, '.bashrc'), 'export PATH=$PATH\n')
      },
      (root) => {
        assert.equal(isGhostMountPoint(root, '.bashrc'), false)
      },
    )
  })

  it('keeps a real .vscode directory', () => {
    withRoot(
      (root) => {
        mkdirSync(join(root, '.vscode'))
      },
      (root) => {
        assert.equal(isGhostMountPoint(root, '.vscode'), false)
      },
    )
  })

  it('treats a deny path that has already been cleaned up as a ghost', () => {
    // ASRT deletes the mount points right after the sandboxed `git status`
    // exits, so by the time the listing is filtered the file is usually gone.
    withRoot(
      () => {},
      (root) => {
        assert.equal(isGhostMountPoint(root, '.gitconfig'), true)
        assert.equal(isGhostMountPointEntry(root, '.claude'), true)
      },
    )
  })

  it('ignores zero-byte files that are not deny paths', () => {
    withRoot(
      (root) => {
        writeFileSync(join(root, 'empty.txt'), '')
      },
      (root) => {
        assert.equal(isGhostMountPoint(root, 'empty.txt'), false)
      },
    )
  })
})

describe('isGhostMountPointEntry', () => {
  it('treats a .claude directory holding only ghost files as a ghost', () => {
    withRoot(
      (root) => {
        mkdirSync(join(root, '.claude'))
        writeFileSync(join(root, '.claude', 'commands'), '')
        writeFileSync(join(root, '.claude', 'agents'), '')
      },
      (root) => {
        assert.equal(isGhostMountPointEntry(root, '.claude'), true)
      },
    )
  })

  it('keeps a .claude directory that also holds user files', () => {
    withRoot(
      (root) => {
        mkdirSync(join(root, '.claude'))
        writeFileSync(join(root, '.claude', 'commands'), '')
        writeFileSync(join(root, '.claude', 'settings.json'), '{}')
      },
      (root) => {
        assert.equal(isGhostMountPointEntry(root, '.claude'), false)
      },
    )
  })
})

describe('withoutGhostMountPoints', () => {
  it('drops only untracked ghosts, on linux, leaving other records alone', () => {
    withRoot(
      (root) => {
        writeFileSync(join(root, '.gitconfig'), '')
        writeFileSync(join(root, 'untracked.ts'), 'export const fresh = true\n')
      },
      (root) => {
        const status = {
          staged: [{ path: 'staged.ts', status: 'modified' as const }],
          unstaged: [
            { path: 'unstaged.ts', status: 'modified' as const },
            { path: '.gitconfig', status: 'untracked' as const },
            { path: 'untracked.ts', status: 'untracked' as const },
          ],
        }
        assert.deepEqual(withoutGhostMountPoints(status, root, { platform: 'linux' }), {
          staged: status.staged,
          unstaged: [
            { path: 'unstaged.ts', status: 'modified' },
            { path: 'untracked.ts', status: 'untracked' },
          ],
        })
        // Only bubblewrap creates mount-point files; elsewhere the record is real.
        assert.equal(withoutGhostMountPoints(status, root, { platform: 'darwin' }), status)
      },
    )
  })

  it('keeps an untracked file that is missing but was never a deny path', () => {
    const status = { staged: [], unstaged: [{ path: 'gone.ts', status: 'untracked' as const }] }
    withRoot(
      () => {},
      (root) => {
        assert.equal(withoutGhostMountPoints(status, root, { platform: 'linux' }), status)
      },
    )
  })

  it('returns the same object when nothing was filtered', () => {
    const status = { staged: [], unstaged: [{ path: 'a.ts', status: 'untracked' as const }] }
    withRoot(
      () => {},
      (root) => {
        assert.equal(withoutGhostMountPoints(status, root, { platform: 'linux' }), status)
      },
    )
  })
})

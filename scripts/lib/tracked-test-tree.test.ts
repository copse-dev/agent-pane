import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  captureTrackedTestTree,
  changedTrackedTestFiles,
  intentionalTestUpdates,
} from './tracked-test-tree.mts'

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'copse-tracked-tree-'))
  try {
    git(root, 'init', '-q')
    await writeFile(join(root, 'generated.ts'), 'original\n')
    await writeFile(join(root, '.gitignore'), 'ignored/\n')
    git(root, 'add', '.')
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('tracked test tree invariant', () => {
  it('preserves unchanged pre-existing staged and unstaged edits and ignores ordinary output', async () => {
    await fixture(async (root) => {
      await writeFile(join(root, 'generated.ts'), 'staged\n')
      git(root, 'add', 'generated.ts')
      await writeFile(join(root, 'generated.ts'), 'unstaged\n')
      const before = await captureTrackedTestTree(root)
      await writeFile(join(root, 'unit-tests.tap'), 'untracked report\n')
      await mkdir(join(root, 'ignored'))
      await writeFile(join(root, 'ignored', 'bundle.mjs'), 'ignored output\n')
      assert.deepEqual(changedTrackedTestFiles(before, await captureTrackedTestTree(root)), [])
    })
  })

  it('detects additional edits to an already dirty generated file', async () => {
    await fixture(async (root) => {
      await writeFile(join(root, 'generated.ts'), 'before run\n')
      const before = await captureTrackedTestTree(root)
      await writeFile(join(root, 'generated.ts'), 'after run\n')
      assert.deepEqual(changedTrackedTestFiles(before, await captureTrackedTestTree(root)), [
        '"generated.ts" (worktree)',
      ])
    })
  })

  it('detects deleted files and permission changes', async () => {
    await fixture(async (root) => {
      const before = await captureTrackedTestTree(root)
      await rm(join(root, 'generated.ts'))
      await chmod(join(root, '.gitignore'), 0o755)
      assert.deepEqual(changedTrackedTestFiles(before, await captureTrackedTestTree(root)), [
        '".gitignore" (worktree)',
        '"generated.ts" (worktree)',
      ])
    })
  })

  it('detects newly staged paths, index removal and staging unchanged dirty content', async () => {
    await fixture(async (root) => {
      await writeFile(join(root, 'generated.ts'), 'dirty\n')
      const before = await captureTrackedTestTree(root)
      await writeFile(join(root, 'new file.ts'), 'new\n')
      git(root, 'add', 'new file.ts', 'generated.ts')
      git(root, 'rm', '--cached', '.gitignore')
      assert.deepEqual(changedTrackedTestFiles(before, await captureTrackedTestTree(root)), [
        '".gitignore" (index)',
        '"generated.ts" (index)',
        '"new file.ts" (index)',
      ])
    })
  })

  it('detects symlink retargeting and quotes unusual filenames in diagnostics', async () => {
    await fixture(async (root) => {
      const path = 'link\nwith-tab\t'
      await symlink('generated.ts', join(root, path))
      git(root, 'add', path)
      const before = await captureTrackedTestTree(root)
      await rm(join(root, path))
      await symlink('.gitignore', join(root, path))
      assert.deepEqual(changedTrackedTestFiles(before, await captureTrackedTestTree(root)), [
        `${JSON.stringify(path)} (worktree)`,
      ])
    })
  })

  it('detects a tracked file replaced by a directory without recursing into the parent checkout', async () => {
    await fixture(async (root) => {
      const before = await captureTrackedTestTree(root)
      await rm(join(root, 'generated.ts'))
      await mkdir(join(root, 'generated.ts'))
      assert.deepEqual(changedTrackedTestFiles(before, await captureTrackedTestTree(root)), [
        '"generated.ts" (worktree)',
      ])
    })
  })

  it('covers nested gitlink content and distinguishes an uninitialized submodule directory', async () => {
    await fixture(async (root) => {
      const nested = join(root, 'nested')
      await mkdir(nested)
      git(nested, 'init', '-q')
      await writeFile(join(nested, 'source.ts'), 'original\n')
      git(nested, 'add', '.')
      git(
        nested,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-qm',
        'fixture',
      )
      git(root, 'add', 'nested')
      const before = await captureTrackedTestTree(root)
      await writeFile(join(nested, 'source.ts'), 'modified\n')
      assert.deepEqual(changedTrackedTestFiles(before, await captureTrackedTestTree(root)), [
        '"nested" (worktree)',
      ])
      await rm(nested, { recursive: true })
      await mkdir(nested)
      const uninitialized = await captureTrackedTestTree(root)
      assert.deepEqual(changedTrackedTestFiles(before, uninitialized), ['"nested" (worktree)'])
      assert.deepEqual(
        changedTrackedTestFiles(uninitialized, await captureTrackedTestTree(root)),
        [],
      )
    })
  })

  it('limits explicit update exemptions to the corresponding file and never exempts staging', async () => {
    await fixture(async (root) => {
      const snapshot = 'benchmarks/escalation-review/testset/gate-replay.jsonl'
      await mkdir(join(root, 'benchmarks/escalation-review/testset'), { recursive: true })
      await writeFile(join(root, snapshot), 'old\n')
      git(root, 'add', snapshot)
      const before = await captureTrackedTestTree(root)
      await writeFile(join(root, snapshot), 'new\n')
      await writeFile(join(root, 'generated.ts'), 'accidental mutation\n')
      const allowed = intentionalTestUpdates({ UPDATE_GATE_REPLAY: '1' })
      assert.deepEqual(
        changedTrackedTestFiles(before, await captureTrackedTestTree(root), allowed),
        ['"generated.ts" (worktree)'],
      )
      git(root, 'add', snapshot)
      assert.deepEqual(
        changedTrackedTestFiles(before, await captureTrackedTestTree(root), allowed),
        [
          '"benchmarks/escalation-review/testset/gate-replay.jsonl" (index)',
          '"generated.ts" (worktree)',
        ],
      )
      assert.equal(intentionalTestUpdates({ UPDATE_GATE_REPLAY: 'true' }).size, 0)
      assert.deepEqual(
        [...intentionalTestUpdates({ UPDATE_HOOK_PAYLOAD_SNAPSHOTS: '1' })],
        ['src/main/services/hooks/__snapshots__/wire-payloads.json'],
      )
    })
  })

  it('fails inspection outside a Git checkout rather than reporting a false pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-not-git-'))
    try {
      await assert.rejects(captureTrackedTestTree(root), /cannot inspect tracked files/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

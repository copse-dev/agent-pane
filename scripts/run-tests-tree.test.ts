import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'copse-runner-tree-'))
  try {
    await mkdir(join(root, 'scripts/lib'), { recursive: true })
    await mkdir(join(root, 'src'))
    for (const file of [
      'scripts/run-tests.mts',
      'scripts/lib/test-filter.mts',
      'scripts/lib/module-relative-test-paths.mts',
      'scripts/lib/tracked-test-tree.mts',
    ])
      await copyFile(join(process.cwd(), file), join(root, file))
    await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir')
    await writeFile(join(root, 'generated.ts'), 'original\n')
    await writeFile(join(root, '.gitignore'), 'node_modules/\n.tmp/\ndist-test/\nunit-tests.tap\n')
    const init = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function invoke(root: string, ...args: string[]): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' }
  delete env['NODE_TEST_CONTEXT']
  delete env['UPDATE_GATE_REPLAY']
  delete env['UPDATE_HOOK_PAYLOAD_SNAPSHOTS']
  return spawnSync(process.execPath, ['scripts/run-tests.mts', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
  })
}

function track(root: string): void {
  const result = spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

describe('unit runner tracked tree enforcement', () => {
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    it(`fails a passing test that sets ${flag} without changing tracked content`, async () => {
      await fixture(async (root) => {
        await writeFile(
          join(root, 'src/mutate.test.ts'),
          `import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import assert from 'node:assert/strict';
it('passing index mutation', () => assert.equal(spawnSync('git', ['update-index', '--${flag}', 'generated.ts']).status, 0));\n`,
        )
        track(root)
        const result = invoke(root)
        assert.equal(result.status, 1, result.stdout + result.stderr)
        assert.match(result.stderr, /tests changed tracked files/)
        assert.match(result.stderr, /"generated\.ts" \(index\)/)
        assert.equal(await readFile(join(root, 'generated.ts'), 'utf8'), 'original\n')
        assert.match(await readFile(join(root, 'unit-tests.tap'), 'utf8'), /# pass 1/)
      })
    })
  }

  it('fails a passing test that mutates a tracked generated file and leaves evidence intact', async () => {
    await fixture(async (root) => {
      await writeFile(
        join(root, 'src/mutate.test.ts'),
        `import { writeFileSync } from 'node:fs';
import { it } from 'node:test';
it('passing mutation', () => writeFileSync('generated.ts', 'mutated\\n'));\n`,
      )
      track(root)
      const result = invoke(root)
      assert.equal(result.status, 1, result.stdout + result.stderr)
      assert.match(result.stderr, /tests changed tracked files/)
      assert.match(result.stderr, /"generated\.ts" \(worktree\)/)
      assert.equal(await readFile(join(root, 'generated.ts'), 'utf8'), 'mutated\n')
      assert.match(await readFile(join(root, 'unit-tests.tap'), 'utf8'), /# pass 1/)
    })
  })

  it('guards coverage test-only execution and preserves unchanged dirty edits on ordinary runs', async () => {
    await fixture(async (root) => {
      await writeFile(
        join(root, 'src/mutate.test.ts'),
        `import { writeFileSync } from 'node:fs';
import { it } from 'node:test';
it('passing mutation', () => writeFileSync('generated.ts', 'mutated\\n'));\n`,
      )
      track(root)
      await writeFile(join(root, 'generated.ts'), 'pre-existing edit\n')
      const bundled = invoke(root, '--bundle-only')
      assert.equal(bundled.status, 0, bundled.stdout + bundled.stderr)
      const result = invoke(root, '--test-only')
      assert.equal(result.status, 1, result.stdout + result.stderr)
      assert.match(result.stderr, /"generated\.ts" \(worktree\)/)
      await writeFile(
        join(root, 'src/mutate.test.ts'),
        "import { it } from 'node:test'; it('read only', () => {});\n",
      )
      const clean = invoke(root)
      assert.equal(clean.status, 0, clean.stdout + clean.stderr)
    })
  })
})

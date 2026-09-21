import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'

it('publishes the completed coverage-phase report after nested runners finish', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'copse-test-report-'))
  try {
    await mkdir(join(fixture, 'scripts/lib'), { recursive: true })
    await mkdir(join(fixture, 'src'))
    for (const file of [
      'scripts/run-tests.mts',
      'scripts/lib/test-filter.mts',
      'scripts/lib/module-relative-test-paths.mts',
    ]) {
      await copyFile(join(process.cwd(), file), join(fixture, file))
    }
    await symlink(join(process.cwd(), 'node_modules'), join(fixture, 'node_modules'), 'dir')
    await writeFile(
      join(fixture, 'src/child.test.ts'),
      "import { it } from 'node:test'; it('nested child report', () => {});\n",
    )
    await writeFile(
      join(fixture, 'src/outer.test.ts'),
      `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
it('completed outer coverage report', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['scripts/run-tests.mts', 'src/child.test.ts'], {
    env, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
});
`,
    )
    const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' }
    delete env['NODE_TEST_CONTEXT']
    for (const phase of ['--bundle-only', '--test-only']) {
      const result = spawnSync(
        process.execPath,
        ['scripts/run-tests.mts', phase, 'src/outer.test.ts'],
        { cwd: fixture, env, encoding: 'utf8' },
      )
      assert.equal(result.status, 0, result.stdout + result.stderr)
    }
    const tap = await readFile(join(fixture, 'unit-tests.tap'), 'utf8')
    assert.match(tap, /completed outer coverage report/)
    assert.doesNotMatch(tap, /nested child report/)
    assert.match(tap, /# pass 1/)
    assert.match(tap, /# fail 0/)
    assert.equal((await stat(join(fixture, 'dist-test/src/outer.test.mjs'))).isFile(), true)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

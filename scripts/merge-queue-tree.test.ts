import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { computeMergeTree } from './merge-queue-tree.mts'

// actions/checkout configures the HTTPS repository URL without a .git suffix.
const ORIGIN = 'https://github.com/copse-dev/agent-pane'

async function repository(
  run: (cwd: string, git: (args: string[]) => string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'copse-tree-test-'))
  const git = (args: string[]): string =>
    execFileSync(
      '/usr/bin/git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      {
        cwd,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        timeout: 10_000,
      },
    ).trim()
  try {
    git(['init', '-b', 'main'])
    git(['remote', 'add', 'origin', ORIGIN])
    await writeFile(join(cwd, 'original.txt'), 'original\n')
    git(['add', '.'])
    git(['commit', '-m', 'base'])
    await run(cwd, git)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

describe('trusted queue merge tree', () => {
  it('matches a single-parent squash tree although the source is not an ancestor', async () => {
    await repository(async (cwd, git) => {
      const base = git(['rev-parse', 'HEAD'])
      git(['checkout', '-b', 'candidate'])
      await writeFile(join(cwd, 'candidate.txt'), 'approved change\n')
      // Executable-looking candidate files are data, never a program to run.
      await writeFile(join(cwd, 'package.json'), '{"scripts":{"prepare":"touch executed"}}')
      git(['add', '.'])
      git(['commit', '-m', 'candidate'])
      const head = git(['rev-parse', 'HEAD'])
      git(['checkout', 'main'])
      git(['merge', '--squash', head])
      git(['commit', '-m', 'squash'])
      const syntheticTree = git(['rev-parse', 'HEAD^{tree}'])
      assert.throws(() => git(['merge-base', '--is-ancestor', head, 'HEAD']))
      assert.equal(await computeMergeTree(base, head, { cwd }), syntheticTree)
      await assert.rejects(readFile(join(cwd, 'executed')), { code: 'ENOENT' })
    })
  })

  it('includes advancing base changes rather than a stale source merge tree', async () => {
    await repository(async (cwd, git) => {
      git(['checkout', '-b', 'candidate'])
      await writeFile(join(cwd, 'candidate.txt'), 'approved\n')
      git(['add', '.'])
      git(['commit', '-m', 'candidate'])
      const head = git(['rev-parse', 'HEAD'])
      const staleTree = git(['rev-parse', 'HEAD^{tree}'])
      git(['checkout', 'main'])
      await writeFile(join(cwd, 'advanced.txt'), 'new base\n')
      git(['add', '.'])
      git(['commit', '-m', 'advance'])
      const base = git(['rev-parse', 'HEAD'])
      git(['merge', '--squash', head])
      git(['commit', '-m', 'squash advanced base'])
      const expected = git(['rev-parse', 'HEAD^{tree}'])
      const actual = await computeMergeTree(base, head, { cwd })
      assert.equal(actual, expected)
      assert.notEqual(actual, staleTree)
    })
  })

  it('rejects conflicts and never executes repository-configured merge drivers', async () => {
    await repository(async (cwd, git) => {
      await writeFile(join(cwd, '.gitattributes'), 'original.txt merge=hostile\n')
      git(['add', '.'])
      git(['commit', '-m', 'attributes'])
      git(['config', 'merge.hostile.driver', `touch ${join(cwd, 'driver-executed')}; true`])
      git(['checkout', '-b', 'candidate'])
      await writeFile(join(cwd, 'original.txt'), 'candidate\n')
      git(['add', '.'])
      git(['commit', '-m', 'candidate conflict'])
      const head = git(['rev-parse', 'HEAD'])
      git(['checkout', 'main'])
      await writeFile(join(cwd, 'original.txt'), 'base\n')
      git(['add', '.'])
      git(['commit', '-m', 'base conflict'])
      const base = git(['rev-parse', 'HEAD'])
      const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const
      const previous = keys.map((key) => process.env[key])
      process.env['GIT_CONFIG_COUNT'] = '1'
      process.env['GIT_CONFIG_KEY_0'] = 'merge.hostile.driver'
      process.env['GIT_CONFIG_VALUE_0'] = `touch ${join(cwd, 'driver-executed')}; true`
      try {
        await assert.rejects(computeMergeTree(base, head, { cwd }))
      } finally {
        for (const [index, key] of keys.entries()) {
          const value = previous[index]
          if (value === undefined) Reflect.deleteProperty(process.env, key)
          else process.env[key] = value
        }
      }
      await assert.rejects(readFile(join(cwd, 'driver-executed')), { code: 'ENOENT' })
    })
  })

  it('rejects revision expressions, options and malformed SHAs before Git runs', async () => {
    for (const invalid of [
      'HEAD',
      '--help',
      'a'.repeat(39),
      'g'.repeat(40),
      'A'.repeat(40),
      'a'.repeat(40) + '\n',
    ]) {
      await assert.rejects(
        computeMergeTree(invalid, 'b'.repeat(40), { cwd: '/does/not/exist' }),
        /immutable/,
      )
      await assert.rejects(
        computeMergeTree('a'.repeat(40), invalid, { cwd: '/does/not/exist' }),
        /immutable/,
      )
    }
  })

  it('rejects tree objects supplied as commit SHAs', async () => {
    await repository(async (cwd, git) => {
      const tree = git(['rev-parse', 'HEAD^{tree}'])
      const head = git(['rev-parse', 'HEAD'])
      await assert.rejects(computeMergeTree(tree, head, { cwd }))
    })
  })

  it('accepts only the two exact public checkout URL forms', async () => {
    await repository(async (cwd, git) => {
      const head = git(['rev-parse', 'HEAD'])
      const tree = git(['rev-parse', 'HEAD^{tree}'])
      for (const origin of [ORIGIN, `${ORIGIN}.git`]) {
        git(['remote', 'set-url', 'origin', origin])
        assert.equal(await computeMergeTree(head, head, { cwd }), tree)
      }
      for (const origin of [
        `${ORIGIN}.git.evil`,
        `${ORIGIN}?token=fixture`,
        'https://github.com/external/agent-pane',
        'https://fixture@github.com/copse-dev/agent-pane',
      ]) {
        git(['remote', 'set-url', 'origin', origin])
        await assert.rejects(computeMergeTree(head, head, { cwd }), /public trusted origin/)
      }
    })
  })

  it('refuses origins that could run a remote helper or load private credentials', async () => {
    await repository(async (cwd, git) => {
      const head = git(['rev-parse', 'HEAD'])
      git(['remote', 'set-url', 'origin', 'ext::touch remote-executed'])
      await assert.rejects(computeMergeTree(head, head, { cwd }), /public trusted origin/)
      await assert.rejects(readFile(join(cwd, 'remote-executed')), { code: 'ENOENT' })
    })
  })
})

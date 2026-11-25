/**
 * `pnpm run lint` must lint exactly the files `eslint .` lints. Sharding exists
 * only to bound memory, so a gap between shards is silent: when the catch-all
 * ignored all of `src/**` while the named shards listed only some of it,
 * `src/sidecar`, `src/mobile` and `wdio.quarantine.conf.ts` went unlinted in
 * CI, and an undefined global and two unparseable test files sat unnoticed.
 *
 * ESLint decides per file (config `files`, global ignores, `--ignore-pattern`),
 * so the test asks ESLint rather than re-deriving its matching rules.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { ESLint } from 'eslint'
import { LINT_SHARDS, shardIgnorePatterns, type LintShard } from './lint-shards.mts'

const root = resolve(import.meta.dirname, '../..')

/** Tracked files plus untracked ones git does not ignore: what `eslint .` walks in a checkout. */
function repositoryFiles(): string[] {
  const listed = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return [...new Set(listed.split('\0'))].filter(
    (file) =>
      file !== '' && statSync(join(root, file), { throwIfNoEntry: false })?.isFile() === true,
  )
}

function contains(path: string, file: string): boolean {
  return path === '.' || file === path || file.startsWith(`${path}/`)
}

async function lintedFiles(eslint: ESLint, files: readonly string[]): Promise<string[]> {
  const linted: string[] = []
  for (const file of files) if (!(await eslint.isPathIgnored(file))) linted.push(file)
  return linted
}

async function lintedByShard(shard: LintShard, files: readonly string[]): Promise<string[]> {
  const eslint = new ESLint({ cwd: root, ignorePatterns: shardIgnorePatterns(shard, root) })
  const inShardPaths = files.filter((file) => shard.paths.some((path) => contains(path, file)))
  return lintedFiles(eslint, inShardPaths)
}

describe('lint shards', () => {
  it('lint every file `eslint .` lints, each in exactly one shard', async () => {
    const files = repositoryFiles()
    const expected = await lintedFiles(new ESLint({ cwd: root }), files)
    assert.ok(
      expected.includes('scripts/run-lint.mts'),
      'the repository walk found no lintable files',
    )

    const owners = new Map<string, string[]>()
    for (const shard of LINT_SHARDS) {
      for (const file of await lintedByShard(shard, files)) {
        owners.set(file, [...(owners.get(file) ?? []), shard.label])
      }
    }

    assert.deepEqual(
      expected.filter((file) => !owners.has(file)),
      [],
      '`eslint .` lints these files but no shard in scripts/lib/lint-shards.mts does',
    )
    assert.deepEqual(
      [...owners]
        .filter(([, labels]) => labels.length > 1)
        .map(([file, labels]) => `${file}: ${labels.join(', ')}`),
      [],
      'more than one shard lints these files',
    )
  })
})

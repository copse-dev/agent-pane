import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeGitIgnoreExcludes,
  deriveExcludePatterns,
  parseCheckIgnoreRules,
  redundantExcludePatterns,
  repoRootsFromGitDirs,
} from './git-derived-excludes.ts'

describe('git-derived-excludes', () => {
  it('collapses nested ignored dirs to distinct un-anchored patterns', () => {
    // Shape from `git ls-files --others --ignored --directory` in a SwiftPM tree.
    const ignored = [
      'SharedPackages/AIChat/.build/',
      'SharedPackages/AIChat/.swiftpm/',
      'SharedPackages/VPN/.build/',
      'SharedPackages/VPN/.swiftpm/',
      'macOS/LocalPackages/Foo/.build/',
    ]
    assert.deepEqual(deriveExcludePatterns(ignored), ['.build/', '.swiftpm/'])
  })

  it('ignores individual files, keeping only directory patterns', () => {
    const ignored = ['.DS_Store', 'docs/generated/api.html', 'pkg/DerivedData/', 'a.log']
    // Files (no trailing slash) are left alone so a bare `api.html`/`a.log`
    // pattern never over-matches; only the DerivedData dir is emitted.
    assert.deepEqual(deriveExcludePatterns(ignored), ['DerivedData/'])
  })

  it('is empty for a tree with no ignored directories', () => {
    assert.deepEqual(deriveExcludePatterns(['', '  ', 'README.md']), [])
  })

  it('derives repo roots from find output by stripping the trailing .git', () => {
    const findOutput = ['/ws/.git', '/ws/apple-browsers/.git', '/ws/android/.git/', ''].join('\n')
    assert.deepEqual(repoRootsFromGitDirs(findOutput).sort(), [
      '/ws',
      '/ws/android',
      '/ws/apple-browsers',
    ])
  })

  it('emits the gitignore glob, not each instance, for uniquely-named scratch dirs', () => {
    const ignored = ['.wdio-profile-0K8Umz/', '.wdio-profile-1KVaSe/', 'pkg/.build/', 'dist/']
    const rules = new Map([
      ['.wdio-profile-0K8Umz/', '.wdio-profile-*/'],
      ['.wdio-profile-1KVaSe/', '.wdio-profile-*/'],
      ['pkg/.build/', '.build/'],
      ['dist/', 'dist/'],
    ])
    assert.deepEqual(deriveExcludePatterns(ignored, rules), [
      '.build/',
      '.wdio-profile-*/',
      'dist/',
    ])
  })

  it('falls back to the dir name when the rule is anchored or path-scoped', () => {
    // Handing gortex `/site/_build/` or `assets/*/app.iconset/` verbatim would
    // change their meaning (gortex anchors to each tracked repo), so keep the
    // un-anchored basename the pre-rule derivation always emitted.
    const ignored = ['site/_build/', 'assets/icons/ocean/app.iconset/']
    const rules = new Map([
      ['site/_build/', '/site/_build/'],
      ['assets/icons/ocean/app.iconset/', 'assets/icons/*/app.iconset/'],
    ])
    assert.deepEqual(deriveExcludePatterns(ignored, rules), ['_build/', 'app.iconset/'])
  })

  it('skips a listed dir no rule ignores once rules are known', () => {
    // `--directory` lists `assets/icons/wave/` when it only holds ignored files;
    // emitting `wave/` would exclude every `wave/` source dir in the workspace.
    const ignored = ['assets/icons/wave/', 'pkg/', 'pkg/node_modules/']
    const rules = new Map([['pkg/node_modules/', 'node_modules/']])
    assert.deepEqual(deriveExcludePatterns(ignored, rules), ['node_modules/'])
    // Without rules (git check-ignore failed) the old per-name behaviour stands.
    assert.deepEqual(deriveExcludePatterns(ignored), ['node_modules/', 'pkg/', 'wave/'])
  })

  it('parses git check-ignore -v -z records into path → rule', () => {
    const stdout = [
      '.gitignore',
      '30',
      '.wdio-profile-*/',
      '.wdio-profile-0K8Umz/',
      '.gitignore',
      '4',
      'dist/',
      'dist/',
      '',
    ].join('\0')
    assert.deepEqual(
      [...parseCheckIgnoreRules(stdout)],
      [
        ['.wdio-profile-0K8Umz/', '.wdio-profile-*/'],
        ['dist/', 'dist/'],
      ],
    )
    assert.equal(parseCheckIgnoreRules('').size, 0)
  })

  it('finds literal excludes a wildcard exclude already covers', () => {
    const config = [
      'node_modules/',
      '.wdio-profile-*/',
      '.wdio-profile-0K8Umz/',
      '.wdio-profile-1KVaSe/',
      '.wdio-eval-chrome-09707bc3-biuOb4/',
      'build-[0-9]/',
      'build-7/',
      'build-x/',
      '*.egg-info',
      'zoo.egg-info/',
    ]
    assert.deepEqual(redundantExcludePatterns(config), [
      '.wdio-profile-0K8Umz/',
      '.wdio-profile-1KVaSe/',
      'build-7/',
      'zoo.egg-info/',
    ])
  })

  it('does not let a directory-only glob cover a file pattern, or a path cover anything', () => {
    assert.deepEqual(redundantExcludePatterns(['.cache-*/', '.cache-x', 'a/.cache-y/']), [])
    assert.deepEqual(redundantExcludePatterns(['node_modules/', 'dist/']), [])
  })

  it('derives glob excludes from a real repo via git check-ignore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-git-excludes-'))
    try {
      const git = (...args: string[]): Buffer =>
        execFileSync('git', args, { cwd: root, stdio: 'ignore' })
      git('init', '-q')
      writeFileSync(join(root, '.gitignore'), '.wdio-profile-*/\n/out/\nnode_modules/\n')
      for (const dir of [
        '.wdio-profile-aaaaaa',
        '.wdio-profile-bbbbbb',
        'out',
        'pkg/node_modules/x',
      ]) {
        mkdirSync(join(root, dir), { recursive: true })
        writeFileSync(join(root, dir, 'f.txt'), 'x')
      }
      assert.deepEqual(await computeGitIgnoreExcludes(root), [
        '.wdio-profile-*/',
        'node_modules/',
        'out/',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

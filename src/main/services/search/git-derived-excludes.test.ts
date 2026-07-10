import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveExcludePatterns, repoRootsFromGitDirs } from './git-derived-excludes.ts'

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
    const findOutput = [
      '/ws/.git',
      '/ws/apple-browsers/.git',
      '/ws/android/.git/',
      '',
    ].join('\n')
    assert.deepEqual(repoRootsFromGitDirs(findOutput).sort(), [
      '/ws',
      '/ws/android',
      '/ws/apple-browsers',
    ])
  })
})

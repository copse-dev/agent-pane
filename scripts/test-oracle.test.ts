import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import {
  assignShards,
  computeScreenshotGate,
  computeSelection,
  computeUnitPlan,
  demoScreenshots,
  reachableFiles,
  selectDemoSpecs,
  type OracleFiles,
} from './test-oracle.mts'
import {
  parseScreenshotManifest,
  SCREENSHOT_MANIFEST,
  serializeScreenshotManifest,
} from './lib/screenshot-manifest.mts'

const ORACLE = resolve('scripts/test-oracle.mts')

it('CI plan capture preserves docs-only selection and still detects untracked source', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-oracle-capture-'))
  const runnerTemp = mkdtempSync(join(tmpdir(), 'copse-runner-temp-'))
  try {
    git(root, 'init', '-q')
    const base = commit(root, 'README.md', 'base\n')
    commit(root, 'README.md', 'updated docs\n')
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
    const start = workflow.indexOf('          plan_file=')
    const end = workflow.indexOf('\n      # Advisory only:', start)
    assert(start >= 0 && end > start)
    const fragment = workflow
      .slice(start, end)
      .replace('node scripts/test-oracle.mts', '"$ORACLE_NODE" "$ORACLE_SCRIPT"')
    const output = join(runnerTemp, 'output')
    const summary = join(runnerTemp, 'summary')
    const capture = (): string => {
      writeFileSync(output, '')
      writeFileSync(summary, '')
      execFileSync('bash', ['-euo', 'pipefail', '-c', fragment], {
        cwd: root,
        env: {
          ...process.env,
          BASE_SHA: base,
          RUNNER_TEMP: runnerTemp,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          ORACLE_NODE: process.execPath,
          ORACLE_SCRIPT: ORACLE,
        },
        stdio: 'pipe',
      })
      return readFileSync(output, 'utf8')
    }
    assert.match(capture(), /^unit_mode=skip$/m)
    assert.match(readFileSync(summary, 'utf8'), /^unit_mode=skip$/m)
    assert.deepEqual(changed(root, base), ['README.md'])
    writeFileSync(join(root, 'untracked.ts'), 'export const value = 1\n')
    assert.match(capture(), /^unit_mode=full$/m)
    assert.deepEqual(changed(root, base).sort(), ['README.md', 'untracked.ts'])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(runnerTemp, { recursive: true, force: true })
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim()
}

function commit(cwd: string, file: string, body: string): string {
  writeFileSync(join(cwd, file), body)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-qm', file)
  return git(cwd, 'rev-parse', 'HEAD')
}

/** The `--plan` lines CI copies into `$GITHUB_OUTPUT`, as a map. */
function plan(cwd: string, base: string): Map<string, string> {
  const out = execFileSync(process.execPath, [ORACLE, '--plan', '--base', base], {
    cwd,
    encoding: 'utf8',
  })
  const entries = out
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line): [string, string] => [
      line.slice(0, line.indexOf('=')),
      line.slice(line.indexOf('=') + 1),
    ])
  return new Map(entries)
}

function changed(cwd: string, base: string): string[] {
  const out = execFileSync(process.execPath, [ORACLE, '--json', '--base', base], {
    cwd,
    encoding: 'utf8',
  })
  return z.object({ changed: z.array(z.string()) }).parse(JSON.parse(out)).changed
}

/**
 * A push whose `before` was force-replaced, checked out the way ci.yml's
 * precheck does: a depth-1 checkout, then the checked-out commit's full history.
 * `old` is the previous tip; it is NOT fetched yet — each case fetches it the
 * way it wants to test.
 */
function forcePushedCheckout(root: string): { checkout: string; old: string } {
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  execFileSync('git', ['init', '--bare', '-q', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', work])
  const base = commit(work, 'README.md', 'base\n')
  const old = commit(work, 'old.txt', 'old tip\n')
  git(work, 'push', '-q', origin, 'main')
  git(work, 'checkout', '-qb', 'rewrite', base)
  commit(work, 'new.txt', 'new tip\n')
  git(work, 'push', '-q', '--force', origin, 'HEAD:main')

  const checkout = join(root, 'checkout')
  git(root, 'clone', '-q', '--depth=1', '--branch', 'main', `file://${origin}`, checkout)
  git(
    checkout,
    'fetch',
    '-q',
    '--no-tags',
    '--unshallow',
    'origin',
    git(checkout, 'rev-parse', 'HEAD'),
  )
  return { checkout, old }
}

describe('test oracle base resolution', () => {
  it('plans the full suite when the base shares no merge-base with HEAD', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-oracle-base-'))
    try {
      const { checkout, old } = forcePushedCheckout(root)
      // A depth-1 fetch of the replaced tip cannot reconnect it to HEAD's
      // history, so there is no merge-base to diff from. That is "the change set
      // is unknown", not "nothing changed" — an empty set planned mode=skip.
      git(checkout, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', old)
      const p = plan(checkout, old)
      assert.equal(p.get('mode'), 'full')
      assert.equal(p.get('unit_mode'), 'full')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('plans the full suite when the base cannot be resolved at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-oracle-base-'))
    try {
      const { checkout } = forcePushedCheckout(root)
      // The replaced tip was garbage-collected, so its fetch failed (`|| true`).
      const p = plan(checkout, 'f'.repeat(40))
      assert.equal(p.get('mode'), 'full')
      assert.equal(p.get('unit_mode'), 'full')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('diffs a force-pushed base once its history is fetched unshallowed', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-oracle-base-'))
    try {
      const { checkout, old } = forcePushedCheckout(root)
      // ci.yml's precheck fetch: no depth, so the replaced tip joins HEAD's
      // history at their real merge-base and the diff stays precise.
      git(checkout, 'fetch', '-q', '--no-tags', 'origin', old)
      assert.deepEqual(changed(checkout, old), ['new.txt'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a documentation-only push cheap when the base is an ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-oracle-base-'))
    try {
      const { checkout } = forcePushedCheckout(root)
      const base = git(checkout, 'rev-parse', 'HEAD')
      commit(checkout, 'README.md', 'base\nmore docs\n')
      const p = plan(checkout, base)
      assert.equal(p.get('mode'), 'skip')
      assert.equal(p.get('unit_mode'), 'skip')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('test oracle dependency inputs', () => {
  // pnpm installs from these, so one changed alone can swap the code of any
  // shipped dependency. A security pin through pnpm-workspace.yaml `overrides`
  // with its regenerated lockfile once planned mode=skip, as if only docs moved.
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
    it(`plans the full suite for a change to ${file} alone`, () => {
      const root = mkdtempSync(join(tmpdir(), 'copse-oracle-deps-'))
      try {
        git(root, 'init', '-q')
        const base = commit(root, 'README.md', 'base\n')
        commit(root, file, 'changed\n')
        const p = plan(root, base)
        assert.equal(p.get('mode'), 'full')
        assert.equal(p.get('unit_mode'), 'full')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})

describe('test oracle import graph', () => {
  // A type-only import is erased before the code runs, so the module it names
  // cannot change what a unit test does. Following it tied a change to a shared
  // types file to hundreds of unit tests. An e2e spec tests the running app, so
  // its imports, type-only ones included, still stand in for what it observes.
  const files: Record<string, string> = {
    'src/entry.test.ts': [
      "import type { T } from './types.ts'",
      "export type { U } from './reexported-type.ts'",
      "export type * from './star-type.ts'",
      "import type * as Ns from './namespace-type.ts'",
      "import type Default from './default-type.ts'",
      'import type {',
      '  A,',
      '  B,',
      "} from './multiline-type.ts'",
      "export type Alias = { from: 'not-a-module' }",
      "import { value } from './runtime.ts'",
      "import { type Mixed, other } from './mixed.ts'",
      "import type from './named-type.ts'",
      "import './side-effect.ts'",
      "const lazy = (): Promise<unknown> => import('./lazy.ts')",
    ].join('\n'),
    'src/runtime.ts': "import type { Deep } from './deep-type.ts'\nexport const value = 1",
  }
  for (const name of [
    'types',
    'reexported-type',
    'star-type',
    'namespace-type',
    'default-type',
    'multiline-type',
    'mixed',
    'named-type',
    'side-effect',
    'lazy',
    'deep-type',
  ])
    files[`src/${name}.ts`] = 'export {}'
  const tree: OracleFiles = {
    paths: () => Object.keys(files),
    read: (path) => files[path] ?? '',
    exists: (path) => Object.hasOwn(files, path),
  }

  it("follows only the test's own type-only imports, for a unit test", () => {
    // deep-type.ts is reached only through runtime.ts's `import type`.
    assert.deepEqual(
      [...reachableFiles('src/entry.test.ts', new Map(), tree, false)].sort(),
      Object.keys(files)
        .filter((path) => path !== 'src/entry.test.ts' && path !== 'src/deep-type.ts')
        .sort(),
    )
  })

  it('reads each kind of type-only statement, and nothing else, as type-only', () => {
    // The same statements one step down, in a module the test loads: only the
    // ones that load a module are followed.
    const nestedFiles: Record<string, string> = {
      'src/nested.test.ts': "import { entry } from './entry.ts'",
      'src/entry.ts': files['src/entry.test.ts'] ?? '',
    }
    for (const [path, body] of Object.entries(files))
      if (path !== 'src/entry.test.ts') nestedFiles[path] = body
    const nestedTree: OracleFiles = {
      paths: () => Object.keys(nestedFiles),
      read: (path) => nestedFiles[path] ?? '',
      exists: (path) => Object.hasOwn(nestedFiles, path),
    }
    assert.deepEqual(
      [...reachableFiles('src/nested.test.ts', new Map(), nestedTree, false)].sort(),
      [
        'src/entry.ts',
        'src/lazy.ts',
        'src/mixed.ts',
        'src/named-type.ts',
        'src/runtime.ts',
        'src/side-effect.ts',
      ],
    )
  })

  it('still follows type-only imports by default, for e2e specs', () => {
    assert.deepEqual(
      [...reachableFiles('src/entry.test.ts', new Map(), tree)].sort(),
      Object.keys(files)
        .filter((path) => path !== 'src/entry.test.ts')
        .sort(),
    )
  })

  it("selects no unit test that reaches the change only through another module's type import", () => {
    const selectionFiles: Record<string, string> = {
      'tests/e2e/shape.e2e.ts': "import type { Shape } from '../../src/shape.ts'",
      'src/shape.test.ts':
        "import type { Shape } from './shape.ts'\nimport { area } from './area.ts'",
      'src/area.test.ts': "import { area } from './area.ts'",
      'src/area.ts': "import type { Shape } from './shape.ts'\nexport const area = 1",
      'src/shape.ts': 'export type Shape = { width: number }',
    }
    const selectionTree: OracleFiles = {
      paths: (dir) => Object.keys(selectionFiles).filter((path) => path.startsWith(`${dir}/`)),
      read: (path) => selectionFiles[path] ?? '',
      exists: (path) => Object.hasOwn(selectionFiles, path),
    }
    const selection = computeSelection(['src/shape.ts'], selectionTree)
    assert.deepEqual(selection.selectedE2e, ['tests/e2e/shape.e2e.ts'])
    // shape.test.ts names the type itself; area.test.ts reaches it only
    // through area.ts's `import type`, which loads nothing.
    assert.deepEqual(selection.selectedUnit, ['src/shape.test.ts'])
    assert.deepEqual(computeSelection(['src/area.ts'], selectionTree).selectedUnit, [
      'src/area.test.ts',
      'src/shape.test.ts',
    ])
  })

  it('resolves a specifier to the file it names when a sibling shares its stem', () => {
    // src/shared/unknown-value.ts re-exports unknown-value.mts. Trying `.ts`
    // first resolved every `.mts` import to the shim, itself included, so the
    // real module was in no test's graph and a change to it selected nothing.
    const siblingFiles: Record<string, string> = {
      'src/value.test.ts': "import { value } from './value.ts'",
      'src/direct.test.ts': "import { value } from './value.mts'",
      'src/value.ts': "export * from './value.mts'",
      'src/value.mts': 'export const value = 1',
    }
    const siblingTree: OracleFiles = {
      paths: (dir) => Object.keys(siblingFiles).filter((path) => path.startsWith(`${dir}/`)),
      read: (path) => siblingFiles[path] ?? '',
      exists: (path) => Object.hasOwn(siblingFiles, path),
    }
    assert.deepEqual(computeSelection(['src/value.mts'], siblingTree).selectedUnit, [
      'src/direct.test.ts',
      'src/value.test.ts',
    ])
    assert.deepEqual(computeSelection(['src/value.ts'], siblingTree).selectedUnit, [
      'src/value.test.ts',
    ])
    assert.ok(
      computeSelection(['src/shared/unknown-value.mts']).selectedUnit.includes(
        'src/shared/roadmap/export.test.ts',
      ),
    )
  })

  it('still resolves a specifier whose extension differs from the file on disk', () => {
    const jsFiles: Record<string, string> = {
      'src/a.test.ts': "import './a.js'\nimport './dir'",
      'src/a.ts': '',
      'src/dir/index.mts': '',
    }
    const jsTree: OracleFiles = {
      paths: () => Object.keys(jsFiles),
      read: (path) => jsFiles[path] ?? '',
      exists: (path) => Object.hasOwn(jsFiles, path),
    }
    assert.deepEqual([...reachableFiles('src/a.test.ts', new Map(), jsTree)].sort(), [
      'src/a.ts',
      'src/dir/index.mts',
    ])
  })

  it('follows an import of every workspace package into its source', () => {
    // A package missing from the alias table is a dead end: a change to
    // packages/review/src reached none of the src/ and scripts/ tests that
    // import it, so a stacked PR ran a unit subset without them.
    const packages = readdirSync('packages').flatMap((dir) => {
      const manifest = join('packages', dir, 'package.json')
      if (!existsSync(manifest) || !existsSync(join('packages', dir, 'src/index.ts'))) return []
      const { name } = z
        .object({ name: z.string() })
        .parse(JSON.parse(readFileSync(manifest, 'utf8')))
      return [{ name, entry: `packages/${dir}/src/index.ts` }]
    })
    assert.ok(packages.length >= 10, 'expected the workspace packages')
    const probe = 'src/probe.test.ts'
    const body = packages.map(({ name }) => `import '${name}/index.ts'`).join('\n')
    const probeTree: OracleFiles = {
      paths: () => [probe],
      read: (path) => (path === probe ? body : ''),
      exists: (path) => path === probe || existsSync(path),
    }
    const reached = reachableFiles(probe, new Map(), probeTree)
    for (const { name, entry } of packages) assert.ok(reached.has(entry), name)

    const selected = computeSelection(['packages/review/src/scripted-provider.ts']).selectedUnit
    assert.ok(selected.includes('src/main/services/review/review-service.test.ts'))
    assert.ok(
      computeSelection(['packages/remote-protocol/src/signing.ts']).selectedUnit.includes(
        'src/main/services/remote-names/names-client.test.ts',
      ),
    )
    assert.ok(
      computeSelection(['packages/review/ci/action-policy.mts']).selectedUnit.includes(
        'scripts/reviewer-actions.test.ts',
      ),
    )
  })

  it('ties the module run-tests swaps in to the tests that import the real one', () => {
    // Every unit bundle loads user-data-files.test-shim.ts in place of
    // user-data-files.ts, but no test imports the shim by name.
    const selected = computeSelection([
      'src/main/services/storage/user-data-files.test-shim.ts',
    ]).selectedUnit
    assert.ok(selected.includes('src/main/services/storage/usage-ledger.test.ts'))
  })

  it('keeps the classifier settings spec mapped through its type-only import', () => {
    const selection = computeSelection(['src/main/services/classifiers/classifier-service.ts'])
    assert.ok(selection.selectedE2e.includes('tests/e2e/settings-classifiers.e2e.ts'))
  })
})

describe('test oracle disk readers', () => {
  // These tests read specs, fixtures or the CI spec list from disk, so the import
  // graph cannot tie a changed spec to them. A PR adding a spec beside a source
  // edit got a unit subset without them, and the 21st unweighted spec failed
  // only in the full check.
  const source = 'src/renderer/views/footer-branch-status.ts'
  const cases: readonly { input: string; readers: readonly string[]; reason: RegExp }[] = [
    {
      input: 'tests/e2e/new-feature.e2e.ts',
      readers: [
        'scripts/ci-workflow-invariants.test.ts',
        'scripts/small-gate.test.ts',
        'scripts/screenshot-producers.test.ts',
        'scripts/readme-screenshots.test.ts',
        'scripts/check-mock-fixtures.test.ts',
      ],
      reason: /reads .* from disk/,
    },
    {
      input: 'scripts/e2e-shard-weights.json',
      readers: ['scripts/ci-workflow-invariants.test.ts', 'scripts/small-gate.test.ts'],
      reason: /reads the CI spec list/,
    },
    {
      input: 'tests/e2e/exclusions.json',
      readers: ['scripts/ci-workflow-invariants.test.ts', 'scripts/small-gate.test.ts'],
      reason: /reads the CI spec list/,
    },
    {
      input: 'tests/e2e/smoke-inventory.json',
      readers: ['scripts/ci-workflow-invariants.test.ts', 'scripts/small-gate.test.ts'],
      reason: /reads the CI spec list/,
    },
    {
      input: 'tests/e2e/screenshots/manifest.json',
      readers: ['scripts/screenshot-producers.test.ts', 'scripts/readme-screenshots.test.ts'],
      reason: /reads the screenshots specs save/,
    },
    {
      input: 'README.md',
      readers: ['scripts/readme-screenshots.test.ts'],
      reason: /reads the README screenshots/,
    },
    {
      input: 'src/main/services/acp/acp-new-fixture.test.ts',
      readers: ['scripts/check-mock-fixtures.test.ts'],
      reason: /reads the executable mock fixtures/,
    },
    {
      input: 'benchmarks/new-pack.json',
      readers: ['scripts/check-mock-fixtures.test.ts'],
      reason: /reads the executable mock fixtures/,
    },
  ]

  it('adds them to an import-graph subset when an input they read changes', () => {
    for (const { input, readers, reason } of cases) {
      const sel = computeSelection([input, source])
      const plan = computeUnitPlan(sel)
      assert.equal(plan.mode, 'subset', input)
      for (const reader of readers) {
        assert.ok(plan.tests.includes(reader), `${input} should select ${reader}`)
        assert.match(sel.unitReasons.get(reader)?.join('\n') ?? '', reason, `${input}: ${reader}`)
      }
    }
  })

  it('adds only the readers of the input that changed', () => {
    const plan = computeUnitPlan(computeSelection(['README.md', source]))
    assert.ok(!plan.tests.includes('scripts/small-gate.test.ts'))
    assert.ok(!plan.tests.includes('scripts/check-mock-fixtures.test.ts'))
  })

  // Documentation is in no import graph, so a docs-only diff planned `skip` even
  // for a page a unit test parses: an edit to CHANGELOG.md that broke the
  // release-notes tests stayed green until the whole suite next ran.
  const pages: readonly { page: string; readers: readonly string[] }[] = [
    {
      page: 'CHANGELOG.md',
      readers: ['scripts/release-bump.test.ts', 'scripts/release-notes.test.ts'],
    },
    { page: 'README.md', readers: ['scripts/readme-screenshots.test.ts'] },
    {
      page: 'docs/boundary-contracts.md',
      readers: ['scripts/boundary-contracts.test.ts', 'scripts/ci-workflow-invariants.test.ts'],
    },
    {
      page: 'docs/host-environment-test-noise.md',
      readers: ['scripts/host-differences.test.ts'],
    },
    {
      page: 'docs/main-process-sync-reads.md',
      readers: ['scripts/main-sync-read-invariants.test.ts'],
    },
    {
      page: 'docs/remote-client-capabilities.json',
      readers: ['scripts/lib/remote-capabilities.test.ts'],
    },
    {
      page: 'packages/review/ACTIONS.md',
      readers: ['scripts/reviewer-summary-publication.test.ts'],
    },
  ]

  it('runs the tests that read a documentation page when only that page changes', () => {
    for (const { page, readers } of pages) {
      const plan = computeUnitPlan(computeSelection([page]))
      assert.equal(plan.mode, 'subset', page)
      assert.deepEqual(plan.tests, readers, page)
    }
    const both = computeUnitPlan(computeSelection(['CHANGELOG.md', 'README.md']))
    assert.deepEqual(both.tests, [
      'scripts/readme-screenshots.test.ts',
      'scripts/release-bump.test.ts',
      'scripts/release-notes.test.ts',
    ])
  })

  it('still skips documentation no test reads, and never thins beside an unmapped change', () => {
    assert.equal(computeUnitPlan(computeSelection(['docs/testing-strategy.md'])).mode, 'skip')
    assert.equal(
      computeUnitPlan(computeSelection(['docs/testing-strategy.md', 'CONTRIBUTING.md'])).mode,
      'skip',
    )
    // The spec is invisible to the import graph, so the readers are not the
    // whole answer for this diff.
    const mixed = computeSelection(['CHANGELOG.md', 'tests/e2e/new-feature.e2e.ts'])
    assert.equal(computeUnitPlan(mixed).mode, 'full')
    const withSource = computeUnitPlan(computeSelection(['CHANGELOG.md', source]))
    assert.equal(withSource.mode, 'subset')
    assert.ok(withSource.tests.includes('scripts/release-notes.test.ts'))
    assert.ok(withSource.tests.includes('src/renderer/views/footer-branch-status.test.ts'))
  })

  it('does not treat the Markdown the app ships as documentation', () => {
    // build.mts copies assets/ and the bundled skills into the app, and the
    // skill tests load both trees from disk.
    for (const file of [
      'assets/skills/reconcile-worktrees/SKILL.md',
      'vendor/bundled-cursor-skills/README.md',
    ])
      assert.equal(computeUnitPlan(computeSelection([file])).mode, 'full', file)
  })

  it('never skips a documentation file a unit test reads by name', () => {
    // Guards the list above: a test that starts reading a page must be added to
    // DISK_READERS, or a change to that page alone runs nothing.
    const read = /\breadFile(?:Sync)?\(\s*(?:resolve\(\s*)?['"]([^'"]+)['"]/g
    const docs = /^docs\/|\.md$/
    const selection = computeSelection([])
    let checked = 0
    for (const test of selection.unitTests) {
      for (const match of readFileSync(test, 'utf8').matchAll(read)) {
        const file = match[1] ?? ''
        if (!docs.test(file) || !existsSync(file)) continue
        checked += 1
        const plan = computeUnitPlan(computeSelection([file]))
        assert.ok(
          plan.mode === 'full' || (plan.mode === 'subset' && plan.tests.includes(test)),
          `${test} reads ${file}, but a change to it plans ${plan.mode}`,
        )
      }
    }
    assert.ok(checked >= pages.length, 'expected to find the documentation reads')
  })

  it('leaves a source-only change alone and a spec-only change on the full suite', () => {
    const readers = new Set(cases.flatMap((c) => c.readers))
    const sourceOnly = computeSelection([source]).selectedUnit
    for (const reader of readers) assert.ok(!sourceOnly.includes(reader), reader)
    const specOnly = computeSelection(['tests/e2e/new-feature.e2e.ts'])
    assert.equal(computeUnitPlan(specOnly).mode, 'full')
  })
})

describe('assignShards', () => {
  const specs = ['a', 'b', 'c', 'd', 'e', 'f']

  it('puts the slow specs on different shards and fills the rest by load', () => {
    const seconds = new Map([
      ['a', 1],
      ['b', 90],
      ['c', 80],
      ['d', 10],
      ['e', 10],
      ['f', 60],
    ])
    // Round-robin by count gives these shards 11s, 100s and 140s.
    assert.deepEqual(assignShards(specs, 3, seconds), [['b'], ['a', 'c'], ['d', 'e', 'f']])
  })

  it('weights an unrecorded spec at the median, not zero', () => {
    const seconds = new Map([
      ['a', 100],
      ['b', 40],
      ['c', 40],
      ['d', 10],
    ])
    // At zero cost `f` would be placed last, leaving shard 2 with b, c, d and f.
    assert.deepEqual(assignShards(['a', 'b', 'c', 'd', 'f'], 2, seconds), [
      ['a', 'd'],
      ['b', 'c', 'f'],
    ])
  })

  it('partitions every spec once and falls back to balanced counts with no data', () => {
    const shards = assignShards(specs, 4, new Map())
    assert.deepEqual(shards.flat().sort(), specs)
    assert.deepEqual(
      shards.map((shard) => shard.length),
      [2, 2, 1, 1],
    )
    assert.deepEqual(assignShards([], 2, new Map()), [[], []])
  })
})

describe('test oracle demo screenshot ownership', () => {
  // Browser demo specs save reference shots beside the e2e ones, and every
  // e2e-tier PR renders every demo, so the candidate filter holds any demo shot
  // no change owns. Their shot names stay fictional here: the producer check
  // reads quoted PNG names under scripts/ as producers.
  const committed = [
    'oracle-demo-phone-pair-light.png',
    'oracle-demo-phone-pair-dark.png',
    'oracle-demo-phone-settled.png',
    'oracle-demo-other.png',
    'oracle-demo-other-native.png',
    'oracle-demo-unowned.png',
  ]
  const files: Record<string, string> = {
    'tests/demo/phone.demo.ts': [
      "import { fixture } from './helpers/phone-fixture.ts'",
      'async function screenshot(name: string): Promise<void> { await fixture(name) }',
      "await $('#oracle-demo-composer').click()",
      "await $('.hidden').waitForExist()",
      "for (const theme of ['light', 'dark']) await screenshot(`oracle-demo-phone-pair-${theme}.png`)",
      "await screenshot('oracle-demo-phone-settled.png')",
    ].join('\n'),
    'tests/demo/helpers/phone-fixture.ts': 'export async function fixture(name: string) {}',
    'tests/demo/other.demo.ts': [
      "await $('.oracle-demo-other-pane').click()",
      "await saveAppScreenshot('oracle-demo-other.png')",
      'await saveAppScreenshot(`oracle-demo-other-${variant}.png`)',
    ].join('\n'),
    'src/mobile/app.css': '#oracle-demo-composer { display: grid; }',
    'src/mobile/app.test.ts': "assert.ok(document.querySelector('#oracle-demo-composer'))",
    'src/renderer/styles/generic.css': '.hidden { display: none; }',
    'src/renderer/other.ts': "export const pane = 'oracle-demo-other-pane'",
    'src/unrelated.ts': 'export const value = 1',
    [SCREENSHOT_MANIFEST]: serializeScreenshotManifest({
      version: 1,
      screenshots: Object.fromEntries(
        committed.map((name) => [name, { sha256: 'a'.repeat(64), bytes: 1 }]),
      ),
    }),
  }
  const tree: OracleFiles = {
    paths: (dir) => Object.keys(files).filter((path) => path.startsWith(`${dir}/`)),
    read: (path) => files[path] ?? '',
    exists: (path) => Object.hasOwn(files, path),
  }
  const phone = 'tests/demo/phone.demo.ts'
  const other = 'tests/demo/other.demo.ts'

  it('selects a demo by its own change, its imports, or its selectors in shipped source', () => {
    assert.deepEqual(selectDemoSpecs([other], false, tree), [other])
    assert.deepEqual(selectDemoSpecs(['tests/demo/helpers/phone-fixture.ts'], false, tree), [phone])
    assert.deepEqual(selectDemoSpecs(['src/mobile/app.css'], false, tree), [phone])
    assert.deepEqual(selectDemoSpecs(['src/renderer/other.ts'], false, tree), [other])
    assert.deepEqual(selectDemoSpecs([], true, tree), [other, phone])
  })

  it('follows the fixture pages a demo bundles with esbuild rather than imports', () => {
    const bundled: Record<string, string> = {
      'tests/demo/bundled.demo.ts':
        "await build({ entryPoints: ['tests/demo/helpers/bundled-fixture.ts'] })",
      'tests/demo/helpers/bundled-fixture.ts':
        "import { tip } from '../../../src/shared/bundled-source.ts'",
      'tests/demo/paged.demo.ts': "page = await buildDemoFixturePage('paged-fixture')",
      'tests/demo/helpers/paged-fixture.ts':
        "import { row } from '../../../src/shared/paged-source.ts'",
      'src/shared/bundled-source.ts': 'export const tip = 1',
      'src/shared/paged-source.ts': 'export const row = 1',
    }
    const bundledTree: OracleFiles = {
      paths: (dir) => Object.keys(bundled).filter((path) => path.startsWith(`${dir}/`)),
      read: (path) => bundled[path] ?? '',
      exists: (path) => Object.hasOwn(bundled, path),
    }
    const select = (file: string): string[] => selectDemoSpecs([file], false, bundledTree)
    assert.deepEqual(select('tests/demo/helpers/bundled-fixture.ts'), [
      'tests/demo/bundled.demo.ts',
    ])
    assert.deepEqual(select('src/shared/bundled-source.ts'), ['tests/demo/bundled.demo.ts'])
    assert.deepEqual(select('tests/demo/helpers/paged-fixture.ts'), ['tests/demo/paged.demo.ts'])
    assert.deepEqual(select('src/shared/paged-source.ts'), ['tests/demo/paged.demo.ts'])
  })

  it('ignores unrelated source, test files and generic selectors', () => {
    for (const file of [
      'src/unrelated.ts',
      'src/mobile/app.test.ts',
      'src/renderer/styles/generic.css',
    ])
      assert.deepEqual(selectDemoSpecs([file], false, tree), [], file)
  })

  it("owns a demo's helper and per-theme captures, but never another spec's exact name", () => {
    const e2e = new Map([['tests/e2e/other.e2e.ts', ['oracle-demo-other-native.png']]])
    assert.deepEqual(demoScreenshots([phone], e2e, tree), [
      'oracle-demo-phone-pair-dark.png',
      'oracle-demo-phone-pair-light.png',
      'oracle-demo-phone-settled.png',
    ])
    // `oracle-demo-other-${variant}` matches the e2e spec's shot too.
    assert.deepEqual(demoScreenshots([other], e2e, tree), ['oracle-demo-other.png'])
    assert.deepEqual(demoScreenshots([], e2e, tree), [])
  })

  it('owns the mobile companion shots for a mobile stylesheet change (#3949)', () => {
    // #3949 changed src/mobile/app.css: 193 e2e shots were affected and no
    // mobile-companion demo shot, so every one of their re-renders was held.
    const manifest = parseScreenshotManifest(readFileSync(SCREENSHOT_MANIFEST, 'utf8'))
    const mobile = Object.keys(manifest.screenshots).filter((name) =>
      name.startsWith('mobile-companion-'),
    )
    assert.ok(mobile.length > 0)
    const gate = computeScreenshotGate(['src/mobile/app.css'], false)
    assert.deepEqual(
      mobile.filter((name) => !gate.affected.includes(name)),
      [],
    )
  })

  it('owns only the shots a changed demo saves, though tests/demo/ is broad for selection', () => {
    const spec = 'tests/demo/mobile-companion.demo.ts'
    assert.equal(computeSelection([spec]).broad, true)
    const gate = computeScreenshotGate([spec], false)
    assert.ok(gate.affected.length > 0)
    assert.deepEqual(
      gate.affected.filter((name) => !name.startsWith('mobile-companion-')),
      [],
    )
  })
})

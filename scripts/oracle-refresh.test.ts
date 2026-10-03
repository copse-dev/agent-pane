import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../src/shared/safe-json.ts'

const ORACLE = resolve('scripts/test-oracle.mts')
const refreshSchema = z.object({
  mode: z.enum(['skip', 'subset', 'review']),
  mappingVersion: z.literal(1),
  candidateTree: z.string().nullable(),
  refs: z
    .object({
      testedBase: z.string(),
      testedCandidate: z.string(),
      testedPrHead: z.string(),
      base: z.string(),
      prHead: z.string(),
      candidate: z.string(),
    })
    .nullable(),
  changes: z.object({ pr: z.array(z.string()), base: z.array(z.string()) }),
  areas: z.object({
    pr: z.array(z.string()),
    base: z.array(z.string()),
    overlap: z.array(z.string()),
  }),
  unitSpecs: z.array(z.string()),
  e2eSpecs: z.array(z.string()),
  reasons: z.array(z.string()),
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Oracle test',
      '-c',
      'user.email=oracle@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()
}

function write(cwd: string, path: string, body: string): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true })
  writeFileSync(join(cwd, path), body)
}

function commit(cwd: string, message: string): string {
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

function fixture(run: (cwd: string, base: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'oracle-refresh-'))
  try {
    git(cwd, 'init', '-q', '-b', 'main')
    write(cwd, 'src/dependency.ts', 'export const dependency = 1\n')
    write(cwd, 'src/common.ts', 'export const common = 1\n')
    write(
      cwd,
      'src/a.ts',
      "import { dependency } from './dependency.ts'\nimport { common } from './common.ts'\nexport const a = dependency + common\n",
    )
    write(cwd, 'src/b.ts', "import { common } from './common.ts'\nexport const b = common + 1\n")
    write(
      cwd,
      'src/client.ts',
      "export const client = () => window.api.read()\nexport const selector = 'client'\n",
    )
    write(cwd, 'src/preload/index.ts', 'export const contract = 1\n')
    for (const name of ['a', 'b', 'client', 'common'])
      write(cwd, `src/${name}.test.ts`, `import './${name}.ts'\n`)
    write(cwd, 'tests/e2e/client.e2e.ts', "import '../../src/client.ts'\n$('#client')\n")
    write(cwd, 'tests/e2e/a.e2e.ts', "import '../../src/a.ts'\n$('#a')\n")
    write(cwd, 'tests/e2e/b.e2e.ts', "import '../../src/b.ts'\n$('#b')\n")
    run(cwd, commit(cwd, 'initial base'))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function candidates(
  cwd: string,
  base: string,
  ownChange: () => void,
  baseChange: () => void,
): {
  testedBase: string
  testedCandidate: string
  testedPrHead: string
  prHead: string
  base: string
  candidate: string
} {
  git(cwd, 'checkout', '-qb', 'pr')
  ownChange()
  const prHead = commit(cwd, 'PR changes')
  git(cwd, 'checkout', '-qb', 'tested', base)
  git(cwd, 'merge', '--no-ff', '-qm', 'previous candidate', prHead)
  const testedCandidate = git(cwd, 'rev-parse', 'HEAD')
  git(cwd, 'checkout', '-q', 'main')
  baseChange()
  const currentBase = commit(cwd, 'base changes')
  git(cwd, 'checkout', '-qb', 'candidate')
  git(cwd, 'merge', '--no-ff', '-qm', 'fresh candidate', prHead)
  return {
    testedBase: base,
    testedCandidate,
    testedPrHead: prHead,
    prHead,
    base: currentBase,
    candidate: 'HEAD',
  }
}

function refresh(cwd: string, refs: ReturnType<typeof candidates>): z.infer<typeof refreshSchema> {
  const result = spawnSync(
    process.execPath,
    [
      ORACLE,
      '--refresh',
      '--json',
      '--tested-base',
      refs.testedBase,
      '--tested-candidate',
      refs.testedCandidate,
      '--tested-pr-head',
      refs.testedPrHead,
      '--base',
      refs.base,
      '--pr-head',
      refs.prHead,
      '--candidate',
      refs.candidate,
    ],
    { cwd, encoding: 'utf8' },
  )
  assert.equal(result.error, undefined)
  const plan = safeJsonParse(result.stdout, decodeWithSchema(refreshSchema))
  assert.ok(plan, result.stderr || result.stdout)
  assert.equal(result.status, plan.mode === 'review' ? 2 : 0, result.stderr)
  return plan
}

describe('bounded oracle base refresh', () => {
  it('keeps independently mapped changes reusable, even with an unchanged shared dependency', () => {
    fixture((cwd, base) => {
      const refs = candidates(
        cwd,
        base,
        () => {
          write(
            cwd,
            'src/a.ts',
            "import { dependency } from './dependency.ts'\nimport { common } from './common.ts'\nexport const a = dependency + common + 2\n",
          )
        },
        () => {
          write(
            cwd,
            'src/b.ts',
            "import { common } from './common.ts'\nexport const b = common + 2\n",
          )
        },
      )
      const plan = refresh(cwd, refs)
      assert.equal(plan.mode, 'skip')
      assert.deepEqual(plan.areas.overlap, [])
      assert.deepEqual(plan.unitSpecs, [])
      assert.deepEqual(plan.e2eSpecs, [])
    })
  })

  it('does not spread a broad IPC base change into an unrelated PR', () => {
    fixture((cwd, base) => {
      const refs = candidates(
        cwd,
        base,
        () => {
          write(cwd, 'src/b.ts', 'export const b = 3\n')
        },
        () => {
          write(cwd, 'src/preload/index.ts', 'export const contract = 2\n')
        },
      )
      const ordinary = execFileSync(
        process.execPath,
        [ORACLE, '--plan', '--base', refs.testedBase],
        { cwd, encoding: 'utf8' },
      )
      assert.match(ordinary, /^mode=full$/m)
      assert.equal(refresh(cwd, refs).mode, 'skip')
    })
  })

  it('refreshes IPC consumers across different files with explicit bounded lists', () => {
    fixture((cwd, base) => {
      const refs = candidates(
        cwd,
        base,
        () => {
          write(
            cwd,
            'src/client.ts',
            "export const client = () => window.api.read(2)\nexport const selector = 'client'\n",
          )
        },
        () => {
          write(cwd, 'src/preload/index.ts', 'export const contract = 2\n')
        },
      )
      const plan = refresh(cwd, refs)
      assert.equal(plan.mode, 'subset')
      assert.ok(plan.areas.overlap.includes('contract:ipc'))
      assert.deepEqual(plan.unitSpecs, ['src/client.test.ts'])
      assert.deepEqual(plan.e2eSpecs, ['tests/e2e/client.e2e.ts'])
      assert.equal(plan.refs?.base, refs.base)
      assert.equal(plan.candidateTree, git(cwd, 'rev-parse', 'HEAD^{tree}'))
    })
  })

  it('retains old dependency edges and deleted paths in refresh selection', () => {
    fixture((cwd, base) => {
      const refs = candidates(
        cwd,
        base,
        () => {
          write(
            cwd,
            'src/a.ts',
            "import { dependency } from './dependency.ts'\nexport const a = dependency + 2\n",
          )
        },
        () => {
          rmSync(join(cwd, 'src/dependency.ts'))
        },
      )
      const plan = refresh(cwd, refs)
      assert.equal(plan.mode, 'subset')
      assert.deepEqual(plan.changes.base, ['src/dependency.ts'])
      assert.ok(plan.areas.overlap.includes('file:src/dependency.ts'))
      assert.ok(plan.unitSpecs.includes('src/a.test.ts'))
      const ordinary = execFileSync(
        process.execPath,
        [ORACLE, '--json', '--base', refs.testedBase],
        { cwd, encoding: 'utf8' },
      )
      const parsed = safeJsonParse(
        ordinary,
        decodeWithSchema(z.object({ changed: z.array(z.string()) })),
      )
      assert.ok(parsed?.changed.includes('src/dependency.ts'))
    })
  })

  it('includes IPC contracts reached through a mapped consumer of a pure leaf', () => {
    fixture((cwd) => {
      write(
        cwd,
        'src/client.ts',
        "import { b } from './b.ts'\nexport const client = () => window.api.read(b)\n",
      )
      const base = commit(cwd, 'IPC consumer of pure leaf')
      const refs = candidates(
        cwd,
        base,
        () => {
          write(cwd, 'src/b.ts', 'export const b = 3\n')
        },
        () => {
          write(cwd, 'src/preload/index.ts', 'export const contract = 2\n')
        },
      )
      const plan = refresh(cwd, refs)
      assert.equal(plan.mode, 'subset')
      assert.ok(plan.areas.overlap.includes('contract:ipc'))
      assert.ok(plan.unitSpecs.includes('src/client.test.ts'))
      assert.ok(plan.e2eSpecs.includes('tests/e2e/client.e2e.ts'))
    })
  })

  it('maps a deletion already present in the validated PR without refreshing unrelated changes', () => {
    fixture((cwd, base) => {
      const refs = candidates(
        cwd,
        base,
        () => {
          rmSync(join(cwd, 'src/dependency.ts'))
          write(cwd, 'src/a.ts', 'export const a = 3\n')
        },
        () => {
          write(cwd, 'src/b.ts', 'export const b = 4\n')
        },
      )
      const plan = refresh(cwd, refs)
      assert.equal(plan.mode, 'skip')
      assert.ok(plan.changes.pr.includes('src/dependency.ts'))
      assert.deepEqual(plan.areas.overlap, [])
    })
  })

  it('preserves both paths of a rename and reports an unmapped new path for review', () => {
    fixture((cwd, base) => {
      const refs = candidates(
        cwd,
        base,
        () => {
          write(
            cwd,
            'src/a.ts',
            "import { dependency } from './dependency.ts'\nexport const a = dependency + 2\n",
          )
        },
        () => git(cwd, 'mv', 'src/dependency.ts', 'src/renamed.ts'),
      )
      const plan = refresh(cwd, refs)
      assert.deepEqual(plan.changes.base, ['src/dependency.ts', 'src/renamed.ts'])
      assert.equal(plan.mode, 'review')
      assert.deepEqual(plan.unitSpecs, [])
      assert.deepEqual(plan.e2eSpecs, [])
    })
  })

  it('reports global oracle changes for review without emitting a full rerun', () => {
    fixture((cwd, base) => {
      const refs = candidates(
        cwd,
        base,
        () => {
          write(cwd, 'src/b.ts', 'export const b = 3\n')
        },
        () => {
          write(
            cwd,
            'scripts/test-oracle.mts',
            'throw new Error("candidate oracle must not execute")\n',
          )
        },
      )
      const plan = refresh(cwd, refs)
      assert.equal(plan.mode, 'review')
      assert.ok(plan.reasons.some((reason) => reason.includes('scripts/test-oracle.mts')))
      assert.deepEqual(plan.unitSpecs, [])
      assert.deepEqual(plan.e2eSpecs, [])
    })
  })

  it('refuses a whole-tier selection even if it fits within the numeric limits', () => {
    fixture((cwd) => {
      for (const name of ['a', 'b', 'common']) rmSync(join(cwd, `src/${name}.test.ts`))
      const oneUnitBase = commit(cwd, 'one unit test baseline')
      const refs = candidates(
        cwd,
        oneUnitBase,
        () => {
          write(cwd, 'src/client.ts', 'export const client = () => window.api.read(2)\n')
        },
        () => {
          write(cwd, 'src/preload/index.ts', 'export const contract = 2\n')
        },
      )
      const plan = refresh(cwd, refs)
      assert.equal(plan.mode, 'review')
      assert.ok(plan.reasons.some((reason) => reason.includes('whole-tier')))
      assert.deepEqual(plan.unitSpecs, [])
      assert.deepEqual(plan.e2eSpecs, [])
    })
  })

  it('reports missing or stale candidates for review rather than producing an empty pass', () => {
    fixture((cwd, base) => {
      const refs = candidates(
        cwd,
        base,
        () => {
          write(cwd, 'src/client.ts', 'export const client = () => window.api.read(2)\n')
        },
        () => {
          write(cwd, 'src/preload/index.ts', 'export const contract = 2\n')
        },
      )
      assert.equal(refresh(cwd, { ...refs, candidate: refs.testedCandidate }).mode, 'review')
      assert.equal(refresh(cwd, { ...refs, testedBase: 'missing-ref' }).mode, 'review')
      assert.equal(refresh(cwd, { ...refs, testedCandidate: refs.testedBase }).mode, 'review')
    })
  })

  it('does not spread a LOW-confidence base execution plan into an unrelated mapped PR', () => {
    fixture((cwd) => {
      rmSync(join(cwd, 'tests/e2e/b.e2e.ts'))
      const base = commit(cwd, 'backend unit mapping without E2E selectors')
      const refs = candidates(
        cwd,
        base,
        () => {
          write(
            cwd,
            'src/a.ts',
            "import { dependency } from './dependency.ts'\nexport const a = dependency + 2\n",
          )
        },
        () => {
          write(
            cwd,
            'src/b.ts',
            "import { common } from './common.ts'\nexport const b = common + 3\n",
          )
        },
      )
      const output = execFileSync(process.execPath, [ORACLE, '--plan', '--files', 'src/b.ts'], {
        cwd,
        encoding: 'utf8',
      })
      assert.match(output, /^mode=full$/m)
      assert.equal(refresh(cwd, refs).mode, 'skip')
    })
  })

  it('reports an over-limit interaction without emitting any runnable lists', () => {
    fixture((cwd) => {
      for (let i = 0; i < 65; i++)
        write(cwd, `src/ipc-${String(i)}.test.ts`, "import './client.ts'\n")
      const base = commit(cwd, 'many IPC consumers')
      const refs = candidates(
        cwd,
        base,
        () => {
          write(cwd, 'src/client.ts', 'export const client = () => window.api.read(2)\n')
        },
        () => {
          write(cwd, 'src/preload/index.ts', 'export const contract = 2\n')
        },
      )
      const plan = refresh(cwd, refs)
      assert.equal(plan.mode, 'review')
      assert.ok(plan.reasons.some((reason) => reason.includes('unbounded')))
      assert.deepEqual(plan.unitSpecs, [])
      assert.deepEqual(plan.e2eSpecs, [])
    })
  })

  it('honors CI E2E exclusions in the explicit refresh list', () => {
    fixture((cwd) => {
      write(cwd, 'wdio.ci.conf.ts', "export default { exclude: ['./tests/e2e/client.e2e.ts'] }\n")
      const base = commit(cwd, 'CI E2E exclusion')
      const refs = candidates(
        cwd,
        base,
        () => {
          write(cwd, 'src/client.ts', 'export const client = () => window.api.read(2)\n')
        },
        () => {
          write(cwd, 'src/preload/index.ts', 'export const contract = 2\n')
        },
      )
      const plan = refresh(cwd, refs)
      assert.equal(plan.mode, 'subset')
      assert.deepEqual(plan.unitSpecs, ['src/client.test.ts'])
      assert.deepEqual(plan.e2eSpecs, [])
    })
  })

  it('ignores dirty working-tree inputs and rejects changed source-head evidence', () => {
    fixture((cwd, base) => {
      const refs = candidates(
        cwd,
        base,
        () => {
          write(cwd, 'src/client.ts', 'export const client = () => window.api.read(2)\n')
        },
        () => {
          write(cwd, 'src/preload/index.ts', 'export const contract = 2\n')
        },
      )
      write(cwd, 'src/client.ts', 'uncommitted unrelated source\n')
      assert.equal(refresh(cwd, refs).mode, 'subset')
      const changedHead = commit(cwd, 'source changed after prior validation')
      assert.equal(refresh(cwd, { ...refs, prHead: changedHead }).mode, 'review')
    })
  })

  it('rejects a rewound source even when both candidates contain its ancestor', () => {
    fixture((cwd, base) => {
      git(cwd, 'checkout', '-qb', 'source')
      write(cwd, 'src/client.ts', 'export const client = () => window.api.read(2)\n')
      const rewoundHead = commit(cwd, 'earlier PR source')
      const refs = candidates(
        cwd,
        base,
        () => {
          write(cwd, 'src/client.ts', 'export const client = () => window.api.read(3)\n')
        },
        () => {
          write(cwd, 'src/preload/index.ts', 'export const contract = 2\n')
        },
      )
      assert.equal(refresh(cwd, refs).mode, 'subset')
      // Ancestry succeeds for the rewind on both combined commits, but the
      // validation belongs to the later source and cannot be reused.
      git(cwd, 'merge-base', '--is-ancestor', rewoundHead, refs.testedCandidate)
      git(cwd, 'merge-base', '--is-ancestor', rewoundHead, 'HEAD')
      const plan = refresh(cwd, { ...refs, prHead: rewoundHead })
      assert.equal(plan.mode, 'review')
      assert.ok(plan.reasons.some((reason) => reason.includes('Source head differs')))
      assert.deepEqual(plan.unitSpecs, [])
      assert.deepEqual(plan.e2eSpecs, [])
    })
  })

  it('reports unmapped runtime inputs instead of declaring independence', () => {
    fixture((cwd, base) => {
      const refs = candidates(
        cwd,
        base,
        () => {
          write(cwd, 'src/b.ts', 'export const b = 3\n')
        },
        () => {
          write(cwd, 'src/runtime-fixture.json', '{"value":2}\n')
        },
      )
      const plan = refresh(cwd, refs)
      assert.equal(plan.mode, 'review')
      assert.ok(plan.reasons.some((reason) => reason.includes('src/runtime-fixture.json')))
      assert.deepEqual(plan.unitSpecs, [])
      assert.deepEqual(plan.e2eSpecs, [])
    })
  })

  it('emits separate CI keys and rejects --run to prevent full-suite runner fallbacks', () => {
    fixture((cwd, base) => {
      const refs = candidates(
        cwd,
        base,
        () => {
          write(cwd, 'src/client.ts', 'export const client = () => window.api.read(2)\n')
        },
        () => {
          write(cwd, 'src/preload/index.ts', 'export const contract = 2\n')
        },
      )
      const args = [
        ORACLE,
        '--refresh',
        '--tested-base',
        refs.testedBase,
        '--tested-candidate',
        refs.testedCandidate,
        '--tested-pr-head',
        refs.testedPrHead,
        '--pr-head',
        refs.prHead,
        '--base',
        refs.base,
      ]
      const output = execFileSync(process.execPath, [...args, '--plan'], { cwd, encoding: 'utf8' })
      assert.match(output, /^refresh_mode=subset$/m)
      assert.doesNotMatch(output, /^mode=|=full$/m)
      const rejected = spawnSync(process.execPath, [...args, '--run', 'all'], {
        cwd,
        encoding: 'utf8',
      })
      assert.equal(rejected.status, 1)
      assert.match(rejected.stderr, /--run\/--files\/--list-ci-specs are not supported/)
      for (const mode of [
        ['--ci-shard', '1/8'],
        ['--specs', 'tests/e2e/smoke.e2e.ts'],
      ]) {
        const mixed = spawnSync(process.execPath, [...args, ...mode], { cwd, encoding: 'utf8' })
        assert.equal(mixed.status, 1)
        assert.equal(mixed.stdout, '')
        assert.match(mixed.stderr, /--ci-shard\/--specs are not supported/)
      }
    })
  })
})

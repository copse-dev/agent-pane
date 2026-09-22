import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  collectE2eExclusions,
  exclusionRegistrySchema,
  validateExclusionRegistry,
  type ExclusionRegistry,
} from './e2e-exclusions.mts'

const spec = 'tests/e2e/example.e2e.ts'
const marker = 'describeSkipInCi: approval'

function registry(): ExclusionRegistry {
  return {
    version: 1,
    entries: [
      {
        spec,
        category: 'quarantine',
        reason: 'Session ends during approval',
        tracker: 'https://github.com/copse-dev/agent-pane/issues/1680',
        ownerRole: 'Runtime maintainer',
        recordedOn: '2026-09-20',
        reviewBy: '2026-09-27',
        coverage: 'Policy tests are not equivalent runtime evidence',
        markers: [marker],
      },
    ],
  }
}

describe('collectE2eExclusions', () => {
  it('detects shorthand and literal computed exclude properties', () => {
    for (const property of ['exclude', "['exclude']: exclude"]) {
      assert.deepEqual(
        collectE2eExclusions(
          new Map([
            [
              'wdio.conf.ts',
              `const exclude = ['./${spec}']; export const config = { ${property} }`,
            ],
          ]),
        ),
        [{ spec, marker: 'wdio.conf.ts: exclude' }],
      )
    }
  })

  it('resolves literal and named/spread config exclusions without duplicating the inherited base', () => {
    const sources = new Map([
      ['wdio.conf.ts', `export const config = { exclude: ['./${spec}'] }`],
      [
        'wdio.ci.conf.ts',
        `
        import { config as baseConfig } from './wdio.conf.ts'
        const first = ['./tests/e2e/second.e2e.ts'] as const
        const extra = [...first, './${spec}'] satisfies string[]
        export const config = { ...baseConfig, exclude: [...(baseConfig.exclude ?? []), ...extra] }
      `,
      ],
    ])
    assert.deepEqual(collectE2eExclusions(sources), [
      { spec, marker: 'wdio.ci.conf.ts: exclude' },
      { spec, marker: 'wdio.conf.ts: exclude' },
      { spec: 'tests/e2e/second.e2e.ts', marker: 'wdio.ci.conf.ts: exclude' },
    ])
  })

  it('rejects broad or unresolved config exclusions instead of silently undercounting', () => {
    for (const expression of ["['./tests/e2e/*.e2e.ts']", 'getExclusions()', 'unknown', 'first']) {
      assert.throws(
        () =>
          collectE2eExclusions(
            new Map([
              [
                'wdio.ci.conf.ts',
                `const first = second; const second = first; export const config = { exclude: ${expression} }`,
              ],
            ]),
          ),
        /exclude/,
      )
    }
    assert.throws(
      () =>
        collectE2eExclusions(
          new Map([
            [
              'wdio.ci.conf.ts',
              'export const config = { exclude: [...(missingConfig.exclude ?? [])] }',
            ],
          ]),
        ),
      /unsupported exclude expression/,
    )
  })

  it('rejects mutations and escaped references to exclusion arrays', () => {
    for (const mutation of [
      `ciExclude.push('./${spec}')`,
      `ciExclude?.push('./${spec}')`,
      `ciExclude.unshift('./${spec}')`,
      `ciExclude.splice(0, 0, './${spec}')`,
      `ciExclude[0] = './${spec}'`,
      `ciExclude = ['./${spec}']`,
      `const alias = ciExclude; alias.push('./${spec}')`,
      `addExclusion(ciExclude)`,
      `config.exclude?.push('./${spec}')`,
      `config['exclude'] = ['./${spec}']`,
      `const { exclude } = config; exclude.push('./${spec}')`,
    ]) {
      assert.throws(
        () =>
          collectE2eExclusions(
            new Map([
              [
                'wdio.ci.conf.ts',
                `let ciExclude = []; ${mutation}; export const config = { exclude: ciExclude }`,
              ],
            ]),
          ),
        /exclude lists must be declared statically/,
        mutation,
      )
    }
  })

  it('rejects mutation through a binding used by a spread and an inherited config', () => {
    for (const mutation of [
      `first.push('./${spec}')`,
      `extra.push('./${spec}')`,
      `baseConfig.exclude?.push('./${spec}')`,
      `const alias = baseConfig.exclude; alias?.push('./${spec}')`,
    ]) {
      assert.throws(
        () =>
          collectE2eExclusions(
            new Map([
              ['wdio.conf.ts', 'export const config = { exclude: [] }'],
              [
                'wdio.ci.conf.ts',
                `import { config as baseConfig } from './wdio.conf.ts'
                 const first = []; const extra = [...first]
                 export const config = { exclude: [...(baseConfig.exclude ?? []), ...extra] }
                 ${mutation}`,
              ],
            ]),
          ),
        /exclude lists must be declared statically/,
        mutation,
      )
    }
  })

  it('finds helper aliases, direct skips, platform aliases and runtime skips; ignores prose', () => {
    const sources = new Map([
      [
        spec,
        `
      import { describeSkipInCi as conditional } from './helpers/ci-gate.ts'
      // describe.skip('not code', () => {})
      const note = "it.skip('not code')"
      conditional('approval', () => {})
      itSkipInCi('streaming', () => {})
      xit('pending case', () => {})
      const macOnly = process.platform === 'darwin' ? describe : describe.skip
      it['skip']('broken', () => {})
      before(function () { if (!ready) this.skip() })
    `,
      ],
    ])
    assert.deepEqual(
      collectE2eExclusions(sources).map((item) => item.marker),
      [
        'describe.skip',
        marker,
        'it.skip',
        'itSkipInCi: streaming',
        'this.skip',
        'xit: pending case',
      ],
    )
  })

  it('requires a stable title for CI skip helpers', () => {
    assert.throws(
      () => collectE2eExclusions(new Map([[spec, 'describeSkipInCi(title, () => {})']])),
      /literal title/,
    )
  })
})

describe('validateExclusionRegistry', () => {
  it('accepts matching evidence markers regardless of ordering and reports review due dates separately', () => {
    const valid = registry()
    const actual = [{ spec, marker }]
    assert.deepEqual(validateExclusionRegistry(valid, actual, new Set([spec]), '2026-09-26'), {
      errors: [],
      due: [],
    })
    assert.deepEqual(validateExclusionRegistry(valid, actual, new Set([spec]), '2026-09-27'), {
      errors: [],
      due: [spec],
    })
    assert.deepEqual(validateExclusionRegistry(valid, actual, new Set([spec]), '2026-10-01'), {
      errors: [],
      due: [spec],
    })
    const entry = valid.entries[0]
    assert.ok(entry)
    entry.markers.push('wdio.ci.conf.ts: exclude')
    assert.deepEqual(
      validateExclusionRegistry(
        valid,
        [{ spec, marker: 'wdio.ci.conf.ts: exclude' }, ...actual],
        new Set([spec]),
        '2026-09-26',
      ),
      { errors: [], due: [] },
    )
  })

  it('fails unrecorded specs and additional, removed or changed skip markers in an existing spec', () => {
    const valid = registry()
    for (const actual of [
      [],
      [{ spec, marker: 'describeSkipInCi: different journey' }],
      [
        { spec, marker },
        { spec, marker: 'this.skip' },
      ],
      [
        { spec, marker },
        { spec, marker },
      ],
    ]) {
      assert.ok(
        validateExclusionRegistry(valid, actual, new Set([spec]), '2026-09-20').errors.some(
          (error) => error.includes('changed or removed'),
        ),
      )
    }
    assert.deepEqual(
      validateExclusionRegistry(
        { version: 1, entries: [] },
        [{ spec, marker }],
        new Set([spec]),
        '2026-09-20',
      ).errors,
      [`Unrecorded exclusion: ${spec}`],
    )
  })

  it('fails duplicate entries, missing source files, and review deadlines before the inventory date', () => {
    const valid = registry()
    const entry = valid.entries[0]
    assert.ok(entry)
    valid.entries.push({ ...entry, reviewBy: '2026-09-19' })
    const result = validateExclusionRegistry(valid, [{ spec, marker }], new Set(), '2026-09-20')
    assert.ok(result.errors.includes(`Duplicate registry entry: ${spec}`))
    assert.ok(result.errors.includes(`Missing spec: ${spec}`))
    assert.ok(result.errors.includes(`Review date precedes inventory date: ${spec}`))
  })

  it('rejects incomplete metadata, invalid dates, and unknown fields in the registry', () => {
    const valid = registry()
    assert.ok(exclusionRegistrySchema.safeParse(valid).success)
    for (const patch of [
      { ownerRole: '' },
      { tracker: 'not-an-issue' },
      { reviewBy: '2026-02-30' },
      { markers: [] },
      { reason: '' },
      { coverage: '' },
      { accepted: true },
    ]) {
      assert.equal(
        exclusionRegistrySchema.safeParse({
          version: 1,
          entries: [{ ...valid.entries[0], ...patch }],
        }).success,
        false,
      )
    }
  })
})

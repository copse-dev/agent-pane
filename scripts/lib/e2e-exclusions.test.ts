import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  collectE2eExclusions,
  exclusionCheckFails,
  exclusionRegistrySchema,
  LAST_VERIFIED_WARN_DAYS,
  QUARANTINE_MARKER,
  validateExclusionRegistry,
  type ExclusionRegistry,
} from './e2e-exclusions.mts'

const spec = 'tests/e2e/example.e2e.ts'
const marker = 'describeSkipInCi: approval'

const quarantined = 'tests/e2e/flaky.e2e.ts'
const evidence = 'https://github.com/copse-dev/agent-pane/actions/runs/1'

function registry(): ExclusionRegistry {
  return {
    version: 2,
    entries: [
      {
        spec,
        category: 'platform',
        reason: 'macOS-only approval journey',
        tracker: 'https://github.com/copse-dev/agent-pane/issues/1680',
        ownerRole: 'Runtime maintainer',
        recordedOn: '2026-09-20',
        coverage: 'Policy tests are not equivalent runtime evidence',
        markers: [marker],
        lastVerified: { on: '2026-09-20', evidence },
      },
      {
        spec: quarantined,
        category: 'quarantine',
        reason: 'Failed then passed on the same SHA',
        tracker: 'https://github.com/copse-dev/agent-pane/issues/2719',
        ownerRole: 'Renderer maintainer',
        owner: 'octocat',
        recordedOn: '2026-09-20',
        reviewBy: '2026-09-27',
        coverage: 'No equivalent runtime evidence',
        markers: [QUARANTINE_MARKER],
      },
    ],
  }
}

const actual = [
  { spec, marker },
  { spec: quarantined, marker: QUARANTINE_MARKER },
]
const sources = new Set([spec, quarantined])

type Entry = ExclusionRegistry['entries'][number]

function entries(value: ExclusionRegistry): {
  standing: Extract<Entry, { lastVerified: unknown }>
  quarantine: Extract<Entry, { category: 'quarantine' }>
} {
  const [standing, quarantine] = value.entries
  assert.ok(standing?.category === 'platform')
  assert.ok(quarantine?.category === 'quarantine')
  return { standing, quarantine }
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
  it('accepts matching markers regardless of ordering', () => {
    const valid = registry()
    assert.deepEqual(
      validateExclusionRegistry(valid, [...actual].reverse(), sources, '2026-09-26'),
      { errors: [], quarantine: [], stale: [] },
    )
    entries(valid).standing.markers.push('wdio.ci.conf.ts: exclude')
    assert.deepEqual(
      validateExclusionRegistry(
        valid,
        [{ spec, marker: 'wdio.ci.conf.ts: exclude' }, ...actual],
        sources,
        '2026-09-26',
      ).errors,
      [],
    )
  })

  it('fails unrecorded specs and additional, removed or changed skip markers in an existing spec', () => {
    const valid = registry()
    const other = { spec: quarantined, marker: QUARANTINE_MARKER }
    for (const markers of [
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
        validateExclusionRegistry(valid, [...markers, other], sources, '2026-09-20').errors.some(
          (error) => error.includes('changed or removed'),
        ),
      )
    }
    assert.deepEqual(
      validateExclusionRegistry(
        { version: 2, entries: [] },
        [{ spec, marker }],
        new Set([spec]),
        '2026-09-20',
      ).errors,
      [`Unrecorded exclusion: ${spec}`],
    )
  })

  it('fails duplicate entries, missing source files and future inventory dates', () => {
    const valid = registry()
    const { standing } = entries(valid)
    valid.entries.push({ ...standing })
    const result = validateExclusionRegistry(valid, actual, new Set([quarantined]), '2026-09-19')
    assert.ok(result.errors.includes(`Duplicate registry entry: ${spec}`))
    assert.ok(result.errors.includes(`Missing spec: ${spec}`))
    assert.ok(result.errors.includes(`Inventory date is in the future: ${spec}`))
  })

  describe('quarantine', () => {
    it('reports an expired deadline as a quarantine problem, not an error', () => {
      for (const today of ['2026-09-27', '2026-10-01']) {
        assert.deepEqual(validateExclusionRegistry(registry(), actual, sources, today), {
          errors: [],
          quarantine: [`Quarantine expired on 2026-09-27: ${quarantined}`],
          stale: [],
        })
      }
    })

    it('reports a missing named owner as a quarantine problem', () => {
      const valid = registry()
      entries(valid).quarantine.owner = null
      assert.deepEqual(validateExclusionRegistry(valid, actual, sources, '2026-09-21').quarantine, [
        `Quarantine has no named owner: ${quarantined}`,
      ])
    })

    it('rejects a review deadline more than 14 days after recording, or before it', () => {
      for (const [reviewBy, error] of [
        ['2026-10-05', 'Quarantine review must be within 14 days of recording'],
        ['2026-09-19', 'Review date precedes inventory date'],
      ] as const) {
        const valid = registry()
        entries(valid).quarantine.reviewBy = reviewBy
        assert.deepEqual(validateExclusionRegistry(valid, actual, sources, '2026-09-21').errors, [
          `${error}: ${quarantined}`,
        ])
      }
      const valid = registry()
      entries(valid).quarantine.reviewBy = '2026-10-04'
      assert.deepEqual(validateExclusionRegistry(valid, actual, sources, '2026-09-21').errors, [])
    })

    it('requires exactly the CI config exclusion, never an in-spec skip', () => {
      for (const markers of [['this.skip'], [QUARANTINE_MARKER, 'wdio.conf.ts: exclude']]) {
        const valid = registry()
        entries(valid).quarantine.markers = markers
        const found = markers.map((item) => ({ spec: quarantined, marker: item }))
        assert.deepEqual(
          validateExclusionRegistry(valid, [{ spec, marker }, ...found], sources, '2026-09-21')
            .errors,
          [
            `Quarantine must be exactly one ${QUARANTINE_MARKER} entry, not an in-spec skip: ${quarantined}`,
          ],
        )
      }
    })

    it('moves the deadline with one renewal that has a new reason and its own 14-day window', () => {
      const valid = registry()
      const { quarantine } = entries(valid)
      quarantine.renewal = {
        renewedOn: '2026-09-27',
        reason: 'Root cause found in workspace teardown; fix in review',
        reviewBy: '2026-10-11',
      }
      assert.deepEqual(validateExclusionRegistry(valid, actual, sources, '2026-10-10'), {
        errors: [],
        quarantine: [],
        stale: [],
      })
      assert.deepEqual(validateExclusionRegistry(valid, actual, sources, '2026-10-11').quarantine, [
        `Quarantine expired on 2026-10-11: ${quarantined}`,
      ])
    })

    it('rejects a renewal that reuses the reason, overruns 14 days, or is misdated', () => {
      const cases = [
        [
          {
            renewedOn: '2026-09-27',
            reason: ' Failed then passed on the same SHA ',
            reviewBy: '2026-10-01',
          },
          ['Renewal needs a new reason'],
        ],
        [
          { renewedOn: '2026-09-27', reason: 'New cause', reviewBy: '2026-10-12' },
          ['Renewed review must be 1-14 days after renewal'],
        ],
        [
          { renewedOn: '2026-09-27', reason: 'New cause', reviewBy: '2026-09-27' },
          ['Renewed review must be 1-14 days after renewal'],
        ],
        [
          { renewedOn: '2026-09-19', reason: 'New cause', reviewBy: '2026-09-30' },
          ['Renewal precedes inventory date'],
        ],
        [
          { renewedOn: '2026-10-02', reason: 'New cause', reviewBy: '2026-10-05' },
          ['Renewal date is in the future'],
        ],
      ] as const
      for (const [renewal, errors] of cases) {
        const valid = registry()
        entries(valid).quarantine.renewal = { ...renewal }
        assert.deepEqual(
          validateExclusionRegistry(valid, actual, sources, '2026-10-01').errors,
          errors.map((error) => `${error}: ${quarantined}`),
        )
      }
    })

    it('cannot represent a second renewal or an owner that is a role', () => {
      const { quarantine } = entries(registry())
      for (const patch of [
        { renewal: [{ renewedOn: '2026-09-27', reason: 'a', reviewBy: '2026-10-01' }] },
        { owner: 'Renderer maintainer (person assignment pending)' },
        { owner: undefined },
        { lastVerified: null },
      ]) {
        assert.equal(
          exclusionRegistrySchema.safeParse({ version: 2, entries: [{ ...quarantine, ...patch }] })
            .success,
          false,
          JSON.stringify(patch),
        )
      }
    })
  })

  describe('platform, external-service and environment', () => {
    it('never expire, but warn when no real pass is recorded', () => {
      const valid = registry()
      entries(valid).standing.lastVerified = null
      assert.deepEqual(validateExclusionRegistry(valid, actual, sources, '2026-09-21'), {
        errors: [],
        quarantine: [],
        stale: [`No real pass recorded for platform exclusion: ${spec}`],
      })
    })

    it(`warn when the last real pass is older than ${String(LAST_VERIFIED_WARN_DAYS)} days`, () => {
      const valid = registry()
      const { standing } = entries(valid)
      standing.lastVerified = { on: '2026-07-01', evidence }
      // 2026-07-01 + 90 days = 2026-09-29.
      assert.deepEqual(validateExclusionRegistry(valid, actual, sources, '2026-09-26').stale, [])
      assert.deepEqual(validateExclusionRegistry(valid, actual, sources, '2026-09-29').stale, [])
      assert.deepEqual(validateExclusionRegistry(valid, actual, sources, '2026-09-30').stale, [
        `Last real pass 2026-07-01 is older than 90 days: ${spec}`,
      ])
      standing.lastVerified = { on: '2026-09-27', evidence }
      assert.deepEqual(validateExclusionRegistry(valid, actual, sources, '2026-09-26').errors, [
        `Last-verified date is in the future: ${spec}`,
      ])
    })

    it('reject a review deadline, an owner, or evidence outside this repository', () => {
      const { standing } = entries(registry())
      for (const patch of [
        { reviewBy: '2026-09-27' },
        { owner: 'octocat' },
        { lastVerified: undefined },
        { lastVerified: { on: '2026-09-20', evidence: 'https://example.com/run' } },
        { lastVerified: { on: '2026-09-20' } },
        { category: 'flaky' },
      ]) {
        assert.equal(
          exclusionRegistrySchema.safeParse({ version: 2, entries: [{ ...standing, ...patch }] })
            .success,
          false,
          JSON.stringify(patch),
        )
      }
    })
  })

  it('rejects incomplete metadata, invalid dates, unknown fields and the old version', () => {
    const valid = registry()
    assert.ok(exclusionRegistrySchema.safeParse(valid).success)
    for (const entry of valid.entries) {
      for (const patch of [
        { ownerRole: '' },
        { tracker: 'not-an-issue' },
        { recordedOn: '2026-02-30' },
        { markers: [] },
        { reason: ' ' },
        { coverage: '' },
        { accepted: true },
      ]) {
        assert.equal(
          exclusionRegistrySchema.safeParse({ version: 2, entries: [{ ...entry, ...patch }] })
            .success,
          false,
          JSON.stringify(patch),
        )
      }
    }
    assert.equal(exclusionRegistrySchema.safeParse({ ...valid, version: 1 }).success, false)
  })
})

describe('exclusionCheckFails', () => {
  const clean = { errors: [], quarantine: [], stale: [] }
  it('warns on quarantine problems by default and fails on them when enforcing', () => {
    const expired = { ...clean, quarantine: ['Quarantine expired'] }
    assert.equal(exclusionCheckFails(expired, 'warn'), false)
    assert.equal(exclusionCheckFails(expired, 'enforce'), true)
  })

  it('always fails on errors and never on stale verification alone', () => {
    for (const mode of ['warn', 'enforce'] as const) {
      assert.equal(exclusionCheckFails({ ...clean, errors: ['bad'] }, mode), true)
      assert.equal(exclusionCheckFails({ ...clean, stale: ['old'] }, mode), false)
      assert.equal(exclusionCheckFails(clean, mode), false)
    }
  })
})

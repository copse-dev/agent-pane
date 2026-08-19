import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import {
  decodePackument,
  evaluateWatch,
  fetchPackument,
  formatReport,
  parseSemver,
  rangeMajor,
  readPinnedRange,
  SDK_PACKAGE,
  type Packument,
} from './acp-v2-watch.mts'

/** Today's shape: one dist-tag, a 1.x line, no v2 anywhere. */
const V1_ONLY: Packument = {
  distTags: { latest: '1.3.0' },
  versions: ['0.29.0', '1.0.0', '1.2.1', '1.3.0'],
  modified: '2026-07-21T15:49:38.613Z',
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('evaluateWatch', () => {
  it('stays quiet while the registry only carries the v1 line', () => {
    const verdict = evaluateWatch(V1_ONLY, '^1.3.0')
    assert.equal(verdict.status, 'v1-only')
    assert.deepEqual(verdict.signals, [])
    assert.equal(verdict.latest, '1.3.0')
  })

  it('flags a major >= 2 release, because 1.x is the protocol-v1 line', () => {
    const verdict = evaluateWatch(
      { ...V1_ONLY, versions: [...V1_ONLY.versions, '2.0.0'] },
      '^1.3.0',
    )
    assert.equal(verdict.status, 'v2-candidate')
    assert.deepEqual(
      verdict.signals.map((s) => [s.kind, s.name]),
      [['version', '2.0.0']],
    )
  })

  it('flags a v2 prerelease and says so, since that is how v2 ships first', () => {
    const verdict = evaluateWatch(
      { ...V1_ONLY, versions: [...V1_ONLY.versions, '2.0.0-alpha.1'] },
      '^1.3.0',
    )
    assert.equal(verdict.status, 'v2-candidate')
    assert.match(verdict.signals[0]?.why ?? '', /prerelease alpha\.1/)
  })

  it('flags a dist-tag beyond `latest` even when it points at a 1.x build', () => {
    // An unstable-v2 build published on a `next` channel can carry v2 types
    // without a major bump — the tag itself is the signal.
    const verdict = evaluateWatch(
      { ...V1_ONLY, distTags: { latest: '1.3.0', next: '1.4.0-next.0' } },
      '^1.3.0',
    )
    assert.equal(verdict.status, 'v2-candidate')
    assert.deepEqual(
      verdict.signals.map((s) => [s.kind, s.name, s.target]),
      [['dist-tag', 'next', '1.4.0-next.0']],
    )
  })

  it('flags a package.json bumped past the v1 line', () => {
    // The registry is clean here: the alarm is that *we* moved, which means the
    // v1 adapters in src/main/services/acp are running against a v2 SDK.
    const verdict = evaluateWatch(V1_ONLY, '^2.0.0')
    assert.equal(verdict.status, 'v2-candidate')
    assert.deepEqual(
      verdict.signals.map((s) => s.kind),
      ['pin'],
    )
  })

  it('reports an acknowledged candidate without going red for it again', () => {
    // A triaged release the migration has not caught up with yet must not turn
    // the nightly red every night — it stays in the report, marked reviewed.
    const packument = { ...V1_ONLY, versions: [...V1_ONLY.versions, '2.0.0'] }
    const verdict = evaluateWatch(packument, '^1.3.0', ['2.0.0'])
    assert.equal(verdict.status, 'reviewed')
    assert.deepEqual(
      verdict.signals.map((s) => [s.name, s.reviewed]),
      [['2.0.0', true]],
    )
    // ...and one unacknowledged signal is enough to bring the run back.
    assert.equal(
      evaluateWatch({ ...packument, versions: [...packument.versions, '2.1.0'] }, '^1.3.0', [
        '2.0.0',
      ]).status,
      'v2-candidate',
    )
  })

  it('ignores unparseable versions rather than reading them as v2', () => {
    const verdict = evaluateWatch({ ...V1_ONLY, versions: ['1.3.0', 'nightly'] }, '^1.3.0')
    assert.equal(verdict.status, 'v1-only')
  })
})

describe('decodePackument', () => {
  it('reads dist-tags, the version list, and the modified stamp', () => {
    const packument = decodePackument(
      JSON.stringify({
        'dist-tags': { latest: '1.3.0' },
        versions: { '1.2.1': { name: SDK_PACKAGE }, '1.3.0': { name: SDK_PACKAGE } },
        modified: '2026-07-21T15:49:38.613Z',
      }),
    )
    assert.deepEqual(packument, {
      distTags: { latest: '1.3.0' },
      versions: ['1.2.1', '1.3.0'],
      modified: '2026-07-21T15:49:38.613Z',
    })
  })

  it('rejects a response that is not a usable packument', () => {
    // A registry outage that serves an HTML error page, or a body without the
    // fields the verdict is read from, must fail loudly — a silently empty
    // packument would report "v1-only" forever.
    assert.throws(() => decodePackument('<html>502</html>'), /not a JSON object/)
    assert.throws(() => decodePackument('{"dist-tags":{"latest":"1.3.0"}}'), /no versions map/)
    assert.throws(() => decodePackument('{"versions":{"1.3.0":{}}}'), /no dist-tags/)
  })
})

describe('fetchPackument', () => {
  it('requests the abbreviated packument for the scoped package', async () => {
    const calls: { url: string; accept: string }[] = []
    const packument = await fetchPackument(async (input, init) => {
      const headers = new Headers(init?.headers)
      calls.push({ url: requestUrl(input), accept: headers.get('accept') ?? '' })
      return jsonResponse({ 'dist-tags': { latest: '1.3.0' }, versions: { '1.3.0': {} } })
    })

    const [call] = calls
    assert.ok(call, 'expected the watch to reach the registry exactly once')
    assert.equal(call.url, 'https://registry.npmjs.org/@agentclientprotocol%2Fsdk')
    // The full packument is megabytes; the install-v1 form is a few KB and
    // carries everything the verdict reads.
    assert.equal(call.accept, 'application/vnd.npm.install-v1+json')
    assert.deepEqual(packument.versions, ['1.3.0'])
  })

  it('fails on a non-OK registry response instead of reporting v1-only', async () => {
    await assert.rejects(
      fetchPackument(async () => new Response('nope', { status: 503 })),
      /npm registry -> 503/,
    )
  })
})

describe('formatReport', () => {
  it('points a clean run at the readiness doc without raising an alarm', () => {
    const report = formatReport(evaluateWatch(V1_ONLY, '^1.3.0'))
    assert.match(report, /still v1-only/)
    assert.match(report, /docs\/acp-v2-readiness\.md/)
    assert.doesNotMatch(report, /Candidate v2 SDK release/)
  })

  it('says a reviewed candidate needs no new action', () => {
    const report = formatReport(
      evaluateWatch({ ...V1_ONLY, versions: [...V1_ONLY.versions, '2.0.0'] }, '^1.3.0', ['2.0.0']),
    )
    assert.match(report, /already triaged/)
    assert.doesNotMatch(report, /Candidate v2 SDK release/)
  })

  it('renders every signal and the triage-first instruction', () => {
    const report = formatReport(
      evaluateWatch({ ...V1_ONLY, versions: [...V1_ONLY.versions, '2.0.0'] }, '^1.3.0'),
    )
    assert.match(report, /Candidate v2 SDK release/)
    assert.match(report, /\| version \| `2\.0\.0` \|/)
    assert.match(report, /REVIEWED_RELEASES/)
  })
})

describe('the pinned SDK', () => {
  it('is the v1 line the ACP integration is written against', () => {
    // The offline half of the nightly watch. Copse's ACP client, session-update
    // adapter, permission bridge, and capability probe are all protocol v1
    // (docs/acp-v2-readiness.md). A bump to an SDK that negotiates v2 is a
    // migration, not a dependency bump — this test is what makes that loud.
    assert.equal(PROTOCOL_VERSION, 1)
    assert.equal(rangeMajor(readPinnedRange()), 1)
  })

  it('is the same package the watch polls', () => {
    const manifest = readFileSync(resolve('package.json'), 'utf8')
    assert.ok(manifest.includes(`"${SDK_PACKAGE}"`))
  })
})

describe('parseSemver / rangeMajor', () => {
  it('reads releases, prereleases, and build metadata', () => {
    assert.deepEqual(parseSemver('1.3.0'), { major: 1, minor: 3, patch: 0, prerelease: '' })
    assert.deepEqual(parseSemver('2.0.0-alpha.1'), {
      major: 2,
      minor: 0,
      patch: 0,
      prerelease: 'alpha.1',
    })
    assert.deepEqual(parseSemver('2.0.0+build.5'), { major: 2, minor: 0, patch: 0, prerelease: '' })
    assert.equal(parseSemver('next'), null)
  })

  it('reads the lowest major a dependency range can install', () => {
    assert.equal(rangeMajor('^1.3.0'), 1)
    assert.equal(rangeMajor('~2.0.0'), 2)
    assert.equal(rangeMajor('1.x'), 1)
    assert.equal(rangeMajor('>=2.0.0 <3'), 2)
    assert.equal(rangeMajor('latest'), null)
  })
})

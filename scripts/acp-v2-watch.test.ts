import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { PROTOCOL_VERSION as V2_PROTOCOL_VERSION } from '@agentclientprotocol/sdk/experimental/v2'
import {
  decodeManifest,
  decodePackument,
  evaluateWatch,
  fetchLatestManifest,
  fetchPackument,
  formatReport,
  parseSemver,
  rangeMajor,
  readPinnedRange,
  SDK_PACKAGE,
  type Manifest,
  type Packument,
} from './acp-v2-watch.mts'

/** Today's registry shape: one dist-tag, a 1.x line, no major >= 2. */
const PACKUMENT: Packument = {
  distTags: { latest: '1.3.0' },
  versions: ['0.29.0', '1.0.0', '1.2.1', '1.3.0'],
  modified: '2026-07-21T15:49:38.613Z',
}

/** Today's published export map: v2 exists, behind the experimental marker. */
const MANIFEST: Manifest = {
  version: '1.3.0',
  exportPaths: [
    '.',
    './experimental/v2',
    './experimental/node',
    './schema/schema.json',
    './schema/v2/schema.unstable.json',
  ],
}

const ACKNOWLEDGED_TODAY = ['export:./experimental/v2', 'export:./schema/v2/schema.unstable.json']

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('evaluateWatch', () => {
  it('stays quiet on the v2 surface already triaged', () => {
    const verdict = evaluateWatch(PACKUMENT, MANIFEST, '^1.3.0', ACKNOWLEDGED_TODAY)
    assert.equal(verdict.status, 'as-expected')
    assert.deepEqual(verdict.v2Exports, ['./experimental/v2', './schema/v2/schema.unstable.json'])
    assert.ok(verdict.signals.every((signal) => signal.acknowledged))
  })

  it('flags a v2 entry point that has left `./experimental/`', () => {
    // The real migration trigger. v2 graduating out of the experimental marker
    // is what says "this is now the supported surface" — and it needs no major
    // bump and no new dist-tag to happen.
    const verdict = evaluateWatch(
      PACKUMENT,
      { ...MANIFEST, exportPaths: [...MANIFEST.exportPaths, './v2'] },
      '^1.3.0',
      ACKNOWLEDGED_TODAY,
    )
    assert.equal(verdict.status, 'changed')
    const graduated = verdict.signals.filter((signal) => !signal.acknowledged)
    assert.deepEqual(
      graduated.map((signal) => [signal.kind, signal.name]),
      [['export', './v2']],
    )
    assert.match(graduated[0]?.why ?? '', /OUTSIDE `\.\/experimental\/`/)
  })

  it('flags a new experimental v2 subpath nobody has looked at yet', () => {
    const verdict = evaluateWatch(
      PACKUMENT,
      { ...MANIFEST, exportPaths: [...MANIFEST.exportPaths, './experimental/v2/client'] },
      '^1.3.0',
      ACKNOWLEDGED_TODAY,
    )
    assert.equal(verdict.status, 'changed')
    assert.deepEqual(
      verdict.signals.filter((signal) => !signal.acknowledged).map((signal) => signal.name),
      ['./experimental/v2/client'],
    )
  })

  it('reads a package with no v2 subpath at all as no v2 surface', () => {
    // What 1.2.1 looked like. Not a decode failure — a real answer.
    const verdict = evaluateWatch(
      PACKUMENT,
      { version: '1.2.1', exportPaths: ['.', './experimental/node'] },
      '^1.3.0',
      ACKNOWLEDGED_TODAY,
    )
    assert.equal(verdict.status, 'as-expected')
    assert.deepEqual(verdict.v2Exports, [])
  })

  it('flags a major >= 2 release, because the main entry of 1.x negotiates v1', () => {
    const verdict = evaluateWatch(
      { ...PACKUMENT, versions: [...PACKUMENT.versions, '2.0.0'] },
      MANIFEST,
      '^1.3.0',
      ACKNOWLEDGED_TODAY,
    )
    assert.equal(verdict.status, 'changed')
    assert.deepEqual(
      verdict.signals.filter((signal) => !signal.acknowledged).map((signal) => signal.name),
      ['2.0.0'],
    )
  })

  it('flags a v2 prerelease and says so', () => {
    const verdict = evaluateWatch(
      { ...PACKUMENT, versions: [...PACKUMENT.versions, '2.0.0-alpha.1'] },
      MANIFEST,
      '^1.3.0',
      ACKNOWLEDGED_TODAY,
    )
    assert.match(
      verdict.signals.find((signal) => signal.kind === 'version')?.why ?? '',
      /prerelease alpha\.1/,
    )
  })

  it('flags a dist-tag beyond `latest`', () => {
    const verdict = evaluateWatch(
      { ...PACKUMENT, distTags: { latest: '1.3.0', next: '1.4.0-next.0' } },
      MANIFEST,
      '^1.3.0',
      ACKNOWLEDGED_TODAY,
    )
    assert.equal(verdict.status, 'changed')
    assert.deepEqual(
      verdict.signals.filter((signal) => signal.kind === 'dist-tag').map((signal) => signal.name),
      ['next'],
    )
  })

  it('flags a package.json bumped past the v1 line', () => {
    // The registry is unchanged here: the alarm is that *we* moved, which means
    // the v1 adapters in src/main/services/acp are running against a v2 default.
    const verdict = evaluateWatch(PACKUMENT, MANIFEST, '^2.0.0', ACKNOWLEDGED_TODAY)
    assert.equal(verdict.status, 'changed')
    assert.deepEqual(
      verdict.signals.filter((signal) => signal.kind === 'pin').map((signal) => signal.name),
      ['^2.0.0'],
    )
  })

  it('ignores unparseable versions rather than reading them as v2', () => {
    const verdict = evaluateWatch(
      { ...PACKUMENT, versions: ['1.3.0', 'nightly'] },
      MANIFEST,
      '^1.3.0',
      ACKNOWLEDGED_TODAY,
    )
    assert.equal(verdict.status, 'as-expected')
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
    // A registry outage that serves an HTML error page, or a body missing the
    // fields the verdict reads, must fail loudly — silently empty data would
    // report "nothing changed" forever.
    assert.throws(() => decodePackument('<html>502</html>'), /not a JSON object/)
    assert.throws(() => decodePackument('{"dist-tags":{"latest":"1.3.0"}}'), /no versions map/)
    assert.throws(() => decodePackument('{"versions":{"1.3.0":{}}}'), /no dist-tags/)
  })
})

describe('decodeManifest', () => {
  it('reads the export subpaths, which is where v2 actually showed up', () => {
    const manifest = decodeManifest(
      JSON.stringify({
        version: '1.3.0',
        exports: { '.': './dist/acp.js', './experimental/v2': './dist/v2/acp.js' },
      }),
    )
    assert.deepEqual(manifest, {
      version: '1.3.0',
      exportPaths: ['.', './experimental/v2'],
    })
  })

  it('treats a package without a subpath export map as having no subpaths', () => {
    assert.deepEqual(decodeManifest('{"version":"1.0.0"}').exportPaths, [])
    assert.deepEqual(decodeManifest('{"version":"1.0.0","exports":"./index.js"}').exportPaths, [])
  })

  it('rejects a manifest with no version', () => {
    assert.throws(() => decodeManifest('{"exports":{}}'), /no version/)
  })
})

describe('registry requests', () => {
  it('asks for the abbreviated packument on the scoped path', async () => {
    const calls: { url: string; accept: string }[] = []
    const packument = await fetchPackument(async (input, init) => {
      calls.push({
        url: requestUrl(input),
        accept: new Headers(init?.headers).get('accept') ?? '',
      })
      return jsonResponse({ 'dist-tags': { latest: '1.3.0' }, versions: { '1.3.0': {} } })
    })

    const [call] = calls
    assert.ok(call, 'expected the watch to reach the registry exactly once')
    assert.equal(call.url, 'https://registry.npmjs.org/@agentclientprotocol%2Fsdk')
    // The full packument is megabytes; the install-v1 form is a few KB.
    assert.equal(call.accept, 'application/vnd.npm.install-v1+json')
    assert.deepEqual(packument.versions, ['1.3.0'])
  })

  it('asks for the `latest` manifest separately, since no packument carries `exports`', async () => {
    const calls: string[] = []
    const manifest = await fetchLatestManifest(async (input) => {
      calls.push(requestUrl(input))
      return jsonResponse({ version: '1.3.0', exports: { '.': './dist/acp.js' } })
    })

    assert.deepEqual(calls, ['https://registry.npmjs.org/@agentclientprotocol%2Fsdk/latest'])
    assert.deepEqual(manifest.exportPaths, ['.'])
  })

  it('fails on a non-OK registry response instead of reporting no change', async () => {
    await assert.rejects(
      fetchPackument(async () => new Response('nope', { status: 503 })),
      /npm registry -> 503/,
    )
    await assert.rejects(
      fetchLatestManifest(async () => new Response('nope', { status: 404 })),
      /npm registry -> 404/,
    )
  })
})

describe('formatReport', () => {
  it('names the published v2 entry points even on a quiet run', () => {
    const report = formatReport(evaluateWatch(PACKUMENT, MANIFEST, '^1.3.0', ACKNOWLEDGED_TODAY))
    assert.match(report, /v2 entry points published: `\.\/experimental\/v2`/)
    assert.match(report, /already triaged in `ACKNOWLEDGED`/)
    assert.doesNotMatch(report, /surface moved/)
  })

  it('renders every signal and the triage-first instruction when the surface moves', () => {
    const report = formatReport(
      evaluateWatch(
        PACKUMENT,
        { ...MANIFEST, exportPaths: [...MANIFEST.exportPaths, './v2'] },
        '^1.3.0',
        ACKNOWLEDGED_TODAY,
      ),
    )
    assert.match(report, /The published SDK surface moved/)
    assert.match(report, /\| export \| `\.\/v2` \| \*\*new\*\* \|/)
    assert.match(report, /ACKNOWLEDGED/)
  })
})

describe('the pinned SDK', () => {
  it('negotiates v1 from its main entry, which is what Copse is written against', () => {
    // The offline half of the nightly watch. Copse's ACP client, session-update
    // adapter, permission bridge, and capability probe are all protocol v1
    // (docs/acp-v2-readiness.md). A main entry that starts negotiating v2 is a
    // migration, not a dependency bump — this is what makes that loud.
    assert.equal(PROTOCOL_VERSION, 1)
    assert.equal(rangeMajor(readPinnedRange()), 1)
  })

  it('carries its v2 API on the experimental subpath, not the main entry', () => {
    // Since 1.3.0 the same package also publishes a protocol-v2 API. Copse does
    // not import it; pinning it here means the day it moves — graduating out of
    // `experimental/`, or changing what it negotiates — a test says so rather
    // than the adapters finding out at runtime.
    assert.equal(V2_PROTOCOL_VERSION, 2)
    assert.notEqual(PROTOCOL_VERSION, V2_PROTOCOL_VERSION)
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

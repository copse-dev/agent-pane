import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AdvisoryChecker,
  combineVerdict,
  DATADOG_MANIFEST_URLS,
  loadCachedManifest,
  manifestAdvisoryLookup,
  OSV_QUERYBATCH_URL,
  osvAdvisoryLookup,
  parseMalwareManifest,
  type AdvisoryLookup,
} from './advisories.ts'
import type { PackageCoordinates } from './registry-targets.ts'

const lodash: PackageCoordinates = { ecosystem: 'npm', name: 'lodash', version: '4.17.21' }
const evil: PackageCoordinates = { ecosystem: 'npm', name: '@factiii/runner', version: '0.28.0' }

describe('osvAdvisoryLookup', () => {
  it('sends one querybatch and keeps only MAL- advisories', async () => {
    const calls: { url: string; body: unknown }[] = []
    const lookup = osvAdvisoryLookup((url, body) => {
      calls.push({ url, body })
      return Promise.resolve(
        JSON.stringify({
          results: [
            { vulns: [{ id: 'GHSA-35jh-r3h4-6jhm', modified: 'x' }] },
            { vulns: [{ id: 'MAL-2026-18204' }, { id: 'GHSA-9j83-qj34-g5vc' }] },
          ],
        }),
      )
    })
    assert.deepEqual(await lookup.lookup([lodash, evil]), [[], ['MAL-2026-18204']])
    assert.equal(calls.length, 1)
    const [call] = calls
    assert.ok(call)
    assert.equal(call.url, OSV_QUERYBATCH_URL)
    assert.deepEqual(call.body, {
      queries: [
        { package: { name: 'lodash', ecosystem: 'npm' }, version: '4.17.21' },
        { package: { name: '@factiii/runner', ecosystem: 'npm' }, version: '0.28.0' },
      ],
    })
  })

  it('queries a versionless package without a version', async () => {
    let sent: unknown
    const lookup = osvAdvisoryLookup((_url, body) => {
      sent = body
      return Promise.resolve('{"results":[{}]}')
    })
    assert.deepEqual(await lookup.lookup([{ ...evil, version: null }]), [[]])
    assert.deepEqual(sent, {
      queries: [{ package: { name: '@factiii/runner', ecosystem: 'npm' } }],
    })
  })

  it('cannot answer when the request fails or the reply does not line up', async () => {
    const failing = osvAdvisoryLookup(() => Promise.reject(new Error('403')))
    assert.deepEqual(await failing.lookup([lodash]), [null])
    const short = osvAdvisoryLookup(() => Promise.resolve('{"results":[]}'))
    assert.deepEqual(await short.lookup([lodash]), [null])
    const garbage = osvAdvisoryLookup(() => Promise.resolve('<html>'))
    assert.deepEqual(await garbage.lookup([lodash]), [null])
  })
})

describe('manifestAdvisoryLookup', () => {
  const manifest = parseMalwareManifest(
    JSON.stringify({ 'every-version': null, 'some-versions': ['1.0.0'], Bad_Py: null }),
    'npm',
  )
  const pyManifest = parseMalwareManifest(JSON.stringify({ Bad_Py: null }), 'PyPI')

  it('lists every version for a null entry and only listed versions otherwise', async () => {
    const lookup = manifestAdvisoryLookup((ecosystem) =>
      Promise.resolve(ecosystem === 'npm' ? manifest : pyManifest),
    )
    const answers = await lookup.lookup([
      { ecosystem: 'npm', name: 'every-version', version: '9.9.9' },
      { ecosystem: 'npm', name: 'some-versions', version: '1.0.0' },
      { ecosystem: 'npm', name: 'some-versions', version: '1.0.1' },
      { ecosystem: 'npm', name: 'unlisted', version: '1.0.0' },
      { ecosystem: 'PyPI', name: 'bad-py', version: '0.1' },
    ])
    assert.deepEqual(
      answers.map((answer) => (answer === null ? null : answer.length > 0)),
      [true, true, false, false, true],
    )
  })

  it('cannot answer for ecosystems or feeds it does not have', async () => {
    const lookup = manifestAdvisoryLookup(() => Promise.resolve(null))
    assert.deepEqual(
      await lookup.lookup([lodash, { ecosystem: 'crates.io', name: 'itoa', version: '1.0.0' }]),
      [null, null],
    )
  })

  it('rejects a manifest that is not name → versions', () => {
    assert.equal(parseMalwareManifest('{"x": 1}', 'npm'), null)
    assert.equal(parseMalwareManifest('[]', 'npm'), null)
  })
})

describe('combineVerdict', () => {
  const authoritative: AdvisoryLookup = {
    label: 'a',
    authoritative: true,
    lookup: () => Promise.resolve([]),
  }
  const offline: AdvisoryLookup = { ...authoritative, label: 'b', authoritative: false }

  it('blocks when any source lists the package', () => {
    assert.deepEqual(
      combineVerdict([
        { lookup: authoritative, advisories: [] },
        { lookup: offline, advisories: ['feed'] },
      ]),
      { status: 'blocked', advisories: ['feed'] },
    )
  })

  it('needs an authoritative answer to call a package checked', () => {
    assert.equal(
      combineVerdict([
        { lookup: authoritative, advisories: null },
        { lookup: offline, advisories: [] },
      ]).status,
      'unverified',
    )
    assert.equal(combineVerdict([{ lookup: authoritative, advisories: [] }]).status, 'allowed')
  })
})

describe('AdvisoryChecker', () => {
  it('batches concurrent checks into one lookup and caches verdicts', async () => {
    const batches: string[][] = []
    const checker = new AdvisoryChecker([
      {
        label: 'osv',
        authoritative: true,
        lookup: (packages): Promise<string[][]> => {
          batches.push(packages.map((pkg) => pkg.name))
          return Promise.resolve(packages.map((pkg) => (pkg.name === evil.name ? ['MAL-1'] : [])))
        },
      },
    ])
    const [a, b, again] = await Promise.all([
      checker.check(lodash),
      checker.check(evil),
      checker.check(lodash),
    ])
    assert.deepEqual(batches, [['lodash', '@factiii/runner']])
    assert.equal(a.status, 'allowed')
    assert.deepEqual(b, { status: 'blocked', advisories: ['MAL-1'] })
    assert.equal(again, a)
    await checker.check(evil)
    assert.equal(batches.length, 1, 'a known verdict is not looked up again')
  })

  it('treats a throwing source as unable to answer', async () => {
    const checker = new AdvisoryChecker([
      {
        label: 'osv',
        authoritative: true,
        lookup: (): Promise<never> => Promise.reject(new Error('boom')),
      },
    ])
    assert.equal((await checker.check(lodash)).status, 'unverified')
  })
})

describe('loadCachedManifest', () => {
  let dir: string
  const body = JSON.stringify({ evil: null })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'firewall-feed-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('downloads a missing feed and caches it', async () => {
    const fetched: string[] = []
    const manifest = await loadCachedManifest('npm', {
      cacheDir: join(dir, 'feeds'),
      fetchText: (url) => {
        fetched.push(url)
        return Promise.resolve(body)
      },
    })
    assert.deepEqual([...(manifest ?? new Map()).keys()], ['evil'])
    assert.deepEqual(fetched, [DATADOG_MANIFEST_URLS.npm])
    assert.equal(readFileSync(join(dir, 'feeds', 'datadog-npm.json'), 'utf8'), body)
  })

  it('uses a fresh cached copy without fetching', async () => {
    writeFileSync(join(dir, 'datadog-npm.json'), body)
    const manifest = await loadCachedManifest('npm', {
      cacheDir: dir,
      fetchText: () => Promise.reject(new Error('should not fetch')),
    })
    assert.ok(manifest?.has('evil'))
  })

  it('falls back to a stale copy when the refresh fails', async () => {
    const path = join(dir, 'datadog-pypi.json')
    writeFileSync(path, JSON.stringify({ Stale_Pkg: null }))
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(path, twoDaysAgo, twoDaysAgo)
    const manifest = await loadCachedManifest('PyPI', {
      cacheDir: dir,
      fetchText: () => Promise.reject(new Error('offline')),
    })
    assert.ok(manifest?.has('stale-pkg'))
  })

  it('cannot answer with neither a cache nor a download', async () => {
    const manifest = await loadCachedManifest('npm', {
      cacheDir: dir,
      fetchText: () => Promise.resolve('not json'),
    })
    assert.equal(manifest, null)
  })
})

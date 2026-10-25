import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import {
  describeReleaseAge,
  hideRecentCrateVersions,
  hideRecentNpmVersions,
  hideRecentPythonFiles,
  hideRecentVersions,
  npmPackumentMayListRecent,
  parseNpmPackument,
} from './release-age.ts'
import type { MetadataTarget } from './registry-targets.ts'

const NOW = Date.parse('2026-10-24T12:00:00Z')
const CUTOFF = NOW - 48 * 60 * 60 * 1000
const OLD = '2026-09-01T00:00:00.000Z'
const RECENT = '2026-10-24T09:00:00.000Z'
const NEWEST = '2026-10-24T11:00:00.000Z'

const packumentSchema = z.object({
  versions: z.record(z.string(), z.unknown()),
  'dist-tags': z.record(z.string(), z.string()),
  time: z.record(z.string(), z.unknown()).optional(),
  readme: z.string().optional(),
})

function packument(text: string): z.infer<typeof packumentSchema> {
  const doc = safeJsonParse(text, decodeWithSchema(packumentSchema))
  assert.ok(doc, 'filtered output is a packument')
  return doc
}

function fullPackument(): string {
  return JSON.stringify({
    name: 'demo',
    readme: 'kept',
    'dist-tags': { latest: '2.1.0', next: '3.0.0-rc.2', legacy: '1.0.0' },
    versions: {
      '1.0.0': { version: '1.0.0' },
      '2.0.0': { version: '2.0.0' },
      '2.1.0-beta.1': { version: '2.1.0-beta.1' },
      '2.1.0': { version: '2.1.0' },
      '3.0.0-rc.1': { version: '3.0.0-rc.1' },
      '3.0.0-rc.2': { version: '3.0.0-rc.2' },
      '9.9.9': { version: '9.9.9' },
    },
    time: {
      created: OLD,
      modified: NEWEST,
      '1.0.0': OLD,
      '2.0.0': OLD,
      '2.1.0-beta.1': OLD,
      '2.1.0': RECENT,
      '3.0.0-rc.1': OLD,
      '3.0.0-rc.2': NEWEST,
      unpublished: { time: OLD, versions: ['0.0.1'] },
    },
  })
}

function packumentWithTimes(text: string): {
  doc: NonNullable<ReturnType<typeof parseNpmPackument>>
  times: Readonly<Record<string, unknown>>
} {
  const doc = parseNpmPackument(text)
  assert.ok(doc?.time)
  return { doc, times: doc.time }
}

describe('describeReleaseAge', () => {
  it('names the limit in hours, or minutes when it is not whole hours', () => {
    assert.equal(describeReleaseAge(48 * 60 * 60 * 1000), '48 hours')
    assert.equal(describeReleaseAge(60 * 60 * 1000), '1 hour')
    assert.equal(describeReleaseAge(90 * 60 * 1000), '90 minutes')
  })
})

describe('hideRecentNpmVersions', () => {
  it('leaves out versions published after the cutoff, newest first', () => {
    const text = fullPackument()
    const { doc, times } = packumentWithTimes(text)
    const result = hideRecentNpmVersions(text, doc, times, CUTOFF)
    assert.deepEqual(result.hidden, ['3.0.0-rc.2', '2.1.0'])
    const filtered = packument(result.text)
    assert.deepEqual(Object.keys(filtered.versions), [
      '1.0.0',
      '2.0.0',
      '2.1.0-beta.1',
      '3.0.0-rc.1',
      '9.9.9',
    ])
    assert.equal(filtered.readme, 'kept', 'fields it does not understand are kept')
    assert.ok(filtered.time)
    assert.equal(Object.hasOwn(filtered.time, '2.1.0'), false)
    assert.equal(filtered.time['modified'], NEWEST)
  })

  it('moves a dist-tag on a left-out version to the version before it', () => {
    const text = fullPackument()
    const { doc, times } = packumentWithTimes(text)
    const tags = packument(hideRecentNpmVersions(text, doc, times, CUTOFF).text)['dist-tags']
    // latest skips the older prerelease; next may land on one.
    assert.deepEqual(tags, { latest: '2.0.0', next: '3.0.0-rc.1', legacy: '1.0.0' })
  })

  it('drops a dist-tag with no earlier version to move to', () => {
    const text = JSON.stringify({
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {} },
      time: { '1.0.0': NEWEST },
    })
    const { doc, times } = packumentWithTimes(text)
    const filtered = packument(hideRecentNpmVersions(text, doc, times, CUTOFF).text)
    assert.deepEqual(filtered.versions, {})
    assert.deepEqual(filtered['dist-tags'], {})
  })

  it('keeps a version without a publish time, and returns the original text when nothing is left out', () => {
    const text = JSON.stringify({
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {} },
      time: { '1.0.0': OLD },
    })
    const { doc } = packumentWithTimes(text)
    assert.deepEqual(hideRecentNpmVersions(text, doc, {}, CUTOFF), { hidden: [], text })
  })
})

describe('npmPackumentMayListRecent', () => {
  it('trusts the modified date of an abbreviated packument', () => {
    const old = parseNpmPackument(JSON.stringify({ versions: {}, modified: OLD }))
    const recent = parseNpmPackument(JSON.stringify({ versions: {}, modified: RECENT }))
    const undated = parseNpmPackument(JSON.stringify({ versions: {} }))
    assert.ok(old && recent && undated)
    assert.equal(npmPackumentMayListRecent(old, CUTOFF), false)
    assert.equal(npmPackumentMayListRecent(recent, CUTOFF), true)
    assert.equal(npmPackumentMayListRecent(undated, CUTOFF), true)
  })
})

describe('hideRecentVersions', () => {
  const npm: MetadataTarget = { ecosystem: 'npm', name: 'demo' }

  it('fetches publish times only for an abbreviated packument modified after the cutoff', async () => {
    const abbreviated = (modified: string): string =>
      JSON.stringify({
        'dist-tags': { latest: '2.1.0' },
        versions: { '2.0.0': {}, '2.1.0': {} },
        modified,
      })
    let fetches = 0
    const times = (): Promise<Record<string, unknown>> => {
      fetches += 1
      return Promise.resolve({ '2.0.0': OLD, '2.1.0': RECENT })
    }
    assert.equal(await hideRecentVersions(npm, abbreviated(OLD), CUTOFF, times), null)
    assert.equal(fetches, 0)
    const result = await hideRecentVersions(npm, abbreviated(RECENT), CUTOFF, times)
    assert.equal(fetches, 1)
    assert.deepEqual(result?.hidden, ['2.1.0'])
    assert.deepEqual(packument(result.text)['dist-tags'], { latest: '2.0.0' })
  })

  it('serves the document unchanged when the times cannot be had or it does not parse', async () => {
    const abbreviated = JSON.stringify({ versions: { '1.0.0': {} }, modified: RECENT })
    const none = (): Promise<undefined> => Promise.resolve(undefined)
    assert.equal(await hideRecentVersions(npm, abbreviated, CUTOFF, none), null)
    assert.equal(await hideRecentVersions(npm, '<html>', CUTOFF, none), null)
  })
})

describe('hideRecentPythonFiles', () => {
  const file = (filename: string, uploaded: string | null): Record<string, unknown> => ({
    filename,
    url: `https://files.pythonhosted.org/packages/aa/${filename}`,
    hashes: { sha256: '00' },
    ...(uploaded === null ? {} : { 'upload-time': uploaded }),
  })

  it('leaves out files uploaded after the cutoff, including a new file for an old release', () => {
    const text = JSON.stringify({
      meta: { 'api-version': '1.4' },
      name: 'demo',
      versions: ['1.0', '1.1'],
      files: [
        file('demo-1.0.tar.gz', OLD),
        file('demo-1.0-cp314-cp314-manylinux_2_28_x86_64.whl', RECENT),
        file('demo-1.1-py3-none-any.whl', NEWEST),
        file('demo-0.9.tar.gz', null),
      ],
    })
    const result = hideRecentPythonFiles(text, CUTOFF)
    assert.deepEqual(result?.hidden, ['1.1', '1.0'])
    const kept = safeJsonParse(
      result.text,
      decodeWithSchema(
        z.object({
          meta: z.object({ 'api-version': z.string() }),
          files: z.array(z.object({ filename: z.string(), url: z.string() })),
        }),
      ),
    )
    assert.deepEqual(
      kept?.files.map((entry) => entry.filename),
      ['demo-1.0.tar.gz', 'demo-0.9.tar.gz'],
    )
    assert.equal(kept.meta['api-version'], '1.4')
  })

  it('does not touch the HTML index, which has no upload times', () => {
    assert.equal(
      hideRecentPythonFiles('<!DOCTYPE html><a href="x">demo-1.1.tar.gz</a>', CUTOFF),
      null,
    )
  })
})

describe('hideRecentCrateVersions', () => {
  const line = (vers: string, pubtime?: string): string =>
    JSON.stringify({ name: 'demo', vers, deps: [], cksum: '00', ...(pubtime ? { pubtime } : {}) })

  it('leaves out index lines published after the cutoff and keeps the rest verbatim', () => {
    const kept = [line('0.1.0'), line('1.0.0', OLD), 'not json']
    const text = [...kept, line('1.1.0', RECENT), line('1.2.0', NEWEST), ''].join('\n')
    const result = hideRecentCrateVersions(text, CUTOFF)
    assert.deepEqual(result.hidden, ['1.2.0', '1.1.0'])
    assert.equal(result.text, [...kept, ''].join('\n'))
  })

  it('returns the original text when nothing is recent', () => {
    const text = `${line('1.0.0', OLD)}\n`
    assert.deepEqual(hideRecentCrateVersions(text, CUTOFF), { hidden: [], text })
  })
})

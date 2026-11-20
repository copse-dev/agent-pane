import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const tag = 'v0.1.0'
const atomListing = `<entry><link href="https://github.com/o/r/releases/tag/${tag}"/></entry>`

interface Response {
  code: number
  body?: string
}

/** What the signed-out GitHub endpoints answer; `down` means no response at all. */
interface Host {
  latest?: Response
  atom?: Response
  feed?: Response
  sums?: Response
  down?: boolean
}

function verify(state: string, host: Host): SpawnSyncReturns<string> {
  const dir = mkdtempSync(join(tmpdir(), 'verify-public-release-'))
  try {
    for (const key of ['latest', 'atom', 'feed', 'sums'] as const) {
      const response = host[key] ?? { code: 404 }
      writeFileSync(join(dir, `${key}.code`), String(response.code))
      writeFileSync(join(dir, `${key}.body`), response.body ?? '')
    }
    // Answers like curl -sSL -o FILE -w '%{http_code}' URL, from the fixtures.
    writeFileSync(
      join(dir, 'curl'),
      `#!/usr/bin/env bash
out=/dev/null url=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -w|-H|--max-time) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
if [ "$HOST_DOWN" = true ]; then printf 000; exit 6; fi
case "$url" in
  */releases/latest) key=latest ;;
  */releases.atom) key=atom ;;
  */latest-mac.yml) key=feed ;;
  */SHA256SUMS) key=sums ;;
  *) exit 3 ;;
esac
cp "$FIXTURES/$key.body" "$out"
cat "$FIXTURES/$key.code"
`,
      { mode: 0o755 },
    )
    writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    return spawnSync('bash', ['scripts/verify-public-release-state.sh', 'o/r', tag, state], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env['PATH'] ?? ''}`,
        FIXTURES: dir,
        HOST_DOWN: String(host.down ?? false),
      },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const json = (tagName: string): string => JSON.stringify({ tag_name: tagName })

describe('verify-public-release-state.sh', () => {
  it('confirms a halt only from real answers that no longer name the release', () => {
    const halted = { latest: { code: 200, body: json('v0.0.9') }, atom: { code: 200, body: '' } }
    assert.equal(verify('halted', halted).status, 0)
    // No stable release left is a 404 from releases/latest, which is also absent.
    assert.equal(verify('halted', { ...halted, latest: { code: 404 } }).status, 0)
  })

  it('never reads an unreachable host as a halted release', () => {
    const result = verify('halted', { down: true })
    assert.equal(result.status, 1)
    assert.match(result.stdout, /still does not see v0\.1\.0 as halted/)
    // Server errors are not answers either.
    const failing = { latest: { code: 503 }, atom: { code: 200 }, sums: { code: 404 } }
    assert.equal(verify('halted', failing).status, 1)
    const atomDown = { latest: { code: 404 }, atom: { code: 502 }, sums: { code: 404 } }
    assert.equal(verify('halted', atomDown).status, 1)
  })

  it('does not call a release halted while either feed or its assets still serve it', () => {
    const latest = { code: 200, body: json(tag) }
    assert.equal(verify('halted', { latest, atom: { code: 200 } }).status, 1)
    const listed = { latest: { code: 404 }, atom: { code: 200, body: atomListing } }
    assert.equal(verify('halted', listed).status, 1)
    const served = { latest: { code: 404 }, atom: { code: 200 }, sums: { code: 200 } }
    assert.equal(verify('halted', served).status, 1)
  })

  it('confirms a promotion from releases/latest and its stable feed', () => {
    const latest = { code: 200, body: json(tag) }
    const feed = { code: 200, body: 'version: 0.1.0\nfiles:\n' }
    assert.equal(verify('promoted', { latest, feed }).status, 0)
    assert.equal(
      verify('promoted', { latest: { code: 200, body: json('v0.0.9') }, feed }).status,
      1,
    )
    const wrongFeed = { code: 200, body: 'version: 0.1.0-beta.3\n' }
    assert.equal(verify('promoted', { latest, feed: wrongFeed }).status, 1)
    assert.equal(verify('promoted', { down: true }).status, 1)
  })

  it('confirms a listing only from a fetched Atom feed', () => {
    assert.equal(verify('listed', { atom: { code: 200, body: atomListing } }).status, 0)
    assert.equal(verify('listed', { atom: { code: 200, body: '' } }).status, 1)
    assert.equal(verify('listed', { down: true }).status, 1)
  })
})

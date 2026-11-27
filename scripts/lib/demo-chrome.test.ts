import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  DEMO_CHROME_PIN,
  demoChromeUrl,
  installDemoChrome,
  type DemoChromePin,
} from './demo-chrome.mts'

const VERSION = '1.2.3.4'
let work = ''

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'demo-chrome-test-'))
})
afterEach(async () => {
  await rm(work, { recursive: true, force: true })
})

/**
 * A zip holding `<asset>/<binary>` as an executable shell script. Built in
 * memory (stored, uncompressed) so the test needs neither a fixture file nor
 * the system `zip`, which some runner images lack.
 */
function makeZip(asset: string, binary: string): Buffer {
  const name = Buffer.from(`${asset}/${binary}`)
  const data = Buffer.from(`#!/bin/sh\necho ${VERSION}\n`)
  const crc = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4) // version needed
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE((3 << 8) | 20, 4) // made by Unix, so the mode below is honoured
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE((0o100755 << 16) >>> 0, 38) // regular file, rwxr-xr-x
  const localSize = local.length + name.length + data.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(localSize, 16)
  return Buffer.concat([local, name, data, central, name, end])
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

async function fixture(): Promise<{ zips: Map<string, Buffer>; pin: DemoChromePin }> {
  const chrome = makeZip('chrome-linux64', 'chrome')
  const driver = makeZip('chromedriver-linux64', 'chromedriver')
  return {
    zips: new Map([
      [demoChromeUrl(VERSION, 'chrome-linux64'), chrome],
      [demoChromeUrl(VERSION, 'chromedriver-linux64'), driver],
    ]),
    pin: {
      version: VERSION,
      sha256: { 'chrome-linux64': sha(chrome), 'chromedriver-linux64': sha(driver) },
    },
  }
}

function fakeFetch(zips: Map<string, Buffer>, calls: string[]): typeof fetch {
  return async (input) => {
    const url = input instanceof Request ? input.url : input.toString()
    calls.push(url)
    const body = zips.get(url)
    return body ? new Response(new Uint8Array(body)) : new Response(null, { status: 404 })
  }
}

const quiet = (): void => {}
const readVersion = async (): Promise<string> => `Google Chrome for Testing ${VERSION}\n`

describe('installDemoChrome', () => {
  it('pins real sha256 values for both zips', () => {
    for (const hash of Object.values(DEMO_CHROME_PIN.sha256)) assert.match(hash, /^[a-f0-9]{64}$/)
  })

  it('unpacks verified zips and returns both binaries', async () => {
    const { zips, pin } = await fixture()
    const calls: string[] = []
    const root = join(work, 'root')
    const install = await installDemoChrome({
      root,
      pin,
      fetchImpl: fakeFetch(zips, calls),
      log: quiet,
      readVersion,
    })
    assert.equal(install.chrome, join(root, VERSION, 'unpacked/chrome-linux64/chrome'))
    assert.equal(
      install.chromedriver,
      join(root, VERSION, 'unpacked/chromedriver-linux64/chromedriver'),
    )
    assert.equal(execFileSync(install.chrome).toString().trim(), VERSION)
    assert.equal(calls.length, 2)

    // A second run re-hashes the cached zips instead of downloading again.
    await installDemoChrome({
      root,
      pin,
      fetchImpl: fakeFetch(zips, calls),
      log: quiet,
      readVersion,
    })
    assert.equal(calls.length, 2)
  })

  it('refuses a download whose sha256 does not match, leaving nothing to run', async () => {
    const { zips, pin } = await fixture()
    zips.set(demoChromeUrl(VERSION, 'chrome-linux64'), Buffer.from('tampered'))
    const root = join(work, 'root')
    await assert.rejects(
      installDemoChrome({ root, pin, fetchImpl: fakeFetch(zips, []), log: quiet, readVersion }),
      /sha256 mismatch .*chrome-linux64\.zip/,
    )
    assert.equal(existsSync(join(root, VERSION, 'chrome-linux64.zip')), false)
    assert.equal(existsSync(join(root, VERSION, 'unpacked/chrome-linux64/chrome')), false)
  })

  it('replaces a cached zip that no longer matches', async () => {
    const { zips, pin } = await fixture()
    const root = join(work, 'root')
    await mkdir(join(root, VERSION), { recursive: true })
    await writeFile(join(root, VERSION, 'chrome-linux64.zip'), 'left by an earlier job')
    const calls: string[] = []
    await installDemoChrome({
      root,
      pin,
      fetchImpl: fakeFetch(zips, calls),
      log: quiet,
      readVersion,
    })
    assert.equal(calls.length, 2)
  })

  it('refuses a binary that reports another version', async () => {
    const { zips, pin } = await fixture()
    await assert.rejects(
      installDemoChrome({
        root: join(work, 'root'),
        pin,
        fetchImpl: fakeFetch(zips, []),
        log: quiet,
        readVersion: async () => 'Google Chrome for Testing 9.9.9.9',
      }),
      /not 1\.2\.3\.4/,
    )
  })
})

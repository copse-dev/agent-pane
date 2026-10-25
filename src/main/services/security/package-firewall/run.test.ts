import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { CLOSED_PROXY_URL } from './child-env.ts'
import type { FirewallDecision } from './proxy.ts'
import type { MetadataTarget } from './registry-targets.ts'
import { blockedLogLine, recentVersionsLogLine, runPackageFirewall } from './run.ts'

function decision(name: string, status: FirewallDecision['verdict']['status']): FirewallDecision {
  return {
    pkg: { ecosystem: 'npm', name, version: '1.0.0' },
    verdict: { status, advisories: status === 'blocked' ? ['MAL-2026-7'] : [] },
  }
}

describe('blockedLogLine', () => {
  it('names the package and links each OSV advisory', () => {
    assert.equal(
      blockedLogLine(decision('evil', 'blocked')),
      '[safe-install] Blocked npm package evil@1.0.0: listed as malicious by MAL-2026-7 ' +
        '(https://osv.dev/vulnerability/MAL-2026-7)',
    )
  })
})

describe('recentVersionsLogLine', () => {
  const entry = (
    ecosystem: MetadataTarget['ecosystem'],
    name: string,
    hidden: string[],
  ): [string, { target: MetadataTarget; hidden: string[] }] => [
    `${ecosystem}:${name}`,
    { target: { ecosystem, name }, hidden },
  ]
  const DAY2 = 48 * 60 * 60 * 1000

  it('prints nothing when no version was left out', () => {
    assert.equal(recentVersionsLogLine(new Map(), DAY2), null)
  })

  it('names each package with its newest left-out version', () => {
    const recent = new Map([
      entry('npm', 'demo', ['2.1.0', '2.0.1']),
      entry('PyPI', 'boto3', ['1.43.118']),
    ])
    assert.equal(
      recentVersionsLogLine(recent, DAY2),
      '[safe-install] Ignored versions published in the last 48 hours: demo@2.1.0, boto3@1.43.118',
    )
  })

  it('summarises past eight packages', () => {
    const recent = new Map(
      Array.from({ length: 10 }, (_, index) => entry('npm', `p${String(index)}`, ['1.0.0'])),
    )
    assert.match(recentVersionsLogLine(recent, DAY2) ?? '', /p7@1\.0\.0 and 2 more packages$/)
  })
})

describe('runPackageFirewall', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'firewall-run-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs the command behind the firewall and returns its exit status', async () => {
    const report = join(dir, 'child-env.json')
    const script =
      'const fs = require("node:fs");' +
      'const ca = fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8");' +
      'fs.writeFileSync(process.argv[1], JSON.stringify({' +
      ' proxy: process.env.HTTPS_PROXY, caFile: process.env.NODE_EXTRA_CA_CERTS,' +
      ' hasCa: ca.includes("BEGIN CERTIFICATE"), runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null }));' +
      'process.exit(7)'
    const lines: string[] = []
    const status = await runPackageFirewall(
      [process.execPath, '-e', script, report],
      { ...process.env, ELECTRON_RUN_AS_NODE: '1', COPSE_DIR: join(dir, 'profile') },
      (line) => lines.push(line),
    )
    assert.equal(status, 7)
    const seen = safeJsonParse(
      readFileSync(report, 'utf8'),
      decodeWithSchema(
        z.object({
          proxy: z.string(),
          caFile: z.string(),
          hasCa: z.boolean(),
          runAsNode: z.string().nullable(),
        }),
      ),
    )
    assert.ok(seen)
    assert.match(seen.proxy, /^http:\/\/copse:[0-9a-f]{48}@127\.0\.0\.1:\d+$/)
    assert.equal(seen.hasCa, true)
    assert.equal(seen.runAsNode, null)
    assert.equal(existsSync(seen.caFile), false, 'trust files are removed after the run')
    assert.deepEqual(lines, [], 'nothing is printed when nothing was blocked')
  })

  it('fails closed when loopback binding is denied, as inside a contained sandbox', async () => {
    const denied = new Error('listen EPERM: operation not permitted 127.0.0.1')
    const listen = mock.method(Server.prototype, 'listen', function (this: Server): Server {
      process.nextTick(() => this.emit('error', Object.assign(denied, { code: 'EPERM' })))
      return this
    })
    const report = join(dir, 'proxy.txt')
    const lines: string[] = []
    try {
      const status = await runPackageFirewall(
        [
          process.execPath,
          '-e',
          'require("node:fs").writeFileSync(process.argv[1], process.env.HTTPS_PROXY ?? "")',
          report,
        ],
        { ...process.env, COPSE_DIR: join(dir, 'profile') },
        (line) => lines.push(line),
      )
      assert.equal(status, 0, 'a command that needs no download still runs')
    } finally {
      listen.mock.restore()
    }
    assert.equal(readFileSync(report, 'utf8'), CLOSED_PROXY_URL)
    assert.match(
      lines.join('\n'),
      /cannot listen on loopback here \(EPERM\); package downloads are disabled/,
    )
  })

  it('reports a command that cannot start', async () => {
    const lines: string[] = []
    const status = await runPackageFirewall(
      [join(dir, 'no-such-command')],
      { ...process.env, COPSE_DIR: join(dir, 'profile') },
      (line) => lines.push(line),
    )
    assert.equal(status, 127)
    assert.match(lines.join('\n'), /could not start/)
  })

  it('prints usage without a command', async () => {
    const lines: string[] = []
    assert.equal(await runPackageFirewall([], {}, (line) => lines.push(line)), 64)
    assert.match(lines.join('\n'), /usage: package-firewall/)
  })
})

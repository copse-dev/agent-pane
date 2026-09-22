import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { wrapCommandWithSandboxMacOS } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js'
import type { CellSpec } from '@copse/review/isolation.ts'
import { createOsSandboxBackend, reviewCellSandboxOverlay } from './os-sandbox-backend.ts'

const spec: CellSpec = {
  checkouts: { base: '/tmp/review-cell/base', head: '/tmp/review-cell/head' },
  scratchDir: '/tmp/review-cell',
  readOnlyPaths: ['/store/pnpm', '/repo/.git'],
  env: { PATH: process.env['PATH'] ?? '', CI: '1' },
}

describe('reviewCellSandboxOverlay', () => {
  const overlay = reviewCellSandboxOverlay(spec)
  const fs = overlay.filesystem
  assert.ok(fs, 'overlay must define a filesystem config')

  it('denies all network', () => {
    assert.deepEqual(overlay.network, {
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: false,
    })
  })

  it('writes only inside the checkouts and scratch', () => {
    assert.deepEqual(fs.allowWrite, [
      '/tmp/review-cell/base',
      '/tmp/review-cell/base/**',
      '/tmp/review-cell/head',
      '/tmp/review-cell/head/**',
      '/tmp/review-cell',
      '/tmp/review-cell/**',
    ])
    for (const path of ['/store/pnpm', '/store/pnpm/**', '/repo/.git', '/repo/.git/**']) {
      assert.ok(fs.denyWrite.includes(path), `${path} must be write-denied`)
    }
    assert.ok(fs.denyWrite.includes('/tmp/review-cell/head/.git/hooks'))
  })

  it('denies the host filesystem and re-allows declared paths and runtimes', () => {
    assert.deepEqual(fs.denyRead, ['/'])
    const allow = fs.allowRead ?? []
    for (const path of [
      '/tmp/review-cell/base/**',
      '/tmp/review-cell/head/**',
      '/tmp/review-cell/**',
      '/store/pnpm/**',
      '/repo/.git/**',
    ]) {
      assert.ok(allow.includes(path), `${path} must be readable`)
    }
    for (const path of allow) {
      assert.ok(
        !path.startsWith(homedir()) ||
          path.startsWith('/tmp/review-cell') ||
          path.startsWith('/store') ||
          path.startsWith('/repo') ||
          /\/node(\/|$)|\/bin\b|sandbox-runtime|apply-seccomp|\.nvm|fnm|\/versions\//.test(path),
        `${path} re-allows something under home that is not toolchain`,
      )
    }
  })
})

describe('createOsSandboxBackend', () => {
  it('is absent when ASRT is not active in this process', () => {
    // Nothing in the unit tier initialises the sandbox, so the honest answer
    // here is "no backend" — never a backend that claims a wall it lacks.
    assert.equal(createOsSandboxBackend(), null)
  })
})

it(
  'enforces read containment with real macOS seatbelt',
  { skip: process.platform !== 'darwin' },
  async () => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'review-seatbelt-')))
    const cell = join(scratch, 'cell')
    const outside = join(scratch, 'outside.txt')
    await mkdir(cell)
    await writeFile(outside, 'HOST_CANARY')
    await writeFile(join(cell, 'inside.txt'), 'CELL_DATA')
    try {
      const overlay = reviewCellSandboxOverlay({
        ...spec,
        scratchDir: cell,
        checkouts: { base: cell, head: cell },
        readOnlyPaths: [],
      })
      const filesystem = overlay.filesystem
      assert.ok(filesystem)
      const run = (command: string): string =>
        execFileSync(
          '/bin/sh',
          [
            '-c',
            wrapCommandWithSandboxMacOS({
              command,
              needsNetworkRestriction: true,
              readConfig: {
                denyOnly: filesystem.denyRead,
                allowWithinDeny: filesystem.allowRead ?? [],
              },
              writeConfig: {
                allowOnly: filesystem.allowWrite,
                denyWithinAllow: filesystem.denyWrite,
              },
              binShell: '/bin/sh',
            }),
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        )
      assert.equal(run(`/bin/cat '${join(cell, 'inside.txt')}'`), 'CELL_DATA')
      assert.throws(() => run(`/bin/cat '${outside}'`), /Operation not permitted/)
      assert.equal(
        run(`'${process.execPath}' -e 'process.stdout.write("node works")'`),
        'node works',
      )
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  },
)

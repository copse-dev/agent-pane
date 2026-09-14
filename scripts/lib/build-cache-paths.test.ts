import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { cacheLinkTarget, electronDistCacheRoot, gortexCacheRoot } from './build-cache-paths.mts'

describe('build cache locations', () => {
  it('preserves the default cache layout and follows COPSE_DIR', () => {
    assert.equal(electronDistCacheRoot({}), join(homedir(), '.copse/cache/electron-dist'))
    assert.equal(gortexCacheRoot({}), join(homedir(), '.copse/cache/gortex'))
    const env = { COPSE_DIR: ' /Volumes/Dev Disk/data/copse ' }
    assert.equal(
      electronDistCacheRoot(env),
      resolve('/Volumes/Dev Disk/data/copse/cache/electron-dist'),
    )
    assert.equal(gortexCacheRoot(env), resolve('/Volumes/Dev Disk/data/copse/cache/gortex'))
  })

  it('honors dedicated overrides, ignores blank overrides, and resolves relative roots', () => {
    const env = {
      COPSE_DIR: './portable profile',
      COPSE_ELECTRON_DIST_CACHE: ' ./shared electron ',
      COPSE_GORTEX_CACHE: ' ./shared gortex ',
    }
    assert.equal(electronDistCacheRoot(env), resolve('shared electron'))
    assert.equal(gortexCacheRoot(env), resolve('shared gortex'))
    assert.equal(
      electronDistCacheRoot({ ...env, COPSE_ELECTRON_DIST_CACHE: ' ' }),
      resolve('portable profile/cache/electron-dist'),
    )
    assert.equal(
      gortexCacheRoot({ ...env, COPSE_GORTEX_CACHE: '' }),
      resolve('portable profile/cache/gortex'),
    )
  })

  it('keeps an Electron directory link working when the kit changes mount point', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-cache-move-'))
    try {
      const kit = join(root, 'Original Disk')
      const link = join(kit, 'projects/app/node_modules/electron/dist')
      const target = join(kit, 'data/copse/cache/electron-dist/version')
      mkdirSync(dirname(link), { recursive: true })
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'version'), '44.1.1')
      const relativeTarget = cacheLinkTarget(link, target)
      assert.equal(isAbsolute(relativeTarget), false)
      symlinkSync(relativeTarget, link, 'dir')
      const moved = join(root, 'Renamed Disk')
      renameSync(kit, moved)
      assert.equal(
        readFileSync(join(moved, 'projects/app/node_modules/electron/dist/version'), 'utf8'),
        '44.1.1',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it(
    'repairs a dangling gortex link from the relocated cache without downloading',
    { skip: process.platform === 'win32' },
    () => {
      const root = mkdtempSync(join(tmpdir(), 'copse-gortex-move-'))
      try {
        const profile = join(root, 'Drive/data/copse')
        const checkout = join(root, 'Drive/projects/app')
        const cache = join(
          profile,
          'cache/gortex',
          `v0.60.0-${process.platform}-${process.arch}`,
          'gortex',
        )
        const link = join(checkout, 'vendor/gortex/gortex')
        mkdirSync(dirname(cache), { recursive: true })
        mkdirSync(dirname(link), { recursive: true })
        writeFileSync(cache, '#!/bin/sh\necho gortex 0.60.0\n', { mode: 0o755 })
        symlinkSync(join(root, 'old-host/gortex'), link)
        const script = fileURLToPath(new URL('../fetch-gortex.mts', import.meta.url))
        const output = execFileSync(process.execPath, [script], {
          cwd: checkout,
          env: { PATH: process.env['PATH'], COPSE_DIR: profile },
          encoding: 'utf8',
          timeout: 10_000,
        })
        assert.doesNotMatch(output, /downloading/)
        assert.equal(isAbsolute(readlinkSync(link)), false)
        renameSync(join(root, 'Drive'), join(root, 'Another Drive'))
        const movedLink = join(root, 'Another Drive/projects/app/vendor/gortex/gortex')
        assert.match(execFileSync(movedLink, ['version'], { encoding: 'utf8' }), /0\.60\.0/)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})

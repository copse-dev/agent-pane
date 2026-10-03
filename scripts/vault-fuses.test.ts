import assert from 'node:assert/strict'
import { constants, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it } from 'node:test'
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import { hardenVaultCaller } from './lib/vault-fuses.mts'

it(
  'packaging disables runtime injection and requires the sealed app archive',
  { skip: process.platform !== 'darwin' },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'copse-fuse-check-'))
    try {
      // A disposable binary copy is never signed or executed; the development
      // Electron install and its fuse settings remain untouched.
      const copy = join(directory, 'framework')
      copyFileSync(
        resolve(
          'node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework',
        ),
        copy,
        constants.COPYFILE_FICLONE,
      )
      await hardenVaultCaller(copy)
      const actual = await getCurrentFuseWire(copy)
      for (const option of [
        FuseV1Options.RunAsNode,
        FuseV1Options.EnableNodeOptionsEnvironmentVariable,
        FuseV1Options.EnableNodeCliInspectArguments,
      ]) {
        assert.equal(actual[option], FuseState.DISABLE)
      }
      for (const option of [
        FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
        FuseV1Options.OnlyLoadAppFromAsar,
      ]) {
        assert.equal(actual[option], FuseState.ENABLE)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

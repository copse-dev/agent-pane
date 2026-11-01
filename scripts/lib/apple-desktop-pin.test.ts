import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appleDesktopBuiltImageDigest,
  verifyAppleDesktopCreatedImage,
  pinAppleDesktopBuild,
  readAppleDesktopPin,
} from './apple-desktop-pin.mts'

const digest = 'sha256:' + 'a'.repeat(64)
const variant = 'sha256:' + 'b'.repeat(64)
const inspect = JSON.stringify([
  {
    configuration: { descriptor: { digest } },
    variants: [{ digest: variant, platform: { architecture: 'arm64', os: 'linux' } }],
  },
])

function created(imageDigest: string): string {
  return JSON.stringify([
    {
      configuration: {
        image: {
          descriptor: { digest: imageDigest },
          reference: 'docker.io/library/copse-desktop:local',
        },
        platform: { architecture: 'arm64', os: 'linux' },
      },
    },
  ])
}

async function fixture(
  run: (env: NodeJS.ProcessEnv, file: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'copse-desktop-pin-'))
  try {
    const env = { COPSE_DIR: directory }
    await mkdir(join(directory, 'isolated-desktop'))
    await run(env, join(directory, 'isolated-desktop', 'image-pin.json'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('isolated desktop image pin', () => {
  it('pins the built index and verifies the created container image', async () => {
    assert.equal(appleDesktopBuiltImageDigest(inspect), digest)
    await fixture(async (env) => {
      assert.equal(await pinAppleDesktopBuild(inspect, env), digest)
      assert.equal(await readAppleDesktopPin(env), digest)
      verifyAppleDesktopCreatedImage(created(digest), digest)
    })
  })

  it('rejects invalid engine metadata without replacing the previous pin', async () => {
    await fixture(async (env, file) => {
      await pinAppleDesktopBuild(inspect, env)
      const before = await readFile(file, 'utf8')
      for (const invalid of [
        '[]',
        '{}',
        inspect.replace(digest, 'latest'),
        inspect.replace('arm64', 'amd64'),
        inspect.replace('linux', 'darwin'),
      ]) {
        await assert.rejects(pinAppleDesktopBuild(invalid, env), /inspection/)
        assert.equal(await readFile(file, 'utf8'), before)
      }
    })
    for (const invalid of [created(variant), '{}', created(digest).replace('arm64', 'amd64')])
      assert.throws(() => {
        verifyAppleDesktopCreatedImage(invalid, digest)
      }, /trusted build pin/)
    assert.throws(() => {
      verifyAppleDesktopCreatedImage(created(digest), 'latest')
    })
  })

  it('refuses missing, malformed and writable receipts without a tag fallback', async () => {
    await fixture(async (env, file) => {
      await assert.rejects(readAppleDesktopPin(env), /No trusted desktop image pin/)
      for (const value of [
        '{}',
        JSON.stringify({ version: 1, digest: 'latest' }),
        JSON.stringify({ version: 1, digest, extra: true }),
      ]) {
        await writeFile(file, value, { mode: 0o600 })
        await assert.rejects(readAppleDesktopPin(env), /No trusted desktop image pin/)
      }
      await pinAppleDesktopBuild(inspect, env)
      await chmod(file, 0o666)
      await assert.rejects(readAppleDesktopPin(env), /No trusted desktop image pin/)
    })
  })

  it('does not follow a receipt symlink', async () => {
    await fixture(async (env, file) => {
      const target = file + '.target'
      await writeFile(target, JSON.stringify({ version: 1, digest }), { mode: 0o600 })
      await symlink(target, file)
      await assert.rejects(readAppleDesktopPin(env), /No trusted desktop image pin/)
    })
  })
})

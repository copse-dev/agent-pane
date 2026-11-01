/** Build the experimental Linux desktop image from explicit, credential-free inputs. */
import * as esbuild from 'esbuild'
import { spawn, execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { parseArgs, promisify } from 'node:util'
import { pinAppleDesktopBuild } from './lib/apple-desktop-pin.mts'
import { APPLE_DESKTOP_DOCKERFILE, stageAppleDesktopInputs } from './lib/apple-desktop-image.mts'

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { help: { type: 'boolean' } } })
  if (values.help) {
    console.log(
      'Build experimental Linux Copse for Apple container.\nRun pnpm run build first, then node scripts/build-apple-desktop.mts.\nRequires the preflight-tested copse-desktop-probe:local image.\nCopies only declared build inputs; no host profile, dependencies or credentials.\nOutput image: copse-desktop:local. No desktop is started.',
    )
    return
  }
  const context = await mkdtemp(resolve('.tmp/apple-desktop-build-'))
  try {
    stageAppleDesktopInputs(process.cwd(), context)
    await writeFile(join(context, 'Dockerfile'), APPLE_DESKTOP_DOCKERFILE)
    await esbuild.build({
      entryPoints: ['scripts/apple-desktop-guest.mts'],
      outfile: join(context, 'desktop-guest.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      logLevel: 'warning',
    })
    // No model keys or arbitrary shell commands are sent to the engine.
    console.log(
      'Building copse-desktop:local; the first Linux dependency install can take several minutes.',
    )
    const build = spawn(
      '/usr/local/bin/container',
      ['build', '--tag', 'copse-desktop:local', '--file', join(context, 'Dockerfile'), context],
      {
        stdio: 'inherit',
        timeout: 15 * 60 * 1000,
        killSignal: 'SIGKILL',
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: homedir() },
      },
    )
    await new Promise<void>((resolve, reject) => {
      build.once('error', reject)
      build.once('close', (code, signal) => {
        if (code === 0) resolve()
        else
          reject(
            new Error(
              `Apple desktop image build failed (${signal ?? String(code)}); see the engine output above. If it says Operation not permitted, run this command in host Terminal.`,
            ),
          )
      })
    })
    const inspection = await promisify(execFile)(
      '/usr/local/bin/container',
      ['image', 'inspect', 'copse-desktop:local'],
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: homedir() },
      },
    )
    const digest = await pinAppleDesktopBuild(inspection.stdout)
    console.log('Built and pinned copse-desktop:local at ' + digest)
  } finally {
    await rm(context, { recursive: true, force: true })
  }
}
void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

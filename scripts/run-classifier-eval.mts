import * as esbuild from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const savedProfile = args.includes('--profile')
  const require = createRequire(import.meta.url)
  const directory = await mkdtemp(join(tmpdir(), 'copse-classifier-eval-'))
  try {
    const out = join(directory, 'runner.cjs')
    await esbuild.build({
      entryPoints: [
        resolve(
          savedProfile
            ? 'scripts/classifier-eval-electron.mts'
            : 'scripts/classifier-eval-node.mts',
        ),
      ],
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      plugins: [
        {
          name: 'native-keyring',
          setup(build): void {
            build.onResolve({ filter: /^@napi-rs\/keyring$/ }, () => ({
              path: require.resolve('@napi-rs/keyring'),
              external: true,
            }))
          },
        },
      ],
      alias: { '@shared': resolve('src/shared') },
    })
    const electron: unknown = savedProfile ? require('electron') : undefined
    if (savedProfile && typeof electron !== 'string') throw new Error('Electron is not installed.')
    const executable = typeof electron === 'string' ? electron : process.execPath
    const env = { ...process.env }
    delete env['ELECTRON_RUN_AS_NODE']
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(executable, [out, ...args], { stdio: 'inherit', env })
      const interrupt = (): void => {
        child.kill('SIGINT')
      }
      const terminate = (): void => {
        child.kill('SIGTERM')
      }
      process.on('SIGINT', interrupt)
      process.on('SIGTERM', terminate)
      child.once('error', reject)
      child.once('close', (code) => {
        process.removeListener('SIGINT', interrupt)
        process.removeListener('SIGTERM', terminate)
        resolve(code ?? 1)
      })
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

void main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Unable to start classifier eval.')
    process.exitCode = 2
  },
)

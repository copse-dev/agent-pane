import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { it } from 'node:test'
import * as esbuild from 'esbuild'
import { MAIN_EXTERNALS } from '../main-externals.mts'

it('build-only forwards the empty agent selection and exits before provider setup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'copse-build-only-'))
  try {
    const outfile = join(directory, 'cli.cjs')
    await esbuild.build({
      entryPoints: [resolve('src/main/services/container-runtime/cli.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: [...MAIN_EXTERNALS],
      alias: { '@shared': resolve('src/shared') },
      plugins: [
        {
          name: 'build-only-fixture',
          setup(build): void {
            build.onLoad({ filter: /\/container-runtime\/thread-container\.ts$/ }, () => ({
              contents: `
                export const WORKER_IMAGE = 'copse-worker:local';
                export async function assertThreadContainerEngine() { return 'apple'; }
                export async function buildWorkerImage(options) {
                  console.log(JSON.stringify(options));
                }
                export function listManagedRuntimes() { throw Error('unexpected list'); }
                export function forgetPnpmStoreVolume() { throw Error('unexpected store'); }
                export function sweepOrphanedRuntimes() { throw Error('unexpected sweep'); }
                export function runThreadInContainer() { throw Error('unexpected thread'); }
                export function teardownRuntime() { throw Error('unexpected teardown'); }
              `,
              loader: 'js',
            }))
          },
        },
      ],
      logLevel: 'silent',
    })
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        outfile,
        '--build-only',
        '--no-acp-agents',
        '--image',
        'copse-desktop-probe:local',
        '--worker-bundle',
        'fixture-worker.cjs',
      ],
      { env: { PATH: process.env['PATH'] ?? '' }, timeout: 30_000 },
    )
    assert.ok(stdout.includes('"engine":"apple"'))
    assert.ok(stdout.includes('"image":"copse-desktop-probe:local"'))
    assert.ok(stdout.includes('"workerBundle":"fixture-worker.cjs"'))
    assert.ok(stdout.includes('"acpAgents":[]'))
    assert.match(stdout, /\[thread-container\] built copse-desktop-probe:local/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

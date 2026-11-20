/** Developer preflight for the isolated-desktop path. Never launches a host GUI. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { parseArgs, promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { resolveThreadContainerEngine } from '../src/main/services/container-runtime/container-engine.ts'
import { appleDesktopProbeArgs, runAppleDesktopProbe } from './lib/apple-desktop-probe.mts'

const execFileAsync = promisify(execFile)

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      image: { type: 'string' },
      report: { type: 'string' },
      ttl: { type: 'string', default: '60' },
    },
  })
  if (values.help) {
    console.log(`Probe the Apple-container isolation required for a future Copse desktop.

Usage: pnpm run probe:apple-desktop --image <worker-image> [--report <file>] [--ttl <seconds>]

Requires Apple silicon, Apple container and an existing Copse worker image with Node 24 and setpriv.
No Docker or host-execution fallback. No GUI/control capability is enabled by this probe.

Options:
  --image <ref>      Existing Linux arm64 Copse worker image (required)
  --report <file>    Write validated evidence after successful teardown
  --ttl <seconds>   Attached guest deadline, 1–300 seconds (default 60)
  --dry-run         Print the launch plan without contacting an engine
  --help            Show this help

Examples:
  pnpm run probe:apple-desktop --image copse-worker:local --dry-run
  pnpm run probe:apple-desktop --image copse-worker:local --report .tmp/apple-desktop-probe.json
`)
    return
  }
  if (!values.image)
    throw new Error(
      'An existing worker image is required. Example: pnpm run probe:apple-desktop --image copse-worker:local --dry-run',
    )
  const ttl = Number(values.ttl)
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 300)
    throw new Error('--ttl must be an integer from 1 to 300 seconds')
  const name = `copse-desktop-probe-${randomUUID()}`
  const createArgs = appleDesktopProbeArgs(name, values.image)
  if (values['dry-run']) {
    console.log(
      JSON.stringify(
        {
          engine: 'apple',
          isolation: 'vm',
          name,
          create: createArgs,
          hostMounts: [],
          credentials: 'none',
          network: 'none',
        },
        null,
        2,
      ),
    )
    return
  }
  // Deliberately ignore the normal engine preference. This path requires a VM.
  await resolveThreadContainerEngine({ env: { COPSE_CONTAINER_ENGINE: 'apple' } })
  const controller = new AbortController()
  const abort = (): void => {
    controller.abort()
  }
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  const command = async (args: string[], timeout = 30000): Promise<string> => {
    const result = await execFileAsync('container', args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 256 * 1024,
      signal: controller.signal,
    })
    return result.stdout
  }
  let report: Awaited<ReturnType<typeof runAppleDesktopProbe>>
  try {
    report = await runAppleDesktopProbe(name, values.image, {
      run: (args): Promise<string> => command(args, args[0] === 'start' ? ttl * 1000 : 30000),
      remove: async (ownedName): Promise<void> => {
        try {
          await execFileAsync('container', ['delete', '--force', ownedName], {
            timeout: 30000,
            maxBuffer: 256 * 1024,
          })
        } catch (error) {
          if (!(error instanceof Error) || !/not found/i.test(error.message)) throw error
        }
      },
    })
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
  const evidence =
    JSON.stringify(
      { engine: 'apple', isolation: 'vm', name, teardown: 'complete', report },
      null,
      2,
    ) + '\n'
  if (values.report) await writeFile(values.report, evidence, { mode: 0o600 })
  process.stdout.write(evidence)
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

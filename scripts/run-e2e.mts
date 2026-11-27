import { hydrateScreenshots } from './lib/screenshot-hydration.mts'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { shouldUseLinuxVirtualDisplay } from '../tests/e2e/helpers/display-mode.mts'
import {
  E2E_ATTEMPT_DIRECTORY_ENV,
  managedAttemptDirectory,
  startAttemptArtifacts,
  recordLaunchResult,
  sealAttemptArtifacts,
} from './lib/e2e-attempt-diagnostics.mts'
import { reexecOutsideRootIfNeeded } from './lib/root-container-userns.mts'

const [, , configFile, ...args] = process.argv
if (!configFile) throw new Error('Usage: run-e2e.mts <wdio-config> [...wdio args]')

// Root Linux containers: run as an ordinary user so the project sandbox works,
// or stop before any spec when it cannot (specs would capture fallback copy).
reexecOutsideRootIfNeeded('run-e2e', { requireSandbox: true })

const forwardedArgs = args[0] === '--' ? args.slice(1) : args
const wdioBinary = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wdio.cmd' : 'wdio',
)
const wdioArgs = ['run', configFile, ...forwardedArgs]

const needsVirtualDisplay = shouldUseLinuxVirtualDisplay()
const command = needsVirtualDisplay ? 'xvfb-run' : wdioBinary
const commandArgs = needsVirtualDisplay
  ? [
      '--auto-servernum',
      // Chromium reports this framebuffer in device pixels. At the pinned 2x
      // DPR, 3200x2048 preserves a 1600x1024 logical desktop: enough for the
      // widest 1600x800 reference frame without changing app layout.
      '--server-args=-screen 0 3200x2048x24',
      '--',
      wdioBinary,
      ...wdioArgs,
    ]
  : wdioArgs

await hydrateScreenshots()

const inheritedDiagnostics = managedAttemptDirectory(process.env[E2E_ATTEMPT_DIRECTORY_ENV])
// Keep ordinary local logs bounded by their existing filenames. CI and local
// investigations opt into retained, separately sealed attempts explicitly.
const attempt = process.env['COPSE_E2E_ATTEMPT']
const diagnostics = inheritedDiagnostics ?? (attempt ? startAttemptArtifacts(attempt) : undefined)

const result = spawnSync(command, commandArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...(diagnostics ? { [E2E_ATTEMPT_DIRECTORY_ENV]: diagnostics } : {}),
  },
  shell: process.platform === 'win32',
  stdio: 'inherit',
})

if (diagnostics) {
  recordLaunchResult(diagnostics, needsVirtualDisplay ? 'xvfb-run' : 'wdio', result)
  // CI seals after its outer timeout/pipeline returns, including partial runner death.
  if (!inheritedDiagnostics) await sealAttemptArtifacts(diagnostics)
}

if (result.error) throw result.error
if (result.signal) {
  process.kill(process.pid, result.signal)
}
process.exit(result.status ?? 1)

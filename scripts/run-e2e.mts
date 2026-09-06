import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const [, , configFile, ...args] = process.argv
if (!configFile) throw new Error('Usage: run-e2e.mts <wdio-config> [...wdio args]')

const forwardedArgs = args[0] === '--' ? args.slice(1) : args
const wdioBinary = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wdio.cmd' : 'wdio',
)
const wdioArgs = ['run', configFile, ...forwardedArgs]

const needsVirtualDisplay = process.platform === 'linux' && !process.env['DISPLAY']
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

const result = spawnSync(command, commandArgs, {
  cwd: process.cwd(),
  env: process.env,
  shell: process.platform === 'win32',
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.signal) {
  process.kill(process.pid, result.signal)
}
process.exit(result.status ?? 1)

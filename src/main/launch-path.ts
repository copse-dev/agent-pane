import { homedir } from 'node:os'
import { join } from 'node:path'

/** A prepared launcher can own PATH without Copse discovering host tools. */
export function augmentPathForGuiLaunch(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): void {
  if (env['COPSE_PRESERVE_PATH'] === '1') return
  const pathKey = platform === 'win32' ? 'Path' : 'PATH'
  const sep = platform === 'win32' ? ';' : ':'
  const current = env[pathKey] ?? ''
  const seen = new Set(current.split(sep).filter(Boolean))
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homeDir, '.local', 'bin'),
    join(homeDir, '.vera', 'bin'),
  ]
  if (platform !== 'win32') extra.push('/usr/bin', '/bin')
  const missing = extra.filter((entry) => !seen.has(entry))
  if (missing.length > 0) env[pathKey] = [...missing, current].filter(Boolean).join(sep)
}

/** Probe the launcher's tools when PATH is controlled; retain legacy defaults otherwise. */
export function toolProbePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const prefix =
    env['COPSE_PRESERVE_PATH'] === '1' || platform === 'win32' ? '' : '/usr/bin:/bin:/exec-daemon:'
  return `${prefix}${env['PATH'] ?? ''}`
}

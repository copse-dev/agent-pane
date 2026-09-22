/** Values that explicitly opt an e2e run out of headless mode. */
const OFF = /^(0|false|no|off)$/i

/**
 * Electron e2e runs headlessly unless the caller explicitly asks for a window.
 *
 * Takes `env` explicitly so launchers and WDIO configs share one tested
 * decision without mutating process state.
 */
export function shouldRunE2eHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env['COPSE_E2E_HEADLESS']?.trim()
  return explicit === undefined || explicit === '' || !OFF.test(explicit)
}

/**
 * Chromium headless works for Electron on macOS and Windows. Linux Electron
 * still needs a display driver, so its non-visible mode is an isolated Xvfb.
 */
export function shouldUseChromiumHeadless(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return platform !== 'linux' && shouldRunE2eHeadless(env)
}

/** Run Linux inside Xvfb by default, or whenever no real display is available. */
export function shouldUseLinuxVirtualDisplay(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return platform === 'linux' && (shouldRunE2eHeadless(env) || !env['DISPLAY']?.trim())
}

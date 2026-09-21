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
